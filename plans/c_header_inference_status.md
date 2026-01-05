# C Header Inference Status

## Done

- Module loader can call a foreign type provider for `.h` imports in raw mode,
  with safe fallback to unknown types.
- Provider scaffolding in `src/foreign_types/c_header_provider.ts`.
- Zig extractor template in `src/foreign_types/zig/c_header_extract.zig`.
- CLI and LSP compile paths pass `foreignTypes` so LSP benefits from C types.
- Basic type mapping for structs, functions, pointers, and primitives.
- Disk cache for extracted JSON under `dist_zig/__wm_cache/c_headers`.

## Pending

- Parse `build.wm` to capture include paths/defines for `@cImport`.
- Decide enum strategy (nominal vs `c_int`), and export enum tags as values.
- Handle more C shapes: function pointers, arrays vs slices, const/volatile.
- Improve diagnostics (e.g. surface extractor errors as layer1 diagnostics).
- Include Zig version and build flags in cache key.
- Wire provider into any remaining compile paths (if any were missed).

## Notes

- C type extraction requires `build.wm` to be present (source of include/define
  data once parsing is implemented).
- No Workman-side C header parsing is planned; Zig remains the source of truth.
