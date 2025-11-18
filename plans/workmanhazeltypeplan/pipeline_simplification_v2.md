# Pipeline Simplification v2 — Marked AST First, Normalized Diagnostics

This document refines the earlier plan to align with the Hazel model while keeping our linear, dependency‑light pipeline. The core idea: keep a single, authoritative marked AST throughout; Layer 2 normalizes diagnostics and performs monotonic remarking; Layer 3 and the LSP never re‑scan Layer 1 marks.

## Principles
- Single source of truth: the marked AST flows through the pipeline and is only refined (monotonic) by Layer 2.
- Diagnostics as a stream: all user‑visible diagnostics are normalized in Layer 2 with stable reason codes and spans.
- One‑way data flow: Layer 3 and the LSP consume only Layer 2 output; no cross‑layer reach‑back.
- Deterministic and total: Layer 1 always produces a marked tree; Layer 2 never blocks presentation (always returns a result and diagnostics).

## Target Architecture
- Layer 1 – Inference/Marking
  - Output: `InferResult` with `markedProgram`, `nodeTypeById`, `holes`, `constraintStubs`, and optional `layer1Diagnostics` (non‑constraint issues only).
  - Never triggers evaluation; never depends on Layer 2 results.

- Layer 2 – Solver/Remarking
  - Input: strictly the `InferResult` data needed for solving.
  - Responsibilities:
    - Solve equality/shape constraints (union‑find + occurs check + arity checks).
    - Produce a single `diagnostics` list with stable reasons, spans, and details.
    - Perform monotonic remarking: replace `Unknown(H)` annotations with concrete types when solved; do not rewrite structure or spans.
  - Output: `SolverResult` with `diagnostics`, `resolvedNodeTypes`, `substitution`, and the post‑solver `remarkedProgram`.

- Layer 3 – Presentation
  - Input: `SolverResult` only.
  - Responsibilities: build `nodeViews`, attach spans to diagnostics, prepare indices for LSP.
  - No AST re‑traversal for diagnostics; marks are used for type/hover views only.

- LSP
  - Input: Layer 3 result + environment snapshot for hovers/completions.
  - Responsibilities: publish diagnostics and semantic features; never triggers eval.

## Data Contracts (TypeScript)
- SolveInput (Layer 2):
  - `markedProgram: MProgram`
  - `constraintStubs: ConstraintStub[]`
  - `holes: Map<HoleId, UnknownInfo>`
  - `nodeTypeById: Map<NodeId, Type>`

- SolverResult (Layer 2):
  - `diagnostics: ConstraintDiagnostic[]`
  - `resolvedNodeTypes: Map<NodeId, Type>`
  - `substitution: Substitution`
  - `solutions: Map<HoleId, HoleSolution>`
  - `remarkedProgram: MProgram`

- ConstraintDiagnostic
  - `origin: NodeId`
  - `reason: 'not_function' | 'branch_mismatch' | 'missing_field' | 'not_record' | 'occurs_cycle' | 'type_mismatch' | 'arity_mismatch' | 'not_numeric' | 'not_boolean'`
  - `details?: Record<string, unknown>`

## Diagnostic Lifecycle
1. Layer 1 records constraint sites (call, field, branch, boolean, numeric, annotation) as `ConstraintStub`s.
2. Layer 2 solves; on failure, emits a single normalized diagnostic per failure site using the stub `origin` for spans.
3. Layer 2 does not invent mark‑derived diagnostics; all mark‑centric inconsistencies should map to a reason code.
4. Layer 3 attaches spans using the span index and never re‑interprets marks for diagnostics.

## Mark Policy
- Keep marks for:
  - Unknowns/holes, refined by Layer 2 into concrete types when solved (monotonic remarking).
  - Presentation‑only annotations (hover/type display).
- Do not use marks for:
  - Duplicated diagnostics. Once mapped to a solver diagnostic, do not re‑scan `markedProgram` to rediscover the same error.

## Layer 2 Algorithm Notes
- Unification: structural equality on tuples/records/functions/constructors; occurs‑check for variables; arity checks.
- Constraint handling:
  - call: unify callee with `(arg -> result)`; if callee not function post‑subst → `not_function`.
  - has_field: record shape constraints; `not_record` or `missing_field` as applicable.
  - boolean/numeric: unify operands/result with `Bool`/`Int`; on failure → `not_boolean`/`not_numeric`.
  - branch_join: unify branch results and with join node; on mismatch → `branch_mismatch`.
  - annotation: unify annotation with value; failures become `type_mismatch`/`arity_mismatch`/`occurs_cycle`.
- Remarking: after solving, apply the final substitution to node types and update annotations from `Unknown(H)` to concrete types only.

## Server Integration
- Replace any codepaths that read Layer 1 artifacts in the LSP with calls that consume `presentProgram(SolverResult)`.
- Ensure one codepath for analysis in the server: `analyzeAndPresent` → cache per module; no evaluation during diagnostics.

## Migration Plan
1. Complete Diagnostic Migration
   - Identify mark kinds still used for user diagnostics.
   - Introduce corresponding solver reason codes (if missing) and emit them from Layer 2.
   - Remove mark scanning for diagnostics in Layer 3.

2. Complete Monotonic Remarking
   - Confirm remarking replaces only `Unknown(H)`; add tests for solved holes appearing concretely in `remarkedProgram` and `nodeViews`.

3. Tighten Interfaces
   - Make `presentProgram` accept `SolverResult` (done) and eliminate any remaining Layer 1 reach‑throughs.
   - Consider adding `layer1Diagnostics` to `InferResult` for non‑constraint issues; have Layer 2 forward them into its combined list.

4. LSP Cleanup
   - Ensure module loader and diagnostics publishing use only Layer 2/3 data; remove evaluation hooks.
   - Verify hover/completion read types from `resolvedNodeTypes`/`remarkedProgram`.

5. Tests & Verification
   - Unit: solver reasons (`not_function`, `not_boolean`, `branch_mismatch`, etc.).
   - Integration: `presentProgram` spans and nodeViews, VS Code smoke tests on examples.
   - Regression: std library and known failing fixtures; ensure diagnostics don’t regress.

## Acceptance Criteria
- Layer 3 and LSP do not traverse Layer 1 marks for diagnostics.
- All diagnostics visible in the IDE originate from Layer 2’s normalized list with accurate spans.
- `remarkedProgram` contains refined types for solved holes (monotonic only), and no structural rewrites.
- Full test suite passes (excluding explicitly ignored TODOs), solver tests assert diagnostic presence.

## Risks & Mitigations
- Risk: Missing a diagnostic migration case → duplicate or missing messages.
  - Mitigation: exhaustively list mark kinds and map each to a solver reason; add tests per mapping.
- Risk: Over‑remarking changes AST shape.
  - Mitigation: limit remarking to annotation updates; add structural snapshot tests on marked AST.

## Work Breakdown (Next Steps)
- [ ] Inventory mark kinds still used for diagnostics; design mapping table to solver reasons.
- [ ] Implement missing solver emissions; unify details schema (e.g., `{ expected, actual }`).
- [ ] Remove mark sweep in `src/layer3/mod.ts`; keep span index and type views only.
- [ ] Add unit tests for each migrated diagnostic; update examples in `examples/*.wm` where helpful.
- [ ] Verify server codepaths only consume `presentProgram(SolverResult)`.
- [ ] Run `deno test --no-lock -A --no-check tests` and fix any fallout.

## References
- hazelpaper.md — marked lambda calculus, total error recovery, constraint layer atop holes.
- hazeltypes_mvp.md — monotonic remarking scope and MVP constraints list.


Here’s what’s still left to fully land the simplification.

Layer 1 diagnostics forwarding

Add layer1Diagnostics to InferResult (e.g., non-constraint issues: free var, unsupported expr, non-exhaustive match, type-expr arity/unknown).
Have Layer 2 merge/pass these through into SolverResult.diagnostics so LSP/Layer 3 see a single diagnostic stream.
Remove mark-based diagnostics entirely from presentation

We removed the mark sweep in src/layer3/mod.ts; now ensure no other paths (server/LSP) rescan marks for diagnostics.
Add tests asserting presentation diagnostics match Layer 2 only.
Diagnostic coverage audit

Map existing mark kinds to normalized reasons (add any missing: e.g., free_variable, unsupported_expr, non_exhaustive_match).
Ensure each has spans and stable details; add unit tests per reason.
Monotonic remarking completeness

The current remarkType updates unknowns to concrete types only (good). Add tests for solved holes appearing in remarkedProgram and node views across more shapes (tuples, records, constructors).
Server/LSP tightening

Confirm diagnostics publishing uses only Layer 3’s output.
Keep using Layer 1 env/ADT for exports/hovers as needed, but no diagnostics sourced from Layer 1.
Verify no evaluation codepaths are reachable during diagnostics.
Tests and regressions

Run full suite (deno test --no-lock -A --no-check tests) and fix fallout after diagnostic forwarding (the existing TODO in edge_cases_test.ts can stay ignored until implemented).
Add integration tests for Layer 1–only issues (non-exhaustive match, unsupported expr, free var) to ensure they surface in Layer 2 diagnostics.
Docs and examples

Update examples to reflect that diagnostics flow via Layer 2 (e.g., errors in examples/errors.wm).
