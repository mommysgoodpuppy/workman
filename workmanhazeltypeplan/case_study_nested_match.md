# Case Study: The `composes nested bundle references` Test

This document provides a detailed analysis of the failing `composes nested bundle references` test case from `tests/match_tests.ts`. It serves as a concrete example of the limitations of the current type system and a benchmark for the proposed architectural evolution.

## 1. The Code

The test case defines a series of match bundles, composes them, and then uses them in a way that should specialize a generic type.

```workman
// Generic bundle, where the formatter function's argument is unconstrained.
// Inferred type is `forall T. Int -> (String, (Int, Bool), T -> String)`
let zero = match {
  0 => { ("zero", (0, true), (_) => { "zero" }) }
};

// Another bundle with the same structure.
let one = match {
  1 => { ("one", (1, false), (_) => { "one" }) }
};

// A fully generic bundle.
let other = match {
  value => { ("other", (value, false), (_) => { "other" }) }
};

// `grouped` composes `zero` and `one`.
let grouped = match {
  zero,
  one
};

// `describeNumber` composes `grouped` and `other`.
// Its type is not fully known at this point.
let describeNumber = match(n) {
  grouped,
  other
};

// `describeNumber` is applied, creating tuples.
let a = describeNumber(0);
let b = describeNumber(1);
let c = describeNumber(42);

// ... other matches to extract parts of the tuples ...

// The crucial line:
// `b` has a type like `(String, (Int, Bool), T -> String)`
// The `formatter` is extracted and called with an Int.
// This should constrain `T` to be `Int`.
let bFormatted = match(b) {
  (_, _, formatter) => { formatter(999) }
};
```

## 2. The Failure Analysis: Current System

The test fails with the error:
`AssertionError: Values are not equal. [Diff] Actual / Expected
-   Int -> (String, (Int, Bool), T -> String)
+   Int -> (String, (Int, Bool), Int -> String)`

This failure occurs on the assertion `assertEquals(zeroBinding.type, expectedBundleType)`. The test expects the type of the `zero` binding to have been retroactively specialized to use `Int`, but the type system correctly reports its original, generic type.

### Current Code Path and Problem

1.  **`inferProgram` (`src/infer.ts`)**: The main loop begins processing declarations sequentially.
2.  **`inferLetDeclaration` for `zero`**: The type of the `zero` bundle is inferred. The `(_) => ...` expression causes the formatter's argument to be a generic type variable, let's call it `'t2`.
3.  **`generalizeInContext` for `zero`**: The type `Int -> (String, (Int, Bool), 't2 -> String)` is generalized. Since `'t2` does not appear in the environment, it is quantified over. The type of `zero` is "frozen" as `forall T. Int -> (String, (Int, Bool), T -> String)` and stored in the environment.
4.  **Sequential Inference**: The inferencer proceeds to the next declarations (`one`, `other`, `grouped`, etc.), repeating this process.
5.  **`inferLetDeclaration` for `describeNumber`**: The type of `describeNumber` is inferred. Because its body contains references to other bundles and a free variable `n`, its type remains partially unknown: `Int -> (String, (Int, Bool), 't16 -> String)`, where `'t16` is a new, *non-quantified* (free) type variable.
6.  **`inferLetDeclaration` for `bFormatted`**: The type of `b` is looked up. It is an application of `describeNumber`, so it has the type `(String, (Int, Bool), 't16 -> String)`. The `match` expression extracts the third element, `formatter`, which has type `'t16 -> String`. The call `formatter(999)` correctly unifies `'t16` with `Int`.
7.  **The Disconnect**: This unification `{ 't16 => Int }` is added to the global substitution map. When the final summaries are calculated, this substitution is applied to the type of `describeNumber`, correctly specializing it. However, it is **not** applied to the already-generalized type of `zero`. The `T` in `zero`'s type is a quantified variable, not the free variable `'t16`, so the substitution `applySubstitutionScheme` correctly ignores it.

**The root cause is the eager generalization of `let` bindings in a sequential process.**

## 3. The Solution: New System Code Path

Under the new two-layer architecture, the process would be entirely different.

1.  **Layer 1: Marking Pass**: The bidirectional marker would traverse the entire program. In this specific test case, there are no local type errors, so the marking pass would complete without inserting any error marks. The output would be an unmarked AST, identical to the input.

2.  **Layer 2: Constraint Generation**: The new inference layer would traverse the AST to generate constraints for all unknown types. For simplicity, let's imagine all top-level bindings are initially unknown types.
    *   From `zero`: `'type_of_zero` must be `Int -> (String, (Int, Bool), 't_formatter_arg -> String)`
    *   From `describeNumber`: `'type_of_describeNumber` must be `'t_n -> 'type_of_body`
    *   From `bFormatted`: The third element of the type of `b` must be a function whose first argument is `Int`.
    *   ...and so on for all expressions.

3.  **Layer 2: Global Constraint Solving**: The unification engine would process this large set of constraints. Critically, no types are generalized yet. All the type variables (`'t_formatter_arg`, `'t_n`, etc.) are free.
    *   The engine would unify the type of `b` with the result of `describeNumber`.
    *   It would unify the result of `describeNumber` with the types from `grouped` and `other`.
    *   It would unify the types from `grouped` with `zero` and `one`.
    *   Crucially, the constraint from `bFormatted` (`formatter`'s argument must be `Int`) would propagate through this entire chain of relationships. The variable `'t_formatter_arg` that originated in `zero` would be unified with `Int`.

4.  **Final Generalization & Reporting**: After the solver finishes, the substitution map would contain `{ 't_formatter_arg => Int }`. Now, and only now, the system would compute the final types for reporting.
    *   **Type of `zero`**: The solver has determined its full type is `Int -> (String, (Int, Bool), Int -> String)`. There are no remaining free variables to generalize over. The assertion `assertEquals(zeroBinding.type, "Int -> (String, (Int, Bool), Int -> String)")` would **pass**.
    *   **Type of `other`**: The solver would find that the first type variable in `other` was also unified with `Int`, but the second (from the inner `_`) remains unconstrained. Its final type would be `Int -> (String, (Int, Bool), T -> String)`, and it would be generalized to `forall T. Int -> (String, (Int, Bool), T -> String)`. The test would need to be adjusted for this specific binding.

This new code path correctly implements the programmer's intuition by treating the entire scope as a single system of equations to be solved, leading to more powerful and accurate type inference.
