# Inference Refactor Plan

## Overview

The current implementation in `src/infer.ts` expects the legacy AST (`src/old_ast.ts`). We have replaced the core AST with the new TypeScript-like structures (`src/ast.ts`). The inference engine must therefore be rewritten to operate directly on the new nodes without relying on any desugaring bridge. This document captures the required adjustments and the order in which we should implement them.

## Structural Differences to Account For

- **Identifiers vs. variables**: Expressions now use `IdentifierExpr` (`kind: "identifier"`) instead of `kind: "var"`.
- **Applications**: Function application is represented by `CallExpr` (`kind: "call"`) with an argument array instead of chained binary `apply` nodes.
- **Arrow functions**: Lambda expressions are now `ArrowFunctionExpr` (`kind: "arrow"`) with an explicit parameter list and block body.
- **Blocks**: `BlockExpr` contains statement lists plus an optional result expression, replacing implicit `let ... in ...` chaining.
- **Let declarations**: Top-level `LetDeclaration` holds `parameters` and a `BlockExpr` body; there is no curried `lambda`/`apply` layering in the AST.
- **Match expressions/functions**: We have both `MatchExpr` (`match (expr) { ... }`) and `MatchFunctionExpr` (`match(expr) => { ... }`). Arms carry a `hasTrailingComma` flag for diagnostics.
- **Type declarations**: `TypeDeclaration` now exposes `typeParams: TypeParameter[]` and union members via `TypeAliasMember` variants (`ConstructorAlias` or `TypeAliasExprMember`).
- **Type expressions**: Types use `TypeExpr` variants (`type_var`, `type_fn`, `type_ref`, `type_tuple`, `type_unit`).

## Required Changes in `src/infer.ts`

1. **Update imports and discriminated unions**
   - Replace references to legacy kinds (`"var"`, `"lambda"`, `"apply"`, etc.) with the new ones (`"identifier"`, `"arrow"`, `"call"`, `"block"`, `"match_fn"`).
   - Adjust type names (`TypeParameter`, `TypeAliasMember`, etc.).

2. **Top-level let handling**
   - Handle `LetDeclaration.parameters`: support optional type annotations per parameter (future-proof) and convert the list into nested function types during inference.
   - Evaluate the `BlockExpr` body and generalize the resulting type.

3. **Block expression inference**
   - Implement `inferBlockExpr(ctx, block)` that processes statements sequentially, extending the environment for each `let_statement`, and returns the type of the final `result` (or `unit` if absent).

4. **Arrow function inference**
   - Support multi-parameter arrows with optional type annotations.
   - Treat block bodies via `inferBlockExpr`.
   - Ensure captured substitutions are applied when leaving the function scope.

5. **Call expression inference**
   - Accept multiple arguments in a single node, enforcing function types via repeated application.

6. **Constructor expressions**
   - The parser now stores constructor arguments on the `ConstructorExpr`. Reuse existing constructor inference logic but ensure spans/types reflect the updated node shape.

7. **Match expressions & match functions**
   - Split inference into two entry points:
     - `MatchExpr`: infer scrutinee, then evaluate arms, unify result types, and enforce exhaustiveness (reuse existing coverage logic with updated property names).
     - `MatchFunctionExpr`: treat as shorthand for a lambda taking the scrutinee argument; return a function type from parameter type to arm result type.
   - Update pattern inference to work with the new `Pattern` structure (mostly identical to legacy, but we must respect constructor argument grouping).

8. **Type declarations and constructor registration**
   - Replace usage of `decl.parameters` (string array) with `decl.typeParams` (array of nodes). Extract the identifier names and maintain spans if needed for diagnostics.
   - Members: support both constructor aliases and pure type aliases. Constructor aliases should register as data constructors; alias members should just expand to the underlying type expression and register the alias if necessary.

9. **Type expression conversion**
   - Adapt `convertTypeExpr` to the new variants: `type_var`, `type_fn`, `type_ref`, `type_tuple`, `type_unit`.
   - Ensure function types `(A, B) => C` desugar into curried form by folding parameter list into nested `TypeFunction` or `Type` structures.

10. **Prelude and environment helpers**
    - Verify `registerPrelude` still holds: adapt to the new constructor/type registration format and ensure list constructors align with updated type expression kinds.

11. **Block-level let statements**
    - When inferring `BlockExpr`, treat `let_statement` similarly to top-level let: infer initializer, generalize if needed (likely no generalization inside block, keep monomorphic binding), extend scope before proceeding.

12. **Diagnostics and spans**
    - The new AST carries spans on every node. Update error reporting (where needed) to prefer richer messages (optional stretch goal, can defer).

## Implementation Order

1. Update type conversion utilities (`convertTypeExpr`, registration helpers) to parse new type declarations correctly.
2. Implement block and statement inference helpers.
3. Rewrite expression inference switch to handle new `Expr` variants.
4. Adjust let declaration inference to support parameter lists and block bodies.
5. Port match inference (expressions and functions) and ensure coverage checks work.
6. Run/adapt existing inference tests (rewritten for new syntax) to validate behavior.

## Notes

- Legacy files (`src/old_ast.ts`, `src/old_parser.ts`) are retained for reference only; inference should target the new structures exclusively.
- While refactoring, keep the public API (`inferProgram`) stable so `runner.ts` can switch over once the parser is integrated.
- After each milestone, update or add tests in `tests/infer_test.ts` to mirror the new syntax.
