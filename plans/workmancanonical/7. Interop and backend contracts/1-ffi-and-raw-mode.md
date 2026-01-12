# FFI and Raw Mode (Normative Boundary)

Canonical Workman may support FFI, but canonical semantics must clearly
separate:

- safe, portable language meaning
- explicit unsafe/interop boundaries

---

## Canonical FFI (Wrappers)

Normative direction:

- Canonical Workman does not expose backend-native primitives directly (e.g.,
  Zig pointers) as ordinary language constructs.
- FFI is expressed via typed wrapper modules that:
  - declare ABI-safe types explicitly
  - isolate unsafe behavior behind a small API

What counts as ABI-safe must be specified before this section is complete.

---

## Raw Mode (Non-Canonical, Future Work)

Raw Workman is a proposed future extension intended for direct interop with the
target language (e.g., Zig), including:

- native types
- raw calling conventions
- target-specific constructs

Raw mode is **not** part of canonical Workman v1. Any mention of directives such
as `@raw;`, `@backend("zig");`, or block-scoped backend targets is aspirational
and provided only to guide future design. The canonical specification does not
define their syntax, semantics, or safety guarantees.

Non-normative note (current implementation reality):
- Some Workman implementations expose additional expression forms in *raw Zig*
  mode for interop/ergonomics. These are **not canonical v1** and must not be
  relied on by portable code. Examples include:
  - index expressions `target[index]` over raw pointer/slice-like values
  - the `value :> target[index]` write sugar (elaborating to
    `write(target, index, value)` under the host/toolchain's `write` binding)

Future work must supply:

- A dedicated grammar supplement describing backend directives.
- A normative account of the safety/infection boundary for raw code.
- Examples and conformance tests showing how mixed canonical/raw modules
  operate.
