# TinyHM Plan

## Goals
- Build a minimal HM-typed functional core language with algebraic data types (ADTs) and total pattern matching.
- Keep the implementation intentionally small while retaining type soundness.
- Provide a REPL-like runner via Deno for executing source files.

## Constraints & Simplifications
- Single compilation unit (no modules or imports).
- Non-recursive `let` bindings initially; explicit `let rec` support deferred.
- Hindley–Milner (rank-1) polymorphism, no polymorphic recursion, no implicit references.
- ADTs limited to non-mutually-recursive definitions; constructors stored in a global registry.
- Pattern matching without guards; enforce coverage but skip redundancy warnings.
- Call-by-value evaluation; immutable data structures.

## Architectural Components
- **Lexer**: Tokenize identifiers, keywords, literals, constructors, punctuation.
- **Parser**: Produce AST nodes for expressions, type declarations, and match expressions.
- **Type System**: Implement HM inference (Algorithm W) with type environments, unification, and generalization.
- **Pattern Checker**: Matrix-based exhaustiveness analysis using constructor sets from ADT environment.
- **Evaluator**: Interpret AST via closures and tagged union values.
- **Runner**: End-to-end pipeline (parse → type-check → evaluate) exposed to CLI.

## Milestones
1. Bootstrap syntax & AST definitions.
2. Implement parser and AST builders.
3. Add type representations, unifier, and inference engine.
4. Integrate pattern exhaustiveness checking.
5. Build evaluator/runtime values.
6. Wire runner, diagnostics, and minimal CLI UX.

## Future Enhancements
- Recursive `let` bindings and polymorphic recursion safeguards.
- Exhaustiveness diagnostics for uncovered patterns.
- Redundancy checking for match arms.
- Basic standard library primitives (numeric ops, list utilities).
- Pretty-printer and REPL mode.

## ADT HM Type System Deep Review Plan (2025-10-10)

### Objectives
- Ensure `src/infer.ts` correctly implements Algorithm W with ADT support, recursion, and pattern coverage.
- Audit surrounding infrastructure (`src/parser.ts`, `src/types.ts`, `src/type_printer.ts`, `src/runner.ts`) for sound integration with HM inference.
- Expand `tests/` suites to cover success/failure paths, edge cases, and regression scenarios for ADTs, tuples, recursion, and annotations.

### Workstreams
- **Source Audit**: Perform a file-by-file deep review of `src/infer.ts`, `src/types.ts`, `src/parser.ts`, `src/lexer.ts`, `src/runner.ts`, and any helper modules to document invariants, potential bugs, and refactor opportunities.
- **Pattern Semantics Review**: Validate pattern coverage checks in `inferPattern()` and `ensureExhaustive()` for tuples, nested constructors, wildcard interactions, and mutually recursive ADTs.
- **Recursion Semantics Review**: Verify recursive and mutually recursive binding handling in `inferLetDeclaration()` and `inferLetBinding()` including annotation enforcement and substitution hygiene.
- **Diagnostics & Error Surfaces**: Evaluate `InferError` messaging, parser errors, and runtime diagnostics to ensure actionable feedback for type/coverage violations.
- **Test Matrix Design**: Draft a categorized checklist for new tests (positive and negative) covering: polymorphic generalization, constructor arity mismatches, tuple inference, mutually recursive ADTs, pattern exhaustiveness, occurs-check failures, and annotation mismatches.
- **Automation & Tooling**: Confirm test harness coverage via Deno, consider adding property/regression suites, and ensure coverage reports remain interpretable.
