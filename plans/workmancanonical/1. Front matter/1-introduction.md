# Introduction (Normative)

## Scope

Defines how to read the canonical Workman manual, conformance language, and
what counts as observable behavior.

## Status

Draft (normative where specified).

## Dependencies

None.

This document is part of the **Canonical Workman Reference Manual**.

Canonical Workman is the base language definition for Workman: it specifies
what programs **mean**. Tooling and compilers may differ internally, but
conforming implementations must agree on the observable behavior described
here.

This manual is intended to be:
- Tight where it matters (so different implementations behave the same).
- Loose where evolution is desirable (so tooling can improve without “spec
  breaks”).

References for current user-facing behavior (non-normative):
- `workmansyntaxguide.md` (syntax constraints and idioms)
- `workmaninfectionguide.md` (infection model for users)

---

## Conformance Language

The keywords **must**, **must not**, **should**, and **may** are used as
follows:

- **must / must not**: required / forbidden for conforming implementations.
- **should**: recommended, but non-conformance is permitted.
- **may**: optional or implementation choice.

---

## Defined vs Implementation-Defined vs Unspecified vs Undefined

This manual uses these terms:

- **Defined behavior**: the manual specifies the outcome. Conforming
  implementations must behave the same (modulo allowed implementation-defined
  choices).
- **Implementation-defined behavior**: the implementation chooses a behavior,
  but must document the choice (e.g., maximum recursion depth).
- **Unspecified behavior**: the implementation may choose, and it may vary
  between runs; programs must not rely on it.
- **Undefined behavior (UB)**: the program is invalid; no guarantees are made.
  Canonical Workman aims to avoid UB except at explicit unsafe/FFI boundaries.

---

## What Counts as Observable Behavior

Unless otherwise stated, the observable behavior of a program is:

- Text output and other explicit I/O effects produced by standard library APIs.
- Program termination (normal completion vs failure).
- Raised runtime errors (if any) that escape into the host environment.

The following are **not** observable behavior and may vary:

- Performance, timing, allocation counts.
- Concrete in-memory layouts (unless explicitly guaranteed by an FFI contract).
- Exact wording of diagnostic messages (but error *classes* should be stable).

---

## Execution Model (High-Level)

Canonical Workman is:

- **Expression-oriented**: most constructs produce values; control flow
  constructs are expressions.
- **Strict (eager)**: expressions evaluate their subexpressions before use.
- **Deterministic evaluation order**: unless explicitly stated as
  implementation-defined, evaluation order is fixed by this manual.

Detailed evaluation rules live in:
- `../5. Dynamic semantics/1-values-and-evaluation.md`

---

## Program Model (High-Level)

- A program is a set of modules; module structure and name resolution are
  specified in `../3. Program structure/1-modules-and-names.md`.
- Top-level execution is restricted (no arbitrary top-level effects); the
  entrypoint is defined by the host/tooling contract.

---

## Status of the Manual

This manual is normative for canonical Workman, but sections may be incomplete.
Incomplete sections must say what is **defined now** vs what is **reserved for
future definition**.
