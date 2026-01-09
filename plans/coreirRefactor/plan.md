# Core IR Refactor Plan

This document turns the "must-do" Core IR cleanup list into a concrete work plan. It assumes we want two Zig backends (runtime + raw) and future backends (JS, GLSL, etc.) sharing the same Core surface area.

---

## Guiding Principles

1. **Three-layer contract**
   - **Layer A – Core IR (portable semantics only)**: No backend strings, no backend-specific runtime hooks, no conditional emission logic.
   - **Layer B – Elaborated Core**: Sugar eliminated, infection/effects/evidence inserted as explicit nodes.
   - **Layer C – Target IRs**: Per-backend lowering (ZigTargetIR, JSTargetIR, …) feeding their printers/runtimes.
2. **Backend-agnostic invariants stay in Core**; everything else lives in elaboration passes or backend lowerings.
3. **Every change below should land with tests + migration notes**, so other contributors can follow the contract.

---

## Phase 1 – Data Model Hygiene (unblocks every backend)

| Task | Description | Deliverables |
| --- | --- | --- |
| 1.1 ABI type tree | Replace `typeAnnotation?: string` with a structured `AbiType` union; update parser + type checker to populate it only when authoring native interop. | `AbiType` definition, migration script, updated emitter helpers. |
| 1.2 Constructors carry payload types | Extend `CoreTypeConstructor` with `fields: Type[]`; update lowerings so emitters stop re-reading source ASTs. | Schema change + graph migration. |
| 1.3 Record decl field rename | Disambiguate `CoreRecordExprField` vs `CoreRecordDeclField` to avoid future type confusion. | Refactor + lint rule.

**Exit criteria:** Core graph serialization no longer stores backend strings, and all ADTs/records expose enough metadata for any backend.

---

## Phase 2 – Symbol & Polymorphism Infrastructure

| Task | Description | Deliverables |
| --- | --- | --- |
| 2.1 Symbol IDs | Introduce `SymbolId` on bindings/imports/exports/vars; add per-backend manglers (Zig, JS) to map IDs → printable names. | Symbol allocator, serialization update, mangler utilities. |
| 2.2 Type schemes | Store `{ type, vars }` on every exported binding + type decl (`typeParams`); ensure generalization order is stable. | Type scheme data in Core, regression tests for cross-module reuse. |
| 2.3 Complete module interfaces | Reshape imports/exports to distinguish value/type/ctor/namespace + explicit re-exports. | Updated `CoreImportSpecifier`/`CoreExport`, graph validation, CLI diff helper.

**Exit criteria:** Multiple backends can rely on Core metadata without guessing name stability or generalization rules.

---

## Phase 3 – Infection & Effects as Explicit IR

| Task | Description | Deliverables |
| --- | --- | --- |
| 3.1 Elaborated Core pass | Move current infection heuristics into a dedicated pass that inserts explicit carrier ops (preferred) or `callKind` / `matchKind` tags. | New IR nodes + lowering pass + tests. |
| 3.2 Backend updates | Update Zig runtime emitter(s) and JS runtime to consume the new carrier ops instead of ad-hoc checks. | Updated emitters, runtime adapters, golden tests. |
| 3.3 Trait/evidence hook (optional) | Add scaffolding so future evidence insertion reuses the same pipeline stage. | Doc + placeholder IR node definitions.

**Exit criteria:** No backend examines carrier metadata directly; they just follow elaborated IR instructions.

---

## Phase 4 – Sequencing & Metadata

| Task | Description | Deliverables |
| --- | --- | --- |
| 4.1 Block/assign forms | Add a portable sequencing construct (`block` + optional `assign`) so different backends stop inventing bespoke sequencing strategies. | Parser + Core schema + lowering updates + emitter support. |
| 4.2 Metadata side table | Replace per-node `origin/span` with `metaId` references into a shared table; provide tooling to strip or enrich metadata per backend. | Meta table schema, serializer changes, debug tooling. |

**Exit criteria:** Backends share the same sequencing semantics and can opt-in/out of metadata without touching Core nodes.

---

## Phase 5 – Target IR Split (per backend family)

| Task | Description |
| --- | --- |
| 5.1 Define ZigTargetIR | Shared IR for both runtime Zig and raw Zig emitters (captures calling convention + layout decisions). |
| 5.2 Define JSTargetIR | Minimal JS-specific IR (handles dynamic runtime helpers) while still ingesting the same Elaborated Core. |
| 5.3 Pipeline wiring | `Core -> Elaborated Core -> TargetIR (per backend) -> printer/runtime`. Update CLI to choose target stacks. |

**Exit criteria:** Adding a third backend means adding a new TargetIR + printer, without modifying Core or existing backends.

---

## Implementation Notes & Dependencies

- **Migrations:** Each schema change (AbiType, constructor fields, symbol IDs, schemes) requires a graph migration utility + compatibility layer for cached build artifacts.
- **Testing:** Add golden dumps for Core + Elaborated Core to ensure future contributors see when they accidentally leak backend-specific data.
- **Tooling:** Provide codemods / lint checks preventing reintroduction of backend strings or missing symbol IDs.
- **Docs:** Update contributor docs with the 3-layer contract and rules for adding new IR nodes.

---

## Suggested Order of Execution

1. Phase 1 (ABI + constructors) – minimal ripple, unblocks others.
2. Phase 2 (symbols + schemes + interfaces) – foundational.
3. Phase 3 (infection elaboration) – depends on symbol/type info.
4. Phase 4 (sequencing + metadata) – can happen in parallel once symbol work lands.
5. Phase 5 (Target IR split) – final structural change after Core contract is stable.

---

## Tracking & Next Steps

- Create issues/epics per phase with explicit acceptance criteria above.
- Add CI check that rejects Core dumps containing Zig/JS-specific strings.
- Schedule pairing sessions for Phase 3 (largest semantics shift).
- Revisit plan after Phase 2 to confirm no new backend constraints emerged.
