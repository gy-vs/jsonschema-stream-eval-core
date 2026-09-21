export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * The schema subset supported by both the tree validator and the streaming
 * validator. Any keyword outside this set is reported by `compileStream`
 * instead of being silently ignored in streaming mode.
 */
export type Schema = {
  type?: SchemaType;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  prefixItems?: Schema[];
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type Issue = { path: string; message: string };

export type IssueCode =
  | 'type'
  | 'required'
  | 'minimum'
  | 'maximum'
  | 'exclusiveMinimum'
  | 'exclusiveMaximum'
  | 'multipleOf'
  | 'minLength'
  | 'maxLength'
  | 'pattern'
  | 'uniqueItems'
  | 'duplicateKey'
  | 'limit'
  | 'syntax';

/**
 * A streaming issue. `path` is a JSON Pointer (RFC 6901) with the historical
 * `#` prefix used by the tree validator; `offset` is the UTF-8 byte offset of
 * the token that triggered the issue.
 */
export type StreamIssue = Issue & { offset: number; code: IssueCode };

/** Escape a property key for use in a JSON Pointer segment. */
export function ptrEscape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function typeMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

export type NumericLimits = {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
};

/** Shared by both validators so numeric constraint messages stay identical. */
export function numericMessages(limits: NumericLimits, value: number): Array<{ message: string; code: IssueCode }> {
  const out: Array<{ message: string; code: IssueCode }> = [];
  if (limits.minimum !== undefined && value < limits.minimum)
    out.push({ message: `must be >= ${limits.minimum}`, code: 'minimum' });
  if (limits.maximum !== undefined && value > limits.maximum)
    out.push({ message: `must be <= ${limits.maximum}`, code: 'maximum' });
  if (limits.exclusiveMinimum !== undefined && value <= limits.exclusiveMinimum)
    out.push({ message: `must be > ${limits.exclusiveMinimum}`, code: 'exclusiveMinimum' });
  if (limits.exclusiveMaximum !== undefined && value >= limits.exclusiveMaximum)
    out.push({ message: `must be < ${limits.exclusiveMaximum}`, code: 'exclusiveMaximum' });
  if (limits.multipleOf !== undefined && !isMultipleOf(value, limits.multipleOf))
    out.push({ message: `must be a multiple of ${limits.multipleOf}`, code: 'multipleOf' });
  return out;
}

function isMultipleOf(value: number, m: number): boolean {
  const q = value / m;
  return Math.abs(q - Math.round(q)) <= 1e-12 * Math.max(1, Math.abs(q));
}

export type StringLimits = { minLength?: number; maxLength?: number; pattern?: RegExp };

/** Shared by both validators so string constraint messages stay identical. */
export function stringMessages(limits: StringLimits, value: string): Array<{ message: string; code: IssueCode }> {
  const out: Array<{ message: string; code: IssueCode }> = [];
  if (limits.minLength !== undefined && stringLength(value) < limits.minLength)
    out.push({ message: `length must be >= ${limits.minLength}`, code: 'minLength' });
  if (limits.maxLength !== undefined && stringLength(value) > limits.maxLength)
    out.push({ message: `length must be <= ${limits.maxLength}`, code: 'maxLength' });
  if (limits.pattern !== undefined && !limits.pattern.test(value))
    out.push({ message: `must match pattern ${limits.pattern.source}`, code: 'pattern' });
  return out;
}

/** Length in Unicode code points, matching JSON Schema string semantics. */
export function stringLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Canonical serialization used for uniqueItems comparison: object keys are
 * sorted and numbers go through String(), so `1` and `1.0` are equal and key
 * order does not matter. The streaming canonical writer produces the exact
 * same strings token-by-token.
 */
export function canonicalOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalOf).join(',') + ']';
  const parts: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) parts.push(JSON.stringify(key) + ':' + canonicalOf(record[key]));
  return '{' + parts.join(',') + '}';
}
