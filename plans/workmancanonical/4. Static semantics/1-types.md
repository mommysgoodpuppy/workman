# Types (Normative)

## Scope

Defines the canonical type language and core type meanings.

## Status

Draft (normative where specified).

## Dependencies

- `../2. Source text/1-lexical-structure.md`

This section defines the type language of canonical Workman.

Canonical Workman is HM-based with extensions, but remains strongly typed and
predictable.

---

## Type Forms

The type language includes at least:

- Primitive types: `Number`, `Bool`, `Byte`, `String`, `Bytes`, `Void`
- Fixed-width integers: `Int8`, `Int16`, `Int32`, `Int64`, `Uint8`, `Uint16`,
  `Uint32`, `Uint64`
- Floating-point: `Float32`, `Float64`
- Function types: `(A, B, ...) => R`
- Tuples: `(A, B, ...)`
- Nominal records: `RecordName`
- Nominal algebraic data types: `TypeName<...>`
- Type variables (for polymorphism): `a`, `b`, ...

This manual intentionally does not guarantee representation/layout of any type
unless stated in the FFI/backends chapter.

---

## Number (Canonical Numeric Type)

`Number` is the canonical numeric type for most code. It is a *sum* of:
- integers
- floating-point numbers

Normative:
- Integer literals (no decimal point or exponent) have type `Number` and are
  integers.
- Floating literals (decimal point or exponent) have type `Number` and are
  floats.
- Arithmetic that involves at least one float yields a float.
- Division (`/`) on `Number` **always** produces a float.

Implementation-defined (must be documented):
- The integer range supported by `Number` (implementations must support at
  least signed 64-bit range).
- The floating-point precision of `Number` (recommended: IEEE-754 64-bit).

Normative error class:
- If an integer operation on `Number` exceeds the supported integer range, the
  program must raise a runtime error.

### Runtime representation and specialization

Normative:
- `Number` is a *semantic* sum type (int or float). The language definition
  does **not** require a specific runtime representation.
- A conforming implementation **may** specialize `Number` to a concrete
  numeric representation when type inference determines the value is
  unambiguously integer or float, as long as observable behavior is preserved.

Implementation-defined (must be documented):
- Whether `Number` is represented as a tagged union, NaN-boxed value, or
  specialized to a concrete numeric type in common cases.

---

## Void (Unit Type)

`Void` is the unit type. Its sole value is the literal `void`.

Normative:
- `void` has type `Void`.
- `Void` has exactly one value.

---

## Byte and String (v1 Minimal Semantics)

Canonical Workman v1 uses the simplest useful model:

- `Byte` is an 8-bit value in the range `0..255`.
- `String` is a sequence of `Byte` values (a byte string).
- String length is the number of bytes.
- String indexing yields a `Byte`.

This model is sufficient for AoC-style problems and self-hosting, and avoids
committing to Unicode semantics in v1. Future versions may extend this model in
a backward-compatible way.

---

## Nominality

- Record types are nominal.
- ADT types are nominal.
- Type equality is nominal for named types, except where the language defines
  aliasing (if alias types exist).

---

## Polymorphism

Canonical Workman supports parametric polymorphism (`forall` / HM schemes).

The precise generalization/instantiation rules are specified in
`plans/workmancanonical/4. Static semantics/2-type-inference.md`.
