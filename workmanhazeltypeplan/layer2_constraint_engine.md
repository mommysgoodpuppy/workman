# Layer 2 – Constraint Solver & Monotonic Remarking

Layer 2 executes once per edit immediately after Layer 1. Its responsibilities are to solve all first-order constraints over the hole graph, report conflicts, and optionally tighten type annotations in place **without** re-running the marking algorithm. The pipeline stays strictly forward:

```
Layer 1 (mark) → Layer 2 (solve + monotonic remarking) → Layer 3 (flow views)
```

## Core invariants
- **Stable hole identity:** Every hole created during Layer 1 owns a unique `HoleId`. Δ₁ is keyed by `HoleId`, never by `NodeId`. Multiple nodes may reference the same hole, and nodes may be rebuilt across edits while the hole persists.
- **Marks are hard cut points:** Constraints never cross into the interior of a marked subtree. Layer 2 can read mark metadata for provenance but must not propagate information past a mark boundary.
- **Single forward pass:** Layer 2 runs once, produces Δ₁ (and optional tightened annotations), and stops. There is no Layer 2 ↔ Layer 3 feedback loop.
- **Hindley–Milner discipline:** Constraint solving is equality/row based—no subtyping. Shape constraints are expressed via explicit field equality (`hasField`) rather than ≥ relations.
- **Monotonic remarking only:** If Layer 2 writes back into the marked AST, it may only replace `Unknown(H)` annotations with more precise information derived from solved holes. Node structure, mark placement, and the hole set remain unchanged.

## Inputs
- `InferResult` from Layer 1 (see `layer1_extensions.md`):
  - `markedProgram`
  - `holes: Map<HoleId, UnknownInfo>`
  - `constraintStubs: ConstraintStub[]`
  - `guardFacts: GuardFact[]`
- Optional incremental cache (union-find state, hash-cons tables).

## Outputs
- Δ₁ – `HoleSolution` map keyed by `HoleId`:
  - `state: "solved" | "partial" | "unsolved"`
  - `type?: Type` (for fully solved holes)
  - `partial?: PartialType` (structural skeleton with embedded `HoleRef`s)
  - `provenance: UnknownInfo`
- `ConstraintDiagnostics[]` – minimal unsatisfied cores (constraint IDs, hole IDs, node spans, reason codes).
- `SolverTrace` (optional) – derivation steps for debugging/telemetry.
- Optionally updated `markedProgram'` where node annotations referencing solved holes have been tightened (monotonic remarking).

## Constraint normalisation
Each `ConstraintStub` is expanded into HM-friendly constraints with explicit provenance (`origin: NodeId`, `participants: HoleId[]`).

| Stub kind            | Normal form                                                                  | Notes |
|----------------------|-------------------------------------------------------------------------------|-------|
| Unary call `f x`     | `type(f) ≡ τ_arg → τ_res`, `type(x) ≡ τ_arg`, `res(f) ≡ τ_res`                | Prefer curried arrows; report arity mismatches explicitly. |
| N-ary call           | `type(f) ≡ (τ₁, …, τₙ) → τ_res`, unify each argument with τᵢ                 | Represent as vector arrows if curried encoding is awkward. |
| Field access         | `hasField(record, label, hole_label)`                                         | `hole_label` allocated in Layer 1; reuse via (recordHole, label) key. |
| Branch join          | `t := type(arm₀)` then fold `unify(t, type(armᵢ))` for i ≥ 1                   | Linear-time join; store per-arm provenance for diagnostics. |
| Pattern constructor  | `scrutinee ≡ C τ₁ … τₖ`, unify payload positions                              | Supports ADTs and tuples. |
| Projection           | `tuple ≡ (τ₀, τ₁, …)`, `element ≡ τᵢ`                                        | Works for tuple destructuring and literal fields. |
| Arithmetic           | `type(lhs) ≡ Int`, `type(rhs) ≡ Int` (or emit `Num τ` constraint)             | Decide upfront whether to keep concrete or add type classes. |
| Comparison           | `type(lhs) ≡ Int`, `type(rhs) ≡ Int` (or `Ord τ`)                            | Same consideration as arithmetic. |
| Declaration annotation| `type(def)` ≡ `annotation`                                                   | Covers `let`/type annotations. |

### Guard facts
- Represent guard refinements as predicates: `Refine(targetHole, predicate)`.
- Guards carry a `GuardId` with dominance metadata (set of NodeIds/HoleIds dominated by the guard).
- Layer 2 records guard facts but does not apply them; Layer 3 handles control-flow-sensitive refinements.

## Data structures
```ts
type HoleId = string;
type ConstraintId = string;

interface Constraint {
  id: ConstraintId;
  origin: NodeId;
  participants: HoleId[];
  kind: "eq" | "call" | "hasField" | "branch" | "numeric" | "boolean" | "decl";
  payload: ConstraintPayload;
}

type ConstraintPayload =
  | { tag: "eq"; left: TypeExpr; right: TypeExpr }
  | { tag: "call"; fn: TypeExpr; args: TypeExpr[]; res: TypeExpr }
  | { tag: "hasField"; record: TypeExpr; field: string; value: TypeExpr }
  | { tag: "branch"; arms: TypeExpr[] }
  | { tag: "numeric"; subject: TypeExpr }
  | { tag: "boolean"; subject: TypeExpr }
  | { tag: "decl"; annotated: TypeExpr; actual: TypeExpr };

interface HoleSolution {
  holeId: HoleId;
  state: "solved" | "partial" | "unsolved";
  type?: Type;
  partial?: PartialType;
  provenance: UnknownInfo;
}

interface ConflictDiagnostic {
  id: string;
  reason: "eq_mismatch" | "arity_mismatch" | "occurs_cycle" | "missing_field" | "field_retype" | "numeric_required" | "boolean_required";
  constraints: ConstraintId[];
  holes: HoleId[];
  nodes: NodeId[];
  message: string;
}

interface PartialType {
  kind: "unknown" | "primitive" | "record" | "tuple" | "function" | "union";
  base?: "Int" | "Bool" | "String" | "Char" | "Unit";
  fields?: Map<string, PartialField>;
  elements?: Array<PartialType | HoleRef>;
  args?: Array<PartialType | HoleRef>;
  result?: PartialType | HoleRef;
  variants?: Array<PartialType | HoleRef>;
  nullable?: boolean;
  readonly?: boolean;
}

interface PartialField {
  value: PartialType | HoleRef;
  present: "known" | "unknown";
}

interface HoleRef {
  holeId: HoleId;
}
```

## Solver algorithm
1. **Normalise** `constraintStubs` into `Constraint[]`, building type expressions that reference union-find representatives (`TypeExpr::Hole(HoleId)`, `TypeExpr::Const`, `TypeExpr::Arrow`, `TypeExpr::Row`, …).
2. **Initialise** a union-find over `HoleId`s. Hash-cons structural nodes to preserve sharing and speed equality checks.
3. **Process constraints** in dependency order (worklist seeded `eq/decl → call → hasField → branch → numeric/boolean`):
   - Equality: recursively unify structures with occurs checks. With the default `RecursiveTypePolicy = "occurs_error"`, cycles raise `occurs_cycle` diagnostics. If the policy switches to `"record_cycles"`, replace the hard failure with cycle recording.
   - Call: unify the function hole with an arrow (curried by default); enforce arity; enqueue equalities for each argument and the result to keep higher-order flows acyclic.
   - hasField: unify the record hole with a row containing the field hole produced in Layer 1; do **not** allocate new persistent holes here.
   - Branch: unify all branch result holes and log provenance for diagnostics.
   - Numeric / boolean: unify with concrete primitive types (or raise a dedicated diagnostic if a class constraint is unsupported).
   - Declaration: unify annotation and actual types directly.
   - On failure, emit a `ConflictDiagnostic` capturing the (greedily) minimised set of constraints/holes/nodes involved (unsatisfied core approximation).
4. **Persist guard facts** unchanged; attach them to Δ₁ entries for Layer 3 to consume with dominance awareness.
5. **Construct Δ₁**:
   - For each union-find class, if it collapses to a concrete type, mark `state = "solved"` and record `type`.
   - If partially solved, build a `PartialType` skeleton that keeps references to residual holes.
   - If untouched, emit `state = "unsolved"` with `PartialType.kind = "unknown"`.
6. **Monotonic remarking (optional)**:
   - If a node annotation references `Unknown(H)` and Δ₁[H] is `solved`, rewrite the annotation to the concrete type.
   - If a node holds a partial record/tuple that now has known fields, update the annotation to the partial view.
   - Do not create new holes, change node kinds, or penetrate marks.

## Integration with other layers
- Layer 1 → Layer 2: read-only except for the allowed monotonic annotation replacement.
- Layer 2 → Layer 3: provide Δ₁, `guardFacts`, `ConstraintDiagnostics`, and the (optionally) tightened `markedProgram'`.
- Layer 3 must treat Δ₁ as authoritative for solved and partial hole information.

## Incremental roadmap (future work)
- Maintain a bipartite dependency graph (`ConstraintId ↔ HoleId`) to invalidate only affected regions on edits.
- Hash-cons and memoise structural type construction to minimise recomputation.
- Cache guard dominance analysis for reuse between edits within the same module.

## Testing strategy
1. **Normalisation tests** – each stub kind reduces to the expected canonical constraint set.
2. **Solver tests** – cover successful unifications, arity mismatches, occurs-check failures, missing/ret-typed fields, and guard preservation.
3. **Remarking tests** – verify that solved holes rewrite node annotations monotonically while marks and structure remain untouched.
4. **Integration tests** – run Layer 1 fixtures through Layer 2, asserting Δ₁ contents and emitted diagnostics.
5. **Performance baselines** – measure constraint processing and remarking on representative programs, tracking union-find operations and wall-clock latency.

## Open questions
- Do we need typeclass-style constraints (e.g., `Num τ`, `Ord τ`) immediately, or can we keep arithmetic/comparison concrete for the first milestone?
- Should we support equirecursive types? If yes, replace hard occurs-check failures with cycle recording for Layer 3 views.
- What minimal unsatisfied-core shrinking strategy offers sufficient diagnostic quality without expensive MUS search?
- When enabling incremental mode, what invalidation granularity (per declaration, per expression, per hole) offers the best trade-off between complexity and responsiveness?
