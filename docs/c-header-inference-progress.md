# C Header Type Inference Progress

## Goal
Make raw-mode C header imports produce useful types (WinAPI) without hand-written stubs.

## Current Status
- WinAPI inference works using Zig's bundled mingw headers (windows-gnu target).
- `SYSTEM_INFO` resolves as a type value and can be passed to `allocStructUninit`.
- Common opaque pointers now infer as `Optional<Ptr<Null>>` instead of holes.

## What Changed
- Added c_header extractor target selection on Windows and defaulted it to `*-windows-gnu`.
- Added env overrides for extractor behavior:
  - `WM_C_HEADER_TARGET` (explicit target triple)
  - `WM_C_HEADER_USE_WINSDK=1` (switch to Windows SDK + MSVC headers)
  - `WM_C_HEADER_INCLUDE_DIRS` and `WM_C_HEADER_DEFINES` (semi-colon lists)
- Added mapping so typedef tags like `_SYSTEM_INFO` resolve to `SYSTEM_INFO`.
- Stopped encoding record fields as constructor type arguments to avoid `Ptr<SYSTEM_INFO<...>>` mismatches.
- Mapped `anyopaque` (including unknown `anyopaque`) to raw `Null` so pointer chains are clean.
- Exported extracted type names as values so `SYSTEM_INFO` can be passed as a type argument.
- Fixed rawmem polymorphism: type vars are lowercase (`Ptr<t>`), preventing constraint conflicts.

## Example Results
- `GetProcessHeap : Unit -> Optional<Ptr<Null>>`
- `allocStructUninit(SYSTEM_INFO) : Ptr<SYSTEM_INFO>`

## Files Touched
- `src/foreign_types/c_header_provider.ts`
- `src/foreign_types/zig/c_header_extract.zig` (unchanged, but used by extractor)
- `std/zig/rawmem.wm`
- `docs/design/raw-ffi-alloc.md`
- `examples/winapi/wm/main.wm`
- `examples/winapi/wm/build.wm`
- `examples/winapi/zig/main.zig`
- `examples/winapi/zig/build.zig`

## Open Questions
- Should `WM_C_HEADER_USE_WINSDK` default to on for non-WinAPI headers?
- Do we want a small, curated set of header compatibility shims to avoid SDK parsing issues?
