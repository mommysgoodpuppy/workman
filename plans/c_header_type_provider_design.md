# C Header Type Provider Design (Raw Mode)

## Summary

Add a Zig-backed foreign type provider that injects C header type metadata into
Workman's typechecker when using raw mode. The provider runs only for `.h`
imports and uses the project's `build.wm` to supply include paths/defines. If
extraction fails, the typechecker falls back to opaque/unknown types.

## Goals

- Make C interop ergonomic in Workman raw mode without full Zig types.
- Avoid stub generation or sidecar files.
- Keep integration optional and backend-specific (Zig raw mode only).
- Prefer build determinism and caching.

## Non-Goals

- Full Zig type system modeling in Workman.
- Parsing C headers directly in Workman.
- Changing semantics for non-raw modules.

## Design Overview

### Trigger

When a Workman module is marked `@raw` and imports a `.h` file, the module loader
asks the foreign type provider for type metadata. This replaces the current
behavior that seeds unknown types for foreign imports.

### Build Configuration Source

If a module imports a C header, `build.wm` is required so the compiler can read:

- Include paths used for `@cImport`.
- Defines/flags that affect `@cImport`.
- Optional system library hints (if needed later for tooling).

This keeps C interop aligned with the build settings the Zig backend already
uses.

## Integration Points

### Module Loader Hook

Location: `src/module_loader.ts`

- Current: `seedForeignImports(record, initialEnv)` for `.h` imports.
- New: `applyForeignTypes(record, initialEnv, initialAdtEnv, provider)` when
  `record.kind === "c_header"` and `program.mode === "raw"`.
- Fallback: if provider fails, keep the existing `unknownType` behavior.

### Provider Interface (Typechecker-Side)

```
type ForeignTypeRequest = {
  headerPath: string;
  specifiers: { imported: string; local: string }[];
  includeDirs: string[];
  defines: string[];
  rawMode: boolean;
};

type ForeignTypeResult = {
  values: Map<string, TypeScheme>;
  types: Map<string, TypeInfo>;
  diagnostics?: { message: string; detail?: string }[];
};
```

Notes:
- `values` include functions and constants.
- `types` include struct/enum/type aliases.
- Failures should not crash analysis; emit diagnostics and fall back.

### Zig Extractor (Backend-Side)

Add a small Zig tool that:

1. Runs `@cImport` with the include dirs + defines.
2. Uses `@typeInfo` to describe requested symbols.
3. Emits JSON in a minimal schema.

Invocation example (conceptual):
```
zig run tools/c_header_extract.zig -- \
  --header path/to/raylib.h \
  --symbol InitWindow \
  --symbol Color \
  --include path/to/include \
  --define PLATFORM_DESKTOP_GLFW
```

The Workman loader parses JSON and constructs `TypeScheme`/`TypeInfo`.

## Minimal Metadata Schema

- **Struct**
  - `name`
  - `fields`: ordered list of `{ name, type }`
  - `isOpaque`: boolean (true if fields are not available)
- **Enum**
  - `name`
  - `tags`: ordered list of `{ name, value? }`
  - `backing`: integer type (optional)
- **Fn**
  - `name`
  - `params`: ordered list of `{ name?, type }`
  - `return`: type

## Type Mapping (Workman Raw Mode)

- **Integer/float/bool** map to `std/zig/types.wm` names when possible:
  `i32`, `u32`, `f32`, `bool`, etc.
- **`void`** maps to `unit`.
- **Pointers** map to `Ptr<T>` (existing pointer type syntax).
- **Optionals** map to `Optional<T>`.
- **Structs**
  - Create nominal types in `adtEnv`.
  - Use `TypeInfo.alias = record` and `recordFields` for order.
  - Opaque structs produce a nominal type without alias.
- **Enums**
  - Initial approach: treat as `c_int` or chosen backing integer.
  - Optional future work: nominal enum wrapper type with value exports.

## Caching

Cache JSON results in a build cache directory keyed by:

```
{ header path + include dirs + defines + zig version + workman version }
```

Suggested location: `dist_zig/__wm_cache/c_headers/`.

## Diagnostics and Fallback

- If the extractor fails, emit a layer1 diagnostic:
  `foreign_type_import_failed` with the header path and error message.
- Continue with opaque/unknown types so compilation proceeds.

## Phased Implementation

1. Add provider interface and loader hook (raw mode only).
2. Implement Zig extractor that supports `struct`, `enum`, `fn`.
3. Implement mapping into Workman `TypeScheme` and `TypeInfo`.
4. Add caching and diagnostics.
5. Expand pointer/slice/optional coverage if needed by examples.

## Open Questions

- Should the build tool expose include paths/defines explicitly to the compiler
  CLI, or should the compiler read them from `build.wm` only?
- Should enums be nominal (type distinct from `c_int`) or treated as integers?
