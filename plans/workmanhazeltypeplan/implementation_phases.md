# Implementation Phases for Type System Evolution

This document breaks down the implementation of the new Workman type system into a series of high-level, sequential phases. Each phase is a major undertaking that should result in a testable, verifiable state.

## Phase 0: Preparation and AST Modification

Before we can implement the new logic, we must prepare the foundational data structures.

1.  **AST Node IDs:** Every expression node in the AST will need a unique identifier. This is crucial for Layer 2 to trace constraints back to their syntactic origin. This should be a simple numeric or string ID added during parsing.

2.  **New "Marked" AST:** Define a new set of data structures for the Marked AST. This will largely mirror the existing AST (`src/ast.ts`), but with the addition of new node types for error marks, as described in the Hazel paper (e.g., `InconsistentTypes`, `FreeVariable`, `ApplicationOfNonFunction`).
    -   `MExp` in the paper corresponds to this new AST.
    -   These new nodes will contain the original, erroneous expression(s) as children.

3.  **Unknown Type with Provenance:** Modify the `Type` definition in `src/types.ts`. The current `TypeVar` is not sufficient. We need a distinct `Unknown` type that carries a **provenance** record. The provenance tracks the origin of the unknown type (e.g., "from expression hole #123", "from a `?` type annotation", "from the result of a free variable error").

## Phase 1: Implementing Layer 1 (The Marking System)

This phase focuses on refactoring the existing type checker into a total marking system. The goal at the end of this phase is that `inferProgram` **never throws a type error**. Instead, it always returns a fully-marked AST.

1.  **Refactor `infer.ts` and `infermatch.ts`:** Go through every function (`inferExpr`, `inferLetDeclaration`, `unify`, etc.).
2.  **Identify Failure Points:** Locate every `throw inferError(...)` call that relates to a type mismatch, unbound variable, etc.
3.  **Replace Failures with Marking:** For each failure point, change the logic:
    -   Instead of throwing, create one of the new `Mark` nodes from the Marked AST.
    -   The type of this new `Mark` node will be the new `Unknown` type (`?`).
    -   The `Unknown` type's provenance should be set to indicate the reason for the error (e.g., `Provenance.InconsistentBranches`).
    -   Allow the function to return successfully with this marked, unknown-typed expression.
4.  **Update `inferProgram`:** The top-level function will now return a `{ markedAST: MExp, ... }` structure instead of throwing. All existing tests will need to be updated or temporarily disabled, as the return type of the core function will have changed.

**Verification for Phase 1:** Create a new suite of tests that feed the type system various kinds of invalid code. The tests will not check for specific types, but will assert that `inferProgram` successfully returns and that the resulting `markedAST` contains the expected error mark nodes at the correct locations.

## Phase 2: Implementing Layer 2 (Constraint Generation & Solving)

With a total marking system in place, we can now build the global inference engine on top of it.

1.  **Constraint Data Structure:** Define a data structure for constraints, which is simply a pair of types that must be unified (e.g., `type Constraint = { typeA: Type, typeB: Type }`).

2.  **Modify Layer 1 for Constraint Generation:** Augment the entire marking system from Phase 1. Every typing and marking function will now, in addition to its primary job, return a `Set<Constraint>`.
    -   For example, in `inferExpr` for a function call `f(x)`, you would generate a constraint that the type of `f` must be consistent with `type of x -> fresh_var`.
    -   In `unify`, when unifying two types, you simply generate a constraint `{ typeA, typeB }` and return it. The actual unification is deferred.

3.  **Implement the Constraint Solver:** Create a new module, `src/solver.ts`. This module will contain the unification algorithm (e.g., a standard union-find algorithm as described in the Hazel paper).
    -   The input will be a `Set<Constraint>`.
    -   The output will be a `Substitution` map (from type variable/unknown IDs to concrete types).

4.  **Integrate into `inferProgram`:** The new `inferProgram` flow will be:
    a.  Call the Layer 1 marking system to get a `markedAST` and a `Set<Constraint>`.
    b.  Pass the constraint set to the new `solver` to get a final `Substitution`.
    c.  Apply the final substitution to the `markedAST` to produce the final, fully-typed tree for consumers like IDEs.

**Verification for Phase 2:** The `composes nested bundle references` test becomes the primary benchmark. With this phase complete, that test should now pass without any modifications to the test itself.

## Phase 3: Handling Unfillable Holes and User Interaction

This phase completes the vision by handling cases where the global constraints are contradictory.

1.  **Modify the Solver:** The solver from Phase 2 needs to be enhanced. When it detects an inconsistency (e.g., trying to unify `Int` and `String`), it should not throw an error. Instead, it should:
    -   Record the conflict.
    -   Trace the provenances of the conflicting types back to their source holes.
    -   Mark the source `TypeHole` or `ExpressionHole` as "unfillable."

2.  **Partial Solutions:** The solver should also be able to generate *partially consistent* substitutions. For a conflict between `Int` and `String`, it would generate two potential solutions:
    -   Solution A: A substitution where the type is `Int`. This solution would be marked as conflicting with the constraint that requires `String`.
    -   Solution B: A substitution where the type is `String`, conflicting with the `Int` constraint.

3.  **IDE Integration (Long-Term):** This is beyond the scope of the core compiler change but is the ultimate goal. The information from the enhanced solver would be exposed to the IDE (e.g., via the Language Server Protocol). The IDE could then:
    -   Highlight the unfillable hole in red.
    -   On hover, display the conflict and the provenances.
    -   Present the partial solutions as interactive suggestions, as mocked up in the Hazel paper.

**Verification for Phase 3:** Create new tests with deliberately contradictory code. The tests will assert that `inferProgram` successfully returns, and that the correct holes in the resulting AST are marked as unfillable, with the correct conflict information attached.
