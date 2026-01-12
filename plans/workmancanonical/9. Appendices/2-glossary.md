# Glossary

Terms used throughout the canonical Workman manual.

- **ADT**: Algebraic Data Type; a nominal sum type with constructors.
- **Arm**: A single `match` clause: `pattern (when guard)? => { body }`.
- **Carrier**: An infectious type with `@value` and `@effect` constructors.
- **Canonical Workman**: The base language defined by this manual.
- **Conformance**: An implementation property meaning it obeys all “must”
  requirements of the manual.
- **Domain**: A named infection domain defining propagation and merge rules.
- **Elaboration**: Compiler transformation that makes implicit semantics
  explicit while preserving meaning.
- **Infection**: The language’s typed propagation mechanism (effect-like),
  described in the infection chapters.
- **Pinned pattern**: A pattern identifier that matches an existing value.
- **Var pattern**: `Var(x)` which introduces a new binding.

