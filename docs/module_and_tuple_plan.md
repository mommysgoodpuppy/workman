# Module System and Tuple Arguments Plan

## Current State Snapshot
- **Modules**: Source files are single-compilation units processed via `src/main.ts` pipeline (`runFile`). No notion of imports/exports; std helpers presently copy-pasted per file.
- **Tuples**: Parser (`src/parser.ts`) and evaluator (`src/eval.ts`) support tuple literals and pattern matching, but function parameters only accept individual names; tuple destructuring in parameter position is unsupported. Type inference (`src/infer.ts`) handles tuple literals via `TypeTuple` but lacks tuple-call conventions.

## Goals
- **Modules**: Introduce a minimal module system enabling explicit export/import of bindings and optional namespace control, supporting std library composition without runtime primitives.
- **Tuple Arguments**: Allow binding tuple patterns directly in parameter lists (e.g., `let swap = ((a, b)) => { (b, a) };`) plus support call sites passing tuples to tuple-parameter functions.

## Design Considerations
### Modules
- **Scope**: Pure source-level modules; defer packaging/bundling. Maintain compatibility with Deno CLI workflow.
- **Syntax**: Default one module per file. Add `export` modifiers (`export let`, `export type`) and `import { name } from "path"` with optional namespace imports (`import * as List from "std/list"`).
- **Resolution**: Resolve module paths relative to the importing file, with extension inference (`.wm`). Support bare specifiers mapped to std search roots.
- **Visibility**: Only exported bindings visible to importers; re-export allowed via `export { name } from ...` (optional Stage 2 enhancement).
- **Type Sharing**: Type declarations respect export semantics; importing exposes both constructors and the nominal type.
- **Error Handling**: Provide diagnostics for missing modules, circular imports, and duplicate exports.

### Tuple Arguments
- **Pattern in Parameters**: Extend AST (`Parameter` in `src/ast.ts`) to allow tuple patterns alongside identifiers. Parser must recognize `(a, b)` form inside parameter lists.
- **Desugaring**: Implement lowering that transforms tuple parameters into fresh bindings plus destructuring match at function entry (e.g., `let f = ((a, b), x) => body;` becomes `let f = (tmp0, x) => { match(tmp0) { (a, b) => { body } } };`).
- **Inference**: Update `src/infer.ts` to support tuple patterns when binding parameters, ensuring tuple types propagate. Enforce arity matching and provide error messages for mismatched tuple shapes.
- **Evaluation**: Interpreter already supports tuple patterns via `match`; reuse that logic post-desugaring. Ensure closures store transformed parameter list.
- **Call Sites**: Permit direct tuple literals `(x, y)` or variables bound to tuples; inference should handle them via existing tuple type rules.

## Implementation Plan
### Stage M1: Module Foundations
- **Parser**: Add grammar for `export`/`import`. Update AST with `ModuleDeclaration`, `ImportSpec`, annotation for exported status on declarations.
- **Resolver**: New module loader in `src/main.ts`/`src/runner.ts` orchestrating dependency graph, performing topological sort, and concatenating ASTs for inference/eval. Maintain dependency metadata to avoid reprocessing shared modules.
- **Type Checker**: Extend environment assembly in `inferProgram()` to preload imported module summaries before processing file-level declarations. Distinguish between exported and internal bindings.
- **Evaluator**: Similar to inference; load imported modules into runtime environment before executing local declarations. Cache evaluation results per module to avoid duplicate initialization.
- **Tooling**: Update CLI usage to recognize entry file plus module resolution options (e.g., std search path). Add basic diagnostics for missing exports.

### Stage M2: Module Ergonomics
- **Re-exports**: Support `export { foo } from "./module";` and namespace re-exports.
- **Default exports** (optional): Evaluate whether single-export modules need special syntax.
- **Caching**: Introduce persistent module cache to skip re-inference for unchanged dependencies (future improvement).

## Tuple Argument Rollout
### Stage T1: Parser & AST
- Update `src/parser.ts` to parse tuple parameters. Extend `Parameter` type in `src/ast.ts` to include `pattern` variant referencing existing `Pattern` nodes.

### Stage T2: Desugaring / Lowering
- Add preprocessing step (e.g., `lowerTupleParams()` in a new module) that rewrites functions with tuple parameters into canonical form using match expressions.
- Ensure recursion and closures adopt lowered body while preserving spans for diagnostics.

### Stage T3: Type Inference
- Modify `inferLetBinding()` and `inferArrowFunction()` in `src/infer.ts` to handle pattern parameters: generate types for tuple patterns, unify with argument types, and introduce bindings for tuple elements.
- Provide errors for mismatched tuple lengths or unsupported nested patterns beyond current tuple support.

### Stage T4: Runtime
- Verify evaluator handles lowered form (match expressions). No direct tuple-parameter support needed once lowering occurs.

### Stage T5: Testing & Docs
- Add parser/infer/eval tests demonstrating tuple-parameter functions and module imports/exports.
- Document module resolution and tuple parameter syntax in new `docs/` guides. Update examples to leverage modules instead of local helper copies.

## Risks & Mitigations
- **Cycle Handling**: Module cycles may require lazy evaluation or explicit prohibition. Initial approach: detect cycles and throw descriptive error; consider later support via mutually recursive modules.
- **Name Collisions**: Imported names colliding with local bindings must be flagged. Provide namespace import ergonomics to avoid conflicts.
- **Error Surfacing**: Lowering tuple parameters must preserve span mapping to ensure diagnostics point to user source, not generated code.

## Next Steps
- Prioritize Module Stage M1 and Tuple Stages T1–T3 for minimal viable support.
- Prototype module resolver focusing on std path to enable reuse of freshly added std files.
- After core functionality, refactor demos/tests to rely on module imports and tuple parameters to validate ergonomics.
