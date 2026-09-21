/**
 * Streaming JSON tokenizer. Consumes text chunks of arbitrary size and emits
 * structural/value tokens annotated with UTF-8 byte offsets into the
 * concatenated input. Tokens may span chunk boundaries (a string, number,
 * literal, or even a surrogate pair can be split across two pushes).
 *
 * Malformed input is reported once through onError and the tokenizer stops;
 * it does not attempt recovery.
 */

export type Token =
  | { type: 'startObject'; offset: number }
  | { type: 'endObject'; offset: number }
  | { type: 'startArray'; offset: number }
  | { type: 'endArray'; offset: number }
  | { type: 'key'; value: string; offset: number }
  | { type: 'string'; value: string; offset: number }
  | { type: 'number'; value: number; raw: string; offset: number }
  | { type: 'boolean'; value: boolean; offset: number }
  | { type: 'null'; offset: number };

type ObjectFrame = { kind: 'object'; expect: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd' };
type ArrayFrame = { kind: 'array'; expect: 'valueOrEnd' | 'value' | 'commaOrEnd' };
type Frame = ObjectFrame | ArrayFrame;

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function hexValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

function isNumberChar(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === 'e' || ch === 'E' || ch === '+' || ch === '-' || ch === '.';
}

export class Tokenizer {
  private frames: Frame[] = [];
  private rootDone = false;
  private failed = false;
  private ended = false;
  /** A trailing high surrogate held back so it can pair with the next chunk. */
  private carry = '';
  /** UTF-8 bytes consumed so far. */
  private offset = 0;
  private mode: 'struct' | 'string' | 'number' | 'literal' = 'struct';
  private stringIsKey = false;
  private strBuf = '';
  private strEscape = false;
  private unicodeLeft = 0;
  private unicodeAcc = 0;
  private tokenOffset = 0;
  private numBuf = '';
  private litWord = '';
  private litPos = 0;

  constructor(
    private readonly onToken: (token: Token) => void,
    private readonly onError: (message: string, offset: number) => void,
  ) {}

  push(input: string): void {
    if (this.failed || this.ended) return;
    let chunk = this.carry + input;
    this.carry = '';
    // A chunk ending in a high surrogate may be half of an astral character
    // split across chunks; defer it so byte accounting and string decoding
    // see the whole code point.
    if (chunk.length > 0) {
      const last = chunk.charCodeAt(chunk.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.carry = chunk.slice(-1);
        chunk = chunk.slice(0, -1);
      }
    }
    this.process(chunk);
  }

  end(): void {
    if (this.failed || this.ended) return;
    this.ended = true;
    if (this.carry) {
      const rest = this.carry;
      this.carry = '';
      this.process(rest);
      if (this.failed) return;
    }
    if (this.mode === 'number') {
      if (!this.finishNumber()) return;
    } else if (this.mode === 'string') {
      this.fail('unexpected end of JSON input (unterminated string)', this.offset);
      return;
    } else if (this.mode === 'literal') {
      this.fail('unexpected end of JSON input', this.offset);
      return;
    }
    if (this.frames.length > 0) {
      this.fail('unexpected end of JSON input', this.offset);
      return;
    }
    if (!this.rootDone) this.fail('unexpected end of JSON input (empty document)', this.offset);
  }

  private process(chunk: string): void {
    let i = 0;
    const consume = (): void => {
      const cp = chunk.codePointAt(i)!;
      this.offset += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      i += cp > 0xffff ? 2 : 1;
    };
    while (i < chunk.length) {
      const ch = chunk[i];

      if (this.mode === 'string') {
        if (this.unicodeLeft > 0) {
          const v = hexValue(ch);
          if (v < 0) {
            this.fail('invalid \\u escape in string', this.offset);
            return;
          }
          this.unicodeAcc = this.unicodeAcc * 16 + v;
          this.unicodeLeft--;
          consume();
          if (this.unicodeLeft === 0) this.strBuf += String.fromCharCode(this.unicodeAcc);
          continue;
        }
        if (this.strEscape) {
          if (ch === 'u') {
            this.unicodeLeft = 4;
            this.unicodeAcc = 0;
          } else {
            const mapped = ESCAPES[ch];
            if (mapped === undefined) {
              this.fail(`invalid escape '\\${ch}' in string`, this.offset);
              return;
            }
            this.strBuf += mapped;
          }
          this.strEscape = false;
          consume();
          continue;
        }
        if (ch === '\\') {
          this.strEscape = true;
          consume();
          continue;
        }
        if (ch === '"') {
          const offset = this.tokenOffset;
          consume();
          const value = this.strBuf;
          this.strBuf = '';
          this.mode = 'struct';
          if (this.stringIsKey) {
            const frame = this.top();
            if (frame && frame.kind === 'object') frame.expect = 'colon';
            this.onToken({ type: 'key', value, offset });
          } else {
            this.onToken({ type: 'string', value, offset });
            this.afterValue();
          }
          continue;
        }
        if (ch < ' ') {
          this.fail('control character in string', this.offset);
          return;
        }
        this.strBuf += String.fromCodePoint(chunk.codePointAt(i)!);
        consume();
        continue;
      }

      if (this.mode === 'number') {
        if (isNumberChar(ch)) {
          this.numBuf += ch;
          consume();
          continue;
        }
        if (!this.finishNumber()) return;
        continue; // reprocess the delimiter in struct mode
      }

      if (this.mode === 'literal') {
        if (ch === this.litWord[this.litPos]) {
          this.litPos++;
          consume();
          if (this.litPos === this.litWord.length) {
            this.mode = 'struct';
            this.emitLiteral();
            this.afterValue();
          }
          continue;
        }
        this.fail(`invalid literal, expected '${this.litWord}'`, this.tokenOffset);
        return;
      }

      // struct mode
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        consume();
        continue;
      }
      const frame = this.top();
      if (!frame) {
        if (this.rootDone) {
          this.fail('unexpected non-whitespace character after JSON value', this.offset);
          return;
        }
        if (!this.startValue(ch, consume)) return;
        continue;
      }
      if (frame.kind === 'object') {
        switch (frame.expect) {
          case 'keyOrEnd':
            if (ch === '}') {
              const offset = this.offset;
              consume();
              this.frames.pop();
              this.onToken({ type: 'endObject', offset });
              this.afterValue();
              continue;
            }
            if (ch === '"') {
              this.beginString(true);
              consume();
              continue;
            }
            this.fail(`expected object key or '}'`, this.offset);
            return;
          case 'key':
            if (ch === '"') {
              this.beginString(true);
              consume();
              continue;
            }
            this.fail('expected object key', this.offset);
            return;
          case 'colon':
            if (ch === ':') {
              frame.expect = 'value';
              consume();
              continue;
            }
            this.fail(`expected ':'`, this.offset);
            return;
          case 'value':
            if (!this.startValue(ch, consume)) return;
            continue;
          case 'commaOrEnd':
            if (ch === ',') {
              frame.expect = 'key';
              consume();
              continue;
            }
            if (ch === '}') {
              const offset = this.offset;
              consume();
              this.frames.pop();
              this.onToken({ type: 'endObject', offset });
              this.afterValue();
              continue;
            }
            this.fail(`expected ',' or '}'`, this.offset);
            return;
        }
      } else {
        switch (frame.expect) {
          case 'valueOrEnd':
            if (ch === ']') {
              const offset = this.offset;
              consume();
              this.frames.pop();
              this.onToken({ type: 'endArray', offset });
              this.afterValue();
              continue;
            }
            if (!this.startValue(ch, consume)) return;
            continue;
          case 'value':
            if (!this.startValue(ch, consume)) return;
            continue;
          case 'commaOrEnd':
            if (ch === ',') {
              frame.expect = 'value';
              consume();
              continue;
            }
            if (ch === ']') {
              const offset = this.offset;
              consume();
              this.frames.pop();
              this.onToken({ type: 'endArray', offset });
              this.afterValue();
              continue;
            }
            this.fail(`expected ',' or ']'`, this.offset);
            return;
        }
      }
    }
  }

  private top(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  private startValue(ch: string, consume: () => void): boolean {
    const offset = this.offset;
    if (ch === '{') {
      consume();
      this.frames.push({ kind: 'object', expect: 'keyOrEnd' });
      this.onToken({ type: 'startObject', offset });
      return true;
    }
    if (ch === '[') {
      consume();
      this.frames.push({ kind: 'array', expect: 'valueOrEnd' });
      this.onToken({ type: 'startArray', offset });
      return true;
    }
    if (ch === '"') {
      this.beginString(false);
      consume();
      return true;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.mode = 'number';
      this.numBuf = ch;
      this.tokenOffset = offset;
      consume();
      return true;
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      this.mode = 'literal';
      this.litWord = ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null';
      this.litPos = 1;
      this.tokenOffset = offset;
      consume();
      return true;
    }
    this.fail(`unexpected character '${ch}'`, offset);
    return false;
  }

  private beginString(isKey: boolean): void {
    this.mode = 'string';
    this.stringIsKey = isKey;
    this.strBuf = '';
    this.strEscape = false;
    this.unicodeLeft = 0;
    this.tokenOffset = this.offset;
  }

  private finishNumber(): boolean {
    const raw = this.numBuf;
    this.numBuf = '';
    this.mode = 'struct';
    if (!NUMBER_RE.test(raw)) {
      this.fail(`invalid number '${raw}'`, this.tokenOffset);
      return false;
    }
    this.onToken({ type: 'number', value: Number(raw), raw, offset: this.tokenOffset });
    this.afterValue();
    return true;
  }

  private emitLiteral(): void {
    const offset = this.tokenOffset;
    if (this.litWord === 'null') this.onToken({ type: 'null', offset });
    else this.onToken({ type: 'boolean', value: this.litWord === 'true', offset });
  }

  private afterValue(): void {
    const frame = this.top();
    if (frame) frame.expect = 'commaOrEnd';
    else this.rootDone = true;
  }

  private fail(message: string, offset: number): void {
    this.failed = true;
    this.onError(message, offset);
  }
}
