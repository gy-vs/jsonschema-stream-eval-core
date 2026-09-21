# JSON Schema core

TypeScript library for schema validation, with a whole-value (tree) validator
and a streaming validator for JSON token streams.

Run `npm install`, then `npm test` and `npm run build`.

## Tree validator

```ts
import { validate } from 'jsonschema-stream-eval-core';

const issues = validate(schema, JSON.parse(text)); // Issue[] = { path, message }
```

## Streaming validator

`validateStream` / `createStreamValidator` validate a JSON document fed in as
text chunks, without materializing the whole value. Peak memory is
O(nesting depth + uniqueItems budget), independent of array length, so huge
arrays and deep documents stream in bounded space.

```ts
import { compileStream, createStreamValidator, validateStream } from 'jsonschema-stream-eval-core';

// One-shot (throws StreamCompileError for non-streamable schemas):
const issues = validateStream(schema, chunks);

// Incremental:
const compiled = compileStream(schema);
if (!compiled.ok) throw new Error(compiled.issues.map(i => i.message).join('\n'));
const v = createStreamValidator(compiled.program, { stopOnFirstError: true });
for (const chunk of chunks) v.push(chunk);
const issues2 = v.end();
```

### Streamable subset

Exactly these keywords are compiled to stack-based states; anything else is
reported at compile time (never silently ignored):

- `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`)
- objects: `required`, `properties`
- arrays: `items`, `prefixItems`, `uniqueItems`
- numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- strings: `minLength`, `maxLength`, `pattern`

`compileStream(schema)` returns `{ ok: false, issues }` listing every
unsupported keyword (e.g. `contains`, `minItems`, `enum`, `allOf`) with its
schema path, plus invalid keyword values (bad regex, negative `minLength`, …).

### Issues

Each streaming issue carries:

- `path` — JSON Pointer (RFC 6901, `#`-prefixed, e.g. `#/items/3/name`)
- `offset` — UTF-8 byte offset of the token that triggered it
- `code` — `type`, `required`, `minimum`, …, `uniqueItems`, `duplicateKey`,
  `limit` (validator limit diagnostics), `syntax` (malformed JSON, fatal)

### Options

- `stopOnFirstError` (default `false`) — halt on the first validation issue;
  otherwise collect all issues.
- `duplicateKeys` (`'error'` | `'ignore'`, default `'error'`) — repeated
  object keys are flagged at the second occurrence; every occurrence is still
  validated against `properties`.
- `uniqueItemsBudget` (default `1024`) — max elements tracked per
  `uniqueItems` array. Overflow evicts oldest-first and emits one `limit`
  issue per array (reported, not silent).
- `uniqueSampleBytes` (default `256`) — canonical bytes retained per element
  for exact collision verification; larger elements compare by digest only.
- `digestFn` — custom digest for `uniqueItems` bucketing (default cyrb53).
- `signal` — `AbortSignal`; `v.cancel()` also works. After cancellation,
  pushes are ignored and `end()` returns what was collected.

### uniqueItems

Elements are canonicalized incrementally (sorted object keys, normalized
numbers, so `1` ≡ `1.0` and `{"a":1,"b":2}` ≡ `{"b":2,"a":1}`), bucketed by
digest, and digest collisions are verified exactly against retained samples.

### Consistency

For schemas in the streamable subset (within the uniqueItems budget, and for
documents without duplicate keys), streaming issues match the tree
validator's `{path, message}` pairs as a set; ordering may differ since the
stream reports in document order.
