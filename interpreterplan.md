# Interpreter Implementation Plan

## Objectives
- **Execute HM-typed programs**: Interpret the AST produced by `src/parser.ts` and accepted by `src/infer.ts`, yielding concrete runtime values.
- **Maintain semantic parity**: Mirror call-by-value, immutable semantics, and pattern coverage guarantees already enforced in `src/infer.ts`.
- **Surface actionable diagnostics**: Provide runtime errors that reference `SourceSpan` data so the VS Code extension (`vscodeExtension/server/src/server.ts`) can display precise locations.

## Current State Snapshot
- **Type system**: `src/infer.ts` offers Algorithm W inference, pattern coverage, and constructor registration (including a List prelude).
- **Runner**: `src/runner.ts` stops after inference, returning type summaries without executing code.
- **Tooling**: Tests in `tests/` validate parsing and type inference but no runtime semantics.

## Deliverables
- **Runtime value layer**: Represent literals, tuples, ADT instances, closures, and native primitives in a dedicated module (`src/value.ts`).
- **Evaluator core**: Implement `evaluateProgram()` in `src/eval.ts` with helpers for expressions, blocks, and pattern matching.
- **Prelude runtime**: Populate global environment with constructors (`Nil`, `Cons`, etc.) and primitive operations (arithmetic, comparison, boolean).
- **Diagnostics integration**: Define `RuntimeError` with spans and message formatting aligned with `ParseError`/`InferError`.
- **Runner wiring**: Extend `runFile()` to evaluate programs post-inference and return both types and optional value renderings.
- **Test coverage**: Add Deno tests (e.g., `tests/runtime_test.ts`) exercising evaluation success paths and failure diagnostics.

## Workstreams & Tasks
- **Runtime foundation**
  - **Value definitions**: Create union types and helpers for runtime values and environments.
  - **Environment utilities**: Implement lexical scope chaining, lookups, and mutation helpers.
- **Evaluator implementation**
  - **Expression evaluation**: Support literals, identifiers, tuples, blocks, call/arrow expressions, and constructor applications.
  - **Pattern matching**: Add runtime destructuring compatible with inference-time coverage guarantees.
  - **Recursive bindings**: Support `isRecursive` and `mutualBindings` by pre-binding closures in shared environments.
- **Prelude & primitives**
  - **Constructor registration**: Mirror `registerPrelude()` by adding runtime constructors before evaluation.
  - **Native functions**: Provide arithmetic, equality, boolean ops, and list utilities as native closures.
- **Integration & UX**
  - **Runner updates**: Modify `src/runner.ts` and `src/main.ts` to display runtime results alongside inferred types.
  - **Formatting utilities**: Create value pretty-printer for CLI and extension consumption.
- **Testing & QA**
  - **Unit tests**: Add focused evaluator tests covering closures, ADTs, matches, and recursion.
  - **End-to-end tests**: Run pipeline tests that lex/parse/infer/evaluate sample `.wm` programs.

## Milestones & Sequence
1. **Scaffold runtime layer**
   - **Files**: Introduce `src/value.ts` and `src/eval.ts` with type signatures, base evaluator for non-recursive lets, and constructor registration.
   - **Outcome**: Able to execute simple literal-returning programs.
2. **Add functions & recursion**
   - **Closures**: Implement multi-parameter closure invocation.
   - **Recursive lets**: Support `isRecursive` and mutual bindings by preparing environment frames.
3. **Pattern matching runtime**
   - **Destructuring**: Evaluate match expressions/functions, bind variables, and ensure constructor arity correctness.
   - **Exhaustiveness trust**: Assume inference checks coverage but guard against unforeseen cases.
4. **Native primitives & lists**
   - **Arithmetic/equality**: Provide native functions for `+`, `-`, `*`, `/`, comparisons, boolean ops.
   - **List conveniences**: Offer `head`, `tail`, and folding primitives if needed for examples.
5. **Runner integration**
   - **CLI output**: Display both type signatures and evaluated results (pretty-printed).
   - **Diagnostics**: Surface runtime errors with span information.
6. **Testing & polish**
   - **Unit + E2E**: Cover success/failure cases; add regression tests for discovered issues.
   - **Documentation**: Update `plan.md`, add usage examples under `examples/`.

## Risks & Mitigations
- **Constructor semantics**: Runtime constructors must align with inference quantification; mitigate with shared helper bridging type and runtime registration.
- **Recursive environment leaks**: Incorrect handling of shared frames can cause stale values; add targeted tests for mutual recursion.
- **Native primitive coverage**: Missing primitives hinder demos; prioritize a minimal but coherent set before CLI integration.

## Next Actions
- **Create scaffolding**: Add `src/value.ts` and `src/eval.ts` with baseline runtime structures.
- **Update tests**: Prepare infrastructure for runtime-focused Deno tests.
- **Iterate feature-by-feature**: Follow milestone order to keep changes reviewable and testable.
