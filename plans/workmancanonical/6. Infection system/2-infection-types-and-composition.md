# Infection Types and Composition (Normative, Draft)

This section specifies the typing-level contract for infection.

It must eventually answer, precisely:
- what infected types look like in the type system
- how infection propagates through expressions
- how infection composes when multiple infected values interact
- how discharge via pattern matching affects types

This is a draft and is expected to evolve as the solver model is stabilized.

---

## Type-Level Model (Sketch)

Canonical Workman extends the type language with an infection layer.

At a high level:
- A value has a base type `T`.
- It may also carry an infection “annotation” that tracks domain metadata.

This manual does not commit to a concrete internal representation, but it must
be possible to describe:
- which domains affect a value
- the domain-specific state carried by those domains (if any)

---

## Carrier Types

Carrier types are infectious types with explicit constructors:

- `@value` constructors carry normal values.
- `@effect` constructors carry domain-defined effects.

Normative (carrier discharge):
- Pattern matching on a carrier is the mechanism to discharge infection.
- Discharge is only valid when the match covers the domain-defined “effect”
  cases according to the domain’s rules.

---

## Propagation Through Function Application

Normative (high-level):
- If a function expects an uninfected argument but receives an infected value,
  the infection propagates according to the domain’s rules.

This must be defined carefully so it is not “compiler magic”. The eventual spec
should provide rules or a pseudo-formal algorithm.

---

## Composition and Merging

When combining infected values (e.g., in arithmetic or tuple construction), the
result infection is domain-defined and must be deterministic.

Implementation-defined (must be documented):
- Any domain ordering/canonicalization rules if multiple domains appear.

---

## Relationship to HM Inference

Canonical Workman intends infection to fit HM-style inference. That implies:
- infection constraints must integrate with unification/generalization
- solutions must be stable and deterministic for the same program

This section will later include:
- what is generalized at `let` boundaries in the presence of infections
- how domain constraints appear in type schemes (if they do)

