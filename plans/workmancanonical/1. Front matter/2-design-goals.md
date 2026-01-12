# Design Goals (Non-Normative)

## Scope

Explains the intent and priorities of canonical Workman.

## Status

Draft (non-normative).

## Dependencies

None.

This document explains the intent behind canonical Workman. It is
**non-normative**: it helps interpret the language, but does not override
defined behavior in other sections.

---

## Core Goals

1. **One obvious way**
   - Canonical Workman intentionally avoids multiple spellings or redundant
     constructs.
   - Example: `if/else` exists only as sugar over `match` on booleans.

2. **Predictability over cleverness**
   - Deterministic evaluation order.
   - Explicit scoping and binding rules (especially in patterns).

3. **Strong static semantics**
   - HM-style inference is the default mental model.
   - Extensions (pattern matching, infection) are specified as language
     semantics, not as compiler “magic”.

4. **Rigorous pattern matching**
   - Exhaustiveness and coverage are first-class.
   - Match composition (bundles, commas) is designed to scale to large programs
     without hiding missing cases.

5. **Infection as a core feature**
   - Infection is a language-level mechanism for effect-like propagation
     through a general constraint solver.
   - It is not tied to any particular backend.

6. **Backend freedom without semantic drift**
   - Multiple backends are expected.
   - Canonical semantics aim to prevent “backend-specific behavior” from
     accidentally becoming language behavior, except where intentionally
     declared by an explicit backend contract.

---

## Non-Goals

- Making raw interop primitives part of the canonical surface language.
- Specifying low-level memory/resource semantics prematurely (large design area
  deferred unless required for correctness of other sections).
