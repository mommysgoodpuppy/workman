# Layer 1 – Bidirectional Marking (Extensions)

## Purpose
Layer 1 remains the Hazel-inspired, total, bidirectional marker. It guarantees that every well-formed surface program produces:
- A marked AST whose structure mirrors the unmarked input.
- A hole/mark table (Δ₀) mapping node IDs to `unknown` types, mark payloads, and other provenance data.
- Environments (`env`, `adtEnv`) that are internally consistent, even when declarations failed.

This file documents only the *additional* extensions Layer 1 needs so that the downstream layers can operate without redefining the core marking algorithm.

## Responsibilities (recap)
- Perform the structural synth/check traversal once, inserting marks instead of throwing.
- Assign deterministic `NodeId`s to every node, reuse IDs for derived marks, and emit spans.
- Record a canonical `unknown` type for every surviving hole or mark, including provenance.
- Export per-node bookkeeping (e.g., `ctx.nodeTypes`, `ctx.marks`, `ctx.typeExprMarks`).

## Extensions required by Layers 2 & 3
1. **Stable node provenance envelope**
   - Ensure every mark and hole captures `(nodeId, span, originKind)`. Origin kinds include: `expr`, `pattern`, `type_expr`, `top_level`.
   - Provide a lightweight `HoleOrigin` discriminated union for downstream aggregation.

2. **Hole category seed data**
   - Extend `unknownType` calls so they choose between:
     - `unknown_free` (from free variables/holes),
     - `unknown_local_conflict` (branch mismatches, not-yet-solved),
     - `unknown_internal` (internal consistency guards),
     - `unknown_incomplete` (placeholders awaiting solver data).
   - Downstream layers refine these categories rather than redefining them.

3. **Constraint hooks (no solving)**
   - Layer 1 should collect *raw constraint stubs* without attempting to solve them:
     - For applications: `(calleeType, expectedArrow)`
     - For matches/conditionals: branch type tuples
     - For pattern bindings: scrutinee ↔ pattern constructors
     - For arithmetic/comparisons: operand numeric/boolean expectations
   - Store these in `ctx.pendingConstraints: ConstraintStub[]`, scoped per node ID.

4. **Guard metadata for flow typing**
   - Record guard nodes (`if`, `match`, `while`, etc.) with:
     - Guard expression ID
     - Guard “refinement set” (e.g., `typeof x == "string"` ⇒ `(targetId, refinedType)`)
   - Expose them via `ctx.guardFacts` so Layer 3 can seed branch-local refinements.

5. **Mark/AST materialisation tweaks**
   - Ensure `materialize*` helpers propagate the new provenance envelope and guard metadata when building the marked tree.
   - Add `marksVersion` to the `InferResult` so Layer 2 can invalidate caches if structure changes.

## Interfaces exported to downstream layers
- `InferResult`
  - `markedProgram`
  - `marks: Map<NodeId, MMark>`
  - `holes: Map<NodeId, UnknownInfo>` (new alias around the provenance envelope)
  - `pendingConstraints: ConstraintStub[]`
  - `guardFacts: GuardFact[]`
- `ArityDiscipline` (new): documents whether the current compilation unit is using curried or n-ary arrows. For Milestone 1, default to **curried arrows** so partial application remains natural; revisit only if Layer 2 decides to normalise to vector arrows.
- `RecursiveTypePolicy`: `"occurs_error" | "record_cycles"`. Initial default is `"occurs_error"` (hard occurs-check failure). Switching to `"record_cycles"` will require coordinated updates in Layers 2/3.
- `RecordDiscipline`: closed-by-default; explicit extension nodes carry provenance so Layer 2 can enforce hasField constraints deterministically.
- `NumericPolicy`: `"concrete"` for Milestone 1 (arith/comparison force `Int`/`Bool`). Future variants (`"typeclass"`) live behind a feature flag.
- `UnknownInfo`
  - `id: NodeId`
  - `provenance: Provenance`
  - `category: "free" | "local_conflict" | "incomplete" | "internal"`
  - `relatedNodes: NodeId[]`

## Acceptance criteria for Layer 1 updates
- No new throw sites; all failures still emitted as marks.
- Full regression suite passes (existing Layer 1 tests).
- New unit tests covering:
  - Guard fact emission for simple `if`, pattern matches, and guards nested under marks.
  - Constraint stub capture for common constructs.
  - Provenance envelope stability across parsing and transformations.
- Documentation cross-references updated (`layer1_marking_system.md`).

## Open questions
1. **Granularity of constraint stubs** — Should multi-argument calls produce one stub per argument or a single n-ary stub? (Default: per-argument for ease of unification.)
2. **Performance impact** — Need benchmarks to ensure storing guard facts/constraint stubs does not regress keystroke latency.
3. **Legacy API consumers** — Confirm the VS Code extension and CLI tools can ignore the new `InferResult` fields until they opt-in.
