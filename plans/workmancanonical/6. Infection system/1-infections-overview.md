# Infection System Overview (Normative)

This section defines what infection is, at the language level.

Canonical Workman’s infection system is a core extension to HM typing. It
tracks and propagates domain-specific information (carriers/effects and other
constraints) through ordinary expressions without requiring explicit monadic
syntax.

User-facing motivation and examples are described in `workmaninfectionguide.md`.
This manual defines the contract that conforming implementations must follow.

---

## Conceptual Summary

- An “infected value” carries a normal payload value plus domain-defined
  metadata.
- When an infected value is used, the infection propagates according to the
  domain’s rules.
- Discharging infection happens via pattern matching on the carrier (for
  carrier-like domains).

Normative boundary:
- Infection semantics are part of the language, not a backend policy.

---

## What Infection Is Not

- It is not “capability tracking like Rust” by default.
- It is not defined in terms of explicit state transition types.
- It is not a mere codegen convenience; it affects typing and program meaning.

---

## Domains

Infections are organized into **domains** (e.g. `effect`, `async`, others).

Each domain defines:
- how infections compose/merge
- how function application propagates infection
- what it means to discharge infection (if discharge exists)

The formal domain model is specified in:
- `plans/workmancanonical/6. Infection system/2-infection-types-and-composition.md`

