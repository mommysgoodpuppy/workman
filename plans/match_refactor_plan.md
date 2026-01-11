# Workman Pattern Matching Refactor Plan

## Purpose

Elevate Workman's pattern matching from convenient syntax to a principled,
polarity-aware subsystem that delivers "exhaustiveness for free" while staying
practical for engineers. The plan ties commas, bundle references, and
constructor inverses together so that match bundles form bona fide disjunctive
products (linear negation of sum constructors). The goal is safer code (no
missed cases), better ergonomics (composable bundles), and a simpler runtime
model for future optimizations.

---

## Constraints & Non-Goals

- **Pragmatic first**: use theory (De Morgan duals, linear logic, inverse
  constructors) only where it concretely improves Workman ergonomics,
  diagnostics, or performance.
- **No pure-academic detours**: every section below ends with pipeline/test
  implications.
- **Compatibility window**: existing programs must keep compiling until the new
  semantics fully land; we gate breaking changes behind a staged rollout
  (feature flag + lint + default-on).

---

## Current Pain Points Summary

1. **Comma ≠ &**: commas only separate ordered arms or pull in bundle
   references; they dont encode conjunction across inverse clauses, so coverage
   reasoning is ad hoc.
2. **Bundle references short-circuit coverage**: referencing another bundle
   marks the parent match as "has wildcard," hiding missing cases.
3. **Eager discharge + ad hoc coverage**: exhaustiveness + effect discharge
   logic lives in layer1 inference (`inferMatchBranches`), making nested matches
   and domain composition brittle @src/layer1/infer.ts#4373-4611.
4. **Diagnostics surfaces split**: layer1 emits `markNonExhaustive` but layer2/3
   do not have first-class awareness of match products, so errors can be
   duplicated or delayed.

---

## Target Model

| Concept                    | Current                                        | Target                                                                                   |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Match bundle type          | `Func(scrutinee, result)` inferred ad hoc      | `Match(scrutinee, result)` opaque type encoding polarity & coverage metadata             |
| Comma                      | Statement separator                            | Binary `&` node composing inverse clauses (De Morgan dual)                               |
| Bundle reference           | Treated as wildcard coverage and function call | Structured conjunction: pulls in referenced coverage + result type, no implicit wildcard |
| Exhaustiveness             | Derived from guard heuristics and ad hoc sets  | Guaranteed via linear negation (sum -> product) and constructor coverage tables          |
| Discharge (effects/errors) | Eager type rewrites in layer1                  | Lazy rewrites recorded as constraints and solved in layer2, aligned with coverage proof  |

---

## Work Breakdown

### Phase 0  Baseline & Flags

1. **Audit tests + fixtures**: catalog all usages of match bundles, bundle
   references, guard-heavy matches, and diagnostic expectations (especially
   @tests/match_tests.ts#240-454).
2. **Introduce feature flag**: `match_products_v1` toggle accessible via
   CLI/env + per-file pragma to scope new semantics.

### Phase 1  AST & Syntax

1. **Comma-as-node**
   - AST: add `MatchConjunctionArm` referencing left/right children; rewrite
     parser to build binary tree when commas separate arms
     @src/parser.ts#2985-3055.
   - Preserve `hasTrailingComma` only for formatting; semantics come from tree
     structure.
2. **Bundle reference metadata**
   - Extend `MatchBundleReferenceArm` with resolved type + coverage info
     placeholder (populated later).
3. **Inverse constructor surface**
   - Ensure constructors automatically expose inverse handles (`Ctor⁻¹`) in
     AST/type env (named or synthesized) so commas can juxtapose them
     explicitly.

### Phase 2  Type System & Coverage Proofs

1. **`MatchType` introduction**
   - Extend `Type` union with `kind: "match"` storing `from`, `to`, and
     `coverage` payload (list of constructors handled + guard info).
   - `inferMatchBundleLiteral` returns `MatchType` rather than raw func until
     lowered; `match_fn` sugar still exposes `func` externally for backward
     compatibility.
2. **Coverage tables**
   - Replace `coverageMap`/`hasWildcard` heuristics in `inferMatchBranches` with
     algebra on `MatchType.coverage`.
   - Bundle references merge coverage tables instead of toggling wildcard.
3. **Executable proof objects**
   - Each arm yields an "inverse clause" value; comma nodes combine them with an
     `&` constructor in IR, aligning runtime with proofs.
4. **Layered diagnostics**
   - Move `markNonExhaustive` trigger to the point where a `MatchType` fails to
     cover all constructors; emit both layer1 diagnostic + attach structured
     payload for layer2/3.

### Phase 3  Constraint & Solver Integration

1. **Lazy discharge alignment**
   - When coverage shows all constructors for a carrier (e.g., `Result`), emit
     solver constraints that remove error rows only after coverage proof
     succeeds (hook into existing rewrite pathway highlighted in INFECTION plan
     @plans/INFECTION_REFACTOR_PLAN_V3.md#1399-2852).
2. **Constraint labels for coverage**
   - Extend `branch_join` stubs with `coverageProof` describing which
     constructors guarded branch provides; solver validates conjunctions before
     rewriting effects.
3. **Cross-domain extensibility**
   - Document interface so other domains (memory, nullable) can consume the same
     coverage info.

### Phase 4  Runtime & Lowering

1. **IR updates**
   - Ensure match bundles lower to structures that respect `&` products,
     enabling future optimizations (decision trees from coverage metadata).
2. **Bundle reuse**
   - When bundling references, avoid re-inferring bodies; reuse lowered inverse
     clauses with specialization if necessary.
3. **Performance audit**
   - Benchmark tight loops with extensive matching to ensure new structure
     doesnt regress codegen.

### Phase 5  Rollout & Migration

1. **Dual-mode testing**
   - Add test matrix running suite with flag off/on; start migrating
     stdlib/tests to new semantics.
2. **Diagnostics hardening**
   - Update `workmansyntaxguide.md` + docs to explain comma-as-`&`, inverse
     constructors, and coverage-driven exhaustiveness.
3. **Flag removal**
   - After adoption + perf validation, flip default; emit lint for legacy bundle
     behavior before removing fallback.

---

## Deliverables & Milestones

1. **M1**: Parser + AST support landed behind flag; no semantic change yet.
2. **M2**: `MatchType` + coverage tables with legacy behavior matching existing
   results; unit tests for match composition.
3. **M3**: Solver integration delivering lazy discharge + richer diagnostics.
4. **M4**: Runtime lowering + perf validation.
5. **M5**: Flag default-on, docs updated, lint for legacy semantics.

Each milestone ends with:

- Tests (unit + integration) demonstrating coverage/exhaustiveness.
- Benchmarks or smoke tests for regressions.
- Checklist update in this plan.

---

## Open Questions

1. **Constructor identity**: Do we need explicit IDs for constructors to survive
   across modules, or are names sufficient once bundled inside `MatchType`?
2. **Guarded arms**: Should guarded inverse clauses count toward coverage if
   guard is not statically provable? (Current answer: no; treat guard as proof
   obligation recorded in coverage metadata.)
3. **Effects beyond errors**: When memory/ownership carriers arrive, can the
   same coverage proof discharge them, or do we need separate polarity tags per
   domain?

---

## Next Actions

1. Add feature flag plumbing + parser AST changes (Phase 1).
2. Instrument existing tests to snapshot coverage data for diagnostics.
3. Draft doc updates explaining inverse constructors & comma semantics (parallel
   effort).
