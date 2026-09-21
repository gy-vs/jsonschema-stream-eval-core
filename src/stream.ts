import { defaultHash, escapePointerSegment, scalarIssues } from './index.js';
import type { Issue, Schema } from './index.js';

export interface StreamIssue extends Issue {
  /** UTF-8 byte offset of the token that triggered the issue. */
  offset: number;
}

export interface UnsupportedKeyword {
  keyword: string;
  pointer: string;
}

/** Thrown by compileStream when the schema uses keywords outside the streamable subset. */
export class CompileError extends Error {
  readonly unsupported: UnsupportedKeyword[];
  constructor(unsupported: UnsupportedKeyword[]) {
    super(`schema cannot be streamed; unsupported keyword(s): ${unsupported.map((u) => `${u.keyword} (${u.pointer})`).join(', ')}`);
    this.name = 'CompileError';
    this.unsupported = unsupported;
  }
}

/** Thrown when the input is not well-formed JSON. */
export class JsonParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (byte ${offset})`);
    this.name = 'JsonParseError';
    this.offset = offset;
  }
}

export interface StreamValidatorOptions {
  /** 'collect' gathers every issue; 'abort' stops at the first one. Default 'collect'. */
  mode?: 'collect' | 'abort';
  /** Policy for duplicate object keys. Default 'error'. */
  duplicateKeys?: 'error' | 'allow';
  /** Maximum number of item digests retained per uniqueItems array. Default 4096. */
  uniqueBudget?: number;
  /** Digest function for uniqueItems summaries. Collisions are verified against the canonical form. */
  hashFn?: (canonical: string) => number;
}

export interface StreamValidator {
  /** Feed the next chunk. Returns the issues detected while processing it. */
  push(chunk: string | Uint8Array): StreamIssue[];
  /** Signal end of input. Throws JsonParseError on truncated documents. */
  end(): StreamIssue[];
  /** Stop processing; further push() calls throw and end() returns []. */
  cancel(): void;
  readonly cancelled: boolean;
  readonly closed: boolean;
  /** Every issue detected so far. */
  readonly issues: readonly StreamIssue[];
  /** Peak container nesting and live uniqueItems digest count — the two memory drivers. */
  readonly stats: { maxDepth: number; digestCount: number };
}

// Keywords this validator can decide incrementally. Anything else is rejected
// at compile time instead of being silently ignored.
const SUPPORTED_KEYWORDS = new Set([
  'type', 'required', 'properties', 'items', 'prefixItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems',
]);
// Annotation-only keywords: safe to ignore without changing validation outcome.
const INERT_KEYWORDS = new Set(['$id', '$schema', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

function collectUnsupported(schema: Schema, pointer: string, out: UnsupportedKeyword[]): void {
  if (schema === null || typeof schema !== 'object') return;
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !INERT_KEYWORDS.has(key)) out.push({ keyword: key, pointer });
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) collectUnsupported(child, `${pointer}/properties/${escapePointerSegment(key)}`, out);
  if (schema.items !== undefined) collectUnsupported(schema.items, `${pointer}/items`, out);
  schema.prefixItems?.forEach((child, index) => collectUnsupported(child, `${pointer}/prefixItems/${index}`, out));
}

/** Compile a schema into a stack-based streaming validator. */
export function compileStream(schema: Schema, options: StreamValidatorOptions = {}): StreamValidator {
  const unsupported: UnsupportedKeyword[] = [];
  collectUnsupported(schema, '#', unsupported);
  if (unsupported.length > 0) throw new CompileError(unsupported);
  return new StreamValidatorImpl(schema, options);
}

// ---------------------------------------------------------------------------
// Incremental tokenizer: emits tokens with UTF-8 byte offsets, tokens may span chunks.
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string; offset: number }
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'number'; value: number; offset: number }
  | { kind: 'literal'; value: true | false | null; offset: number };

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Tokenizer {
  private buf = '';
  private pos = 0;
  private bytePos = 0; // byte offset of buf[pos]
  private eof = false;
  private inString = false;
  private scanFrom = 0; // resume point inside an unterminated string

  get offset(): number {
    return this.bytePos;
  }

  push(text: string): Token[] {
    this.buf += text;
    const tokens: Token[] = [];
    let token: Token | null;
    while ((token = this.next()) !== null) tokens.push(token);
    if (!this.inString && this.pos > 65536) {
      this.buf = this.buf.slice(this.pos);
      this.pos = 0;
    }
    return tokens;
  }

  end(): Token[] {
    this.eof = true;
    return this.push('');
  }

  private next(): Token | null {
    if (this.inString) return this.scanString();
    this.skipWhitespace();
    if (this.pos >= this.buf.length) return null;
    const c = this.buf[this.pos];
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      const offset = this.bytePos;
      this.advance(1);
      return { kind: 'punct', value: c, offset };
    }
    if (c === '"') {
      this.inString = true;
      this.scanFrom = this.pos + 1;
      return this.scanString();
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.scanNumber();
    if (c === 't' || c === 'f' || c === 'n') return this.scanLiteral();
    throw new JsonParseError(`unexpected character ${JSON.stringify(c)}`, this.bytePos);
  }

  private skipWhitespace(): void {
    let i = this.pos;
    while (i < this.buf.length && (this.buf[i] === ' ' || this.buf[i] === '\t' || this.buf[i] === '\n' || this.buf[i] === '\r')) i++;
    this.advance(i - this.pos);
  }

  private advance(n: number): void {
    const end = this.pos + n;
    let bytes = 0;
    for (let i = this.pos; i < end; i++) {
      const code = this.buf.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code < 0xdc00) { bytes += 4; i++; }
      else bytes += 3;
    }
    this.pos = end;
    this.bytePos += bytes;
  }

  private scanString(): Token | null {
    let i = this.scanFrom;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') {
        const raw = this.buf.slice(this.pos, i + 1);
        let value: string;
        try {
          value = JSON.parse(raw);
        } catch {
          throw new JsonParseError('invalid string literal', this.bytePos);
        }
        const offset = this.bytePos;
        this.advance(i + 1 - this.pos);
        this.inString = false;
        return { kind: 'string', value, offset };
      }
      i++;
    }
    if (this.eof) throw new JsonParseError('unterminated string', this.bytePos);
    // Resume at the trailing backslash, if any, so an escape split across
    // chunks is re-examined once its second half arrives.
    this.scanFrom = i > this.buf.length ? this.buf.length - 1 : i;
    return null;
  }

  private scanNumber(): Token | null {
    NUMBER_RE.lastIndex = this.pos;
    const match = NUMBER_RE.exec(this.buf);
    if (match === null) {
      if (!this.eof && /^-?$/.test(this.buf.slice(this.pos))) return null;
      throw new JsonParseError('invalid number', this.bytePos);
    }
    const end = this.pos + match[0].length;
    const next = this.buf[end];
    if (!this.eof && (end === this.buf.length || next === '.' || next === 'e' || next === 'E')) return null; // may continue in the next chunk
    const offset = this.bytePos;
    const value = Number(match[0]);
    this.advance(match[0].length);
    return { kind: 'number', value, offset };
  }

  private scanLiteral(): Token | null {
    const rest = this.buf.slice(this.pos);
    for (const [text, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (rest.startsWith(text)) {
        const offset = this.bytePos;
        this.advance(text.length);
        return { kind: 'literal', value, offset };
      }
    }
    if (!this.eof && ('true'.startsWith(rest) || 'false'.startsWith(rest) || 'null'.startsWith(rest))) return null;
    throw new JsonParseError('unexpected token', this.bytePos);
  }
}

// ---------------------------------------------------------------------------
// Canonical capture: rebuilds the canonical form of one uniqueItems array
// element from the event stream, without retaining the element's value.
// ---------------------------------------------------------------------------

class CaptureBuilder {
  private stack: { object: boolean; parts: { key: string; member: string }[] }[] = [];
  private pendingKey = '';
  result: string | null = null;

  get done(): boolean {
    return this.result !== null;
  }

  key(name: string): void {
    this.pendingKey = name;
  }

  scalar(value: unknown): void {
    this.append(JSON.stringify(value) ?? 'null');
  }

  open(object: boolean): void {
    this.stack.push({ object, parts: [] });
  }

  close(): void {
    const frame = this.stack.pop()!;
    if (frame.object) {
      frame.parts.sort((a, b) => (a.key === b.key ? (a.member < b.member ? -1 : a.member > b.member ? 1 : 0) : a.key < b.key ? -1 : 1));
      this.append(`{${frame.parts.map((p) => p.member).join(',')}}`);
    } else {
      this.append(`[${frame.parts.map((p) => p.member).join(',')}]`);
    }
  }

  private append(fragment: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.result = fragment;
      return;
    }
    if (top.object) {
      const key = JSON.stringify(this.pendingKey);
      top.parts.push({ key, member: `${key}:${fragment}` });
    } else {
      top.parts.push({ key: '', member: fragment });
    }
  }
}

// ---------------------------------------------------------------------------
// Parser + validator stack machine.
// ---------------------------------------------------------------------------

interface ParserFrame {
  kind: 'object' | 'array';
  expect: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd';
}

interface ValidatorFrame {
  kind: 'object' | 'array';
  schema: Schema | undefined;
  pointer: string;
  keys: Set<string>; // object: keys seen (duplicate policy + required)
  childSchema: Schema | undefined; // object: schema of the current key's value
  childPointer: string;
  index: number; // array: index of the next item
  unique: Map<number, string[]> | null; // array: digest -> canonical forms
  digestCount: number;
  budgetReported: boolean;
}

interface ActiveCapture {
  builder: CaptureBuilder;
  frame: ValidatorFrame; // the uniqueItems array the captured value is an item of
  pointer: string;
}

class StreamValidatorImpl implements StreamValidator {
  private readonly tokenizer = new Tokenizer();
  private readonly decoder = new TextDecoder();
  private readonly parserStack: ParserFrame[] = [];
  private readonly stack: ValidatorFrame[] = [];
  private readonly captures: ActiveCapture[] = [];
  private readonly all: StreamIssue[] = [];
  private fresh: StreamIssue[] = [];
  private rootSeen = false;
  private state: 'open' | 'done' | 'aborted' | 'cancelled' = 'open';
  private maxDepth = 0;
  private readonly mode: 'collect' | 'abort';
  private readonly duplicateKeys: 'error' | 'allow';
  private readonly uniqueBudget: number;
  private readonly hashFn: (canonical: string) => number;

  constructor(private readonly schema: Schema, options: StreamValidatorOptions = {}) {
    this.mode = options.mode ?? 'collect';
    this.duplicateKeys = options.duplicateKeys ?? 'error';
    this.uniqueBudget = options.uniqueBudget ?? 4096;
    this.hashFn = options.hashFn ?? defaultHash;
  }

  get cancelled(): boolean {
    return this.state === 'cancelled';
  }

  get closed(): boolean {
    return this.state !== 'open';
  }

  get issues(): readonly StreamIssue[] {
    return this.all;
  }

  get stats(): { maxDepth: number; digestCount: number } {
    let digestCount = 0;
    for (const frame of this.stack) digestCount += frame.digestCount;
    return { maxDepth: this.maxDepth, digestCount };
  }

  cancel(): void {
    this.state = 'cancelled';
    this.parserStack.length = 0;
    this.stack.length = 0;
    this.captures.length = 0;
  }

  push(chunk: string | Uint8Array): StreamIssue[] {
    if (this.state !== 'open') throw new Error(`cannot push: validator is ${this.state}`);
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.fresh = [];
    for (const token of this.tokenizer.push(text)) {
      this.step(token);
      if (this.state !== 'open') break;
    }
    return this.fresh;
  }

  end(): StreamIssue[] {
    if (this.state === 'cancelled') return [];
    if (this.state === 'aborted') {
      this.state = 'done';
      return [];
    }
    if (this.state !== 'open') throw new Error(`cannot end: validator is ${this.state}`);
    this.fresh = [];
    const tail = this.decoder.decode();
    const tokens = tail ? [...this.tokenizer.push(tail), ...this.tokenizer.end()] : this.tokenizer.end();
    for (const token of tokens) {
      this.step(token);
      if (this.state !== 'open') break;
    }
    if (this.state === 'open') {
      if (!this.rootSeen || this.parserStack.length !== 0) throw new JsonParseError('unexpected end of input', this.tokenizer.offset);
      this.state = 'done';
    } else if (this.state === 'aborted') {
      this.state = 'done';
    }
    return this.fresh;
  }

  private addIssue(issue: StreamIssue): void {
    this.all.push(issue);
    this.fresh.push(issue);
    if (this.mode === 'abort') this.state = 'aborted';
  }

  // -- JSON grammar ---------------------------------------------------------

  private step(token: Token): void {
    if (token.kind === 'punct') {
      switch (token.value) {
        case '{':
          this.expectValue(token.offset);
          this.containerStart('object', token.offset);
          return;
        case '[':
          this.expectValue(token.offset);
          this.containerStart('array', token.offset);
          return;
        case '}':
        case ']': {
          const want = token.value === '}' ? 'object' : 'array';
          const top = this.parserStack[this.parserStack.length - 1];
          const closable = top !== undefined && top.kind === want &&
            (top.expect === 'commaOrEnd' || top.expect === (want === 'object' ? 'keyOrEnd' : 'valueOrEnd'));
          if (!closable) throw new JsonParseError(`unexpected '${token.value}'`, token.offset);
          this.parserStack.pop();
          this.containerEnd(want, token.offset);
          this.afterValue();
          return;
        }
        case ':': {
          const top = this.parserStack[this.parserStack.length - 1];
          if (top === undefined || top.kind !== 'object' || top.expect !== 'colon') throw new JsonParseError(`unexpected ':'`, token.offset);
          top.expect = 'value';
          return;
        }
        case ',': {
          const top = this.parserStack[this.parserStack.length - 1];
          if (top === undefined || top.expect !== 'commaOrEnd') throw new JsonParseError(`unexpected ','`, token.offset);
          top.expect = top.kind === 'object' ? 'key' : 'value';
          return;
        }
      }
      return;
    }
    if (token.kind === 'string') {
      const top = this.parserStack[this.parserStack.length - 1];
      if (top !== undefined && top.kind === 'object' && (top.expect === 'keyOrEnd' || top.expect === 'key')) {
        this.key(token.value, token.offset);
        top.expect = 'colon';
        return;
      }
    }
    this.expectValue(token.offset);
    this.scalar(token.value, token.offset);
    this.afterValue();
  }

  private expectValue(offset: number): void {
    const top = this.parserStack[this.parserStack.length - 1];
    const ok = top === undefined
      ? !this.rootSeen
      : top.kind === 'array'
        ? top.expect === 'value' || top.expect === 'valueOrEnd'
        : top.expect === 'value';
    if (!ok) throw new JsonParseError('unexpected value', offset);
  }

  private afterValue(): void {
    const top = this.parserStack[this.parserStack.length - 1];
    if (top === undefined) {
      this.rootSeen = true;
      return;
    }
    top.expect = 'commaOrEnd';
  }

  // -- schema stack ---------------------------------------------------------

  private key(name: string, offset: number): void {
    const frame = this.stack[this.stack.length - 1];
    const pointer = `${frame.pointer}/${escapePointerSegment(name)}`;
    if (frame.keys.has(name)) {
      if (this.duplicateKeys === 'error') this.addIssue({ path: pointer, message: 'duplicate key', offset });
    } else {
      frame.keys.add(name);
    }
    frame.childSchema = frame.schema?.properties?.[name];
    frame.childPointer = pointer;
    for (const capture of this.captures) capture.builder.key(name);
  }

  private resolveChild(offset: number): { schema: Schema | undefined; pointer: string } {
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) return { schema: this.schema, pointer: '#' };
    if (parent.kind === 'object') return { schema: parent.childSchema, pointer: parent.childPointer };
    const index = parent.index++;
    const schema = parent.schema;
    const child = schema === undefined
      ? undefined
      : index < (schema.prefixItems?.length ?? 0)
        ? schema.prefixItems![index]
        : schema.items;
    if (schema?.maxItems !== undefined && index === schema.maxItems) {
      this.addIssue({ path: parent.pointer, message: `must have <= ${schema.maxItems} items`, offset });
    }
    return { schema: child, pointer: `${parent.pointer}/${index}` };
  }

  private scalar(value: unknown, offset: number): void {
    const { schema, pointer } = this.resolveChild(offset);
    this.beginCapture(pointer);
    for (const capture of [...this.captures]) {
      capture.builder.scalar(value);
      if (capture.builder.done) this.finishCapture(capture, offset);
    }
    if (schema !== undefined) {
      for (const message of scalarIssues(schema, value)) this.addIssue({ path: pointer, message, offset });
    }
  }

  private containerStart(kind: 'object' | 'array', offset: number): void {
    const { schema, pointer } = this.resolveChild(offset);
    if (schema?.type !== undefined && schema.type !== kind) {
      this.addIssue({ path: pointer, message: `expected ${schema.type}`, offset });
    }
    this.beginCapture(pointer);
    for (const capture of this.captures) capture.builder.open(kind === 'object');
    this.parserStack.push({ kind, expect: kind === 'object' ? 'keyOrEnd' : 'valueOrEnd' });
    this.stack.push({
      kind,
      schema,
      pointer,
      keys: new Set(),
      childSchema: undefined,
      childPointer: pointer,
      index: 0,
      unique: schema?.uniqueItems === true && kind === 'array' ? new Map() : null,
      digestCount: 0,
      budgetReported: false,
    });
    if (this.parserStack.length > this.maxDepth) this.maxDepth = this.parserStack.length;
  }

  private containerEnd(kind: 'object' | 'array', offset: number): void {
    for (const capture of [...this.captures]) {
      capture.builder.close();
      if (capture.builder.done) this.finishCapture(capture, offset);
    }
    const frame = this.stack.pop()!;
    const schema = frame.schema;
    if (schema === undefined) return;
    if (kind === 'object') {
      for (const key of schema.required ?? []) {
        if (!frame.keys.has(key)) this.addIssue({ path: `${frame.pointer}/${escapePointerSegment(key)}`, message: 'required', offset });
      }
    } else if (schema.minItems !== undefined && frame.index < schema.minItems) {
      this.addIssue({ path: frame.pointer, message: `must have >= ${schema.minItems} items`, offset });
    }
  }

  // -- uniqueItems ----------------------------------------------------------

  private beginCapture(pointer: string): void {
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined || parent.kind !== 'array' || parent.unique === null) return;
    this.captures.push({ builder: new CaptureBuilder(), frame: parent, pointer });
  }

  private finishCapture(capture: ActiveCapture, offset: number): void {
    this.captures.splice(this.captures.indexOf(capture), 1);
    const canonical = capture.builder.result!;
    const frame = capture.frame;
    const digest = this.hashFn(canonical);
    const bucket = frame.unique!.get(digest);
    if (bucket !== undefined && bucket.includes(canonical)) {
      // Digest hit confirmed against the canonical form: genuine duplicate.
      this.addIssue({ path: capture.pointer, message: 'duplicate array item', offset });
      return;
    }
    if (frame.digestCount >= this.uniqueBudget) {
      if (!frame.budgetReported) {
        frame.budgetReported = true;
        this.addIssue({ path: capture.pointer, message: `uniqueItems digest budget of ${this.uniqueBudget} exceeded; uniqueness not fully verified`, offset });
      }
      return;
    }
    // A digest hit with a different canonical form is a collision: both forms
    // stay in the bucket so future items are verified against each.
    if (bucket === undefined) frame.unique!.set(digest, [canonical]);
    else bucket.push(canonical);
    frame.digestCount++;
  }
}
