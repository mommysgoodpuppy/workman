# HazelTypes MVP Plan

## Objective
Deliver a minimal, end-to-end slice of the Hazel-inspired typing pipeline that already demonstrates value over plain HM inference. The MVP must:

- Keep Layer 1 (marking) deterministic and unchanged other than emitting the data Layer 2 needs.
- Add a minimal Layer 2 solver that unifies core constraints and surfaces actionable diagnostics.
- Optionally tighten node annotations via **monotonic remarking** (unknown → solved) without re-marking.
- Provide a lightweight Layer 3 presentation that exposes Layer 2 results in the IDE/LSP.

This slice restores a testable state quickly and sets the stage for the fuller Layer 2/Layer 3 features later.

---

## Scope

### Layer 1 (Marking)
- **No behavioural changes** to inference rules.
- Ensure these exports are populated:
  - `holes: Map<HoleId, UnknownInfo>`
  - `constraintStubs: ConstraintStub[]` for:
    - Function calls (`call`)
    - Field access (`hasField`)
    - Branch joins (`branch`)
    - Arithmetic/comparison (`numeric`, `boolean`)
    - Declaration annotations (`decl`)
- Each stub should capture `origin: NodeId`, participating `HoleId`s, and enough structure for Layer 2 to normalise.

### Layer 2 (Minimal Solver)
- Implement union-find over `HoleId` with occurs-checks (hard fail → diagnostic).
- Normalise the stub kinds listed above into HM equality constraints.
- Single forward pass; no guard handling, row polymorphism, or incremental updates.
- Emit:
  - Δ₁: `Map<HoleId, { state: "solved" | "unsolved"; type?: Type; provenance: UnknownInfo }>` (partial types optional in MVP).
  - `ConstraintDiagnostics[]` with reason codes (`not_function`, `branch_mismatch`, `missing_field`, `occurs_cycle`, etc.).
- **Monotonic remarking (limited):** if a node annotation is `Unknown(H)` and Δ₁[H] is `solved`, replace it with the concrete type. No other AST edits.

### Layer 3 (Presentation MVP)
- Skip the full up–down–up flow analysis.
- Provide:
  - Simple hover/inspect view: concrete type if available; otherwise display the hole ID / “unknown (pending)”.
  - Surface Layer 2 diagnostics directly in the IDE/LSP (attach to the originating node span).
- No guard dominance, partial type views, or flow diagnostics yet.

---

## Out of Scope for MVP
- Guard-based refinements or flow typing.
- Partial record/tuple reconstruction.
- Incremental solver invalidation.
- Exhaustiveness warnings, union width caps, or branch blame logic beyond the basic diagnostic.
- Typeclass-style numeric/ordering constraints.

These items land in subsequent iterations once the MVP proves the pipeline end-to-end.

---

## Milestone Checklist
1. **Instrument Layer 1** to emit `holes` + `constraintStubs` (manual tests around calls, branches, field access, arithmetic).
2. **Implement Layer 2 solver** with union-find + hard occurs-check + diagnostics mapping.
3. **Hook monotonic remarking** into inference result assembly.
4. **Expose Layer 3 MVP views** in CLI/LSP (hover + diagnostics).
5. **Add regression tests** covering:
   - Calling a non-function (diagnostic).
   - Branch mismatch (`if`/`match`).
   - Missing field on an FFI/unknown value.
   - Occurs-check failure.
   - Successful scenario where a solved hole yields a concrete type in the output AST.

---

## Follow-up Work (Post-MVP)
- Enrich Δ₁ with partial types (records, tuples, functions) and add the full Layer 3 up/down/up view lattice.
- Introduce guard facts and control-flow-sensitive refinements.
- Support partial record completion and branch-local blame.
- Enable incremental solver invalidation (constraint ↔ hole graph).
- Explore numeric/ordering typeclass constraints.

The MVP keeps the system testable and demonstrable while constraining engineering effort. Once this slice is stable, the richer Layer 2/Layer 3 roadmap can proceed incrementally.
