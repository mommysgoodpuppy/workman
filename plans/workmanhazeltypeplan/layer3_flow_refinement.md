# Layer 3 – Flow Views & Control-Flow Refinement

Layer 3 runs after Layer 2 has produced Δ₁ (hole solutions) and optional monotonic remarking. Its job is to compute refined **views** of each node—combining structural information, solved holes, and guard-sensitive refinements—without mutating Layer 1’s marked AST or Δ₁. The output feeds IDE surfaces (hover, completions, diagnostics) once the full pipeline finishes.

```
Layer 1 (mark) → Layer 2 (solve + remark) → Layer 3 (flow views) → UI/LSP
```

## Principles
- **Read-only:** Layer 3 never modifies `markedProgram` or Δ₁. All results are produced as separate view data (Δ₂).
- **Marks remain opaque:** Traversals stop at mark nodes. Refinements never cross marks; marked subtrees retain the unrefined Layer 1 view.
- **Control-flow awareness:** Guard refinements are applied only to nodes dominated by the guard (using GuardId dominance info from Layer 2).
- **Single pass sequence:** Layer 3 executes once per edit after Layer 2. No feedback loop back to the solver.
- **Views, not types:** Results describe what the user sees (e.g., partially refined records, branch-specific types) without claiming they are re-typed AST annotations.
- **No new holes:** Layer 3 never allocates `HoleId`s. Ghost expectations and widened views live solely inside Δ₂ and are discarded on rerun.

## Inputs
- `markedProgram'` – the Layer 1 AST, optionally tightened by Layer 2’s monotonic remarking.
- Δ₁ – `Map<HoleId, HoleSolution>` produced by Layer 2.
- `guardFacts: GuardFact[]` – dominance-scoped guard predicates.
- `ConstraintDiagnostics[]` – for correlating flow diagnostics with solver conflicts.

## Outputs
- Δ₂ – `NodeViewMap: Map<NodeId, NodeView>` capturing per-node observed/expected/final views.
- `FlowDiagnostics[]` – guard/branch-specific warnings (e.g., guard contradictions, unreachable arms).
- Optional `RefinementTrace` (debug) – ordered record of applied refinements during the passes.

## Analysis pipeline
Layer 3 performs three traversals over the AST (expression tree today; pluggable CFG support in the future). All traversals respect mark boundaries.

1. **Upward synthesis (observed info)**
   - Bottom-up walk collecting `ObservedInfo` for each node:
     - Concrete types already present on the node (post-Layer 2 remarking).
     - Partial structural info from Δ₁ (records, tuples, functions).
     - Per-arm results for `match`/`if` constructs.
   - Cache results keyed by `NodeId` for reuse in later phases.

2. **Downward contextualisation (expected info)**
   - Top-down walk computing `ExpectedInfo`:
     - Propagate parent expectations into children (function result expects arrow, match expects union, etc.).
     - Apply active guard refinements. Maintain a stack of `GuardContext` entries; pushing when entering a dominated region and popping on exit.
     - Introduce **ghost expected fields** when parents demand structure the child lacks. These are view-only expectations; no new holes are allocated.
   - Ensure refinements scope correctly: guards only affect dominated nodes; no effects escape lexical or mark boundaries.

3. **Final upward meet (view synthesis)**
   - Bottom-up walk combining `ObservedInfo` and `ExpectedInfo` using a meet operator over a *view lattice*:
     - **Primitives:** meet succeeds only if identical; otherwise report conflict.
     - **Records:** intersect known fields; for shared fields, recursively meet; track field presence (`known` vs `unknown`).
     - **Tuples:** meet element-wise; mismatched arity produces diagnostics.
     - **Functions:** domains are invariant—if argument views disagree, widen the entire domain to `unknown` (or a capped union alternative) rather than inventing contravariant meets; codomains meet normally.
     - **Unions:** normalise and cap width (e.g., at 2). If union width exceeds the cap, degrade to `unknown` and emit a note.
   - When meet fails (empty intersection), emit a `FlowDiagnostic` pointing to the smallest responsible node (push blame down to the offending branch/guard body whenever possible).
   - Populate Δ₂ entries with:
     - `finalType` – the resolved view.
     - `observed` / `expected` – intermediate data for IDE introspection.
     - `guardContext` – active guard predicates at this node (if any).

## NodeView schema
```ts
interface NodeView {
  nodeId: NodeId;
  finalType: PartialType;        // View lattice element
  observed?: PartialType;        // From upward synthesis
  expected?: PartialType;        // From downward pass
  guardContext?: GuardContext;   // Active guard refinements
  sourceSpan: SourceSpan;
}

interface GuardContext {
  guardId: GuardId;
  refinements: Array<{ target: HoleId; predicate: GuardPredicate }>;
}
```

`PartialType` is shared with Layer 2 (see `layer2_constraint_engine.md`) but Layer 3 can annotate it with additional metadata (e.g., which union branch originated from which guard).

## Diagnostics emitted by Layer 3
- **Guard contradiction:** Dominated region where guard refinements and observed info cannot be reconciled.
- **Unreachable branch:** An arm whose expected view collapses to bottom.
- **Flow conflict:** Meet failure that does not originate from Layer 2’s constraint diagnostics (e.g., context demands `Int` but observed is `String`).
- **Widening notification (optional):** When unions/records widen beyond the configured cap, emit an informational note to explain loss of precision.

Diagnostics reference node spans, guard IDs, and related hole IDs to allow IDE clients to correlate with Δ₁ and solver messages.

## Interaction with other layers
- Layer 2 provides Δ₁, guard facts, and (optionally) a tightened AST. Layer 3 consumes these read-only.
- Layer 3 outputs Δ₂ and `FlowDiagnostics`. These are for presentation only; Layer 2 does not currently consume them.
- IDE surfaces should wait for Layer 3 completion before presenting refined views to avoid flicker (Layer 1 baseline can still be shown optimistically if desired).

## Implementation notes
- Traversals must short-circuit at marks. Marked subtrees receive a default view derived solely from the mark metadata (no additional refinement).
- Meet operator must be associative, commutative, and idempotent. Implement depth/width caps to avoid exponential blow-ups, especially for nested records/unions.
- Maintain caches (`ObservedInfo`, `ExpectedInfo`, `NodeView`) keyed by `NodeId` to support future incremental execution.
- If loops or complex control-flow constructs are introduced, upgrade the traversal to operate over a lightweight CFG (keeping the same up/down/up structure per block).
- Preserve binding generalisation rules: no view should suggest a generalised type if the binding references unsolved holes (honour Layer 1’s generalisation guard).
- Handle mutation by versioning: if the language gains mutable bindings, track simple SSA-like versions so refinements do not leak across writes.

## Testing strategy
1. **Unit tests** for the meet lattice (primitives, records, tuples, functions, unions) ensuring algebraic properties and expected diagnostics.
2. **Guard propagation tests** covering `if`, `match`, and nested guards to confirm dominance-scoped refinements.
3. **Scenario tests** combining Layer 1 + Layer 2 fixtures to validate:
   - Guard-based narrowing (e.g., `typeof x == "string"`).
   - Record field completion driven by parent expectations.
   - Flow diagnostics distinguishing solver conflicts vs. view conflicts.
   - Many-arm matches (k ≥ 10) to confirm linear join and accurate per-arm blame.
   - Repeated field accesses sharing the same field hole (refinement propagates to all reads).
   - Occurs-cycle policy surfaced via views if `RecursiveTypePolicy = "record_cycles"` is ever enabled.
4. **Performance benchmarks** – measure triple traversal cost on representative programs; ensure caching avoids redundant work.

## Open questions
- Preferred union width cap for views (2? 3?) to balance precision and complexity.
- Exposure of guard contexts in the IDE: raw predicates or pre-rendered messages?
- Incremental strategy: can we re-use `ObservedInfo` / `ExpectedInfo` caches for localised edits, or is a full rerun acceptable initially?
- How should flow diagnostics interact with solver diagnostics when both fire for the same location (merge vs. prioritise)?

## Next steps
- Implement traversal skeletons operating on existing marked programs and Δ₁, returning placeholder `NodeView`s.
- Integrate with the IDE to surface `NodeView.finalType` on hover once the full pipeline completes.
- Experiment with guard predicate representation to ensure future extensibility (e.g., richer pattern-based guards, effect systems).
