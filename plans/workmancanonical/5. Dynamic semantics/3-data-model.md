# Data Model (Normative)

This section defines the semantic meaning of tuples, records, and ADTs.

---

## Tuples

Normative:
- Tuples are ordered, fixed-size product values.
- Tuples are first-class values (SML-style): a tuple value behaves the same
  regardless of whether it was constructed inline or obtained from a binding.
- Function application is not curried by default. Multi-argument functions are
  functions over tupled arguments (SML-style).
- Tuple equality (if defined) is structural element-wise equality.

If equality is not defined for all values, the manual must specify where it is
defined and where it is rejected (typed error vs runtime error).

---

## Records

Normative:
- Records are nominal types.
- Record values are mappings from field names to values for a particular record
  type.

Implementation-defined / not guaranteed:
- Any in-memory layout or field ordering, unless specified by an FFI contract.

---

## Algebraic Data Types

Normative:
- ADT values are tagged unions identified by their constructor.
- Constructor arguments preserve order.

---

## Equality and Ordering (Reserved)

Canonical Workman has not yet fully specified:
- total equality across all values
- ordering comparisons beyond numeric primitives

Until specified, libraries that expose equality/order must define their own
typing contracts (or be treated as non-canonical extensions).
