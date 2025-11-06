# ESM Backend Design (M1)

- Scope: Compile a single Workman module to ESM, importable from Deno/Node ESM. No imports, no FFI, no partial application, no source maps in M1.
- Decisions:
  - ESM only.
  - Exclude partial application in M1.
  - Limit to a single module (no cross-module imports).
  - When a `type` is exported, also export its constructors in JS.
  - Design portable IR first (Core → MIR), then emit thin target-specific code (JS now; C/Zig later).
- Goals:
  - Minimal runtime, portable representations, correctness parity with interpreter for supported features.

## Directory

- m1_scope.md — exact M1 feature scope and acceptance criteria
- core_ir.md — typed Core IR: nodes, types, semantics
- mir.md — backend-agnostic MIR: values, instructions, function form
- lowering.md — Surface → Core → MIR transforms (ANF, closure-conv, match lowering)
- runtime.md — JS runtime shapes and helpers; tag tables; primitives
- codegen.md — MIR→ESM mapping rules and emission structure
- testing.md — test strategy and golden tests
- future.md — brief notes for M2+ (modules, FFI, source maps, perf)
