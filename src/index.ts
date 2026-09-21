export type Schema = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
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
  minItems?: number;
  maxItems?: number;
};

export type Issue = { path: string; message: string };

/** Escape one JSON Pointer segment (RFC 6901). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function typeMatches(type: NonNullable<Schema['type']>, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
  }
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/**
 * Keyword checks that apply to non-container values. Shared by the tree
 * validator and the streaming validator so both produce identical messages.
 */
export function scalarIssues(schema: Schema, value: unknown): string[] {
  const messages: string[] = [];
  if (schema.type !== undefined && !typeMatches(schema.type, value)) messages.push(`expected ${schema.type}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) messages.push(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) messages.push(`must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) messages.push(`must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) messages.push(`must be < ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && !isMultipleOf(value, schema.multipleOf)) messages.push(`must be a multiple of ${schema.multipleOf}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) messages.push(`length must be >= ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) messages.push(`length must be <= ${schema.maxLength}`);
  }
  return messages;
}

/** FNV-1a 32-bit digest, used for uniqueItems summaries. */
export function defaultHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Canonical serialization: object keys sorted, numbers normalized by JS. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(row[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function validate(schema: Schema, value: unknown, path = '#'): Issue[] {
  const issues: Issue[] = [];
  if (Array.isArray(value)) {
    if (schema.type !== undefined && !typeMatches(schema.type, value)) issues.push({ path, message: `expected ${schema.type}` });
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must have >= ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must have <= ${schema.maxItems} items` });
    if (schema.uniqueItems === true) {
      const seen = new Map<number, string[]>();
      value.forEach((item, index) => {
        const canonical = canonicalize(item);
        const digest = defaultHash(canonical);
        const bucket = seen.get(digest);
        if (bucket === undefined) seen.set(digest, [canonical]);
        else if (bucket.includes(canonical)) issues.push({ path: `${path}/${index}`, message: 'duplicate array item' });
        else bucket.push(canonical);
      });
    }
    value.forEach((item, index) => {
      const sub = index < (schema.prefixItems?.length ?? 0) ? schema.prefixItems![index] : schema.items;
      if (sub !== undefined) issues.push(...validate(sub, item, `${path}/${index}`));
    });
    return issues;
  }
  if (value !== null && typeof value === 'object') {
    if (schema.type !== undefined && !typeMatches(schema.type, value)) issues.push({ path, message: `expected ${schema.type}` });
    const row = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in row)) issues.push({ path: `${path}/${escapePointerSegment(key)}`, message: 'required' });
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in row) issues.push(...validate(child, row[key], `${path}/${escapePointerSegment(key)}`));
    return issues;
  }
  for (const message of scalarIssues(schema, value)) issues.push({ path, message });
  return issues;
}

export { compileStream, CompileError, JsonParseError } from './stream.js';
export type { StreamIssue, StreamValidator, StreamValidatorOptions, UnsupportedKeyword } from './stream.js';
