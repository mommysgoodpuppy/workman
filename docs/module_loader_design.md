# Module Loader Design (Stage M1)

## Current Pipeline Snapshot
- `src/main.ts` reads a single `.wm` file and delegates to `runFile()`.
- `src/runner.ts` lexes (`lex()`), parses (`parseSurfaceProgram()`), infers (`inferProgram()`), and evaluates (`evaluateProgram()`) a stand-alone `Program`.
- `src/parser.ts` already parses `export`/`import` syntax into `Program.imports` and annotated declarations, but nothing consumes that information yet.

## Scope & Constraints
- **Supported**: `export let`, `export type`, `from "path" import { Name }`, `from "path" import { Name as Local }`.
- **Not Supported in M1**:
  - Namespace imports (`* as Alias`) — no runtime surface for dot access (`Foo.bar`) because `src/lexer.ts`/`src/token.ts` lack a dot token.
  - Re-exports (`export { foo } from "..."`).
  - Type import aliasing (`{ Type as Alias }`).
  - Implicit directory/index resolution — only files, optionally with inferred `.wm` extension.

## Module Loader API
- New file: `src/module_loader.ts`.
- Public surface:
  - `loadModuleGraph(entryPath, options?)` → builds dependency graph and returns topo order plus per-module export summaries.
  - `runEntryPath(entryPath, options?)` → orchestrates loading, inference, evaluation, and produces CLI-friendly summaries matching `runFile()` output.
- Options:
  - `stdRoots?: string[]` to resolve bare specifiers beginning with `"std/"`.

## Resolution Rules
- **Relative** (`./foo`, `../bar`): resolve against importer directory; append `.wm` if absent.
- **Absolute**: only allowed when already absolute; append `.wm` if missing.
- **Bare** (`"std/..."`): prefix each `stdRoot` in order; append `.wm`; first existing path wins.
- Diagnostics:
  - Missing module file → `Module not found: <specifier> (resolved from <importer>)`.
  - No matching std root → `Module not found in std roots: <specifier>`.

## Graph Construction
- Parse entry file (lex, parse) and recursively traverse imports.
- Reject `NamespaceImport` immediately with `Namespace imports are not supported in Stage M1`.
- Cache parsed `Program`s by absolute path to avoid duplicate work.
- Depth-first search with three-state marks (`unvisited`, `visiting`, `visited`).
  - On encountering a `visiting` node, report cycle: `Circular import detected: A -> ... -> A`.

## Export Surface Computation
- Collect export intent directly from AST:
  - `export let name` → add to `exportedValueNames`.
  - `export type Name` → add to `exportedTypeNames`.
- After inference:
  - `exports.values`: schemes for exported lets plus constructor schemes for exported types.
  - `exports.types`: `TypeInfo` for exported types from module ADT environment.
- Duplicate detection:
  - Same identifier exported multiple times (let vs let, let vs constructor, constructor vs constructor) → `Duplicate export 'X'`.

## Import Application
- For each `NamedImport { imported, local }`:
  - Look up in provider module exports.
  - If found in `values`, insert into importer `initialEnv` under `local ?? imported`.
  - If found in `types` and no alias, insert into importer `initialAdtEnv` under `imported`.
  - Type aliasing attempt (`local` present for type export) → `Type import aliasing is not supported in Stage M1`.
  - Absent from exports → `Module '<path>' does not export '<imported>'`.
- Detect name collisions after aliasing before inserting into environments.

## Inference Pass (Topological Order)
1. Iterate modules in topo order produced by `loadModuleGraph`.
2. Build `initialEnv` and `initialAdtEnv` from resolved imports.
3. Invoke `inferProgram(program, { initialEnv, initialAdtEnv, registerPrelude: true, resetCounter: true })`.
4. Record substituted schemes for exported values and `TypeInfo` for exported types.
5. Store results for dependents.

## Evaluation Pass (Topological Order)
1. Reuse dependency order.
2. Build `initialBindings` map mirroring the import mapping (value exports only).
3. Evaluate via `evaluateProgram(program, { sourceName, initialBindings, onPrint })`.
4. Collect runtime exports to pass to dependents.
5. Entry module result: final runtime logs and exported values for CLI display.

## Diagnostics Summary
- Unsupported namespace import.
- Unsupported type alias import.
- Missing module / std root miss.
- Unknown import name.
- Duplicate export inside a module.
- Import alias collision within a module.
- Circular dependency.

## CLI Integration (`src/main.ts`)
- Replace `runFile(source)` calls with `runEntryPath(path)`.
- Preserve output formatting: headings, type listings, runtime logs, exported values.
- Keep `runFile()` in `src/runner.ts` for single-file mode and existing tests.

## Testing Plan
- Add module-focused tests under `tests/` (new file, e.g., `module_loader_test.ts`):
  - **Simple import**: entry imports exported let from dependency.
  - **Constructor import**: import ADT constructors from exported type.
  - **Alias import**: `{ foo as bar }` populates value env.
  - **Unknown import name** diagnostic.
  - **Cycle detection** diagnostic.
  - **Namespace import** diagnostic.
  - **Type import usage**: type annotation referencing imported type (no alias).

## Open Follow-ups (Beyond M1)
- Namespace access syntax support (`.`) enabling namespace imports.
- Re-exports and export forwarding.
- Persistent module cache keyed by file hash/mtime.
- Incremental inference/evaluation reuse across runs.
