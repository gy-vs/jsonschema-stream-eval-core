import {
  canonicalOf,
  Issue,
  numericMessages,
  ptrEscape,
  Schema,
  stringMessages,
  typeMatches,
} from './schema.js';

/**
 * Whole-value (tree) validator. Supports the same keyword subset as the
 * streaming validator and emits the same `{path, message}` pairs, so results
 * are comparable between the two modes.
 */
export function validate(schema: Schema, value: unknown, path = '#'): Issue[] {
  const issues: Issue[] = [];
  if (schema.type && !typeMatches(schema.type, value)) issues.push({ path, message: `expected ${schema.type}` });
  if (typeof value === 'number') {
    for (const m of numericMessages(schema, value)) issues.push({ path, message: m.message });
  }
  if (typeof value === 'string') {
    const limits = {
      minLength: schema.minLength,
      maxLength: schema.maxLength,
      pattern: schema.pattern === undefined ? undefined : new RegExp(schema.pattern),
    };
    for (const m of stringMessages(limits, value)) issues.push({ path, message: m.message });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in row)) issues.push({ path: path + '/' + ptrEscape(key), message: 'required' });
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in row) issues.push(...validate(child, row[key], path + '/' + ptrEscape(key)));
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (let i = 0; i < value.length; i++) {
        const canonical = canonicalOf(value[i]);
        if (seen.has(canonical)) issues.push({ path: path + '/' + i, message: 'duplicate item' });
        else seen.add(canonical);
      }
    }
    const prefix = schema.prefixItems ?? [];
    for (let i = 0; i < value.length; i++) {
      const child = i < prefix.length ? prefix[i] : schema.items;
      if (child) issues.push(...validate(child, value[i], path + '/' + i));
    }
  }
  return issues;
}
