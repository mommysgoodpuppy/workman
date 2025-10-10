# ADT HM Follow-up Notes (2025-10-10)

## Findings
- **Undeclared constructor type variables**: `convertTypeExpr()` invents fresh variables for unknown names when building ADT constructors, so definitions such as `type Foo<T> = Bar<U>;` silently introduce `U`.
- **Type constructor arity unchecked**: Annotations like `Option<Int, Bool>` bypass arity validation, allowing ill-formed schemes to enter inference.
- **Unknown ADT names in annotations**: Uppercase identifiers with zero arguments default to fresh type variables instead of rejecting typos (e.g. `Colour`).
- **Exhaustiveness gaps for primitive scrutinees**: `ensureExhaustive()` only validates ADT constructors; matches over `Bool` or other finite domains can omit cases without error.

## Fix Plan
- Update `convertTypeExpr()` to distinguish contexts so ADT constructors require declared parameters while annotations may introduce fresh polymorphic variables.
- Enforce type constructor arity and existence checks (including zero-argument ADTs) before constructing `Type.constructor` nodes.
- Fail fast on unknown ADT references in annotations instead of synthesising new type variables.
- Extend `ensureExhaustive()` (and supporting pattern metadata) to cover boolean literals, issuing `InferError` when `true`/`false` cases are missing.

## Test Additions
- Negative ADT-definition test detecting undeclared type variables in constructor signatures.
- Negative annotation tests for constructor arity mismatch and unknown ADT names.
- Non-exhaustive `Bool` match rejection test.
- Create `tests/edge_cases_test.ts` to house the above and future regressions that do not fit existing suites.
