# Zig Closure Capture Bug (Non-Exhaustive Match) - Root Cause and Fix

## Summary
A non-exhaustive match panic in Zig runtime was triggered by a closure capture bug.
The crash appeared in `aoc2016/1.wm` inside the `move` lambda, but the real fault
was captured variables stored as pointers to stack locals that had already gone
out of scope. That turned a valid `Orientation` value into garbage at runtime,
causing `runtime.isData` checks to fail and the match to fall through.

## Symptoms
- Panic: `Non-exhaustive match` at `aoc2016/1.wm:39:5`
- Scrutinee printed as `oom` (garbage) in the Zig runtime panic
- Call stack pointed at a lambda created inside `move`

## Root Cause
The Zig runtime emitter stored closure captures as `*const Value` pointing to
stack-local variables. The outer function returned a closure (lambda), so the
captured pointers became dangling. When the closure ran later, the captured
`orient`/`distance` were corrupted, which made the `Orientation` match miss all
constructors.

The relevant emitted code pattern:
- Env struct fields were `*const Value`
- Env initialization used `&local` addresses
- The lambda returned after those locals went out of scope

## Fix Implemented
Capture by value in the Zig emitter for closures:
- Env struct fields changed from `*const Value` to `Value`
- Env initialization stores `ref.value` rather than `ref.address`
- Access uses `env.field` rather than `env.field.*`

File updated:
- `backends/compiler/zig/emitter.ts`

## Why This Fix Matches the Core IR Refactor Goals
The bug surfaced because emitters were still responsible for subtle lifetime
behavior. By making the emitter capture values directly, we avoid backend
heuristics about lifetimes and keep Core IR semantics intact.

## Mutability Follow-Up Needed
This fix assumes captured values are immutable. If Core IR introduces mutable
bindings (or reference cells), we will need explicit capture modes:
- `capture_by_value`: copy at closure creation
- `capture_by_ref`: stable pointer into heap-allocated cell

That should be driven by explicit Core IR metadata so emitters do not guess.

## Troubleshooting Steps (What Worked)
1. Reproduced crash with `wm compile --debug` and Zig run.
2. Inspected `dist/debug_ir_elaborated.json` to confirm the match was intact
   (no carrier rewrite in the failing match).
3. Checked generated Zig for the failing lambda; saw `env.orient.*` and
   `env.distance.*`, which implied pointer captures.
4. Confirmed closure escapes (function returns a lambda), so pointer capture
   is invalid.
5. Implemented capture-by-value in the Zig emitter.
6. Re-ran build to verify the match no longer receives garbage.

## Diagnostic Heuristics for Similar Complex Bugs
- Confirm whether the IR is sane before debugging runtime behavior.
- Always check whether a crash value is garbage or legitimate.
- If a crash involves a closure, inspect generated env structs and capture
  initialization.
- For persistent issues, add an elaborated IR dump and line up:
  source -> IR -> emitted code -> runtime behavior.

## Notes
- The new elaborated IR dump is written to `dist/debug_ir_elaborated.json` when
  running `wm compile --debug`.
- Future investigations should prefer IR-driven diagnoses over runtime patches.
