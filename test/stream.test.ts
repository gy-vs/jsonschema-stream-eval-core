import { describe, expect, it } from 'vitest';
import {
  compileStream,
  createStreamValidator,
  Schema,
  StreamCompileError,
  StreamIssue,
  Token,
  Tokenizer,
  validate,
  validateStream,
} from '../src/index.js';

const byPathMessage = (issues: Array<{ path: string; message: string }>) =>
  issues.map((i) => `${i.path}|${i.message}`).sort();

const mustCompile = (schema: unknown) => {
  const result = compileStream(schema);
  if (!result.ok) throw new Error(`expected schema to compile: ${JSON.stringify(result.issues)}`);
  return result.program;
};

describe('compile-time reporting', () => {
  it('reports non-streamable keywords instead of silently degrading', () => {
    const result = compileStream({
      type: 'object',
      properties: { a: { allOf: [{ type: 'string' }] }, b: { type: 'string' } },
      minProperties: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ schemaPath: '#/properties/a', keyword: 'allOf' }),
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ schemaPath: '#', keyword: 'minProperties' }));
  });

  it.each(['contains', 'minItems', 'maxItems', 'enum', 'const', 'patternProperties', 'oneOf', 'not', '$ref'])(
    'rejects keyword %s',
    (keyword) => {
      const result = compileStream({ [keyword]: keyword === 'enum' ? [1] : {} });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.keyword === keyword)).toBe(true);
    },
  );

  it('compiles the full supported subset', () => {
    const result = compileStream({
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'array', items: { type: 'number' }, prefixItems: [{ type: 'string' }], uniqueItems: true },
        b: { type: 'string', minLength: 1, maxLength: 3, pattern: '^x' },
        c: { type: 'integer', minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 11, multipleOf: 2 },
        d: { type: 'boolean' },
        e: { type: 'null' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('reports invalid keyword values at compile time', () => {
    const result = compileStream({ pattern: '(', minLength: -1, type: 'flob', multipleOf: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.keyword).sort()).toEqual(['minLength', 'multipleOf', 'pattern', 'type']);
  });

  it('validateStream throws StreamCompileError for non-streamable schemas', () => {
    expect(() => validateStream({ contains: { type: 'string' } }, ['[]'])).toThrow(StreamCompileError);
    try {
      validateStream({ properties: { a: { enum: [1] } } }, ['{}']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StreamCompileError);
      expect((e as StreamCompileError).issues[0]).toMatchObject({ schemaPath: '#/properties/a', keyword: 'enum' });
    }
  });
});

describe('streaming validation', () => {
  it('validates deeply nested objects with stack state only', () => {
    const depth = 500;
    let schema: Schema = { type: 'number' };
    for (let i = 0; i < depth; i++) schema = { type: 'object', required: ['a'], properties: { a: schema } };
    let doc = '0';
    for (let i = 0; i < depth; i++) doc = `{"a":${doc}}`;

    expect(validateStream(schema, [doc])).toEqual([]);

    const bad = doc.replace('0', '"x"');
    const issues = validateStream(schema, [bad]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: '#' + '/a'.repeat(depth), message: 'expected number', code: 'type' });

    // missing required key deep down
    const missing = doc.replace('{"a":0}', '{"b":0}');
    const requiredIssues = validateStream(schema, [missing]);
    expect(requiredIssues).toHaveLength(1);
    expect(requiredIssues[0]).toMatchObject({
      path: '#' + '/a'.repeat(depth - 1) + '/a',
      message: 'required',
      code: 'required',
    });
  });

  it('validates a huge array incrementally without materializing it', () => {
    const n = 100_000;
    const badIndex = n - 3;
    const chunks: string[] = [];
    let cur = '[';
    for (let i = 0; i < n; i++) {
      cur += (i === 0 ? '' : ',') + (i === badIndex ? '"oops"' : String(i));
      if (cur.length >= 16_384) {
        chunks.push(cur);
        cur = '';
      }
    }
    cur += ']';
    chunks.push(cur);

    const program = mustCompile({ type: 'array', items: { type: 'number', minimum: 0 } });
    const validator = createStreamValidator(program);
    for (const chunk of chunks) validator.push(chunk);
    // issues are available before end() is called: validation is incremental
    expect(validator.issues).toHaveLength(1);
    const issues = validator.end();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: `#/${badIndex}`, message: 'expected number', code: 'type' });
  });

  it('bounds uniqueItems memory by the configured budget and reports it', () => {
    const n = 20_000;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(String(i));
    parts.push(String(0)); // duplicate of an element evicted long ago
    const issues = validateStream({ type: 'array', uniqueItems: true, items: { type: 'number' } }, ['[' + parts.join(',') + ']'], {
      uniqueItemsBudget: 100,
    });
    const limits = issues.filter((i) => i.code === 'limit');
    expect(limits).toHaveLength(1);
    expect(limits[0].message).toContain('budget');
    // the eviction was reported, not silent: the duplicate of 0 is missed
    expect(issues.filter((i) => i.code === 'uniqueItems')).toHaveLength(0);
  });

  it('still catches duplicates within the budget window', () => {
    const parts: string[] = [];
    for (let i = 0; i < 50; i++) parts.push(String(i));
    parts.push('49');
    const issues = validateStream({ type: 'array', uniqueItems: true }, ['[' + parts.join(',') + ']'], {
      uniqueItemsBudget: 100,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: '#/50', message: 'duplicate item', code: 'uniqueItems' });
  });

  it('flags duplicate keys by default and can ignore them', () => {
    const schema: Schema = { type: 'object', properties: { a: { type: 'number' } } };
    const doc = '{"a":1,"a":"x"}';
    const strict = validateStream(schema, [doc]);
    expect(strict.map((i) => i.code)).toEqual(['duplicateKey', 'type']);
    expect(strict[0]).toMatchObject({ path: '#/a', message: 'duplicate key', offset: 7 });
    // both occurrences are still validated against the property schema
    expect(strict[1]).toMatchObject({ path: '#/a', message: 'expected string'.replace('string', 'number') });

    const lenient = validateStream(schema, [doc], { duplicateKeys: 'ignore' });
    expect(lenient.map((i) => i.code)).toEqual(['type']);
  });

  it('counts a duplicated key as present for required', () => {
    const issues = validateStream({ type: 'object', required: ['a'] }, ['{"a":1,"a":2}']);
    expect(issues.map((i) => i.code)).toEqual(['duplicateKey']);
  });
});

describe('uniqueItems digests', () => {
  it('verifies digest collisions exactly when samples are retained', () => {
    // constant digest forces every element into one bucket
    const issues = validateStream({ type: 'array', uniqueItems: true }, ['[1,2,3,1]'], { digestFn: () => 42 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: '#/3', message: 'duplicate item' });
  });

  it('canonicalizes objects and numbers before comparison', () => {
    const issues = validateStream(
      { type: 'array', uniqueItems: true },
      ['[{"a":1,"b":[2]},{"b":[2],"a":1},1e2,100,"100"]'],
    );
    expect(issues.map((i) => i.path)).toEqual(['#/1', '#/3']);
  });

  it('falls back to digest-only comparison for oversized samples', () => {
    const issues = validateStream({ type: 'array', uniqueItems: true }, ['["aaaa","bbbb","aaaa"]'], {
      uniqueSampleBytes: 4,
    });
    expect(issues.map((i) => i.path)).toEqual(['#/2']);
  });

  it('tracks uniqueness inside nested arrays independently', () => {
    const doc = '[[1,1],[2,3],[1,1]]';
    const schema: Schema = { type: 'array', items: { type: 'array', uniqueItems: true } };
    const issues = validateStream(schema, [doc]);
    expect(issues.map((i) => i.path)).toEqual(['#/0/1', '#/2/1']);
  });
});

describe('chunk boundaries', () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 10 },
      num: { type: 'number', maximum: -2000 },
      ok: { type: 'boolean' },
      nil: { type: 'null' },
      arr: { type: 'array', items: { type: 'number' } },
    },
  };
  const doc = '{"text":"ab\\u0041😀cd","num":-12.5e2,"ok":true,"nil":null,"arr":[1,2,"x"]}';

  it('produces identical results for every two-chunk split', () => {
    const oneShot = validateStream(schema, [doc]);
    expect(oneShot.length).toBeGreaterThan(0);
    for (let k = 1; k < doc.length; k++) {
      const split = validateStream(schema, [doc.slice(0, k), doc.slice(k)]);
      expect(byPathMessage(split), `split at ${k}`).toEqual(byPathMessage(oneShot));
      expect(split.map((i) => i.offset), `split at ${k}`).toEqual(oneShot.map((i) => i.offset));
    }
  });

  it('survives one-UTF16-unit-at-a-time feeding (split surrogate pairs)', () => {
    const units: string[] = [];
    for (let i = 0; i < doc.length; i++) units.push(doc[i]);
    const perUnit = validateStream(schema, units);
    const oneShot = validateStream(schema, [doc]);
    expect(byPathMessage(perUnit)).toEqual(byPathMessage(oneShot));
    expect(perUnit.map((i) => i.offset)).toEqual(oneShot.map((i) => i.offset));
  });
});

describe('issue reporting', () => {
  const schema: Schema = {
    type: 'object',
    required: ['missing'],
    properties: {
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      age: { type: 'number', minimum: 0 },
    },
  };
  const doc = '{"name":5,"tags":["a",3],"age":-1}';

  it('collects multiple errors with JSON Pointers and byte offsets', () => {
    const issues = validateStream(schema, [doc]);
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ['#/name', 'expected string'],
      ['#/tags/1', 'expected string'],
      ['#/age', 'must be >= 0'],
      ['#/missing', 'required'],
    ]);
    expect(issues[0].offset).toBe(8); // the `5`
    expect(issues[1].offset).toBe(22); // the `3`
    expect(issues[2].offset).toBe(31); // the `-1`
    expect(issues[3].offset).toBe(doc.length - 1); // the closing `}`
    for (const issue of issues) expect(issue.code).toBeTruthy();
  });

  it('stops on the first error when asked', () => {
    const issues = validateStream(schema, [doc], { stopOnFirstError: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('#/name');
  });

  it('escapes JSON Pointer segments', () => {
    const issues = validateStream({ properties: { 'a/b~c': { type: 'number' } } }, ['{"a/b~c":"x"}']);
    expect(issues[0].path).toBe('#/a~1b~0c');
  });

  it('reports UTF-8 byte offsets, not UTF-16 units', () => {
    const doc = '{"s":"😀","n":-1}';
    const issues = validateStream({ properties: { n: { minimum: 0 } } }, [doc]);
    expect(issues).toHaveLength(1);
    expect(issues[0].offset).toBe(Buffer.byteLength('{"s":"😀","n":', 'utf8'));
  });
});

describe('cancellation', () => {
  const schema: Schema = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } };

  it('stops processing after cancel() and never reports end-of-input', () => {
    const validator = createStreamValidator(mustCompile(schema));
    validator.push('{"a":"bad",');
    expect(validator.issues).toHaveLength(1);
    validator.cancel();
    validator.push('"b":"also bad"}');
    const issues = validator.end();
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('#/a');
    expect(validator.done).toBe(true);
  });

  it('honours an AbortSignal', () => {
    const controller = new AbortController();
    const validator = createStreamValidator(mustCompile(schema), { signal: controller.signal });
    validator.push('{"a":"bad",');
    controller.abort();
    validator.push('"b":"also bad"}');
    expect(validator.end()).toHaveLength(1);
  });

  it('a pre-aborted signal prevents any processing', () => {
    const controller = new AbortController();
    controller.abort();
    const validator = createStreamValidator(mustCompile(schema), { signal: controller.signal });
    validator.push('{"a":"bad"}');
    expect(validator.end()).toHaveLength(0);
  });
});

describe('tokenizer', () => {
  it('emits tokens with byte offsets', () => {
    const tokens: Token[] = [];
    const tokenizer = new Tokenizer(
      (t) => tokens.push(t),
      () => expect.unreachable('no error expected'),
    );
    tokenizer.push('{"a": [1, "😀"]}');
    tokenizer.end();
    expect(tokens.map((t) => t.type)).toEqual([
      'startObject',
      'key',
      'startArray',
      'number',
      'string',
      'endArray',
      'endObject',
    ]);
    expect(tokens[3]).toMatchObject({ value: 1, offset: 7 });
    expect(tokens[4]).toMatchObject({ value: '😀', offset: 10 }); // opening quote
    expect(tokens[5].offset).toBe(16); // ']' after the 4-byte emoji
  });

  it.each([
    ['{bad', 'syntax'],
    ['{"a":1,}', 'syntax'],
    ['[1,2', 'syntax'],
    ['01', 'syntax'],
    ['"abc', 'syntax'],
    ['', 'syntax'],
    ['1 2', 'syntax'],
    ['{"a" 1}', 'syntax'],
    ['[1 2]', 'syntax'],
    ['{"a":tru}', 'syntax'],
    ['[1,]', 'syntax'],
  ])('reports %j as a syntax issue', (doc, code) => {
    const issues = validateStream({}, [doc]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe(code);
    expect(issues[0].message).toMatch(/^invalid JSON: /);
    expect(issues[0].offset).toBeGreaterThanOrEqual(0);
  });

  it('points at the offending byte', () => {
    const issues = validateStream({}, ['[1, x]']);
    expect(issues[0].offset).toBe(4);
  });
});

describe('consistency with the tree validator', () => {
  const cases: Array<{ name: string; schema: Schema; doc: string }> = [
    { name: 'string ok', schema: { type: 'string' }, doc: '"hi"' },
    { name: 'string mismatch', schema: { type: 'string' }, doc: '5' },
    { name: 'integer rejects float', schema: { type: 'integer' }, doc: '2.5' },
    { name: 'integer accepts integral float', schema: { type: 'integer' }, doc: '2.0' },
    { name: 'boolean mismatch', schema: { type: 'boolean' }, doc: '1' },
    { name: 'null mismatch', schema: { type: 'null' }, doc: '0' },
    { name: 'numeric limits', schema: { type: 'number', minimum: 2, maximum: 5, multipleOf: 0.5 }, doc: '5.2' },
    { name: 'exclusive limits', schema: { exclusiveMinimum: 1, exclusiveMaximum: 3 }, doc: '3' },
    { name: 'string limits', schema: { minLength: 2, maxLength: 3, pattern: '^a' }, doc: '"b"' },
    { name: 'string maxLength', schema: { maxLength: 2 }, doc: '"abcd"' },
    { name: 'emoji counts as one character', schema: { minLength: 2 }, doc: '"😀"' },
    {
      name: 'required and properties',
      schema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'string' }, c: { type: 'boolean' } } },
      doc: '{"a":"x","c":1}',
    },
    {
      name: 'nested objects',
      schema: { properties: { a: { properties: { b: { properties: { c: { type: 'null' } } } } } } },
      doc: '{"a":{"b":{"c":1}}}',
    },
    { name: 'array items', schema: { type: 'array', items: { type: 'number' } }, doc: '[1,"x",3,"y"]' },
    {
      name: 'prefixItems plus items',
      schema: { prefixItems: [{ type: 'string' }, { type: 'number' }], items: { type: 'boolean' } },
      doc: '["a",1,true,"x"]',
    },
    { name: 'prefixItems extras unconstrained', schema: { prefixItems: [{ type: 'string' }] }, doc: '["a",1,null,{}]' },
    { name: 'unique numbers', schema: { type: 'array', uniqueItems: true }, doc: '[1,2,1]' },
    { name: 'unique normalized numbers', schema: { uniqueItems: true }, doc: '[1e2,100]' },
    { name: 'unique objects key order', schema: { uniqueItems: true }, doc: '[{"a":1,"b":2},{"b":2,"a":1}]' },
    { name: 'unique nested arrays', schema: { uniqueItems: true }, doc: '[[1,2],[1,2],[3]]' },
    { name: 'unique distinct types', schema: { uniqueItems: true }, doc: '["1",1,"1.0"]' },
    { name: 'array vs object', schema: { type: 'array' }, doc: '{}' },
    { name: 'object vs array', schema: { type: 'object' }, doc: '[]' },
    { name: 'properties ignored on non-object', schema: { properties: { a: { type: 'string' } } }, doc: '5' },
    {
      name: 'deep mix',
      schema: {
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'integer', minimum: 0 }, tag: { type: 'string', maxLength: 2 } },
            },
          },
        },
      },
      doc: '{"list":[{"id":1,"tag":"ok"},{"id":-1,"tag":"toolong"},{}]}',
    },
    { name: 'root scalar constraint', schema: { minimum: 10 }, doc: '5' },
    { name: 'multipleOf float precision', schema: { multipleOf: 0.1 }, doc: '0.3' },
  ];

  it.each(cases)('stream matches tree: $name', ({ schema, doc }) => {
    const tree = validate(schema, JSON.parse(doc));
    const stream = validateStream(schema, [doc]);
    expect(byPathMessage(stream)).toEqual(byPathMessage(tree));
  });

  it('chunked feeding matches one-shot for the deep mix case', () => {
    const { schema, doc } = cases.find((c) => c.name === 'deep mix')!;
    const oneShot = validateStream(schema, [doc]);
    const chunks: string[] = [];
    for (let i = 0; i < doc.length; i += 7) chunks.push(doc.slice(i, i + 7));
    const chunked = validateStream(schema, chunks);
    expect(byPathMessage(chunked)).toEqual(byPathMessage(oneShot));
  });

  it('programs are reusable across validators', () => {
    const program = mustCompile({ type: 'array', items: { type: 'number' } });
    const a = createStreamValidator(program);
    const b = createStreamValidator(program);
    a.push('[1,"x"]');
    b.push('[1,2]');
    expect(a.end()).toHaveLength(1);
    expect(b.end()).toHaveLength(0);
  });
});
