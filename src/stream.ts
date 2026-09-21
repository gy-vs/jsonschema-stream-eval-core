import { compileStream, Node, Program, StreamCompileError } from './compile.js';
import { IssueCode, numericMessages, ptrEscape, StreamIssue, stringMessages, typeMatches } from './schema.js';
import { Token, Tokenizer } from './tokenizer.js';

export type StreamOptions = {
  /** Stop at the first validation issue (default false: collect everything). */
  stopOnFirstError?: boolean;
  /** What to do when an object repeats a key (default 'error'). */
  duplicateKeys?: 'error' | 'ignore';
  /**
   * Maximum number of array elements tracked per uniqueItems array. Once the
   * budget is exhausted the oldest entries are evicted and a single 'limit'
   * issue is reported for that array (duplicates may then be missed — this is
   * reported, never silent).
   */
  uniqueItemsBudget?: number;
  /**
   * Maximum canonical-byte length retained per element for exact collision
   * verification. Larger elements are compared by digest only.
   */
  uniqueSampleBytes?: number;
  /** Digest function for uniqueItems bucketing. Defaults to cyrb53. */
  digestFn?: (canonical: string) => number;
  /** AbortSignal that cancels the validator. */
  signal?: AbortSignal;
};

export interface StreamValidator {
  /** Feed a chunk of JSON text. No-op once done or cancelled. */
  push(chunk: string): void;
  /** Finish the stream and return all collected issues. Idempotent. */
  end(): StreamIssue[];
  /** Stop processing; further pushes are ignored and end() is inert. */
  cancel(): void;
  readonly issues: StreamIssue[];
  readonly done: boolean;
}

export function createStreamValidator(program: Program, options: StreamOptions = {}): StreamValidator {
  return new Validator(program, options);
}

/**
 * Convenience one-shot: compile, feed all chunks, finish. Throws
 * StreamCompileError if the schema uses keywords outside the streamable
 * subset.
 */
export function validateStream(schema: unknown, chunks: Iterable<string>, options: StreamOptions = {}): StreamIssue[] {
  const compiled = compileStream(schema);
  if (!compiled.ok) throw new StreamCompileError(compiled.issues);
  const validator = createStreamValidator(compiled.program, options);
  for (const chunk of chunks) validator.push(chunk);
  return validator.end();
}

type ScalarToken = Extract<Token, { type: 'string' | 'number' | 'boolean' | 'null' }>;

type Frame = {
  kind: 'object' | 'array';
  node: Node | null;
  path: string;
  // object state
  seen: Set<string>;
  pendingKey: string | null;
  pendingNode: Node | null;
  // array state
  index: number;
  unique: UniqueTracker | null;
};

class Validator implements StreamValidator {
  readonly issues: StreamIssue[] = [];
  private readonly tokenizer: Tokenizer;
  private readonly stack: Frame[] = [];
  private captures: Array<{ writer: CanonicalWriter; done: (canonical: string) => void }> = [];
  private halted = false;
  private ended = false;
  private readonly stopOnFirstError: boolean;
  private readonly duplicateKeys: 'error' | 'ignore';
  private readonly uniqueBudget: number;
  private readonly sampleBytes: number;
  private readonly digest: (canonical: string) => number;

  constructor(private readonly program: Program, options: StreamOptions) {
    this.stopOnFirstError = options.stopOnFirstError ?? false;
    this.duplicateKeys = options.duplicateKeys ?? 'error';
    this.uniqueBudget = Math.max(1, Math.floor(options.uniqueItemsBudget ?? 1024));
    this.sampleBytes = Math.max(0, Math.floor(options.uniqueSampleBytes ?? 256));
    this.digest = options.digestFn ?? cyrb53;
    this.tokenizer = new Tokenizer(
      (token) => this.onToken(token),
      (message, offset) => this.onSyntaxError(message, offset),
    );
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) this.halted = true;
      else signal.addEventListener('abort', () => this.cancel(), { once: true });
    }
  }

  get done(): boolean {
    return this.halted || this.ended;
  }

  push(chunk: string): void {
    if (this.done) return;
    this.tokenizer.push(chunk);
  }

  end(): StreamIssue[] {
    if (!this.ended) {
      this.ended = true;
      if (!this.halted) this.tokenizer.end();
    }
    return this.issues;
  }

  cancel(): void {
    this.halted = true;
  }

  private emit(path: string, message: string, offset: number, code: IssueCode): void {
    this.issues.push({ path, message, offset, code });
    // 'limit' issues are diagnostics about the validator itself, not
    // validation errors: they never trigger stop-on-first-error.
    if (this.stopOnFirstError && code !== 'limit') this.halted = true;
  }

  private onSyntaxError(message: string, offset: number): void {
    const top = this.stack[this.stack.length - 1];
    this.issues.push({ path: top ? top.path : '#', message: `invalid JSON: ${message}`, offset, code: 'syntax' });
    this.halted = true;
  }

  private onToken(token: Token): void {
    if (this.halted) return;
    // Feed tokens to active uniqueItems canonical captures first: an element
    // completes exactly when its canonical writer empties its own stack.
    for (let i = 0; i < this.captures.length; i++) {
      const capture = this.captures[i];
      if (capture.writer.feed(token)) {
        this.captures.splice(i, 1);
        i--;
        capture.done(capture.writer.result);
        if (this.halted) return;
      }
    }
    switch (token.type) {
      case 'startObject': {
        const { node, path } = this.valueStart(token);
        if (this.halted) return;
        this.checkContainerType(node, 'object', path, token.offset);
        this.stack.push({ kind: 'object', node, path, seen: new Set(), pendingKey: null, pendingNode: null, index: 0, unique: null });
        break;
      }
      case 'startArray': {
        const { node, path } = this.valueStart(token);
        if (this.halted) return;
        this.checkContainerType(node, 'array', path, token.offset);
        const unique = node?.uniqueItems
          ? new UniqueTracker(this.uniqueBudget, this.sampleBytes, this.digest, path, (p, m, o, c) => this.emit(p, m, o, c))
          : null;
        this.stack.push({ kind: 'array', node, path, seen: new Set(), pendingKey: null, pendingNode: null, index: 0, unique });
        break;
      }
      case 'endObject': {
        const frame = this.stack.pop()!;
        for (const key of frame.node?.required ?? []) {
          if (!frame.seen.has(key)) this.emit(frame.path + '/' + ptrEscape(key), 'required', token.offset, 'required');
        }
        this.valueDone();
        break;
      }
      case 'endArray': {
        this.stack.pop();
        this.valueDone();
        break;
      }
      case 'key': {
        const frame = this.stack[this.stack.length - 1];
        if (frame.seen.has(token.value)) {
          if (this.duplicateKeys === 'error')
            this.emit(frame.path + '/' + ptrEscape(token.value), 'duplicate key', token.offset, 'duplicateKey');
        } else {
          frame.seen.add(token.value);
        }
        frame.pendingKey = token.value;
        frame.pendingNode = frame.node?.properties?.[token.value] ?? null;
        break;
      }
      case 'string':
      case 'number':
      case 'boolean':
      case 'null': {
        const { node, path } = this.valueStart(token);
        if (this.halted) return;
        this.checkScalar(node, token, path);
        this.valueDone();
        break;
      }
    }
  }

  /** Resolve the schema node and JSON Pointer for a value starting here. */
  private valueStart(token: Token): { node: Node | null; path: string } {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) return { node: this.program.root, path: '#' };
    if (parent.kind === 'object') {
      return { node: parent.pendingNode, path: parent.path + '/' + ptrEscape(parent.pendingKey ?? '') };
    }
    const index = parent.index;
    const path = parent.path + '/' + index;
    const node = parent.node
      ? index < (parent.node.prefixItems?.length ?? 0)
        ? parent.node.prefixItems![index]
        : (parent.node.items ?? null)
      : null;
    if (parent.unique) {
      const tracker = parent.unique;
      const elemOffset = token.offset;
      const writer = new CanonicalWriter();
      const done = (canonical: string) => tracker.check(canonical, index, path, elemOffset);
      if (writer.feed(token)) done(writer.result);
      else this.captures.push({ writer, done });
    }
    return { node, path };
  }

  private valueDone(): void {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) return;
    if (parent.kind === 'object') {
      parent.pendingKey = null;
      parent.pendingNode = null;
    } else {
      parent.index++;
    }
  }

  private checkContainerType(node: Node | null, actual: 'object' | 'array', path: string, offset: number): void {
    if (node?.type && node.type !== actual) this.emit(path, `expected ${node.type}`, offset, 'type');
  }

  private checkScalar(node: Node | null, token: ScalarToken, path: string): void {
    if (!node) return;
    const value = token.type === 'null' ? null : token.value;
    if (node.type && !typeMatches(node.type, value)) this.emit(path, `expected ${node.type}`, token.offset, 'type');
    if (typeof value === 'number')
      for (const m of numericMessages(node, value)) this.emit(path, m.message, token.offset, m.code);
    if (typeof value === 'string')
      for (const m of stringMessages(node, value)) this.emit(path, m.message, token.offset, m.code);
  }
}

/**
 * Bounded digest table for one uniqueItems array. Elements are bucketed by
 * digest; bucket members keep their canonical serialization (capped at
 * sampleBytes) so hash collisions are verified exactly. Entries beyond the
 * budget are evicted oldest-first and reported once via a 'limit' issue.
 */
class UniqueTracker {
  private readonly buckets = new Map<number, Array<{ sample: string | null; index: number }>>();
  private readonly queue: Array<{ hash: number; entry: { sample: string | null; index: number } }> = [];
  private limitReported = false;

  constructor(
    private readonly budget: number,
    private readonly sampleBytes: number,
    private readonly digest: (canonical: string) => number,
    private readonly arrayPath: string,
    private readonly emit: (path: string, message: string, offset: number, code: IssueCode) => void,
  ) {}

  check(canonical: string, index: number, path: string, offset: number): void {
    const hash = this.digest(canonical);
    const sample = canonical.length <= this.sampleBytes ? canonical : null;
    const bucket = this.buckets.get(hash);
    if (bucket) {
      for (const entry of bucket) {
        if (entry.sample !== null && sample !== null) {
          // Exact verification: same digest but different content is a
          // collision, not a duplicate.
          if (entry.sample === sample) {
            this.emit(path, 'duplicate item', offset, 'uniqueItems');
            return;
          }
        } else {
          // At least one side was too large to retain: digest equality is
          // treated as a duplicate (documented, probabilistic fallback).
          this.emit(path, 'duplicate item', offset, 'uniqueItems');
          return;
        }
      }
    }
    if (this.queue.length >= this.budget) {
      const oldest = this.queue.shift()!;
      const list = this.buckets.get(oldest.hash)!;
      list.splice(list.indexOf(oldest.entry), 1);
      if (list.length === 0) this.buckets.delete(oldest.hash);
      if (!this.limitReported) {
        this.limitReported = true;
        this.emit(this.arrayPath, 'uniqueItems budget exceeded; duplicates may be missed', offset, 'limit');
      }
    }
    const entry = { sample, index };
    if (bucket) bucket.push(entry);
    else this.buckets.set(hash, [entry]);
    this.queue.push({ hash, entry });
  }
}

/**
 * Incrementally builds the canonical serialization of one array element from
 * the token stream, matching canonicalOf() in schema.ts. Object frames buffer
 * their entries so keys can be sorted; scalar elements complete in one token.
 */
class CanonicalWriter {
  private readonly stack: Array<
    { kind: 'object'; entries: Array<[string, string]>; key: string | null } | { kind: 'array'; items: string[] }
  > = [];
  result = '';

  /** Returns true when the element is complete (result is ready). */
  feed(token: Token): boolean {
    switch (token.type) {
      case 'startObject':
        this.stack.push({ kind: 'object', entries: [], key: null });
        return false;
      case 'startArray':
        this.stack.push({ kind: 'array', items: [] });
        return false;
      case 'key': {
        const top = this.stack[this.stack.length - 1];
        if (top && top.kind === 'object') top.key = token.value;
        return false;
      }
      case 'endObject': {
        const frame = this.stack.pop()!;
        if (frame.kind !== 'object') throw new Error('canonical writer mismatch');
        frame.entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        this.append('{' + frame.entries.map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}');
        return this.stack.length === 0;
      }
      case 'endArray': {
        const frame = this.stack.pop()!;
        if (frame.kind !== 'array') throw new Error('canonical writer mismatch');
        this.append('[' + frame.items.join(',') + ']');
        return this.stack.length === 0;
      }
      case 'string':
        this.append(JSON.stringify(token.value));
        return this.stack.length === 0;
      case 'number':
        this.append(String(token.value));
        return this.stack.length === 0;
      case 'boolean':
        this.append(String(token.value));
        return this.stack.length === 0;
      case 'null':
        this.append('null');
        return this.stack.length === 0;
    }
  }

  private append(canonical: string): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.result = canonical;
      return;
    }
    if (top.kind === 'array') top.items.push(canonical);
    else {
      top.entries.push([top.key ?? '', canonical]);
      top.key = null;
    }
  }
}

/** cyrb53 (public domain, by bryc): 53-bit string hash, seedable for tests. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
