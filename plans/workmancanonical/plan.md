# Workman Canonical: Language Definition Plan

This folder defines **canonical Workman**: a base language and runtime model
that replaces "runtime mode zig Workman" with a principled, portable core.
Canonical Workman is *not* raw mode. It is a stable, restricted language with
explicit semantics and a clean boundary to the Zig runtime.

---

## Goals

- Define the canonical language surface (syntax + semantics) with minimal
  ambiguity and minimal "multiple ways to do the same thing".
- Use a rigorous pattern matching model (coverage/proofs) as a first-class
  language feature.
- Treat infection types as a *core* extension to the HM type system.
- Use a runtime model aligned with Zig (not WASM), including manual memory
  management and explicit resource protocols.
- Allow FFI only through typed wrappers with explicit ABI boundaries.

---

## Non-Goals

- Raw Workman semantics (ctypes/zig interop in the surface language).
- Backend-specific hacks encoded in the language definition.
- Optional syntactic sugar that duplicates existing constructs.

---

## Core Principles

1. **Single construct per concept**: no multiple spellings for the same meaning.
2. **Match-driven control flow**: `if/else` is pattern match sugar only.
3. **Totality-first**: prefer explicit exhaustiveness over runtime errors.
4. **Explicit effects**: infection types track carriers and capabilities.
5. **Portable core**: canonical semantics must be backend-agnostic.

---

## Language Surface (Canonical Syntax)

This is the *only* intended surface for canonical Workman.

- Expressions only (no statements). Sequencing is explicit and expression-valued.
- `if/else` is syntax sugar for a boolean match.
- Pattern matching is the primary branching construct.
- No implicit currying. No implicit returns.
- `match` must be total unless explicitly annotated otherwise (staged rollout).
- Records are nominal; record values use `. { ... }` syntax.

This aligns with current Workman constraints, but canonical Workman treats them
as language law, not backend conventions.

---

## Pattern Matching (Canonical Design)

Canonical Workman uses a **polarity-aware, coverage-proof** model.

Key requirements:
- Comma in match bundles represents a conjunction over inverse clauses.
- Bundles must not suppress coverage diagnostics.
- Coverage proofs are first-class metadata (match type carries coverage data).
- Guarded arms do not count toward coverage unless the guard is provable.

This follows `plans/coreirRefactor/match_refactor_plan.md` as the canonical
definition, not merely a refactor of today’s compiler.

---

## Infection System (Canonical Extension)

Infection is a **core language feature** (like pattern matching), not a target
policy. It extends HM inference with:

- carrier domains (`effect`, `async`, etc.)
- capability domains (`mem`, `raw` as a capability if needed)
- trait domains as constraints/evidence (if traits exist)

Canonical Workman definition must include:
- Type-level representation of infected values.
- Required normalization/canonicalization rules.
- Explicit discharge semantics via pattern matching.

See `plans/coreirRefactor/infection.md` for the type-level model.

---

## Canonical Typeset (Zig-aligned)

Canonical Workman types are **inspired by Grain**, but aligned with Zig
runtime needs:

- Primitive integer types are explicit (`I32`, `U32`, etc.).
- `Int` is a language-level integer with a defined mapping (policy).
- `Bool`, `Char`, `String` defined at language level.
- Nominal records and algebraic data types.

The type system must be able to infer when a value can be unboxed or lowered to
native Zig primitives, but the **language** remains target-agnostic.

---

## Manual Memory Management

Canonical Workman will eventually need a principled story for memory and
resources, but this is a deep design area and should not block the initial
canonical spec.

For now:
- The infection system remains a general (global/local) constraint solver that
  fits HM-style inference; it does **not** require explicit “state transition”
  typing rules.
- Canonical semantics should avoid exposing raw pointers/slices in the surface
  language unless/until FFI requires it.
- The current runtime mode’s memory behavior is acceptable as an initial
  baseline, with a later dedicated memory design doc.

---

## FFI Boundary

Canonical Workman may include FFI, but:

- All FFI uses **typed wrappers**.
- ABI types are explicit (`AbiType` tree).
- No direct raw pointer manipulation in the surface language.

Raw Workman remains the place for direct Zig interop.

---

## Module System and Exports

Canonical Workman modules:

- Distinguish value/type/constructor namespaces.
- Require explicit exports (no default export).
- Provide stable symbol identity for cross-module linking.

---

## Diagnostics and Tooling

Canonical Workman must define:

- Precise match coverage errors.
- Infection discharge errors with domain-specific explanations.
- Deterministic typing errors (stable variable ordering).

---

## Differences from Grain (Canonical Summary)

- Pattern matching uses coverage proofs and polarity-aware conjunctions.
- Infection system is built-in and domain-driven.
- Runtime model targets Zig (not WASM).
- Memory management is explicit and capability-tracked.
- FFI is allowed only via typed wrappers (raw interop is a separate mode).
- Syntax is more restrictive; fewer equivalent forms.

---

## Research Tasks (Canonical Definition)

1. **Formalize pattern matching semantics** as a language section.
2. **Specify infection typing rules** (syntax + inference rules).
3. **Define a canonical runtime model** (value representation, heap model).
4. **Specify FFI wrapper rules** + ABI types.
5. **Enumerate canonical primitive types** and how they relate to Zig.

---

## Deliverables in This Folder

The canonical definition is expressed as a **reference manual** split into
multiple markdown files under numbered folders:

- `plans/workmancanonical/1. Front matter`
- `plans/workmancanonical/2. Source text`
- `plans/workmancanonical/3. Program structure`
- `plans/workmancanonical/4. Static semantics`
- `plans/workmancanonical/5. Dynamic semantics`
- `plans/workmancanonical/6. Infection system`
- `plans/workmancanonical/7. Interop and backend contracts`
- `plans/workmancanonical/8. Standard library`
- `plans/workmancanonical/9. Appendices`

This plan file remains the entry point and stays intentionally high-level.
