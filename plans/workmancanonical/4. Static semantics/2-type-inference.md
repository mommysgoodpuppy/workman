# Type Inference (Normative)

This section defines canonical Workman typing:

- HM-style inference
- generalization boundaries
- interaction with annotations
- extensions required by pattern matching and infection

---

## Typing Judgements (Sketch)

This manual uses a conventional judgement style:

- `Γ ⊢ e : τ` meaning “under environment Γ, expression e has type τ”.
- `Γ` contains value bindings, type constructor bindings, and constructor
  bindings, each in their respective namespaces.

This section will be expanded with formal rules over time.

---

## Generalization and Instantiation

Canonical Workman is based on let-polymorphism.

Normative:
- `let` bindings are generalized (unless restricted by a specified value
  restriction rule).
- Lambda parameters are not generalized at the parameter boundary.

Open design decision (must be resolved):
- Whether canonical Workman adopts a value restriction. If adopted, the manual
  must define what counts as a “generalizable value”.

---

## Annotations

Annotations may appear:
- on bindings: `let x: T = expr;`
- on parameters: `(x: T) => { ... }`
- as local assertions: `expr as T` (if supported)

Normative:
- An annotation constrains inference. If the inferred type does not unify with
  the annotation, the program is ill-typed.

---

## Pattern Matching Typing

Pattern typing:
- Patterns introduce bindings into the environment.
- The scrutinee type constrains the pattern shapes.
- All arms must unify to a common result type (subject to infection rules).

Exhaustiveness and coverage are specified in:
- `plans/workmancanonical/5. Dynamic semantics/2-control-flow-and-pattern-matching.md`
- `plans/workmancanonical/9. Appendices/1-formal-core.md` (when formalized)

---

## Infection Integration (Forward Reference)

Infection extends typing and inference.

This chapter defines only the integration points:
- infected values participate in unification via domain-specific constraints
- discharge occurs via pattern matching rules

Full infection typing rules are in:
- `plans/workmancanonical/6. Infection system/2-infection-types-and-composition.md`

