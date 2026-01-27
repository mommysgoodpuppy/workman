# Core IR Refactor: Research Extension Plan

This document extends the existing Core IR refactor plan with a concrete
research phase. The goal is to eliminate backend hacks by defining stable,
target-agnostic semantics in Core/Elaborated IR and *explicit* target policies
in Target IRs. This plan does not prescribe code changes yet; it turns research
into measurable deliverables and decisions.

---

## Scope and Intent

We are preparing for a major backend rewrite. Workman is a multi-target,
semantics-flexible language (runtime Zig, raw Zig, JS, future targets). That
means:

- Core IR must be portable and semantics-only.
- Target behavior must be explicit (not inferred by emitters).
- Representation choices (boxing, integer widths, calling conventions) must be
  expressed in a target-specific lowering stage, not ad hoc in printers.
- The infection system is a **language feature**, not target policy.

This plan formalizes the research required to make those boundaries robust.

---

## Phase 0: Inventory and Baselines

### 0.1 Current backend behavior inventory
**Goal:** Produce a documented list of behaviors that differ across backends.

Deliverables:
- `plans/coreirRefactor/target_behavior_inventory.md` with sections:
  - runtime Zig (current)
  - raw Zig (current)
  - JS (current)
  - future targets (expected)
  - "unknown/undefined"
- Each section includes: numeric semantics, boxing, closure calling, match
  semantics, record/ADT layout, string/char representation, FFI boundary rules.

Inputs:
- `backends/compiler/zig/emitter.ts`
- `backends/compiler/zig/raw_emitter.ts`
- `backends/compiler/js` (if present)

Acceptance:
- Every backend hack has a named place in the inventory.
- No "hidden" semantics live only in emitter branches.

### 0.2 Grain IR influence summary
**Goal:** Summarize how Grain separates typed AST vs lowering stages, and what
we can borrow.

Deliverables:
- `plans/coreirRefactor/grain_ir_notes.md` with:
  - typedtree responsibilities
  - middle_end responsibilities (ANF, matchcomp, closure analysis)
  - takeaways for Workman (which steps should exist in Workman)

Inputs:
- `C:\GIT\grain\compiler\src\typed\typedtree.re`
- `C:\GIT\grain\compiler\src\middle_end\anftree.re`
- `C:\GIT\grain\compiler\src\middle_end\matchcomp.re`
- `C:\GIT\grain\compiler\src\middle_end\optimize_closures.re`

Acceptance:
- Clear mapping: "Workman Core/Elab/Target should own X, Y, Z".

---

## Phase 1: Target Policy Matrix (Concrete Semantics)

### 1.1 Define explicit target policy axes
**Goal:** Agree on the *dimensions* of target behavior variation.

Deliverables:
- `plans/coreirRefactor/target_policy_axes.md`
- The axes must include (at minimum):
  - numeric widths + overflow rules
  - boxing/unboxing policy (when values are boxed)
  - closure calling convention
  - record/ADT layout
  - string/char representation
  - effect/capability boundary semantics
  - FFI safety rules (what types can cross boundary)

Acceptance:
- Each axis is described with options, defaults, and examples.

### 1.2 Populate the target policy matrix
**Goal:** For each backend, choose explicit options for each axis.

Deliverables:
- `plans/coreirRefactor/target_policy_matrix.md`
- A table with rows = axes, columns = backends.
- Each cell includes: policy choice + rationale.

Acceptance:
- No "TBD" for existing backends (runtime Zig/raw Zig/JS).

---

## Phase 2: Representation Strategy (Boxing + Width)

### 2.1 Value representation model
**Goal:** Document a representation model for runtime Zig (boxed/unboxed).

Deliverables:
- `plans/coreirRefactor/runtime_value_representation.md` describing:
  - unboxed primitive set (Int, Bool, Char, etc.)
  - boxed values and tags (Value enum? tagged union?)
  - representation of tuples/records/ADTs
  - how infections/effects affect representation (if at all)
  - explicit boundary ops: `Box`, `Unbox`, `Tag`, `Untag`

Acceptance:
- A clear list of IR operations the runtime Target IR must expose.

### 2.2 Integer width inference policy
**Goal:** Define how to choose `Int` vs `I32` vs `U32` etc.

Deliverables:
- `plans/coreirRefactor/integer_width_policy.md` with:
  - default policy by backend
  - widening/narrowing rules
  - join rules for `if`/`match`
  - interaction with literals

Acceptance:
- A deterministic rule set suitable for implementation.

---

## Phase 3: Target IR Definitions

### 3.1 ZigTargetIR (runtime + raw)
**Goal:** Define the node set and invariants for Zig backends.

Deliverables:
- `plans/coreirRefactor/zig_target_ir.md` with:
  - core node list (calls, blocks, allocs, tags, etc.)
  - representation-specific nodes (boxing ops, raw pointers)
  - explicit closure environment handling
  - validation invariants

Acceptance:
- Both runtime and raw Zig emitters can be expressed as printers for this IR.

### 3.2 JSTargetIR (runtime JS)
**Goal:** Minimal JS-specific IR design.

Deliverables:
- `plans/coreirRefactor/js_target_ir.md`
- Node list + invariants for JS backend.

Acceptance:
- JS backend decisions are encoded as lowering, not in printer logic.

---

## Phase 4: Integration with Existing Plans

### 4.1 Sync with `plan.md` phases
**Goal:** Update the main plan to reference new research deliverables.

Deliverables:
- Add a "Research Extension" section to `plans/coreirRefactor/plan.md`
  referencing these docs and sequencing.

Acceptance:
- Main plan points to explicit artifacts rather than vague "research".

### 4.2 Align match + infection plans with Target IR split
**Goal:** Ensure match refactor and infection plan have clear layering.

Deliverables:
- Short appendix in:
  - `plans/coreirRefactor/match_refactor_plan.md`
  - `plans/coreirRefactor/infection.md`
  describing which IR layer owns each responsibility.

Acceptance:
- No plan implies backend-specific logic inside Core/Elab.

---

## Phase 5: Decision Review and Freeze

### 5.1 Review checkpoint
**Goal:** Confirm decisions before coding.

Deliverables:
- `plans/coreirRefactor/review_checklist.md` with:
  - target policy matrix complete
  - representation model approved
  - Target IR node sets approved
  - migration impact noted

Acceptance:
- Team agreement to proceed to implementation phases.

---

## Immediate Next Actions (Recommended Order)

1. Write `target_behavior_inventory.md` (Phase 0.1).
2. Write `grain_ir_notes.md` (Phase 0.2).
3. Draft `target_policy_axes.md` (Phase 1.1).
4. Draft `target_policy_matrix.md` (Phase 1.2).
5. Draft `runtime_value_representation.md` (Phase 2.1).
6. Draft `integer_width_policy.md` (Phase 2.2).

---

## Success Criteria for the Research Phase

- We can answer "what does this mean" for any Core construct without touching
  backend code.
- We can answer "how does backend X implement this" by reading a Target IR
  policy doc rather than scanning emitters.
- Adding a new backend requires only:
  1) new target policy entries
  2) new Target IR lowering
  3) a printer
  but no changes to Core/Elaborated IR definitions.

