import { describe, expect, it } from 'vitest';
import { compileStream, CompileError, JsonParseError, validate } from '../src/index.js';
import type { Schema, StreamIssue, StreamValidatorOptions } from '../src/index.js';

function run(schema: Schema, doc: string, options?: StreamValidatorOptions, chunkSize?: number): StreamIssue[] {
  const validator = compileStream(schema, options);
  const issues: StreamIssue[] = [];
  if (chunkSize === undefined) {
    issues.push(...validator.push(doc));
  } else {
    for (let i = 0; i < doc.length; i += chunkSize) issues.push(...validator.push(doc.slice(i, i + chunkSize)));
  }
  issues.push(...validator.end());
  return issues;
}

const summary = (issues: { path: string; message: string }[]) => issues.map((i) => `${i.path} ${i.message}`).sort();

describe('compile time', () => {
  it('rejects keywords outside the streamable subset instead of degrading silently', () => {
    expect(() => compileStream({ pattern: '^a' } as unknown as Schema)).toThrow(CompileError);
    try {
      compileStream({
        type: 'object',
        properties: { a: { $ref: '#/x' } as unknown as Schema, b: { allOf: [] } as unknown as Schema },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CompileError);
      expect((error as CompileError).unsupported).toEqual([
        { keyword: '$ref', pointer: '#/properties/a' },
        { keyword: 'allOf', pointer: '#/properties/b' },
      ]);
    }
  });

  it('finds unsupported keywords nested under items and prefixItems', () => {
    try {
      compileStream({ items: { contains: {} } as unknown as Schema, prefixItems: [{ dependentRequired: ['a'] } as unknown as Schema] });
      expect.unreachable();
    } catch (error) {
      expect((error as CompileError).unsupported).toEqual([
        { keyword: 'contains', pointer: '#/items' },
        { keyword: 'dependentRequired', pointer: '#/prefixItems/0' },
      ]);
    }
  });

  it('ignores annotation-only keywords', () => {
    expect(run({ title: 't', description: 'd', type: 'integer' } as Schema, '1')).toEqual([]);
  });
});

describe('scalars and offsets', () => {
  it('reports numeric constraints with token byte offset', () => {
    expect(run({ type: 'integer', minimum: 10 }, '3')).toEqual([{ path: '#', message: 'must be >= 10', offset: 0 }]);
  });

  it('skips inapplicable constraints instead of double-reporting', () => {
    expect(run({ type: 'string', minLength: 2 }, '5')).toEqual([{ path: '#', message: 'expected string', offset: 0 }]);
  });

  it('tracks byte offsets across multibyte characters', () => {
    const issues = run({ properties: { 'é': { type: 'integer' } } }, '{"é":"x"}');
    expect(issues).toEqual([{ path: '#/é', message: 'expected integer', offset: 6 }]);
  });

  it('escapes JSON Pointer segments', () => {
    expect(run({ required: ['a/b'] }, '{}')).toEqual([{ path: '#/a~1b', message: 'required', offset: 1 }]);
  });
});

describe('objects and arrays', () => {
  it('checks required and properties, reporting required at the closing brace', () => {
    const schema: Schema = { type: 'object', required: ['a'], properties: { a: { type: 'number' }, b: { type: 'string' } } };
    expect(run(schema, '{"b":1}')).toEqual([
      { path: '#/b', message: 'expected string', offset: 5 },
      { path: '#/a', message: 'required', offset: 6 },
    ]);
  });

  it('supports prefixItems tuples with items fallback', () => {
    const schema: Schema = { prefixItems: [{ type: 'string' }, { type: 'number' }], items: { type: 'boolean' } };
    expect(run(schema, '["x",1,true,"no"]')).toEqual([{ path: '#/3', message: 'expected boolean', offset: 12 }]);
  });

  it('enforces minItems at close and maxItems as soon as the extra item starts', () => {
    expect(run({ minItems: 2 }, '[1]')).toEqual([{ path: '#', message: 'must have >= 2 items', offset: 2 }]);
    expect(run({ maxItems: 1 }, '[1,2]')).toEqual([{ path: '#', message: 'must have <= 1 items', offset: 3 }]);
  });
});

describe('deep nesting', () => {
  const depth = 2000;
  const leaf: Schema = { type: 'integer' };
  let schema: Schema = leaf;
  for (let i = 0; i < depth; i++) schema = { type: 'object', properties: { a: schema } };
  const doc = (inner: string) => '{"a":'.repeat(depth) + inner + '}'.repeat(depth);

  it('handles deep documents with constant per-frame state', () => {
    const validator = compileStream(schema);
    const text = doc('0');
    const issues: StreamIssue[] = [];
    for (let i = 0; i < text.length; i += 977) issues.push(...validator.push(text.slice(i, i + 977)));
    issues.push(...validator.end());
    expect(issues).toEqual([]);
    expect(validator.stats.maxDepth).toBe(depth);
  });

  it('reports errors at the bottom of deep paths', () => {
    const issues = run(schema, doc('"leaf"'));
    expect(issues).toEqual([{ path: `#/${'a/'.repeat(depth - 1)}a`, message: 'expected integer', offset: 5 * depth }]);
  });
});

describe('huge arrays', () => {
  it('validates a 200k-item array without retaining it', () => {
    const n = 200_000;
    const validator = compileStream({ type: 'array', items: { type: 'integer' } });
    const parts = ['['];
    for (let i = 0; i < n - 1; i++) parts.push(`${i},`);
    parts.push('"oops"', ']');
    const doc = parts.join('');
    const issues: StreamIssue[] = [];
    for (let i = 0; i < doc.length; i += 65536) issues.push(...validator.push(doc.slice(i, i + 65536)));
    issues.push(...validator.end());
    let offset = 1;
    for (let i = 0; i < n - 1; i++) offset += String(i).length + 1;
    expect(issues).toEqual([{ path: `#/${n - 1}`, message: 'expected integer', offset }]);
    expect(validator.stats.maxDepth).toBe(1);
  });
});

describe('duplicate keys', () => {
  it('reports duplicates by default and ignores them when allowed', () => {
    expect(run({}, '{"a":1,"a":2}')).toEqual([{ path: '#/a', message: 'duplicate key', offset: 7 }]);
    expect(run({}, '{"a":1,"a":2}', { duplicateKeys: 'allow' })).toEqual([]);
  });
});

describe('uniqueItems', () => {
  it('canonicalizes object key order', () => {
    expect(run({ uniqueItems: true }, '[{"a":1,"b":2},{"b":2,"a":1}]')).toEqual([
      { path: '#/1', message: 'duplicate array item', offset: 27 },
    ]);
  });

  it('verifies digest collisions against the canonical form', () => {
    const collide: StreamValidatorOptions = { hashFn: () => 0 };
    // Same digest, different canonical forms: no duplicate reported.
    expect(run({ uniqueItems: true }, '[[1,2],[2,1]]', collide)).toEqual([]);
    // A later item equal to the first is still caught despite the collision.
    expect(run({ uniqueItems: true }, '[[1,2],[2,1],[1,2]]', collide)).toEqual([
      { path: '#/2', message: 'duplicate array item', offset: 17 },
    ]);
  });

  it('caps retained digests at the configured budget and says so', () => {
    const validator = compileStream({ uniqueItems: true }, { uniqueBudget: 2 });
    const issues: StreamIssue[] = [];
    issues.push(...validator.push('[1,2,3'));
    expect(validator.stats.digestCount).toBe(2);
    issues.push(...validator.push(',4,2]'));
    issues.push(...validator.end());
    // Budget issue reported once; items whose digests were retained before
    // the budget ran out are still verified, so the trailing 2 is caught.
    expect(issues).toEqual([
      { path: '#/2', message: 'uniqueItems digest budget of 2 exceeded; uniqueness not fully verified', offset: 5 },
      { path: '#/4', message: 'duplicate array item', offset: 9 },
    ]);
    expect(validator.stats.digestCount).toBe(0); // array frame popped
  });
});

describe('chunk boundaries', () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      s: { type: 'string', maxLength: 10 },
      n: { type: 'number', maximum: 100 },
      arr: { type: 'array' },
    },
  };
  const doc = '{"s":"a long \\"quoted\\" string","n":12345.678e2,"arr":[true,null,"x"]}';

  it('produces identical results for any chunking', () => {
    const whole = run(schema, doc);
    expect(summary(whole)).toEqual([
      '#/n must be <= 100',
      '#/s length must be <= 10',
    ]);
    for (const size of [1, 2, 3, 7, 64]) {
      expect(run(schema, doc, undefined, size)).toEqual(whole);
    }
  });

  it('accepts Uint8Array chunks that split multibyte characters', () => {
    const bytes = new TextEncoder().encode('{"é":"x"}');
    const validator = compileStream({ properties: { 'é': { type: 'integer' } } });
    const issues: StreamIssue[] = [];
    for (let i = 0; i < bytes.length; i += 3) issues.push(...validator.push(bytes.slice(i, i + 3)));
    issues.push(...validator.end());
    expect(issues).toEqual([{ path: '#/é', message: 'expected integer', offset: 6 }]);
  });
});

describe('error collection modes', () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', maximum: 150 },
      tags: { type: 'array', items: { type: 'string', minLength: 2 }, uniqueItems: true },
    },
  };

  it('collects multiple errors across the document', () => {
    const issues = run(schema, '{"name":42,"age":200,"tags":["a","b","a"]}');
    expect(summary(issues)).toEqual([
      '#/age must be <= 150',
      '#/name expected string',
      '#/tags/0 length must be >= 2',
      '#/tags/1 length must be >= 2',
      '#/tags/2 duplicate array item',
      '#/tags/2 length must be >= 2',
    ]);
    for (const issue of issues) expect(issue.offset).toBeGreaterThanOrEqual(0);
  });

  it('stops at the first error in abort mode', () => {
    const validator = compileStream({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }, { mode: 'abort' });
    expect(validator.push('{"a":1,"b":2}')).toEqual([{ path: '#/a', message: 'expected string', offset: 5 }]);
    expect(validator.closed).toBe(true);
    expect(() => validator.push(' ')).toThrow(/closed|aborted/);
    expect(validator.end()).toEqual([]);
  });
});

describe('cancellation', () => {
  it('stops processing and rejects further input', () => {
    const validator = compileStream({ type: 'array', items: { type: 'integer' } });
    expect(validator.push('[1,"x",')).toEqual([{ path: '#/1', message: 'expected integer', offset: 3 }]);
    validator.cancel();
    expect(validator.cancelled).toBe(true);
    expect(() => validator.push('2]')).toThrow(/cancelled/);
    expect(validator.end()).toEqual([]);
  });
});

describe('malformed input', () => {
  it('rejects truncated documents at end()', () => {
    expect(() => run({}, '[1,')).toThrow(JsonParseError);
    expect(() => run({}, '')).toThrow(JsonParseError);
    expect(() => run({}, '"abc')).toThrow(JsonParseError);
  });

  it('rejects invalid tokens with their offset', () => {
    try {
      run({}, '{"a":01}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsonParseError);
      expect((error as JsonParseError).offset).toBe(6);
    }
    expect(() => run({}, '1 2')).toThrow(JsonParseError);
    expect(() => run({}, 'tru')).toThrow(JsonParseError);
  });
});

describe('consistency with the tree validator', () => {
  const cases: [Schema, unknown][] = [
    [{ type: 'string' }, 'ok'],
    [{ type: 'string' }, 3],
    [{ type: 'number', minimum: 2, maximum: 5 }, 10],
    [{ type: 'integer', multipleOf: 3 }, 7],
    [{ type: 'integer' }, 1.5],
    [{ type: 'string', minLength: 2, maxLength: 3 }, 'abcd'],
    [{ type: 'boolean' }, 0],
    [{ type: 'null' }, null],
    [{ exclusiveMinimum: 0, exclusiveMaximum: 10 }, 10],
    [{ multipleOf: 0.1 }, 0.3],
    [{ type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' } } }, { a: 'x' }],
    [{ type: 'object', required: ['a/b'] }, {}],
    [{ type: 'object', properties: { 'x/y': { type: 'string' } } }, { 'x/y': 5 }],
    [
      { type: 'object', properties: { nested: { type: 'object', required: ['z'], properties: { z: { type: 'array', items: { type: 'integer' } } } } } },
      { nested: { z: [1, 'two', 3] } },
    ],
    [{ type: 'array', minItems: 2, maxItems: 3, items: { type: 'number' } }, [1]],
    [{ type: 'array', minItems: 2, maxItems: 3, items: { type: 'number' } }, [1, 2, 3, 4]],
    [{ prefixItems: [{ type: 'string' }], items: { type: 'number' } }, ['a', 1, 'b']],
    [{ uniqueItems: true }, [1, 2, 1]],
    [{ uniqueItems: true, items: { type: 'array' } }, [[1], [2], [1]]],
    [{ uniqueItems: true }, [{ a: 1, b: [2] }, { b: [2], a: 1 }]],
    [{ type: 'array' }, { not: 'array' }],
    [{ type: 'object' }, [1, 2]],
  ];

  it('produces the same issues as validate() over the shared subset', () => {
    for (const [schema, value] of cases) {
      const streamed = run(schema, JSON.stringify(value));
      const classic = validate(schema, value);
      expect(summary(streamed), `schema=${JSON.stringify(schema)} doc=${JSON.stringify(value)}`).toEqual(summary(classic));
    }
  });
});
