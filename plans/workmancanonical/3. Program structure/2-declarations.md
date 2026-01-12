# Declarations (Normative)

This section defines top-level and local declarations: `let`, `type`, `record`,
operators, and related forms.

---

## Value Bindings (`let`)

### Non-recursive

`let x = expr;` binds `x` to the value of `expr`.

### Mutable bindings

`let mut x = expr;` declares a mutable binding.

Normative:
- A mutable binding may be reassigned (see assignment semantics in
  `../5. Dynamic semantics/1-values-and-evaluation.md`).
- `mut` affects the binding itself, not the interior mutability of the bound
  value.

### Recursive

`let rec f = expr;` permits `f` to be referenced inside `expr`.

Normative restriction:
- Only `let rec` introduces recursive scope.

### Mutual recursion

`let rec f = ... and g = ...;` binds a mutually recursive group.

---

## Types and Data

### Algebraic data types

`type Option<T> = None | Some<T>;`

Normative:
- Types are nominal.
- Constructors are in the constructor namespace.

### Records

`record Point = { x: Int, y: Int };`

Normative:
- Records are nominal.
- Record construction uses `.{ ... }`.

---

## Operators (Surface)

Canonical Workman supports infix/prefix operators by treating operators as
ordinary value bindings (Grain-style).

Normative:
- Operators are values in the value namespace.
- An operator may be bound with a parenthesized operator identifier:
  `let (op) = expr;` where `op` is an operator token such as `+`, `*`, `++`,
  `&&`, etc.
- Infix and prefix uses resolve by name:
  - `a op b` elaborates to `(op)(a, b)`.
  - `op a` elaborates to `(op)(a)` for prefix operators.
- Operator precedence/associativity is defined in the grammar chapter.

Non-normative note (current implementations):
- Some implementations additionally support explicit operator alias
  declarations like `infixl <prec> <op> = <name>;` and `prefix <op> = <name>;`
  to register operators for parsing/typechecking. These forms are not part of
  canonical v1 unless specified in the grammar chapter.
