# Architecture Overview: A New Type System for Workman

This document outlines the high-level architecture for a planned evolution of the Workman type system. The goal is to create a more powerful, resilient, and intuitive typing experience, inspired by the formalisms presented in the paper "Total Type Error Localization and Recovery with Holes" (the "Hazel paper").

## 1. Core Philosophy: No Meaningless States

The guiding principle of this new architecture is that **no syntactically well-formed program is meaningless**. The type system must always be able to produce a well-defined semantic structure, even in the presence of multiple, complex type errors. This is a shift from a traditional "pass/fail" type checker to a **total type localizer** that provides a foundation for a rich, live programming environment where IDE services never fail.

## 2. The Two-Layer Architecture

To achieve this, we will adopt the two-layer architecture proposed by the Hazel paper. The existing bidirectional type checker will be evolved into the first layer, and a new constraint-based inference engine will be built as the second layer.

### Layer 1: The Marked Workman Calculus (Bidirectional Marking)

This layer is responsible for immediate, local error detection and recovery. It is a **total** function that transforms any given Workman source code into a "marked" Abstract Syntax Tree (AST).

- **Concept:** Instead of throwing an exception or halting when a local type rule is violated (e.g., applying a non-function, mismatched conditional branches), the type checker will wrap the erroneous expression in a special **error mark** node.
- **Recovery with Gradual Types:** When a mark is inserted, information is often lost (e.g., the type of an expression is now unknown). The system will recover by assigning the **unknown type (`?`)** to the marked node. This type, from Gradual Typing, is consistent with all other types, allowing the checker to continue processing the rest of the program without cascading failures.
- **Implementation:** This involves a significant refactoring of the existing type inferencer (`src/infer.ts`, `src/infermatch.ts`). Every location that can currently fail will be modified to instead produce a marked node. This will be detailed in `layer1_marking_system.md`.

### Layer 2: Type Hole Inference (Global Constraint Solving)

This layer is responsible for providing the powerful, non-local inference that modern functional programmers expect. It operates on the output of Layer 1.

- **Concept:** After the initial marking pass, Layer 2 traverses the marked AST and gathers **constraints** on all unknown types (`?`) that arose either from explicit type holes written by the user or from error marks inserted by Layer 1.
- **Global Solving:** It attempts to solve this global set of constraints using a standard unification algorithm (e.g., union-find).
- **Neutral Error Localization:** This is the key insight from the Hazel paper. If the constraints are inconsistent (e.g., a type variable must be both `Int` and `String`), the system does **not** guess which use site was "correct." Instead, it localizes the error to the **source of the unknown type** (the original hole or error mark). It marks this hole as "unfillable."
- **User Interaction:** The system will then present the user with partially consistent solutions (e.g., "You could make this type `Int`, but that would cause an error at location X"). This gives the user control over resolving global inconsistencies.
- **Implementation:** This will be a new system, likely involving new data structures for representing constraints and their provenances. This will be detailed in `layer2_type_hole_inference.md`.

## 3. How This Solves Our Problem

The `composes nested bundle references` test fails because it expects the type of `zero` to be retroactively changed by its usage in `bFormatted`. The new architecture solves this cleanly:

1.  **Layer 1** runs. It sees `zero` and correctly gives it a generic type: `forall T. Int -> (String, (Int, Bool), T -> String)`. No errors are marked.
2.  **Layer 2** runs. It gathers constraints. From `bFormatted`, it generates a constraint that the `T` instantiated from `zero` must be `Int`.
3.  If there were another conflicting use (e.g., `T` must be `String`), the solver would detect an inconsistency. It would **not** blame `zero`. It would trace the conflicting constraints back to their origins and mark the relevant *hole* or *usage site* as the source of the conflict, offering the user choices.
4.  In the actual test case, there is no conflict. The solver will successfully unify `T` with `Int`. The final, displayed type of bindings like `describeNumber` will be the specialized, concrete type the test expects, while the generalized type of `zero` itself remains correctly polymorphic.

This architecture provides the best of both worlds: the predictable local error reporting of a bidirectional system and the power of a global inference engine, all within a framework that is resilient to errors and empowers the user.
