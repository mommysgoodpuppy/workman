# Backend Contract: Zig Runtime Mode (Normative, Minimal)

Canonical Workman is backend-agnostic, but the *primary* implementation target
is a Zig runtime-mode backend. This section defines what a Zig backend must
preserve, without constraining internal implementation strategy.

---

## Required Semantic Preservation

A Zig runtime backend must preserve:

- The evaluation order specified in `plans/workmancanonical/5. Dynamic semantics/1-values-and-evaluation.md`.
- The match semantics specified in `plans/workmancanonical/5. Dynamic semantics/2-control-flow-and-pattern-matching.md`.
- The typing and infection semantics specified in the static semantics and
  infection chapters.

---

## Runtime Errors and Panic

Normative:
- `Panic(msg)` must abort execution with an unrecoverable failure.

Implementation-defined (must be documented):
- how panics are surfaced (exit code, stack trace)
- whether location info is included

---

## Representation and Layout

Canonical Workman does not, by default, guarantee:
- record layout
- ADT layout
- pointer stability

If the Zig backend exposes FFI surfaces, it must do so through the FFI wrapper
rules in `plans/workmancanonical/7. Interop and backend contracts/1-ffi-and-raw-mode.md`.

