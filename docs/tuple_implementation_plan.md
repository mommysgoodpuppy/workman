# Tuple Argument Implementation Plan

## Context
- Tuple literals and patterns exist today, but function parameter lists only accept flat identifiers, preventing direct tuple destructuring in bindings or arrow functions.@docs/module_and_tuple_plan.md#3-27
- Type inference already represents tuple types and pattern matching but does not handle tuple parameters during lambda or let binding inference.@docs/module_and_tuple_plan.md#20-57
- Runtime closures store raw parameter nodes and rely on positional binding without pattern expansion, so new lowering or evaluation logic is required.@module_loader.ts#1-236

## Objectives
1. Allow tuple patterns in function and let parameters, e.g. `let swap = ((a, b)) => { (b, a) };`.
2. Ensure type inference, evaluation, and module loader summaries correctly handle the new parameter forms.
3. Preserve source spans for diagnostics after any lowering.
4. Provide comprehensive tests covering parser, inference, evaluation, and module loading scenarios.

## Feature Scope
- Tuple parameters for both top-level `let` declarations and inline arrow expressions.
- Nested tuple patterns (e.g. `((a, (b, c)))`).
- Optional type annotations inside tuple patterns (e.g. `(x: Int, (y: Bool, z: Int))`).
- Support in recursive and mutually recursive bindings.

## Constraints & Assumptions
- No new syntax beyond existing tuple literal/pattern grammar.
- Maintain Stage T2 plan for lowering tuple parameters into existing constructs, avoiding evaluator rewrites.@docs/module_and_tuple_plan.md#40-57
- Namespace imports and module features remain unchanged but must coexist with tuple-aware lowering.

## Architecture Strategy
1. **AST Extension**
   - Update `Parameter` to represent both identifier and pattern forms, e.g. `{ kind: "parameter", pattern: Pattern, name?: string }`.
   - Retain `name` for simple identifier parameters to minimize rewrite churn and ensure backwards compatibility.

2. **Parsing Adjustments**
   - Modify `parseParameterList` and `tryParseArrowParameters` to parse either identifiers or tuple patterns using `parsePattern`.
   - Enforce rule: tuple parameters require surrounding parentheses and may include annotations on individual variables.
   - Capture optional annotation syntax after patterns by distributing annotations down to variable leaves during lowering.

3. **Lowering Pass**
   - Introduce `lowerTupleParams(program: Program): Program` executed immediately after parsing.
   - For each function/let with tuple parameters:
     1. Generate fresh identifier parameters (`__param0`, `__param1`, ...).
     2. Insert a leading statement in the function body performing a `match` that destructures the fresh parameter into the original pattern, binding nested variables.
     3. Reuse existing pattern matching exhaustiveness/type logic.
   - Maintain span mapping metadata (e.g. attach `originalSpan` to generated nodes) for debugging; ensure diagnostics reference original pattern spans.

4. **Type Inference Updates**
   - Extend `inferLetBinding` / `inferArrowFunction` to recognize lowered match statements and ensure variable bindings receive correct schemes.
   - Alternatively, enhance inference to operate directly on pattern parameters before lowering; select approach based on complexity after spike.
   - Ensure fresh type variables correspond to tuple element structure, unifying annotations where provided.

5. **Evaluation Runtime**
   - If lowering approach used, evaluator requires minimal change: `match` statements already perform tuple destructuring.
   - Ensure closure parameter metadata matches generated fresh identifiers.

6. **Module Loader Integration**
   - Lowering should occur before module graph inference/eval to avoid duplicating logic across loader and single-file runner.
   - Confirm exported bindings still match original names and that generated temporaries remain local.

## Implementation Phases
### Phase 1: AST & Parser
- Modify `Parameter` type and parser routines.
- Add unit tests verifying parameter patterns parse for `let` and arrow expressions.
- Validate round-trip printing (if applicable) or structural assertions in tests.

### Phase 2: Lowering Pass
- Implement transformation module.
- Insert into compilation pipeline (`runFile`, module loader) right after parsing.
- Ensure spans and identifiers remain consistent.
- Add tests confirming generated AST structure via targeted fixtures.

### Phase 3: Type Inference Support
- Update inference to work with lowered form (ideally no major change) or add direct pattern handling.
- Add regression tests for tuple-parameter functions, including nested patterns and annotations.

### Phase 4: Evaluation & Runtime Tests
- Confirm runtime evaluation of tuple-parameter functions via tests in `tests/eval_test.ts` (create if missing) or expand existing fixtures.
- Include tests covering recursion and mutual recursion with tuple params.

### Phase 5: Module Loader Scenarios
- Add fixture modules exercising tuple parameters across module boundaries (import/export).
- Validate type summaries and runtime execution.

### Phase 6: Documentation & Examples
- Update language reference to describe tuple parameter syntax and semantics.
- Enhance `examples/` with at least one tuple-parameter example.

## Testing Strategy
- **Parser tests**: New cases in `tests/parser_test.ts` verifying tuple parameters and annotation parsing.
- **Inference tests**: Cases mirroring parser tests, plus failure scenarios (arity mismatch, duplicate bind, annotation mismatch).
- **Evaluation tests**: Confirm runtime results reflect destructuring (e.g., swap, unzip).
- **Module loader tests**: New fixtures demonstrating tuple exports/imports.
- **Integration**: End-to-end run via `runFile` to ensure lowering is wired correctly.

## Tooling & Migration
- Update any developer tooling (LSP, syntax highlighting) that assumes `Parameter` has a `name` field.
- Provide migration notes: existing code without tuple parameters unaffected; new syntax available immediately.

## Risks & Mitigations
- **Span Drift**: Generated nodes may mislead diagnostics. Mitigate by storing original spans and mapping errors back through lowering metadata.
- **Type Annotations in Nested Patterns**: Need explicit rules for how annotations apply; propose limiting annotations to identifier leaves initially to reduce complexity.
- **Performance**: Lowering introduces extra match; ensure match arm creation is deterministic and low overhead.
- **Mutual Recursion**: Verify lowering integrates with `mutualBindings` handling so each declaration receives identical transformation.

## Milestones & Deliverables
1. Parser & AST update merged with basic tests.
2. Lowering pass integrated and covered by unit tests.
3. Inference adjustments with new tuple tests.
4. Runtime/module loader validation with fixtures.
5. Documentation + example updates.

## Open Questions
- Should annotations on tuple patterns support nested scope (e.g., annotate entire tuple vs. elements)?
- Do we allow partially annotated tuples? If so, inference rules must clarify defaulting for unannotated elements.
- How will LSP/server surface generated temporaries during go-to-definition?

## Next Steps
- Prototype parser changes locally to validate grammar.
- Design lowering metadata structure for span preservation.
- Schedule time to update LSP extension once core support lands.
