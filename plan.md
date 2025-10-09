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
