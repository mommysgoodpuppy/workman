# M1 Scope (Single-file ESM)

- Inputs: One `.wm` file, no imports/reexports.
- Outputs: One `.mjs`/ESM text string (tool decides extension); `export const` for exported lets and constructors of exported types.

## Supported language
- Literals: Int, Bool, Char, String, Unit
- Expr: Identifier, Tuple, Call (fully saturated), Arrow, Block, Let (non-recursive and recursive), Constructor expr, Match, Match function sugar
- Operators: Built-in integer ops via primitives (add/sub/mul/div); others desugared to calls (may be unsupported in M1)
- ADTs: Locally defined `type` with constructors

## Exclusions
- Imports/reexports/module graphs
- Partial application/currying
- FFI/extern
- Source maps
- User-declared infix/prefix operators (beyond built-in prims)

## Deliverables
- esm compiler backend
- Inline minimal runtime helpers
- Tag tables and JS constructor exports when `type` is exported

## Acceptance criteria
- Running the emitted ESM in Deno and importing the exported function works
- Evaluating the Workman program via interpreter matches executing the emitted ESM for covered features
