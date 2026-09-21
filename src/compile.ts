import { ptrEscape, SchemaType } from './schema.js';

/**
 * Compiled schema node: only streamable keywords, normalized and
 * pre-validated (e.g. `pattern` is already a RegExp).
 */
export type Node = {
  type?: SchemaType;
  required?: string[];
  properties?: Record<string, Node>;
  items?: Node;
  prefixItems?: Node[];
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
};

export type Program = { root: Node };

export type CompileIssue = { schemaPath: string; keyword: string; message: string };

export type CompileResult = { ok: true; program: Program } | { ok: false; issues: CompileIssue[] };

/**
 * Keywords the streaming validator can decide incrementally. Anything else
 * (e.g. `contains`, `minItems`, `enum`, `allOf`, `patternProperties`) is
 * reported at compile time — never silently dropped.
 */
export const STREAMABLE_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'required',
  'properties',
  'items',
  'prefixItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
]);

const TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

export class StreamCompileError extends Error {
  readonly issues: CompileIssue[];
  constructor(issues: CompileIssue[]) {
    super(
      'schema cannot be evaluated in streaming mode:\n' +
        issues.map((i) => `  ${i.schemaPath}: ${i.message}`).join('\n'),
    );
    this.name = 'StreamCompileError';
    this.issues = issues;
  }
}

/**
 * Compile a schema into a streaming program. Every keyword that cannot be
 * decided in a single streaming pass is reported with its schema path; the
 * result is either a complete program or the full list of problems.
 */
export function compileStream(schema: unknown): CompileResult {
  const issues: CompileIssue[] = [];
  const root = compileNode(schema, '#', issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, program: { root } };
}

function compileNode(schema: unknown, schemaPath: string, issues: CompileIssue[]): Node {
  const node: Node = {};
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({ schemaPath, keyword: '(schema)', message: 'schema must be an object (boolean schemas are not supported)' });
    return node;
  }
  const record = schema as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!STREAMABLE_KEYWORDS.has(key)) {
      issues.push({ schemaPath, keyword: key, message: `keyword '${key}' cannot be decided in streaming mode` });
    }
  }

  if (record.type !== undefined) {
    if (typeof record.type === 'string' && TYPES.has(record.type)) node.type = record.type as SchemaType;
    else issues.push({ schemaPath, keyword: 'type', message: `unsupported type ${JSON.stringify(record.type)}` });
  }

  if (record.required !== undefined) {
    if (Array.isArray(record.required) && record.required.every((k) => typeof k === 'string'))
      node.required = record.required as string[];
    else issues.push({ schemaPath, keyword: 'required', message: 'required must be an array of strings' });
  }

  if (record.properties !== undefined) {
    if (isPlainObject(record.properties)) {
      const props: Record<string, Node> = Object.create(null);
      node.properties = props;
      for (const [key, child] of Object.entries(record.properties))
        props[key] = compileNode(child, schemaPath + '/properties/' + ptrEscape(key), issues);
    } else {
      issues.push({ schemaPath, keyword: 'properties', message: 'properties must be an object' });
    }
  }

  if (record.items !== undefined) node.items = compileNode(record.items, schemaPath + '/items', issues);

  if (record.prefixItems !== undefined) {
    if (Array.isArray(record.prefixItems))
      node.prefixItems = record.prefixItems.map((child, i) => compileNode(child, `${schemaPath}/prefixItems/${i}`, issues));
    else issues.push({ schemaPath, keyword: 'prefixItems', message: 'prefixItems must be an array of schemas' });
  }

  if (record.uniqueItems !== undefined) {
    if (typeof record.uniqueItems === 'boolean') node.uniqueItems = record.uniqueItems;
    else issues.push({ schemaPath, keyword: 'uniqueItems', message: 'uniqueItems must be a boolean' });
  }

  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) node[key] = record[key];
      else issues.push({ schemaPath, keyword: key, message: `${key} must be a finite number` });
    }
  }

  if (record.multipleOf !== undefined) {
    if (typeof record.multipleOf === 'number' && record.multipleOf > 0) node.multipleOf = record.multipleOf;
    else issues.push({ schemaPath, keyword: 'multipleOf', message: 'multipleOf must be a number > 0' });
  }

  for (const key of ['minLength', 'maxLength'] as const) {
    if (record[key] !== undefined) {
      if (Number.isInteger(record[key]) && (record[key] as number) >= 0) node[key] = record[key] as number;
      else issues.push({ schemaPath, keyword: key, message: `${key} must be a non-negative integer` });
    }
  }

  if (record.pattern !== undefined) {
    if (typeof record.pattern === 'string') {
      try {
        node.pattern = new RegExp(record.pattern);
      } catch {
        issues.push({ schemaPath, keyword: 'pattern', message: `invalid regular expression ${JSON.stringify(record.pattern)}` });
      }
    } else {
      issues.push({ schemaPath, keyword: 'pattern', message: 'pattern must be a string' });
    }
  }

  return node;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
