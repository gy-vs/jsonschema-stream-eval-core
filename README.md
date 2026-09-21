# JSON Schema core

TypeScript library for schema validation.

Run `npm install`, then `npm test` and `npm run build`.

## Tree validation

`validate(schema, value)` validates a parsed value and returns `{path, message}` issues.

## Streaming validation

`compileStream(schema, options?)` compiles a schema into a stack-based validator
that consumes a JSON token stream chunk by chunk — it never builds the full
document value, so peak memory depends on container nesting depth and the
`uniqueItems` digest budget, not on document size.

```ts
import { compileStream } from 'jsonschema-stream-eval-core';

const validator = compileStream(schema, { mode: 'collect' });
for (const chunk of chunks) {
  const issues = validator.push(chunk); // string | Uint8Array
}
validator.end(); // throws JsonParseError on truncated input
```

Issues carry a JSON Pointer (`path`, `#`-prefixed) and the UTF-8 byte `offset`
of the triggering token.

### Streamable subset

Supported keywords: `type`, `required`, `properties`, `items`, `prefixItems`,
`uniqueItems`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
`multipleOf`, `minLength`, `maxLength`, `minItems`, `maxItems` (plus inert
annotations like `title`). Any other keyword throws a `CompileError` at
`compileStream` time listing every unsupported keyword and its schema pointer —
there is no silent degradation. Over this subset, streaming results match
`validate()` exactly.

### Options

- `mode`: `'collect'` (default) gathers all issues; `'abort'` stops at the first one.
- `duplicateKeys`: `'error'` (default) reports duplicate object keys; `'allow'` ignores them.
- `uniqueBudget`: maximum number of item digests retained per `uniqueItems`
  array (default 4096). Digests are FNV-1a by default (`hashFn` to override);
  digest collisions are verified against the canonical form, and exceeding the
  budget is reported as an issue rather than silently passing.
- `cancel()`: aborts processing; further `push()` calls throw.

`validator.stats` exposes `maxDepth` and live `digestCount`, the two memory drivers.
