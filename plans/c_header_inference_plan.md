# C Header Type Inference Plan

## Context

- Raw mode Workman can import C headers via Zig `@cImport`, but types remain
  opaque in Workman (`raylib.h` is a concrete example).
- Maintaining generated stub files is not desired.
- We want richer type info without baking Zig types into the Workman stdlib.

## Goals

1. Expose C type metadata to Workman tooling without manual stub generation.
2. Avoid modifying Workman core semantics for non-raw code.
3. Keep the integration optional and backend-specific (Zig only).
4. Preserve build determinism (no network, no hidden dependencies).

## Proposed Architecture (High Level)

### Direct Typechecker Hook (Primary)

- Add a "foreign type provider" interface to the typechecker.
- For `from "raylib.h" import { ... }`, invoke the Zig provider to fetch
  and inject types into the typing environment.
- Cache results keyed by header path + compiler flags.
 - Keep the integration backend-specific and optional (Zig raw mode only).

## Minimal Metadata Schema

- **Struct**: name + ordered fields (name + primitive type + optional pointer).
- **Enum**: name + tags.
- **Fn**: name + params + return type (primitive/ptr/optional/struct/enum).
- **Primitive mapping**: Zig `u8/u32/i32/bool` -> Workman `Int/Bool` or
  `std/zig/types` where appropriate for raw mode.

## Work Breakdown

1. **Typechecker hook**
   - Define the foreign type provider interface.
   - Wire `.h` imports to the Zig provider during analysis.
2. **Zig extractor**
   - Create a Zig helper that takes a header + symbol list and returns types
     directly to the typechecker (no sidecar files).
   - Support `struct`, `enum`, and `fn` to start.
3. **LSP integration**
   - Reuse the enriched typing environment for inlays + signature help.
4. **Caching**
   - Key by header path + include args + Zig version.
   - Store in a build cache directory.

## Open Questions

- How to pass include paths/defines from `build.wm` into the extractor?
- Should types be fetched per header or per module import list?
- What is the mapping strategy for pointers and slices in raw mode?

## Notes

- This plan avoids maintaining stub generators and sidecar metadata files.
- If type info is missing or extraction fails, raw mode should fall back to
  opaque types.
