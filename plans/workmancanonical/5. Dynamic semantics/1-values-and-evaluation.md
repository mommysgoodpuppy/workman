# Values and Evaluation (Normative)

## Scope

Defines evaluation order, strictness, and runtime error categories.

## Status

Draft (normative where specified).

## Dependencies

- `../4. Static semantics/1-types.md`

This section defines what expressions evaluate to, and in what order.

---

## Values

Canonical Workman values include at least:
- integers, booleans, characters, strings, `Void`
- tuples
- records
- constructors/ADT values
- functions (closures)

The *representation* of values is not part of canonical semantics unless stated
in an explicit backend/FFI contract.

Normative:
- Values are immutable by default.
- Functions are closures that capture the lexical environment.

---

## Evaluation Strategy

Normative:
- Evaluation is **strict**.
- Function application evaluates the callee expression and each argument before
  performing the call.

### Pipe operator `:>` (Elaboration)

Normative:
- The pipe operator `:>` is surface syntax that elaborates to function
  application as specified in the grammar chapter (`../2. Source text/2-grammar.md`).
- After elaboration, evaluation order is the normal left-to-right evaluation
  order for function application.
  - In particular, `e1 :> f(x)` elaborates to `f(e1, x)`, so `e1` is evaluated
    before `x`.

### Sequencing and `let`

Normative:
- A non-recursive `let` evaluates its right-hand side before evaluating the
  body.
- A sequence of non-recursive bindings evaluates left-to-right in source order.
- A `let rec` group introduces bindings that are mutually visible within the
  group.
- Each `let` introduces a new scope. If a binding name matches an existing
  binding in the current scope, the new binding **shadows** the old one for the
  remainder of its scope.

Implementation-defined (must be documented):
- The evaluation strategy for recursive value bindings whose right-hand side is
  not a function. (Canonical Workman may restrict or reject such cases later.)

### Mutable bindings and assignment

Normative (v1):
- A `mut` binding creates a mutable variable whose value may be reassigned.
- Assignment uses the form `x = expr;` and is an expression that evaluates to
  `Void`.
- The right-hand side of an assignment is evaluated before updating `x`.
- Assigning to a non-`mut` binding is a type error.
- Canonical Workman does **not** define interior mutability (e.g., `x.field = y`
  is not part of canonical v1).

### Evaluation order

Normative:
- Evaluation order is **left-to-right** for:
  - function arguments
  - tuple elements
  - record field expressions (in source order)
  - record spread expressions (in source order)
  - match scrutinee (before selecting an arm)

If an implementation cannot preserve this order for optimization reasons, it
must not claim conformance to canonical Workman.

---

## Runtime Errors

Canonical Workman prefers typed errors via infection carriers, but some runtime
errors may exist (e.g., explicit `Panic`).

Normative:
- `Panic("msg")` aborts evaluation with an unrecoverable error.
- Unless specified, other runtime errors are reserved.
- If a non-exhaustive match is permitted by the implementation (e.g., via a
  partial-match feature), reaching an uncovered case must raise a runtime error.

Normative runtime error classes (v1 minimal set):
- integer overflow for `Number` integer operations outside the supported range
- non-exhaustive match (if allowed by the checker)

Implementation-defined:
- The exact host-visible form of a panic (exit code, stack trace, etc.), but
  implementations should provide location data when available.

---

## Non-Normative Notes (Current Implementations)

These notes are for guidance only and do **not** define canonical behavior.

- The Zig runtime currently uses a boxed `Value` union for all values
  (`Int`, `Bool`, `String`, `Tuple`, `Record`, `Data`, `Func`).
- The JS runtime currently represents numbers, strings, and booleans as native
  JS values, and uses objects for ADT values; non-exhaustive matches throw an
  error with metadata.
