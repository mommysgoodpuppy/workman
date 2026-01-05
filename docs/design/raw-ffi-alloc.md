# Raw Mode FFI Allocation and Implicit Deref

## Goal
Make raw-mode FFI explicit and ergonomic: allocate memory intentionally, pass typed pointers to C/Zig APIs, and access fields with implicit deref (no `.*`).

This mirrors Zig's `var T = undefined; &T` pattern, but is more explicit: allocation is a deliberate call, not implicit stack storage.

## Summary
- `allocStruct(T)` allocates memory for `T` (zeroed/null by default) and returns a typed pointer.
- Field access on `Ptr<T>` implicitly dereferences in raw mode.
- FFI calls use typed pointers directly.
- Zero-init vs uninit is explicit: `allocStruct` defaults to zeroed/null, `allocStructUninit` is available for perf.
- `allocStructInit(T, value)` writes `value` then returns the pointer (for "write then pass pointer" cases).

## API Sketch

### Types
- `Ptr<T>`: typed pointer (raw mode).
- (Optional) `Ref<T>`: alias of `Ptr<T>` for readability.

### Functions
- `allocStruct(T) -> Ptr<T>`  
  Allocates `@sizeOf(T)` bytes, zero-initialized (null/default).
- `allocStructInit(T, value: T) -> Ptr<T>`  
  Allocates `@sizeOf(T)` bytes, writes `value`, returns `Ptr<T>`.
- `allocStructUninit(T) -> Ptr<T>`  
  Allocates `@sizeOf(T)` bytes, uninitialized.
- `free(ptr: Ptr<T>) -> Unit`  
  Frees memory allocated by `allocStruct*`.

## Example (Workman raw mode)

```wm
@raw;
from "windows.h" import { "GetSystemInfo" as getSystemInfo, SYSTEM_INFO };
from "std/zig/rawmem" import { allocStruct, free };

let main = () => {
  let sys_info = allocStruct(SYSTEM_INFO);
  getSystemInfo(sys_info);
  print(sys_info.dwNumberOfProcessors); -- implicit deref on field access
  free(sys_info);
};
```

## Semantics
- `allocStruct(T)` returns `Ptr<T>`.
- `allocStructInit(T, value)` returns `Ptr<T>` after writing `value` into the allocation.
- In raw mode, `ptr.field` is treated as `(*ptr).field` when `ptr` is `Ptr<RecordLike>`.
- `&` continues to take the address of locals, yielding `Ptr<T>`.
- Pointer types are preserved through inference and shown in diagnostics.

## Design Rationale
- **Explicit allocation**: avoids "mystery memory" like `undefined` in Zig; you can see the allocation.
- **Typed pointers**: closer to Zig/C and safer than untyped pointers.
- **Implicit deref**: keeps code clean and matches modern expectations.
- **Write-then-pass**: `allocStructInit` mirrors common FFI patterns.

## Open Questions
- Should buffers use a different API than structs (e.g. `allocBuffer`/`allocArray`)?
- Should `free` be required for stack-allocated locals (answer: no)?
