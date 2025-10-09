# Syntax Update Plan

## Goals
- Adopt a ReasonML/TypeScript-inspired surface syntax.
- Keep grammar easy to parse while supporting type annotations and Hindley–Milner inference.
- Maintain both first-class match expressions and standalone matches.

## Highlights
- Parenthesized parameter lists for *all* functions, even single argument.
- Block bodies wrapped in `{ ... }` with `;` terminators.
- Implicit return is last expression within a block.
- Matches expressed with `match (...) { ... }` and `match(...) => { ... }` for first-class form.
- `case` clauses inside braces, comma separated.
- `let` remains the binding keyword.
- Type annotations mimic TypeScript: `let value: Result<List<Int>, IoError> = ...;`.
- Type declarations TBD, leaning toward familiar TS style.

## Open Questions
- Precise shape for type declarations (generic parameters, constructors syntax).
- Statement vs expression blocks for `let` initializers (allow nested `let`?).
- Operator precedence and application syntax once arrow functions exist.

## Migration Steps
1. Update lexer tokens to support new symbols: `=>`, `,`, `{`, `}` usage, `case`, parentheses in matches.
2. Redesign AST nodes to separate block expressions, parameter lists, and case clauses.
3. Rewrite parser grammar:
   - `let name [(parameters)] [: Type]? = expression;`
   - Arrow functions: `(params) => { ... }` with optional type annotations per parameter later.
   - Matches: `match (scrutinee) { case Pattern => Expr, ... }` and first-class `match(args...) => { ... }`.
4. Adjust desugaring phase to map new syntax back to existing core AST for inference.
5. Update type inference tests and fixtures to use new syntax.
6. Provide migration examples in `examples/` and update CLI runner documentation.
7. Add compatibility layer or transformer if we need to support old syntax temporarily.

## Proposed Grammar (draft)

- **[File]** `program ::= declaration*`
- **[Declaration]** `letDecl | typeDecl`
- **[LetDecl]** `let` `identifier` `parameterList` `typeAnnotation?` `=` `blockExpr` `;`
- **[parameterList]** `(` `parameters?` `)`
  - `parameters ::= param ("," param)*`
  - `param ::= identifier` *(future)* `| identifier ":" typeExpr`
- **[typeAnnotation]** `":" typeExpr`
- **[blockExpr]** `"{" statement* returnClause? "}"`
  - `statement ::= letDecl | expression` *(only allow nested `let`/expression for now)*
  - `returnClause ::= expression` (implicit return; omit trailing `;`)
- **[arrowFn]** `parameterList "=>" blockExpr`
- **[matchExpr]**
  - `matchStandalone ::= "match" "(" expression ")" matchBlock`
  - `matchFirstClass ::= "match" "(" arguments? ")" "=>" matchBlock`
  - `arguments ::= expression ("," expression)*`
- **[matchBlock]** `"{" matchCase ("," matchCase)* ","? "}"`
  - `matchCase ::= "case" pattern "=>" expression`
- **[typeDecl]** `"type" identifier typeParams? "=" typeAliasUnion ";"`
  - `typeParams ::= "<" identifier ("," identifier)* ">"`
  - `typeAliasUnion ::= typeAliasMember ("|" typeAliasMember)*`
  - `typeAliasMember ::= constructorAlias | typeExpr`
  - `constructorAlias ::= identifier typeArgList?`
  - `typeArgList ::= "<" typeExpr ("," typeExpr)* ">"`
- **[typeExpr]** reuse existing HM type grammar but adopt TS surface: generics `Name<...>`, function types `(T, U) => V` *(desugar to curried form later)*.
- **[Patterns]** constructors, tuples, literals updated to match new delimiter usage.

## Parsing & Desugaring Strategy

- **[Lexer]**
  - Add multi-character tokens: `=>`, `case` keyword, brace/bracket punctuation if not already.
  - Distinguish `{`/`}` usage in expressions vs pattern braces and in type literal contexts.
- **[AST Updates]**
  - Introduce `BlockExpr` node capturing statement list + optional return expr.
  - Add `ArrowFunction` node with parameter array and block body.
  - Wrap match cases in explicit `MatchArm` structure with comma separation metadata (for diagnostics).
  - Support typed identifiers in declarations even if parsing simple subset first.
- **[Desugaring]**
  - Convert arrow functions to nested lambdas `(fn param -> ...)` for inference compatibility.
  - Translate block statements to nested `let`/`match` expressions preserving scope.
  - Standalone `match` remains expression; first-class `match(...) => { ... }` desugars to lambda taking tuple args.
  - Type aliases expand into existing ADT registration format (create constructor entries matching tagged object schema).
- **[Pseudocode]**
  - *Arrow Fn*
    ```pseudo
    desugarArrow(params, block) =
      foldRight(params, desugarBlock(block), (param, body) => Lambda(param, body))
    ```
  - *Block*
    ```pseudo
    desugarBlock({ statements; returnExpr }) =
      desugarStatements(statements, desugarExpr(returnExpr))
    ```
  - *Type Alias*
    ```pseudo
    desugarTypeAlias(name, params, members) =
      for member in members:
        buildConstructorInfo(name, params, member)
    ```

## Migration Phases

1. **Parser Prototype**
   - Implement new lexer tokens and AST nodes behind `NEW_SYNTAX` flag.
   - Add golden tests for representative snippets (functions, matches, type annotations).
2. **Dual Syntax Stage**
   - Allow both legacy and new syntax parsed via different entry points (or feature flag) to avoid breaking existing examples/tests.
   - Provide conversion utilities for examples in `examples/` to help validation.
3. **Type & Runtime Alignment**
   - Ensure desugaring keeps inference semantics identical; expand `tests/infer_test.ts` cases using new syntax.
   - Define transformation from TypeScript-style type aliases into constructor info consumed by inference.
   - Update CLI to mention new syntax usage.
4. **Deprecation & Cleanup**
   - Remove legacy `fn`/`match with` parser paths once examples/tests migrated.
   - Document final grammar in README / language reference.

## Risks & Mitigations

- **[Risk]** Ambiguity between grouped expressions and arrow functions; mitigate by enforcing parentheses before `=>`.
- **[Risk]** Block implicit return may conflict with trailing semicolon; ensure parser treats final expression without terminating semicolon as return.
- **[Risk]** First-class `match` tuple parameterization could be confusing; consider requiring tuple literal `match ((arg1, arg2)) =>` to simplify for V1.
- **[Risk]** Type declaration syntax decision pending; schedule dedicated design spike before implementing stage 2.

## Immediate Next Steps

- **[Action]** Author detailed EBNF for `let` declarations, block statements, and matches.
- **[Action]** Sketch desugaring pseudocode mapping new nodes to existing `src/ast.ts` representation.
- **[Action]** Identify minimal test cases (parser + inference) required before enabling the new syntax flag.
- **[Action]** Draft test matrix covering: arrow functions (single/multiple params), standalone vs first-class match, type aliases with constructors, nested blocks, and type annotations.
