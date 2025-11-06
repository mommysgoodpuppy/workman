# Testing Plan (M1)

## Unit tests (golden)
- Node-by-node emission snippets: literals, tuple, constructor, match lowering
- Tail recursion loopify correctness (factorial)

## Integration tests
- For fixtures under `tests/` that do not import std:
  - Parse → Infer → Evaluate (interpreter) → value A
  - Parse → Infer → Compile to JS → dynamic import and run → value B
  - Assert A == B (for supported kinds)

## Smoke examples
- Exported function compiled to ESM and imported into a small Deno script; call and check output

## Non-goals now
- Source maps comparison
- FFI tests
- Module graph tests
