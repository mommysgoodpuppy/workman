# Infection System Refactor V3: Unified Constraint Model

**Date:** November 12, 2025\
**Goal:** Generalize infectious types into a unified constraint system that
handles Result/Option, memory/capabilities, holes, and future effect domains—all
using the same constraint propagation and conflict detection machinery.

## Executive Summary

This refactor replaces hardcoded `Result` infection tracking with a **general
constraint flow system**. The key innovation: instead of threading "obligations"
through every inference step, we emit **constraint stubs** during inference and
let the **solver propagate and check them**.

### Critical Architectural Change

**The biggest change:** Moving from **eager discharge** (inference-time) to
**lazy discharge** (solver-time).

**Currently (Eager):**

```typescript
// infermatch.ts - happens during type inference
match result {
  Ok(x) => {
    dischargeErrorRow();  // ← Modifies types immediately
    // x now has clean type
  }
}
```

**New (Lazy):**

```typescript
// Inference: Record intent
emitConstraintRewrite(okBranch, remove: errors);
// Types unchanged

// Solver: Apply during propagation
applyRewrite(node);  // ← Happens later, in correct order
```

**Why it matters:**

- **Nested matches** need cleaned types at the right time
- **Multi-domain** effects (errors + memory) compose naturally
- **Constraint graph** separate from type inference (better modularity)

**Trade-off:** More complex solver, but better composability.

### Key Clarifications from Source Code Review

After examining the current implementation, here are the critical design
decisions:

**1. Per-Domain Singleton Invariant**

Each node has **at most one constraint label per domain**. Multiple sources are
merged using domain-specific rules:

- **Error domain**: `errorRowUnion(row1, row2)` — combines error rows
- **Memory domain**: Conflict check (future)
- **Hole domain**: Constraint unification (future)

This matches the current system where
`infectiousCalls: Map<NodeId,
ErrorRowType>` stores one merged error row per
node.

**2. Single-Pass Propagation (Not Worklist)**

The new system uses the **same single-pass algorithm** as
`enforceInfectiousMetadata`. Processing stubs in creation order gives correct
topological ordering because:

- Stubs are created during inference tree traversal
- Inference visits parent expressions before children
- Rewrites applied before dependent nodes see constraints

No fixed-point iteration needed for error domain. Future domains may require it.

**3. Flow Edge Strategy (Already Optimized)**

The current system is **already optimized** — it only tracks error propagation
through **call arguments** via `argumentErrorRow`. Regular expressions (binary
ops, tuples, etc.) rely on implicit propagation via type unification.

**New system matches this**: Only emit explicit `constraint_flow` edges where
the current system uses `argumentErrorRow` (i.e., at call sites with Result
arguments). Other expressions continue using implicit propagation through types.

**Future extension**: When adding memory/capability domains, those may need
explicit flow edges for non-call expressions. Defer until Phase 5.

**4. Nested Function Boundaries**

The language has let-statements in blocks, which can contain arrow function
expressions. Boundary checking recursively traverses all `LetDeclaration` nodes
(top-level and nested) to find function bodies.

Return position: `decl.body.result?.id ?? decl.body.id`

**5. Carrier Operations Already Exist**

All carrier operations are fully implemented in `types.ts`:

- `flattenResultType()` — split Result<T, E> → {value: T, error: E}
- `makeResultType()` — join T + E → Result<T, E>
- `collapseResultType()` — remove carrier
- `errorRowUnion()` — merge error rows

No new code needed! The constraint system just makes error propagation explicit
via stubs instead of implicit via type unification.

### Core Insight

**Type inference stays unchanged (standard HM):**

```
Γ ⊢ e : τ
```

**All effects/obligations are constraint labels that flow through a graph:**

- `source(label, node)` - introduce constraint
- `flow(from → to)` - propagate constraint
- `rewrite(node, add/remove)` - discharge/advance state
- `merge(nodes → out)` - join control flow + check conflicts

### Why This Is Better

**Current:** `Result` infection is hardcoded via `isResultType`,
`flattenResultType`, etc.

**New:** All domains (errors, memory, holes) use the same 3 primitives:

- **source**: where constraints originate
- **flow**: how they propagate through expressions
- **rewrite**: how they're discharged or transformed

### Relation to Existing System

This is **exactly what your solver already does for holes**! The constraint stub
architecture already exists—we just generalize it to handle multiple domains.

**IMPORTANT:** Much of this machinery already exists in the codebase (see
"Source Code Review Findings" section):

- `argumentErrorRow` field is already implicit constraint tracking
- `dischargesResult` flag is already a rewrite marker
- `errorRowCoverage` tracks which errors are handled
- `enforceInfectiousMetadata` is the constraint checking pass (needs
  generalization)
- Error row types already exist and are used as constraint labels
- `infectiousCalls` map in solver already tracks constraint propagation

- `dischargesResult` flag is already a "rewrite" operation
- `errorRowCoverage` tracks which errors are handled
- `enforceInfectiousMetadata` is the constraint checking pass (needs
  generalization)
- Error row types already exist and can be used as constraint labels

### Dual View of Rows: Types AND Constraints

**Key Innovation:** Rows serve double duty:

1. **Type-level (reified)**: Visible in carrier types like `Result<T, ε>`
2. **Constraint-level (latent)**: Flow invisibly through the constraint graph

They're the **same row**, just in different places! This unifies:

- Error rows (existing `error_row` type)
- Capability rows (new, for memory safety)
- Hole constraint rows (existing hole tracking)

**Reify Law (per domain `d` with carrier type `C_d<ValueTy, RowParam>`):**

> If an expression `e` is typed as `C_d(T, ε)` and the latent row at `e` is
> `ρ_d`, the checker **adds** the constraint `ρ_d ⊑ ε` and **clears** the latent
> row `ρ_d := ∅`.
>
> **Where this happens:**
>
> - At any **construction site** of `C_d(...)`
> - When a call's **result** type is such a carrier
> - At a **return** of that type
>
> **Elimination** (e.g., `match Ok/Err`): The obligation is already in the
> value; no latent bookkeeping needed beyond domain-specific rewrites.

**Concrete reification points in code:**

```typescript
// 1) At call result if return type is a carrier
function inferApp(f: Expr, a: Expr): { ty: Type; constraints: ConstraintSet } {
  const F = infer(f); // {ty: σ→τ, constraints: Σf}
  const A = infer(a); // {ty: σa, constraints: Σa}
  unify(expectArrow(F.ty).param, A.ty);

  let Σ = joinAll(Σf, Σa); // Merge latent constraints
  let retTy = expectArrow(F.ty).ret;

  // Reify for domains with carriers
  for (const dom of domainsWithCarriers) {
    const split = dom.splitCarrier(retTy);
    if (!split) continue;

    // Reify Law: latent ⊑ exposed, then clear latent
    dom.checkSubset(Σ[dom], split.rowParam);
    Σ[dom] = dom.empty(); // Clear - moved into carrier
  }

  return { ty: retTy, constraints: Σ };
}

// 2) At return boundary
function checkReturn(body: { ty: Type; constraints: Σ }, declaredRetTy: Type) {
  for (const dom of allDomains) {
    if (dom.hasCarrier) {
      const split = dom.splitCarrier(declaredRetTy);
      if (split) {
        dom.checkSubset(Σ[dom], split.rowParam);
        Σ[dom] = dom.empty();
        continue;
      }
    }
    // No carrier: domain-specific boundary check
    dom.boundaryCheck(Σ[dom], declaredRetTy);
  }
}

// 3) Pattern match elimination (carrier already contains obligation)
function inferMatchResult(scrut: Expr, arms: Arms) {
  const S = infer(scrut);
  const { valueTy: T, rowTy: ε } = ErrorDom.splitCarrier(S.ty);

  // Ok branch: bind x:T (clean, obligation was in carrier)
  const OkBranch = inferInExtendedEnv(arms.okParam, T, arms.okBody);

  // Err branch: handle error cases from ε
  const ErrBranch = inferErrBranches(ε, arms.errArms);

  return joinTyping(OkBranch, ErrBranch);
}
```

**Domain examples:**

- **Errors**: `Result<T, ε>` carrier (reified at producers)
- **Holes**: `Indet<T, Φ>` carrier optional (Hazel mode)
- **Memory/Caps**: No carrier (stays latent only, checked via conflicts)

This means:

- Clean happy-path code (latent rows flow invisibly)
- Explicit `Result`/`Option` types when you want them
- Same machinery for memory, errors, holes

## Theoretical Foundation

### Rows as Constraints: The Unified Model

The key insight is that **row types are the syntax, constraints are the
semantics**. We already have `error_row` in the type system—now we use it
dually:

**One representation, two views:**

```typescript
type ErrorRowType = {
  kind: "error_row";
  cases: Map<string, Type | null>;
  tail?: Type | null;
};

// Used as TYPE: Result<T, ε>  where ε is an error_row
// Used as CONSTRAINT: latent flow of ε through expressions
```

**The connection:**

```
Γ ⊢ e : τ   with latent constraints  C ⊢ { r_err : Row_err, r_caps : Row_caps, r_hole : Row_hole }
```

Each domain tracks a row variable:

- **Error domain**: error row (labels ↦ payload types) - **already exists!**
- **Caps domain**: capability row (identity ↦ state labels) - new
- **Hole domain**: hole row (hole_id ↦ constraint set) - exists as
  `holes: Map<HoleId, UnknownInfo>`

**Rules per domain:**

- **Errors**: Join = union, always compatible, subtraction on handlers
- **Caps**: Join = union **with compatibility check** per identity (e.g.,
  `Closed[ψ] ⟂ Open[ψ]`)
- **Holes**: Join = merge; conflict if same hole needs incompatible types

### Constraint Primitives

Every domain uses these 3 operations:

#### 1. source(label@identity, at node)

Introduce a constraint label for some identity at a program point.

**Examples:**

```typescript
// Errors
source(error:<ParseError>, node=x)

// Memory
source(mem:Open[ψ], node=r)
source(mem:Borrowed[κ], node=s)

// Holes
source(hole:Unknown[α, prov], node=h)
```

#### 2. flow(from → to)

Constraints on `from` propagate to `to`.

**Note**: For error domain, explicit flow edges are **only needed at call sites
with Result arguments**. Other expressions rely on implicit propagation via type
unification (matching current system's optimization).

**Examples where flow IS emitted:**

- Function call with Result arg: `flow(arg → result)` — only if arg has Result
  type

**Examples where flow is NOT needed (implicit via types):**

- Binary operations: `x + y` — error rows flow through Result types
- Tuple/record construction: `(a, b)` — constraints in element types
- Identifier use: `x` — type carries the error row

#### 3. rewrite(at node, add/remove labels)

Local transformations (discharge/advance state).

**This already exists in the codebase!** The `dischargesResult` flag and
`dischargeErrorRow()` function implement this for the error domain:

```typescript
// Current code (infermatch.ts, line ~310):
const dischargeErrorRow = () => {
  const currentInfo = flattenResultType(resolvedResult);
  if (currentInfo) {
    resolvedResult = collapseResultType(currentInfo.value); // Extract T from Result<T, E>
  }
};

// When pattern matching on Ok(x):
dischargedResult = true; // Mark that rewrite happened
dischargeErrorRow(); // Apply the rewrite
```

**Pattern Match Semantics:**

When you write:

```wm
match result {
  Ok(x) => x + 1,
  Err(e) => 0
}
```

- `x` is a **new binding** extracted from `Result<T, E>`, so it has type `T`
  (not `Result`)
- The **Ok branch body** has constraints removed (the rewrite happens at branch
  entry)
- Pattern matching **extracts the value** from the carrier type, naturally
  giving clean types

**Examples:**

```typescript
// Errors: pattern match on Ok removes error row
rewrite(branch, remove: error:<ParseError>)

// Memory: end_sh advances Borrowed → Ended
rewrite(node, remove: mem:Borrowed[κ], add: mem:Ended[κ])

// Holes: unification fills hole
rewrite(node, remove: hole:Unknown[α], add: hole:Filled[α≈Int])
```

**CRITICAL TIMING:** Rewrites must be applied **during propagation**, not after!

**Why:** Nested pattern matches need to see clean types:

```wm
match outerResult {
  Ok(innerResult) => {
    // Rewrite applied HERE removes outer errors
    match innerResult {
      Ok(x) => x + 1  // Should see clean type, no outer errors
    }
  }
}
```

If we propagate first and rewrite after, the outer error would flow into the
inner match and then get removed too late. By applying rewrites **as we visit
nodes** in the propagation worklist, each node sees the correctly transformed
constraints.

### Helper Primitives

#### aliasEq(id₁ ≡ id₂)

Equate identities (union-find) so labels on either side refer to the same thing.

**Examples:**

```typescript
// Memory: borrow creates κ that aliases resource ψ
aliasEq(κ ≡ ψ)

// Holes: unification equates type vars
aliasEq(α ≡ β)
```

#### merge(n₁,...,n_k → n_out)

Control-flow join. Solver joins incoming constraint sets and checks for
conflicts.

**Examples:**

```typescript
// Match expression
merge(okBranch, errBranch → matchResult)

// If expression
merge(thenBranch, elseBranch → ifResult)
```

## Architecture Overview

### Visual: Current vs. New Data Flow

**Current System (Eager Discharge):**

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1: INFERENCE                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  inferCall()                                                │
│    ├─> Extract error row from Result<T, E>                 │
│    ├─> Attach to call stub: argumentErrorRow               │
│    └─> Types include Result wrappers                       │
│                                                             │
│  inferMatch()                                               │
│    ├─> Check for total match (Ok + Err)                    │
│    ├─> MODIFY TYPE: dischargeErrorRow()  ← EAGER           │
│    │   └─> resolvedResult = collapseResultType(...)        │
│    ├─> Set flag: dischargesResult = true                   │
│    └─> Types now cleaned                                   │
│                                                             │
│  Constraint Stubs:                                          │
│    - call (with argumentErrorRow)                           │
│    - branch_join (with dischargesResult flag)              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2: SOLVER                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  enforceInfectiousMetadata()  ← Single-pass, error-only    │
│    ├─> Collect: infectiousCalls map                        │
│    │   └─> Union error rows: errorRowUnion()               │
│    ├─> Validate: Check types are Result<T, E>              │
│    └─> Report: infectious_call_result_mismatch             │
│                                                             │
│  Types already modified by inference                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**New System (Lazy Discharge):**

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1: INFERENCE (Pure - No Type Modification)           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  inferCall()                                                │
│    ├─> Extract error row from Result<T, E>                 │
│    ├─> Emit: constraint_source(result, error:ε)           │
│    ├─> Emit: constraint_flow(arg → result)  ← ONLY if arg is Result │
│    └─> Types unchanged (still Result<T, E>)               │
│                                                             │
│  inferMatch()                                               │
│    ├─> Check for total match (Ok + Err)                    │
│    ├─> Emit: constraint_rewrite(okBranch, remove: ε)  ← LAZY │
│    ├─> Set flag: dischargesResult = true (for validation)  │
│    └─> Types unchanged during inference                    │
│                                                             │
│  Constraint Stubs:                                          │
│    - constraint_source (explicit error introduction)        │
│    - constraint_flow (selective - only Result args)         │
│    - constraint_rewrite (deferred discharge)                │
│    - branch_join (merge points)                             │
│    - (Keep old stubs for migration)                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2: SOLVER (Constraint Graph)                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  buildConstraintFlow()  ← Build graph from stubs            │
│    ├─> labels: Map<NodeId, Set<ConstraintLabel>>          │
│    ├─> edges: Map<NodeId, Set<NodeId>>                    │
│    ├─> rewrites: Map<NodeId, {remove, add}>               │
│    └─> Constraint graph separate from types                │
│                                                             │
│  propagateConstraints()  ← Single-pass algorithm (like current)  │
│    ├─> Apply rewrites DURING propagation                   │
│    │   └─> Nested matches see cleaned constraints          │
│    ├─> Flow labels through edges (in stub creation order)  │
│    ├─> Union labels at merge points (per-domain)           │
│    └─> Single pass (no iteration needed for errors)        │
│                                                             │
│  detectConstraintConflicts()  ← Multi-domain checking       │
│    ├─> Group by domain + identity                          │
│    ├─> Check compatibility rules per domain                │
│    └─> Report: incompatible_constraints                    │
│                                                             │
│  checkReturnBoundaries()  ← Validate at returns             │
│    ├─> Check: errors reified in Result<T, E>              │
│    ├─> Check: no unfulfilled obligations                   │
│    └─> Report: boundary_violation                          │
│                                                             │
│  Types modified by solver based on constraint flow          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Differences

| Aspect                  | Current (Eager)          | New (Lazy)                     |
| ----------------------- | ------------------------ | ------------------------------ |
| **Type Modification**   | During inference         | During solving                 |
| **Discharge Location**  | `infermatch.ts`          | Solver propagation             |
| **Constraint Tracking** | Implicit (stub fields)   | Explicit (separate stubs)      |
| **Flow Representation** | Attached to calls        | Explicit flow edges            |
| **Propagation**         | Single-pass              | Single-pass (stub order)       |
| **Domain Handling**     | Hardcoded (errors only)  | Pluggable (any domain)         |
| **Nested Matches**      | Polluted by outer errors | Clean (rewrites applied first) |

### Why This Change Matters

**Problem with Eager Discharge:**

```wm
match outerResult {
  Ok(innerResult) => {
    // Eager: outer errors removed AFTER this code inferred
    // Problem: innerResult type still has outer errors during inference!
    match innerResult {
      Ok(x) => x + 1  // Type checker sees polluted type
    }
  }
}
```

**Solution with Lazy Discharge:**

```
1. Inference: Record rewrite intent at outer Ok branch
2. Solver: Build constraint graph
3. Solver: Apply rewrite BEFORE propagating to inner match
4. Result: Inner match sees clean type for innerResult
```

### Existing Infrastructure We Build On

The codebase already has most of the machinery needed:

1. **Constraint Stubs** (`src/layer1/context.ts`):
   - `ConstraintStub` union type with `call`, `branch_join`, `annotation`, etc.
   - `recordBranchJoinConstraint()` already tracks `dischargesResult` and
     `errorRowCoverage`
   - We just add new stub kinds: `constraint_source`, `constraint_flow`,
     `constraint_rewrite`

2. **Solver Phases** (`src/layer2/solver.ts`):
   - Already has phased solving: annotations → calls → numeric → branches
   - We add **Phase 5: Constraint Propagation** after type unification
   - `enforceInfectiousMetadata()` (line ~1150) is the code we're generalizing

3. **Error Row Types** (`src/types.ts`):
   - `error_row` type already exists with union/subtraction operations
   - `flattenResultType()`, `collapseResultType()`, `errorRowUnion()` already
     implemented
   - We reuse these for constraint labels!

4. **Pattern Match Discharge** (`src/layer1/infermatch.ts`):
   - `dischargedResult` flag marks when rewrites happen
   - `dischargeErrorRow()` function removes error constraints
   - `errorRowCoverage` tracks which error constructors are handled
   - This IS the rewrite operation—we just make it general

5. **Hole Tracking**:
   - `holes: Map<HoleId, UnknownInfo>` already tracks type holes
   - Conflict detection in `detectConflicts()` (solver.ts line ~1290)
   - Same machinery, just need to unify with constraint system

### Type System (Unchanged!)

```typescript
// types.ts - NO CHANGES to core Type definition
export type Type = 
  | { kind: "var"; id: number }
  | { kind: "func"; from: Type; to: Type }
  | { kind: "constructor"; name: string; args: Type[] }
  | { kind: "error_row"; cases: Map<string, Type | null>; tail?: Type | null }  // Already exists!
  | { kind: "unknown"; provenance: Provenance }
  ...
```

Inference still returns just `Type`, not `{type, obligations}`.

### Constraint IR (New)

```typescript
// types.ts or context.ts

// Identity for tracking resources, borrows, holes
export type Identity = 
  | { kind: "resource"; id: number }      // ψ - file handle, allocation
  | { kind: "borrow"; id: number }        // κ - borrow token
  | { kind: "hole"; id: number };         // α - type hole (reuse existing type var IDs)

// Constraint labels (domain-specific)
// NOTE: Error domain reuses existing ErrorRowType!
export type ConstraintLabel =
  // Error domain - the row IS the constraint
  | { domain: "error"; row: ErrorRowType }                // Reuse existing type!
  
  // Memory domain
  | { domain: "mem"; label: string; identity: Identity }  // Open[ψ], Lent[ψ], Borrowed[κ]
  
  // Hole domain - reuse existing hole tracking
  | { domain: "hole"; identity: Identity; provenance: Provenance };

// IMPORTANT: Per-domain singleton invariant
// Each node has AT MOST ONE constraint label per domain.
// Multiple sources for the same domain are merged using domain-specific rules:
// - Error domain: errorRowUnion(row1, row2)
// - Memory domain: conflict check (future)
// - Hole domain: constraint unification (future)

// Helper constructors
export function errorLabel(row: ErrorRowType): ConstraintLabel {
  return { domain: "error", row };
}

export function memLabel(label: string, identity: Identity): ConstraintLabel {
  return { domain: "mem", label, identity };
}

export function holeLabel(id: Identity, prov: Provenance): ConstraintLabel {
  return { domain: "hole", identity: id, provenance: prov };
}

// Constraint stubs (emitted during inference)
// NOTE: Most of these already exist! We just add new kinds.
export type ConstraintStub =
  // Existing stubs (in src/layer1/context.ts)
  | { kind: "call"; callee: NodeId; argument: NodeId; result: NodeId; 
      argumentErrorRow?: ErrorRowType; ... }  // Already tracks error propagation!
  | { kind: "annotation"; ... }
  | { kind: "branch_join"; 
      dischargesResult?: boolean;              // Already exists!
      errorRowCoverage?: ErrorRowCoverageStub; // Already exists!
      ... }
  
  // NEW: Constraint flow primitives (to be added)
  | { kind: "constraint_source"; 
      node: NodeId; 
      label: ConstraintLabel; }
  
  | { kind: "constraint_flow"; 
      from: NodeId; 
      to: NodeId; }
  
  | { kind: "constraint_rewrite"; 
      node: NodeId; 
      remove: ConstraintLabel[]; 
      add: ConstraintLabel[]; }
  
  | { kind: "constraint_alias"; 
      id1: Identity; 
      id2: Identity; }
  
  | { kind: "constraint_merge"; 
      inputs: NodeId[]; 
      output: NodeId; };
```

**Key Observation:** The `call` stub already has `argumentErrorRow`, and
`branch_join` already has `dischargesResult` and `errorRowCoverage`. These ARE
constraint flow tracking—we just need to generalize them!

### Solver Architecture

```typescript
// solver.ts

export function solveConstraints(input: SolveInput): SolverResult {
  const state: SolverState = { ... };

  // Phases 1-4: Type unification (UNCHANGED - existing code)
  // - Annotations
  // - Calls and field access
  // - Numeric/boolean constraints
  // - Branch joins
  solveAnnotationConstraints(state, annotationStubs);
  solveCallAndFieldConstraints(state, callAndFieldStubs);
  solveNumericBooleanConstraints(state, numericBooleanStubs);
  solveBranchJoinConstraints(state, branchStubs);
  
  // EXISTING: enforceInfectiousMetadata (line ~1150)
  // This is what we're replacing!
  // enforceInfectiousMetadata(input.constraintStubs, resolved, original, state.diagnostics);
  
  // Phase 5: Constraint propagation (NEW - replaces enforceInfectiousMetadata)
  // Uses single-pass algorithm (same as current system)
  const constraintFlow = buildConstraintFlow(input.stubs);
  propagateConstraints(constraintFlow, state);
  
  // Phase 6: Conflict detection (NEW - generalizes existing conflict detection)
  detectConstraintConflicts(constraintFlow, state);
  
  // Phase 7: Boundary checking (NEW)
  checkReturnBoundaries(constraintFlow, state);
  
  return buildResult(state);
}
```

**Migration Strategy:** Keep `enforceInfectiousMetadata` initially, run both
systems in parallel, compare outputs, then remove old system once new one works.

## Domain Specifications

Each domain defines:

1. **Labels** - what constraint states exist
2. **Conflict rules** - which labels are incompatible
3. **Boundary rules** - what's required at function returns
4. **(Optional) Carrier** - value-level reflection

### Concrete Example: How Existing Code Maps to New System

Let's trace through `aoc.wm`'s `parseMulAt` function to see how existing code
already implements constraint flow:

**Source code:**

```wm
let parseMulAt = (chars, i) => {
  let afterMul = expectMulLiteral(chars, i);  -- Returns Result<Int, <NotMul>>
  let leftStep = extendDigits(chars, readRequiredDigit(chars, afterMul), 1);
  // ...
};
```

**Current implementation (infermatch.ts, solver.ts):**

1. `expectMulLiteral` returns `Result<Int, <NotMul>>`
   - Type inference: `Result<Int, { cases: Map { "NotMul" => null } }>`
   - Stub emission: `recordCallConstraint(..., argumentErrorRow: <NotMul>)`

2. `afterMul` binds to this Result
   - Metadata tracking: `infectiousCalls.set(afterMul.id, <NotMul>)`
   - This IS constraint source + flow!

3. `readRequiredDigit(chars, afterMul)` uses `afterMul`
   - Current: Error row propagates through type unification
   - Stub tracking: Call stub records `argumentErrorRow`

4. If we had `match afterMul { Ok(x) => ..., Err(e) => ... }`:
   - Current: `dischargedResult = true` in branch_join stub
   - Current: `dischargeErrorRow()` removes error from result type
   - This IS constraint rewrite!

**New system (same semantics, general mechanism):**

1. `expectMulLiteral` call:
   ```typescript
   // Emit constraint source
   emitConstraintSource(ctx, afterMul.id, 
     errorLabel({ kind: "error_row", cases: Map { "NotMul" => null } }));
   ```

2. Using `afterMul`:
   ```typescript
   // Emit constraint flow
   emitConstraintFlow(ctx, afterMul.id, readRequiredDigit_call.id);
   ```

3. Pattern match discharge:
   ```typescript
   // Emit constraint rewrite
   emitConstraintRewrite(ctx, okBranch.id, {
     remove: [errorLabel(<NotMul>)],
     add: []
   });
   ```

4. Solver propagation:
   ```typescript
   // Build graph from stubs
   flow.labels.set(afterMul.id, Set { error:<NotMul> });
   flow.edges.set(afterMul.id, Set { readRequiredDigit_call.id });
   flow.rewrites.set(okBranch.id, { remove: [error:<NotMul>], add: [] });

   // Propagate (replaces enforceInfectiousMetadata)
   propagateConstraints(flow, state);
   ```

**The Key Insight:** The current code already does this! We're just:

- Making the implicit explicit (constraint stubs instead of metadata maps)
- Generalizing the mechanism (works for any domain, not just errors)
- Moving discharge from inference-time to solver-time (lazy evaluation)
- Unifying with holes (same conflict detection machinery)

**Compatibility Notes:**

- Keep existing `isResultType`, `flattenResultType`, `makeResultType` - these
  ARE the carrier operations (split/join)
- Remove `enforceInfectiousMetadata` and replace with new system
- Remove `dischargesResult` flag once new rewrite system is in place
- Hole tracking will be fully integrated into constraint system

### Error Domain

**Labels:**

```typescript
// Error labels are just error rows (existing type!)
{ domain: "error", row: ErrorRowType }

// Where ErrorRowType is:
{ kind: "error_row", cases: Map<string, Type | null>, tail?: Type | null }

// Examples:
error:{ cases: Map { "ParseError" => null }, tail: null }
error:{ cases: Map { "NetworkError" => StringType, "IOError" => null }, tail: null }
```

**Conflict rules:**

```
Never conflicts! Errors compose via row union (existing errorRowUnion function).
```

**Boundary rule:**

```
At return: either reified (Result<T, ε>) or empty (ε = ∅)
```

**Carrier:** `Result<T, E>` (already exists!)

- `splitCarrier(Result<T, E>) → { value: T, state: E }` (flattenResultType -
  exists!)
- `joinCarrier(T, E) → Result<T, E>` (makeResultType - exists!)
- Pattern match on `Ok` removes error labels from branches (dischargeErrorRow -
  exists!)

**Current Implementation:**

- `dischargedResult` flag in `branch_join` stub marks discharge
- `errorRowCoverage` tracks which error constructors are handled
- `enforceInfectiousMetadata()` checks that errors are handled or reified
- All we need to do is generalize this mechanism to other domains!

### Memory Domain

**Labels:**

```typescript
mem: Open[ψ]; // Resource ψ is open
mem: Closed[ψ]; // Resource ψ is closed
mem: Lent[ψ]; // Resource ψ is lent out
mem: Borrowed[κ]; // Borrow token κ is active
mem: Ended[κ]; // Borrow token κ has ended
mem: DirectRead[ψ]; // (transient) Reading resource ψ
mem: BorrowRead[κ]; // (transient) Reading borrow κ
mem: MustClose[ψ]; // (obligation) Must close ψ before return
mem: MustEnd[κ]; // (obligation) Must end κ before return
```

**Conflict rules (same identity only):**

```typescript
DirectRead[ψ] ⟂ Lent[ψ]
DirectRead[ψ] ⟂ Closed[ψ]
BorrowRead[κ] ⟂ Ended[κ]
Closed[ψ] ⟂ Open[ψ]
Open[ψ] ⟂ Lent[ψ] (at merge points)
```

**Boundary rule:**

```
At return: no MustClose[ψ]/MustEnd[κ] remaining
           no conflict pairs (Open⟂Closed, etc.)
```

**Carrier:** None (erase after checking)

### Hole Domain

**Labels:**

```typescript
hole:Unknown[α, prov]         // Hole α with provenance
hole:Constrained[α, T]        // Hole α must be type T
hole:Filled[α≈T]              // Hole α solved to T
```

**Conflict rules:**

```typescript
Constrained[α, T1] ⟂ Constrained[α, T2]  if T1 ≠ T2 (unfillable hole)
```

**Boundary rule:**

```
"Total mode": no Unknown[α] at return (must be filled)
"Hazel mode": allow Unknown[α] (live holes okay)
```

**Carrier (optional):** `Indet<T, Φ>`

- `Indet<T, Φ> = Known(T) | Unknown(Φ)`
- Allows runtime with holes: `1 + ? ⇒ Unknown(Add(Known(1), Unknown(?)))`

### Multi-Domain Example: Errors + Memory Together

To validate that domains are orthogonal, here's an example using both:

```wm
let processFile = fn(path) {
  let f = open(path);              // mem:Open[ψ], mem:MustClose[ψ]
  let data = read(f)?;             // mem:DirectRead[ψ], error:<IOError>
                                   // ? operator handles error
  close(f);                        // mem:Closed[ψ], removes MustClose[ψ]
  parseJson(data)?;                // error:<ParseError>
};
// Return type: Result<Json, <IOError | ParseError>>
// Memory constraints: Closed[ψ] (satisfied)
// Error constraints: reified in Result type (satisfied)
```

**Constraint flow:**

1. `open(path)`:
   - `source(mem:Open[ψ], f)`
   - `source(mem:MustClose[ψ], f)`

2. `read(f)`:
   - `source(error:<IOError>, data_result)`
   - `source(mem:DirectRead[ψ], read_call)` // Transient
   - Check: `DirectRead[ψ]` compatible with `Open[ψ]`? YES ✓

3. `?` operator (sugar for pattern match):
   - `rewrite(data, remove: [error:<IOError>])`
   - Error moved to function return type

4. `close(f)`:
   - `rewrite(f, remove: [mem:Open[ψ], mem:MustClose[ψ]], add: [mem:Closed[ψ]])`

5. `parseJson(data)`:
   - `source(error:<ParseError>, json_result)`
   - `?` operator: `rewrite(json, remove: [error:<ParseError>])`

6. Return boundary check:
   - Memory: No `MustClose` or `MustEnd` remaining ✓
   - Memory: No `Open` ⟂ `Closed` conflict ✓
   - Errors: `<IOError | ParseError>` reified in `Result<Json, E>` ✓

**What if we forget to close?**

```wm
let buggyProcess = fn(path) {
  let f = open(path);
  let data = read(f)?;
  // forgot close(f)!
  parseJson(data)?
};
```

Constraint flow:

- At return: `mem:MustClose[ψ]` still present
- Boundary check: ERROR - "Unfulfilled obligation: MustClose[ψ]"

**What if we use after close?**

```wm
let buggyProcess = fn(path) {
  let f = open(path);
  close(f);
  read(f)?  // ERROR!
};
```

Constraint flow:

- After `close`: `mem:Closed[ψ]`
- `read(f)`: adds transient `mem:DirectRead[ψ]`
- Conflict check: `DirectRead[ψ]` ⟂ `Closed[ψ]` → ERROR

This demonstrates:

- **Orthogonal domains**: Error and memory constraints coexist
- **Same machinery**: Both use source/flow/rewrite primitives
- **Unified checking**: Single conflict detection pass catches both issues

## Phase 1: Add Constraint IR

**Goal:** Add constraint label types and new stub kinds without changing
inference.

### 1.1: Add Identity and Label Types

**File:** `src/types.ts`

```typescript
// Identity tracking for constraints
export type Identity =
  | { kind: "resource"; id: number } // ψ
  | { kind: "borrow"; id: number } // κ
  | { kind: "hole"; id: number }; // α (reuse existing type var IDs)

let nextResourceId = 0;
let nextBorrowId = 0;

export function freshResource(): Identity {
  return { kind: "resource", id: nextResourceId++ };
}

export function freshBorrow(): Identity {
  return { kind: "borrow", id: nextBorrowId++ };
}

// Constraint labels
export type ConstraintLabel =
  | { domain: "error"; label: string }
  | { domain: "mem"; label: string; identity: Identity }
  | { domain: "hole"; identity: Identity; provenance: Provenance };

export function errorLabel(label: string): ConstraintLabel {
  return { domain: "error", label };
}

export function memLabel(label: string, identity: Identity): ConstraintLabel {
  return { domain: "mem", label, identity };
}

export function holeLabel(
  identity: Identity,
  provenance: Provenance,
): ConstraintLabel {
  return { domain: "hole", identity, provenance };
}

// Helper: check if two labels refer to same identity
export function sameIdentity(id1: Identity, id2: Identity): boolean {
  return id1.kind === id2.kind && id1.id === id2.id;
}

// Helper: format label for display
export function formatLabel(label: ConstraintLabel): string {
  switch (label.domain) {
    case "error":
      return `<${label.label}>`;
    case "mem":
      return `${label.label}[${formatIdentity(label.identity)}]`;
    case "hole":
      return `Unknown[${formatIdentity(label.identity)}]`;
  }
}

function formatIdentity(id: Identity): string {
  switch (id.kind) {
    case "resource":
      return `ψ${id.id}`;
    case "borrow":
      return `κ${id.id}`;
    case "hole":
      return `α${id.id}`;
  }
}
```

**Testing:**

- Create labels for each domain
- Format labels for display
- Identity equality checks

### 1.2: Add Constraint Stub Kinds

**File:** `src/layer1/context.ts`

**Current code (lines 158-207):**

```typescript
export type ConstraintStub =
  | {
    kind: "call";
    origin: NodeId;
    callee: NodeId;
    argument: NodeId;
    result: NodeId;
    resultType: Type;
    index: number;
    argumentValueType?: Type;
    argumentErrorRow?: ErrorRowType; // ← EXISTING implicit constraint tracking
  }
  | {
    kind: "branch_join"; // ← EXISTING merge point tracking
    origin: NodeId;
    scrutinee: NodeId | null;
    branches: NodeId[];
    dischargesResult?: boolean; // ← EXISTING rewrite flag
    errorRowCoverage?: ErrorRowCoverageStub; // ← EXISTING coverage tracking
  }
  | { kind: "annotation" /* ... */ }
  | { kind: "has_field" /* ... */ }
  | { kind: "numeric" /* ... */ }
  | { kind: "boolean" /* ... */ };
```

**Add new constraint stub kinds:**

```typescript
// Add to existing ConstraintStub union (after line 207)
export type ConstraintStub =
  // ... existing kinds above ...

  // NEW: Explicit constraint flow primitives
  | { kind: "constraint_source"; node: NodeId; label: ConstraintLabel }
  | { kind: "constraint_flow"; from: NodeId; to: NodeId }
  | {
    kind: "constraint_rewrite";
    node: NodeId;
    remove: ConstraintLabel[];
    add: ConstraintLabel[];
  }
  | { kind: "constraint_alias"; id1: Identity; id2: Identity };

// NOTE: constraint_merge is NOT needed - branch_join already does this!

// Helper functions to emit constraint stubs (add after existing record* functions)
export function emitConstraintSource(
  ctx: Context,
  node: NodeId,
  label: ConstraintLabel,
): void {
  ctx.constraintStubs.push({ kind: "constraint_source", node, label });
}

export function emitConstraintFlow(
  ctx: Context,
  from: NodeId,
  to: NodeId,
): void {
  ctx.constraintStubs.push({ kind: "constraint_flow", from, to });
}

export function emitConstraintRewrite(
  ctx: Context,
  node: NodeId,
  remove: ConstraintLabel[],
  add: ConstraintLabel[],
): void {
  ctx.constraintStubs.push({ kind: "constraint_rewrite", node, remove, add });
}

export function emitConstraintAlias(
  ctx: Context,
  id1: Identity,
  id2: Identity,
): void {
  ctx.constraintStubs.push({ kind: "constraint_alias", id1, id2 });
}
```

**Migration Notes:**

- Keep existing `argumentErrorRow`, `dischargesResult`, and `errorRowCoverage`
  fields during migration
- `branch_join` already handles merge semantics - no need for separate
  `constraint_merge`
- Recording functions like `recordCallConstraint()` already exist (lines
  211-233)

**Testing:**

- Emit each new stub kind
- Verify stubs are collected in `ctx.constraintStubs` array
- Ensure existing stubs continue working (backward compatibility)

## Phase 2: Emit Error Domain Constraints

**Goal:** Replace hardcoded Result infection with error domain constraints.

### 2.1: Emit Sources for Result-Returning Functions

**File:** `src/layer1/infer.ts`

**Current implementation (lines ~790-830):**

```typescript
// When inferring calls - EXISTING CODE
let argumentErrorRow: ErrorRowType | undefined;
const argResultInfo = flattenResultType(argType);
if (argResultInfo) {
  argumentErrorRow = argResultInfo.error; // ← Implicit constraint source
}

recordCallConstraint(
  ctx,
  expr,
  expr.callee,
  argExpr,
  expr,
  resultType,
  index,
  argumentValueType,
  argumentErrorRow, // ← Error row attached to call stub
);
```

**Add explicit constraint emission (parallel to existing code):**

```typescript
// When inferring a call that returns Result<T, E>
case "call": {
  // ... existing inference ...
  
  const resultType = /* ... compute result type ... */;
  const resolvedResult = applyCurrentSubst(ctx, resultType);
  
  // EXISTING: Check if result is Result type
  const resultInfo = flattenResultType(resolvedResult);
  
  // NEW: Emit explicit constraint source for each error variant
  if (resultInfo) {
    // Extract error row (entire ErrorRowType, not individual labels)
    const errorRow = resultInfo.error;
    
    // Emit constraint source with error row
    emitConstraintSource(ctx, expr.id, errorLabel(errorRow));
    
    // TODO: Eventually replace argumentErrorRow with this
  }
  
  // NEW: Emit flow constraint for call propagation
  // Calls always propagate constraints from callee and arguments to result
  emitConstraintFlow(ctx, expr.callee.id, expr.id);
  for (const arg of expr.arguments) {
    emitConstraintFlow(ctx, arg.id, expr.id);
  }
  
  return resultType;
}

// Helper: error label from error row
function errorLabel(row: ErrorRowType): ConstraintLabel {
  return { domain: "error", row };  // Store entire row, not individual labels
}
```

**Migration Strategy:**

1. **Phase 1:** Emit new stubs alongside existing `argumentErrorRow` tracking
2. **Phase 2:** Run both systems in parallel, compare outputs
3. **Phase 3:** Switch to new system, deprecate `argumentErrorRow`
4. **Phase 4:** Remove old field once migration complete

**Testing:**

- Simple Result-returning function emits source constraint
- Error row contains correct constructors
- Both old and new systems produce same diagnostics

### 2.2: Emit Flow for Value Uses

**File:** `src/layer1/infer.ts`

**Important insight**: The current system is **already optimized**! It only
tracks error flow through **call arguments** via `argumentErrorRow`. Other
expressions (binary ops, tuples, identifiers) rely on **implicit propagation**
via type unification — error rows flow through the types themselves.

**Strategy**: Match the current system's optimization. Do NOT emit
`constraint_flow` edges for most expressions. Only emit where the current system
explicitly tracks (call arguments with Result types).

```typescript
// When referencing an identifier
case "identifier": {
  const scheme = ctx.env.get(expr.name);
  if (!scheme) {
    const mark = markFreeVariable(ctx, expr, expr.name);
    ctx.nodeTypes.set(expr, mark.type);
    return mark.type;
  }
  
  const instantiated = instantiateAndApply(ctx, scheme);
  
  // NEW: Check if this identifier's type has error constraints
  // Error rows are IN the type (Result<T, E>), extract at use site
  const resultInfo = flattenResultType(instantiated);
  if (resultInfo) {
    emitConstraintSource(ctx, expr.id, { domain: "error", row: resultInfo.error });
  }
  
  // NO constraint_flow needed - implicit propagation via types!
  
  return recordExprType(ctx, expr, instantiated);
}

// Binary operations - NO explicit flow edges needed
case "binary": {
  // ... existing inference ...
  
  // NO CHANGE: Binary ops already propagate via type unification
  // Error rows flow through the Result<T, E> types automatically
  
  return resultType;
}

// Call expressions - ONLY place we emit explicit flow
case "call": {
  // ... existing inference ...
  
  // NEW: Only emit flow for arguments that have Result types
  // This matches current system's argumentErrorRow tracking
  for (const arg of expr.arguments) {
    const argType = applyCurrentSubst(ctx, inferExpr(ctx, arg));
    if (flattenResultType(argType)) {
      // Argument has errors - emit explicit flow (replaces argumentErrorRow)
      emitConstraintFlow(ctx, arg.id, expr.id);
    }
  }
  
  return resultType;
}

// Tuple/record construction - NO explicit flow edges needed
case "tuple": {
  // ... existing inference ...
  
  // NO CHANGE: Constraints flow implicitly through element types
  
  return resultType;
}
```

**Key insight**: Error constraints flow **through types** in the current system.
The new system preserves this optimization: 3. No need to track binding
locations - types carry the information!

**Why this is better than emitting flow everywhere:**

- **Fewer constraint stubs** = less overhead
- **Matches current system's performance** characteristics
- **Error domain doesn't need explicit flow** (propagation via types works!)
- **Future domains** (memory/caps) can add explicit flow in Phase 5 if needed

### 2.3: Emit Rewrite for Pattern Matches

**File:** `src/layer1/infermatch.ts`

**Current implementation (lines 285-350):**

```typescript
export function inferMatchBranches(
  ctx: Context,
  expr: Expr,
  scrutineeType: Type,
  bundle: MatchBundle,
  exhaustive: boolean = true,
  scrutineeExpr?: Expr,
): MatchBranchesResult {
  // ... pattern matching logic ...

  let resolvedResult = applyCurrentSubst(ctx, resultType);
  const scrutineeInfo = flattenResultType(resolvedScrutinee);

  // EXISTING: Eager discharge during inference
  const dischargeErrorRow = () => {
    const currentInfo = flattenResultType(resolvedResult);
    if (currentInfo) {
      resolvedResult = applyCurrentSubst(
        ctx,
        collapseResultType(currentInfo.value), // ← Strips error row from type
      );
    }
  };

  // Check for total match (Ok + Err coverage)
  if (hasAllErrors && !preventsDischarge) {
    dischargedResult = true;
    dischargeErrorRow(); // ← HAPPENS DURING INFERENCE!
  } else if (scrutineeInfo && hasErrConstructor) {
    const missingConstructors = findMissingErrorConstructors(
      scrutineeInfo.error,
      handledErrorConstructors,
    );
    if (missingConstructors.length === 0 && !preventsDischarge) {
      dischargedResult = true;
      dischargeErrorRow(); // ← HAPPENS DURING INFERENCE!
    }
  }

  // Record branch join with discharge flag
  recordBranchJoinConstraint(
    ctx,
    expr,
    branchBodies,
    scrutineeExpr,
    {
      dischargesResult: dischargedResult, // ← Flag for solver
      errorRowCoverage,
    },
  );
}
```

**Add lazy discharge (parallel to existing code):**

```typescript
export function inferMatchBranches(
  ctx: Context,
  expr: Expr,
  scrutineeType: Type,
  bundle: MatchBundle,
  exhaustive: boolean = true,
  scrutineeExpr?: Expr,
): MatchBranchesResult {
  // ... existing pattern matching logic ...

  const scrutineeInfo = flattenResultType(resolvedScrutinee);

  // EXISTING: Keep eager discharge for now (backward compatibility)
  const dischargeErrorRow = () => {/* ... */};

  if (scrutineeInfo) {
    // Check for total match (both Ok and Err)
    const hasOk = bundle.branches.some((b) =>
      b.pattern.kind === "constructor" && b.pattern.name === "Ok"
    );
    const hasErr = bundle.branches.some((b) =>
      b.pattern.kind === "constructor" && b.pattern.name === "Err"
    );

    if (hasOk && hasErr && !preventsDischarge) {
      // NEW: Emit lazy rewrite for solver
      // Extract all error constructors from error row
      const errorRow = scrutineeInfo.error;

      // Emit rewrite to remove error labels in Ok branch
      for (const branch of bundle.branches) {
        if (
          branch.pattern.kind === "constructor" && branch.pattern.name === "Ok"
        ) {
          // Ok branch: remove all error labels
          emitConstraintRewrite(
            ctx,
            branch.body.id,
            [errorLabel(errorRow)],
            [],
          );
        }
        // Err branch: errors still present (you're handling them)
      }

      // EXISTING: Still mark as discharging for validation
      dischargedResult = true;
      dischargeErrorRow(); // Keep for now
    }
  }

  // EXISTING: Record branch join (already handles merge semantics)
  recordBranchJoinConstraint(
    ctx,
    expr,
    branchBodies,
    scrutineeExpr,
    {
      dischargesResult: dischargedResult,
      errorRowCoverage,
    },
  );

  return result;
}
```

**Key Insight:**

Pattern matching creates **new bindings** in branches. When you write:

```wm
match result {
  Ok(x) => x + 1,  // x is extracted from Result<T, E>, so it has type T (not Result)
  Err(e) => 0
}
```

The variable `x` is a **new binding** with the extracted type `T`. The rewrite
removes error constraints **at branch entry**, so the body sees clean types.

**Migration Strategy:**

1. Keep both eager (inference) and lazy (solver) discharge initially
2. Validate they produce same results
3. Gradually shift to solver-only discharge
4. Remove eager discharge once validated

**Testing:**

- Simple Result pattern match emits rewrite
- Total match (Ok + Err) emits discharge for Ok branch
- Partial match doesn't emit discharge
- Nested matches work correctly with lazy discharge

## Phase 3: Constraint Propagation Solver

**Goal:** Build constraint flow graph and propagate labels to fixed point.

**Note:** This generalizes the existing `enforceInfectiousMetadata` function
(solver.ts lines 1149-1289) to work for all domains, not just errors.

**Current implementation:**

```typescript
// solver.ts lines 1149-1289
function enforceInfectiousMetadata(
  stubs: ConstraintStub[],
  resolved: Map<NodeId, Type>,
  original: Map<NodeId, Type>,
  diagnostics: ConstraintDiagnostic[],
): void {
  const infectiousCalls = new Map<NodeId, ErrorRowType>(); // ← Constraint labels!
  const dischargedMatches = new Map<NodeId, ErrorRowCoverageStub | undefined>();

  // Phase 1: Collect sources
  for (const stub of stubs) {
    if (stub.kind === "call" && stub.argumentErrorRow) {
      // Accumulate error rows (union operation)
      const existing = infectiousCalls.get(stub.result);
      if (existing) {
        infectiousCalls.set(
          stub.result,
          errorRowUnion(existing, stub.argumentErrorRow),
        );
      } else {
        infectiousCalls.set(stub.result, stub.argumentErrorRow);
      }
    } else if (stub.kind === "branch_join" && stub.dischargesResult) {
      dischargedMatches.set(stub.origin, stub.errorRowCoverage);
    }
  }

  // Phase 2: Check boundaries
  for (const nodeId of infectiousCalls.keys()) {
    const nodeType = resolved.get(nodeId);
    if (!flattenResultType(nodeType)) {
      // ERROR: Has error constraints but not Result type
      diagnostics.push({
        origin: nodeId,
        reason: "infectious_call_result_mismatch",
      });
    }
  }

  // Similar checks for annotations, field access, etc.
}
```

**This IS constraint propagation!** It's just:

- Single-pass (no iteration/worklist)
- Domain-specific (hardcoded to errors)
- Implicit flow (via call stubs, not explicit edges)

### 3.1: Build Constraint Flow Graph

**File:** `src/layer2/solver.ts`

```typescript
// Constraint flow graph
interface ConstraintFlow {
  // Which labels are on which nodes
  // IMPORTANT: Per-domain singleton - each node has at most one label per domain
  labels: Map<NodeId, Map<string, ConstraintLabel>>; // domain → label

  // Flow edges (from → to)
  edges: Map<NodeId, Set<NodeId>>;

  // Rewrites to apply at each node
  rewrites: Map<NodeId, { remove: ConstraintLabel[]; add: ConstraintLabel[] }>;

  // Alias equivalence classes (union-find)
  aliases: UnionFind<Identity>;
}

function buildConstraintFlow(stubs: ConstraintStub[]): ConstraintFlow {
  const flow: ConstraintFlow = {
    labels: new Map(),
    edges: new Map(),
    rewrites: new Map(),
    aliases: new UnionFind<Identity>(sameIdentity),
  };

  // Phase 1: Collect sources
  for (const stub of stubs) {
    if (stub.kind === "constraint_source") {
      const domainMap = flow.labels.get(stub.node) ?? new Map();
      // Per-domain singleton: merge if already exists
      const existing = domainMap.get(stub.label.domain);
      if (existing && stub.label.domain === "error") {
        // Error domain: union rows
        const merged = errorRowUnion(existing.row, stub.label.row);
        domainMap.set("error", { domain: "error", row: merged });
      } else {
        domainMap.set(stub.label.domain, stub.label);
      }
      flow.labels.set(stub.node, domainMap);
    }
  }

  // Phase 2: Collect flow edges
  for (const stub of stubs) {
    if (stub.kind === "constraint_flow") {
      const existing = flow.edges.get(stub.from) ?? new Set();
      existing.add(stub.to);
      flow.edges.set(stub.from, existing);
    }
  }

  // Phase 3: Collect rewrites
  for (const stub of stubs) {
    if (stub.kind === "constraint_rewrite") {
      flow.rewrites.set(stub.node, {
        remove: stub.remove,
        add: stub.add,
      });
    }
  }

  // Phase 4: Build alias union-find
  for (const stub of stubs) {
    if (stub.kind === "constraint_alias") {
      flow.aliases.union(stub.id1, stub.id2);
    }
  }

  return flow;
}
```

### 3.2: Propagate Labels to Fixed Point

**File:** `src/layer2/solver.ts`

**Note:** The current system uses a **single-pass** algorithm (see
`enforceInfectiousMetadata` in solver.ts). This works because:

- Error propagation is monotonic (only adds, never removes)
- Flow is implicit via type unification during inference
- Discharge happens during inference (types already modified)

For the new system, we'll start with the same single-pass approach. A
worklist/fixed-point iteration may be needed later for complex multi-domain
interactions, but it's not required for the initial error domain generalization.

#### 3.2.1: Propagation Algorithm Pseudocode

The current `enforceInfectiousMetadata` already implements constraint
propagation for the error domain. Here's how to generalize it:

```typescript
function propagateConstraints(
  flow: ConstraintFlow,
  stubs: ConstraintStub[],
): void {
  // CRITICAL: Process stubs in creation order (follows inference traversal)
  // This gives parent-before-child ordering for nested matches

  for (const stub of stubs) {
    if (stub.kind === "constraint_source") {
      // Add label to node (merged during buildConstraintFlow)
      // Already handled in buildConstraintFlow
    } else if (stub.kind === "constraint_flow") {
      // Propagate from source to target
      const fromLabels = flow.labels.get(stub.from);
      if (!fromLabels) continue;

      const toLabels = flow.labels.get(stub.to) ?? new Map();

      for (const [domain, label] of fromLabels.entries()) {
        const existing = toLabels.get(domain);
        if (existing && domain === "error") {
          // Error domain: union rows
          const merged = errorRowUnion(existing.row, label.row);
          toLabels.set("error", { domain: "error", row: merged });
        } else if (!existing) {
          toLabels.set(domain, label);
        }
        // Other domains: handle in their conflict rules
      }
      flow.labels.set(stub.to, toLabels);
    } else if (stub.kind === "constraint_rewrite") {
      // Apply rewrite DURING propagation (critical for nested matches)
      const labels = flow.labels.get(stub.node);
      if (!labels) continue;

      for (const removeLabel of stub.remove) {
        labels.delete(removeLabel.domain); // Remove by domain
      }
      for (const addLabel of stub.add) {
        labels.set(addLabel.domain, addLabel);
      }
    } else if (stub.kind === "branch_join") {
      // Union labels from all branches
      const merged = new Map<string, ConstraintLabel>();

      for (const branchId of stub.branches) {
        const branchLabels = flow.labels.get(branchId);
        if (!branchLabels) continue;

        for (const [domain, label] of branchLabels.entries()) {
          const existing = merged.get(domain);
          if (existing && domain === "error") {
            // Error domain: union rows
            const unionRow = errorRowUnion(existing.row, label.row);
            merged.set("error", { domain: "error", row: unionRow });
          } else if (!existing) {
            merged.set(domain, label);
          }
          // Other domains: conflict checking happens later
        }
      }
      flow.labels.set(stub.origin, merged);
    }
  }
}
```

**Key insight**: Processing stubs in creation order naturally gives topological
ordering because:

1. Stubs are created during inference tree traversal
2. Inference visits parent expressions before children
3. This ensures rewrites are applied before constraints propagate to nested
   expressions

**Why in-place mutation works:** Each node processes its rewrites before any
dependent nodes see its constraints. The single-pass traversal respects
data-flow dependencies because stub creation follows inference order.

**Note on termination**: The single-pass approach works for errors because:

- Constraints only flow forward through the program
- Rewrites are applied at well-defined points (pattern matches)
- No cycles in the constraint dependency graph

For future multi-domain support with more complex interactions, a worklist
algorithm with fixed-point iteration may be needed. The implementation can be
changed based on actual requirements.

## Phase 4: Conflict Detection

**Goal:** Check for incompatible labels at merge points and returns.

### 4.1: Domain Conflict Rules

**File:** `src/layer2/conflict_rules.ts` (new file)

```typescript
import type { ConstraintLabel, Identity } from "../types.ts";
import { sameIdentity } from "../types.ts";

// Per-domain conflict rules
export interface ConflictRule {
  check: (label1: ConstraintLabel, label2: ConstraintLabel) => boolean;
  message: (label1: ConstraintLabel, label2: ConstraintLabel) => string;
}

// Error domain: never conflicts (row union)
function errorConflict(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  return false; // Errors compose via union
}

// Memory domain: check incompatibilities on same identity
function memConflict(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  if (label1.domain !== "mem" || label2.domain !== "mem") return false;

  // Must be same identity to conflict
  if (!sameIdentity(label1.identity, label2.identity)) return false;

  const l1 = label1.label;
  const l2 = label2.label;

  // Conflict table (symmetric)
  const conflicts: [string, string][] = [
    ["DirectRead", "Lent"],
    ["DirectRead", "Closed"],
    ["BorrowRead", "Ended"],
    ["Closed", "Open"],
    ["Open", "Lent"], // At merge points
  ];

  for (const [a, b] of conflicts) {
    if ((l1 === a && l2 === b) || (l1 === b && l2 === a)) {
      return true;
    }
  }

  return false;
}

function memConflictMessage(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): string {
  return `Cannot combine ${label1.label} and ${label2.label} on same resource`;
}

// Hole domain: conflicting required types
function holeConflict(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  if (label1.domain !== "hole" || label2.domain !== "hole") return false;

  // TODO: check if constrained to different types
  return false; // Placeholder
}

// Export conflict rules per domain
export const CONFLICT_RULES = new Map<string, ConflictRule>([
  ["error", { check: errorConflict, message: () => "" }],
  ["mem", { check: memConflict, message: memConflictMessage }],
  ["hole", { check: holeConflict, message: () => "Unfillable hole" }],
]);

export function areIncompatible(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  const rule = CONFLICT_RULES.get(label1.domain);
  if (!rule) return false;
  return rule.check(label1, label2);
}

export function conflictMessage(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): string {
  const rule = CONFLICT_RULES.get(label1.domain);
  if (!rule) return "Incompatible constraints";
  return rule.message(label1, label2);
}
```

### 4.2: Detect Conflicts at Merge Points

**File:** `src/layer2/solver.ts`

```typescript
import { areIncompatible, conflictMessage } from "./conflict_rules.ts";

function detectConstraintConflicts(
  flow: ConstraintFlow,
  state: SolverState,
): void {
  // Check conflicts at every node
  for (const [node, domainLabels] of flow.labels.entries()) {
    // Convert Map<string, ConstraintLabel> to array for pairwise checking
    const labelArray = Array.from(domainLabels.values());

    // Check pairs within each node
    for (let i = 0; i < labelArray.length; i++) {
      for (let j = i + 1; j < labelArray.length; j++) {
        const label1 = labelArray[i];
        const label2 = labelArray[j];

        if (areIncompatible(label1, label2)) {
          state.diagnostics.push({
            origin: node,
            reason: "incompatible_constraints",
            details: {
              label1: formatLabel(label1),
              label2: formatLabel(label2),
              message: conflictMessage(label1, label2),
            },
          });
        }
      }
    }
  }
}
```

**Note**: We only check for conflicts between different domains at the same
node. Same-domain conflicts are handled by domain-specific merge logic (e.g.,
error rows union, memory labels require same identity to conflict).

**Testing:**

- No conflict: different identities, compatible labels
- Conflict: DirectRead[ψ] ⟂ Lent[ψ] on same identity
- Conflict: BorrowRead[κ] ⟂ Ended[κ]
- Error labels never conflict (always union)

## Phase 5: Boundary Checking

**Goal:** Verify constraints are properly handled at return boundaries.

### 5.1: Return Boundary Rules

**File:** `src/layer2/boundary_rules.ts` (new file)

```typescript
import type { ConstraintLabel, Type } from "../types.ts";
import { flattenResultType } from "../types.ts";

export interface BoundaryRule {
  check: (labels: Set<ConstraintLabel>, returnType: Type) => string | null;
}

// Error domain: must be reified in Result or empty
function errorBoundary(
  labels: Set<ConstraintLabel>,
  returnType: Type,
): string | null {
  const errorLabels = Array.from(labels).filter((l) => l.domain === "error");
  if (errorLabels.length === 0) return null; // No errors, OK

  // Check if return type is Result
  const resultInfo = flattenResultType(returnType);
  if (resultInfo) {
    // Error is reified in Result type - OK
    return null;
  }

  // Errors not captured!
  const errorNames = errorLabels.map((l) => l.label).join(", ");
  return `Undischarged errors: <${errorNames}>. Return type must be Result<T, E> or errors must be handled with pattern matching.`;
}

// Memory domain: no MustClose/MustEnd obligations
function memBoundary(
  labels: Set<ConstraintLabel>,
  returnType: Type,
): string | null {
  const obligations = Array.from(labels).filter((l) =>
    l.domain === "mem" && (l.label === "MustClose" || l.label === "MustEnd")
  );

  if (obligations.length === 0) return null; // OK

  const obligationNames = obligations.map((l) =>
    `${l.label}[${formatIdentity(l.identity)}]`
  ).join(", ");
  return `Unfulfilled obligations: ${obligationNames}. Resources must be properly closed/ended before return.`;
}

// Hole domain: depends on mode
function holeBoundary(
  labels: Set<ConstraintLabel>,
  returnType: Type,
): string | null {
  const unknownHoles = Array.from(labels).filter((l) =>
    l.domain === "hole" && !isFilled(l)
  );

  if (unknownHoles.length === 0) return null; // OK

  // TODO: Check mode (Total vs Hazel)
  const isHazelMode = true; // Placeholder
  if (isHazelMode) {
    return null; // Live holes allowed
  }

  return `Unfilled holes at return. All type holes must be resolved.`;
}

function isFilled(label: ConstraintLabel): boolean {
  // TODO: check if hole is filled
  return false; // Placeholder
}

export const BOUNDARY_RULES = new Map<string, BoundaryRule>([
  ["error", { check: errorBoundary }],
  ["mem", { check: memBoundary }],
  ["hole", { check: holeBoundary }],
]);
```

### 5.2: Check Returns

**File:** `src/layer2/solver.ts`

```typescript
import { BOUNDARY_RULES } from "./boundary_rules.ts";

function checkReturnBoundaries(
  flow: ConstraintFlow,
  state: SolverState,
  resolved: Map<NodeId, Type>,
  program: MProgram, // Need access to AST structure
): void {
  // Walk all function declarations (top-level and nested)
  function checkFunction(decl: MLetDeclaration) {
    // Return position is body.result or body itself
    const returnNodeId = decl.body.result?.id ?? decl.body.id;
    const labels = flow.labels.get(returnNodeId);
    const returnType = resolved.get(returnNodeId);

    if (!labels || !returnType) return;

    // Check each domain's boundary rules
    for (const [domain, rule] of BOUNDARY_RULES.entries()) {
      // Convert Map<string, ConstraintLabel> to Set<ConstraintLabel> for rules
      const labelSet = new Set(labels.values());
      const error = rule.check(labelSet, returnType);
      if (error) {
        state.diagnostics.push({
          origin: returnNodeId,
          reason: "boundary_violation",
          details: {
            domain,
            message: error,
            functionName: decl.name, // Include function name in error
          },
        });
      }
    }

    // Recursively check nested functions
    if (decl.body.kind === "block") {
      for (const stmt of decl.body.statements) {
        if (stmt.kind === "let_statement") {
          checkFunction(stmt.declaration);
        }
      }
    }
  }

  // Check all top-level function declarations
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      checkFunction(decl);
    }
  }
}
```

**Note on nested functions**: The language has let-statements in blocks, but
these can contain arrow function expressions. The recursive traversal handles
both:

```wm
let outer = () => {
  let x = 5;              // Local binding (not a function)
  let inner = () => { ... };  // Nested arrow function (check this too!)
  inner()
};
```

**Testing:**

- Return Result<T, E> with error labels: OK
- Return T with error labels: ERROR
- Return with MustClose[ψ]: ERROR
- Return with closed resource: OK
- Nested function with errors: checked separately

## Phase 6: Migrate Existing Result Code

**Goal:** Remove hardcoded Result logic and use constraint system.

### 6.1: Keep These Helpers (Used by Carrier System)

**File:** `src/types.ts`

**Current code (lines 35-135) - Keep these functions:**

```typescript
// These ARE the carrier operations for error domain!
// Already implemented and working:

export function flattenResultType(type: Type): ResultTypeInfo | null;
// ^^^^ Split carrier: Result<T, E> → { value: T, error: E }
// Used for extracting error rows from Result types

export function makeResultType(value: Type, error?: Type): Type;
// ^^^^ Join carrier: T + E → Result<T, E>
// Used for constructing Result types with error rows

export function collapseResultType(type: Type): Type;
// ^^^^ Remove carrier: Result<T, E> → T (strips error row)
// Currently used in eager discharge

export function errorRowUnion(left: Type, right: Type): ErrorRowType;
// ^^^^ Row merge operation (domain join)
// Used for combining error rows from multiple branches

export function isResultType(type: Type): boolean;
// ^^^^ Type guard for Result<T, E>

export function ensureErrorRow(type: Type): ErrorRowType;
// ^^^^ Normalize to error row type

export type ErrorRowType = Extract<Type, { kind: "error_row" }>;
// ^^^^ Already exists! Structure:
// { kind: "error_row", cases: Map<string, Type | null>, tail?: Type | null }
```

These functions are the bridge between:

1. **Type system** (Result<T, E> as a type)
2. **Constraint system** (error rows as constraint labels)

**Do NOT remove these!** They serve as:

- Carrier operations (split/join) for error domain
- Row operations (union/merge) for constraint labels
- Type utilities used throughout the codebase

**Migration Path:**

1. Keep all existing functions (lines 35-135 of types.ts)
2. Add new constraint label types (Identity, ConstraintLabel)
3. Constraint system uses ErrorRowType directly
4. Eventually: add explicit carrier system on top of constraints

### 6.2: Replace Infectious Metadata Checking

**File:** `src/layer2/solver.ts`

The existing `enforceInfectiousMetadata` function (lines 1149-1289) should be
replaced by the constraint conflict detection.

**Current code pattern (lines 1149-1289):**

```typescript
function enforceInfectiousMetadata(
  stubs: ConstraintStub[],
  resolved: Map<NodeId, Type>,
  original: Map<NodeId, Type>,
  diagnostics: ConstraintDiagnostic[],
): void {
  const infectiousCalls = new Map<NodeId, ErrorRowType>();
  const dischargedMatches = new Map<NodeId, ErrorRowCoverageStub | undefined>();

  // Collect infectious calls
  for (const stub of stubs) {
    if (stub.kind === "call" && stub.argumentErrorRow) {
      // Track error rows per node (this IS constraint tracking!)
      const existing = infectiousCalls.get(stub.result);
      if (existing) {
        infectiousCalls.set(
          stub.result,
          errorRowUnion(existing, stub.argumentErrorRow),
        );
      } else {
        infectiousCalls.set(stub.result, stub.argumentErrorRow);
      }
    } else if (stub.kind === "branch_join" && stub.dischargesResult) {
      dischargedMatches.set(stub.origin, stub.errorRowCoverage);
    }
  }

  // Check boundaries
  for (const nodeId of infectiousCalls.keys()) {
    const nodeType = getNodeType(nodeId);
    if (!flattenResultType(nodeType)) {
      // ERROR: Has errors but not Result type
      diagnostics.push({
        origin: nodeId,
        reason: "infectious_call_result_mismatch",
      });
    }
  }

  // ... more checks for annotations, field access, etc. ...
}
```

**This function already does:**

1. ✅ Collect constraint sources (infectiousCalls map)
2. ✅ Propagate constraints (errorRowUnion for merging)
3. ✅ Check boundaries (validate Result types)
4. ✅ Handle discharge (dischargedMatches tracking)

**Migration approach:**

1. **Phase 1**: Keep the function initially, mark as deprecated
   ```typescript
   // DEPRECATED: This will be removed once constraint system is complete
   // Use propagateConstraints() + detectConstraintConflicts() instead
   function enforceInfectiousMetadata(...) {
     // ... existing code ...
   }
   ```

2. **Phase 2**: Add new `propagateConstraints()` alongside it
   ```typescript
   export function solveConstraints(input: SolveInput): SolverResult {
     // ... phases 1-4: type unification (UNCHANGED) ...

     // OLD SYSTEM (keep for validation)
     enforceInfectiousMetadata(
       input.constraintStubs,
       resolved,
       original,
       state.diagnostics,
     );
     const oldDiagnostics = [...state.diagnostics];

     // NEW SYSTEM (parallel execution)
     const constraintFlow = buildConstraintFlow(input.constraintStubs);
     propagateConstraints(constraintFlow, state);
     detectConstraintConflicts(constraintFlow, state);
     checkReturnBoundaries(constraintFlow, state, resolved);
     const newDiagnostics = [...state.diagnostics];

     // Compare outputs (development only)
     if (VALIDATE_MIGRATION) {
       compareDiagnostics(oldDiagnostics, newDiagnostics);
     }

     return buildResult(state);
   }
   ```

3. **Phase 3**: Run both systems, compare diagnostics
   - Validate same errors detected
   - Verify same boundary violations found
   - Check performance (new system may be slower initially)

4. **Phase 4**: Switch to new system once validated
   ```typescript
   // Remove call to enforceInfectiousMetadata
   // Use only new constraint system
   const constraintFlow = buildConstraintFlow(input.constraintStubs);
   propagateConstraints(constraintFlow, state);
   detectConstraintConflicts(constraintFlow, state);
   checkReturnBoundaries(constraintFlow, state, resolved);
   ```

5. **Phase 5**: Delete old function after migration complete

**Testing:**

- Run full test suite with both systems
- Compare diagnostic outputs
- Verify no regressions
- Performance benchmarking

## Phase 7: Add Memory Domain (Proof of Generality)

**Goal:** Implement memory safety via constraint conflicts.

### 7.1: Define Memory Operations

**File:** `std/mem.wm` (new)

```wm
// Memory management via incompatible constraint labels
// No explicit regions - they're implicit in constraint flow!

let open : Path -> File
  // Emits: source(mem:Open[ψ], mem:MustClose[ψ])
  = native("fs_open");

let borrow_sh : File -> File
  // Input has Open[ψ]
  // Emits: source(mem:Borrowed[κ], mem:MustEnd[κ])
  //        rewrite(file, add: mem:Lent[ψ])
  //        alias(κ ≡ ψ)
  = native("mem_borrow_shared");

let end_sh : File -> Unit
  // Input has Borrowed[κ]
  // Emits: rewrite(file, remove: Borrowed[κ], MustEnd[κ], add: Ended[κ])
  = native("mem_end_shared");

let read : File -> Result<Bytes, <IO>>
  // Emits: (transient) mem:DirectRead[ψ] at call site
  // Conflicts with Lent[ψ], Closed[ψ], Ended[ψ]
  = native("fs_read");

let close : File -> Unit
  // Input has Open[ψ]
  // Emits: rewrite(file, remove: Open[ψ], MustClose[ψ], add: Closed[ψ])
  = native("fs_close");
```

### 7.2: Implement Native Function Constraint Emission

**File:** `src/layer1/infer.ts`

```typescript
// When inferring call to native function with constraint metadata
function inferNativeCall(ctx: Context, callee: string, args: Expr[]): Type {
  // Look up native function metadata
  const metadata = NATIVE_METADATA.get(callee);
  if (!metadata) {
    // Regular native call
    return inferRegularCall(ctx, callee, args);
  }
  
  // Emit constraints based on metadata
  for (const constraint of metadata.emits) {
    switch (constraint.kind) {
      case "source":
        emitConstraintSource(ctx, /* node */, constraint.label);
        break;
      case "rewrite":
        emitConstraintRewrite(ctx, /* node */, constraint.remove, constraint.add);
        break;
      case "alias":
        emitConstraintAlias(ctx, constraint.id1, constraint.id2);
        break;
    }
  }
  
  return metadata.returnType;
}

// Native function constraint metadata
const NATIVE_METADATA = new Map([
  ["fs_open", {
    returnType: /* File */,
    emits: [
      { kind: "source", label: memLabel("Open", freshResource()) },
      { kind: "source", label: memLabel("MustClose", /* same resource */) },
    ],
  }],
  // ... more natives ...
]);
```

**Testing:**

- `open` → `close` → OK
- `open` → (no close) → ERROR (MustClose at return)
- `open` → `borrow_sh` → `read(original)` → ERROR (Lent conflict)
- `borrow_sh` → `end_sh` → `read` → OK

## Phase 8: Documentation

### 8.1: User Documentation

**File:** `docs/constraint_system.md` (new)

```markdown
# Constraint-Based Effect System

Workman uses a unified constraint system to track effects, errors, memory
safety, and type holes.

## Error Handling

Errors flow through your code as constraints:

\`\`\`wm let x = parseNumber("123"); // x has constraint error:<ParseError> let
y = x + 1; // constraint flows to y return y; // Must return Result<Int,
<ParseError>> \`\`\`

Pattern matching discharges error constraints:

\`\`\`wm match parseNumber(s) { Ok(n) => n + 1, // n is clean (no constraints)
Err(e) => 0 // error discharged } // Returns Int (no constraints) \`\`\`

## Memory Safety

Memory operations emit constraints that conflict with incompatible uses:

\`\`\`wm let f = open("file.txt"); // f has Open[ψ] let b = borrow_sh(f); // f
now has Lent[ψ], b has Borrowed[κ] read(f); // ERROR: DirectRead ⟂ Lent \`\`\`

## How It Works

Three primitives:

- **source**: introduce constraint
- **flow**: propagate constraint through expressions
- **rewrite**: discharge or advance state

The solver propagates constraints and checks for conflicts at merge points and
returns.
```

### 8.2: Developer Documentation

**File:** `docs/dev/constraint_architecture.md` (new)

```markdown
# Constraint System Architecture

## Overview

Type inference remains standard HM. All effects are tracked via a separate
constraint flow graph.

## Constraint Primitives

See Phase 1.1 for `ConstraintLabel` definition.

## Solver Phases

1. Type unification (existing)
2. Build constraint flow graph
3. Propagate labels to fixed point
4. Detect conflicts
5. Check return boundaries

## Adding New Domains

To add a new effect domain:

1. Define labels in `types.ts`
2. Add conflict rules in `conflict_rules.ts`
3. Add boundary rules in `boundary_rules.ts`
4. Emit constraints during inference
5. (Optional) Define carrier type

See memory domain implementation for example.
```

## Implementation Strategy

### Direct Refactor Approach

This refactor will be done **directly** without a parallel migration phase. The
changes are straightforward enough that we can refactor in place:

1. **Phase 1**: Add constraint IR types
   - Add `Identity` and `ConstraintLabel` types to `types.ts`
   - Add new stub kinds to `ConstraintStub` union in `context.ts`
   - **Estimated effort**: 1-2 hours

2. **Phase 2**: Refactor inference to emit constraint stubs
   - Update `infer.ts` to emit `constraint_source` and `constraint_flow` stubs
   - Update `infermatch.ts` to emit `constraint_rewrite` stubs
   - Remove eager `dischargeErrorRow()` calls
   - **Estimated effort**: 4-6 hours

3. **Phase 3**: Refactor solver constraint checking
   - Replace `enforceInfectiousMetadata()` with new constraint propagation
   - Implement `buildConstraintFlow()` and `propagateConstraints()`
   - Implement `detectConstraintConflicts()` and `checkReturnBoundaries()`
   - **Estimated effort**: 6-8 hours

4. **Phase 4**: Test and fix
   - Run full test suite
   - Fix any regressions
   - Update tests if needed
   - **Estimated effort**: 4-6 hours

5. **Phase 5** (Future): Add memory domain
   - Once error domain works, add memory/caps as proof of generality
   - Define capability row operations and conflict rules
   - **Estimated effort**: 8-12 hours

**Total estimated effort for Phases 1-4**: 15-22 hours of focused work

### Why Direct Refactor Works Here

- The constraint infrastructure (~70%) already exists in the codebase
- Changes are well-scoped to specific files (`types.ts`, `context.ts`,
  `infer.ts`, `infermatch.ts`, `solver.ts`)
- The type system remains unchanged (standard HM)
- Existing test suite will catch regressions immediately
- No need for feature flags or parallel systems

### Code That Already Works

**In `infermatch.ts`:**

- `dischargedResult` flag → becomes `constraint_rewrite` emission
- `dischargeErrorRow()` → the semantic operation that rewrite represents
- `errorRowCoverage` → the error row used in constraint labels

**In `solver.ts`:**

- `enforceInfectiousMetadata()` → becomes `propagateConstraints()` +
  `detectConflicts()`
- `detectConflicts()` for holes → same machinery for error/memory domains

**In `types.ts`:**

- `error_row` type → used directly as constraint labels
- `errorRowUnion()` → row join operation for error domain
- `flattenResultType()` → carrier split operation
- `makeResultType()` → carrier join operation

### Rollback Plan

Since this is a direct refactor without parallel systems, rollback means
reverting commits. Each phase should be committed separately:

- Phase 1: Add constraint IR types (pure additive, safe to revert)
- Phase 2: Update inference (may break tests, revert if needed)
- Phase 3: Update solver (may break tests, revert if needed)
- Phase 4: Test fixes (incremental, safe to revert individual fixes)

**Mitigation**: Keep changes small and well-scoped. Test frequently. Commit
after each working increment.

## Success Criteria

### Result Domain

- ✅ Imperative style: `let x = foo(); let y = x + 1; return y;` infers
  `Result<Int, E>` - **Already works!** (via `enforceInfectiousMetadata`)
- ✅ Pattern match discharge: total match returns clean type - **Already
  works!** (via `dischargesResult` flag)
- ✅ fold() purity: `fold(ok, err, result)` with pure callbacks returns clean
  type - **Already works!** (no `argumentErrorRow` tracked)
- ✅ Nested composition: `foo(bar(baz()))` merges all errors - **Already
  works!** (via `argumentErrorRow` propagation)

**Goal:** Keep all existing behavior while generalizing the mechanism.

### Memory Domain (New)

- ✅ Use-after-borrow: `borrow_sh(f); read(f)` → ERROR
- ✅ Use-after-close: `close(f); read(f)` → ERROR
- ✅ Proper lifecycle: `borrow → end → use original` → OK
- ✅ Must-close tracking: return without close → ERROR

### Holes Domain (Integration)

- ✅ Conflicting constraints: `? + 1` and `? || true` → unfillable hole -
  **Already works!** (via `detectConflicts`)
- ✅ Constraint propagation: hole constraints flow through expressions - **Needs
  integration** with constraint flow graph
- ✅ (Optional) Hazel mode: live holes allowed

### Performance

- ✅ No regression in type checking speed
- ✅ Constraint propagation converges quickly (< 100 iterations typical)
- ✅ Memory usage reasonable (constraint graph scales linearly)

### Test Coverage

Existing tests that should continue passing:

- `tests/infectious_base_test.ts` - Basic Result infection
- `tests/infectious_call_constraint_test.ts` - Error propagation through calls
- `tests/infectious_solver_test.ts` - Solver-level checking
- `tests/result_match_guardrails_test.ts` - Pattern match discharge
- `aoc.wm` example - Real-world Result usage

New tests to add:

- Memory domain operations (open/close/borrow)
- Multi-domain interactions (errors + memory)
- Control flow with different constraints (`if` expressions)
- Nested pattern matches with constraint discharge

## Future Extensions

With this constraint system, these become possible as **pure library
additions**:

1. **IO Effects**: `IO<T, <Read|Write>>` tracking side effects
2. **Async**: `Future<T, <Pending>>` with await discharge
3. **Transactions**: `Txn<T, <OpenTx>>` with commit/rollback
4. **State**: `State<T, <Mutated>>` for tracking mutation
5. **Validation**: `Validation<T, <Invalid>>` accumulating errors

All use the same three primitives: source, flow, rewrite.

## Source Code Review Findings

### Current System Architecture (Already Implemented)

After reviewing `solver.ts`, `context.ts`, `infer.ts`, `infermatch.ts`, and
`types.ts`, the codebase already has most of the constraint infrastructure
needed:

#### 1. Constraint Stubs (Existing)

```typescript
// context.ts - lines 158-207
export type ConstraintStub =
  | { kind: "call"; argumentErrorRow?: ErrorRowType; ... }
  | { kind: "branch_join"; dischargesResult?: boolean; errorRowCoverage?: ErrorRowCoverageStub; ... }
  | { kind: "annotation"; ... }
  | { kind: "has_field"; ... }
  | { kind: "numeric"; ... }
  | { kind: "boolean"; ... }
```

Recording functions already exist:

- `recordCallConstraint()` - attaches error rows to call stubs
- `recordBranchJoinConstraint()` - marks discharge and coverage
- `recordAnnotationConstraint()`, `recordHasFieldConstraint()`, etc.

#### 2. Error Flow (Current Implementation)

**In `infer.ts` (lines ~790-830) - Implicit Constraint Source:**

```typescript
let argumentErrorRow: ErrorRowType | undefined;
const argResultInfo = flattenResultType(argType);
if (argResultInfo) {
  argumentErrorRow = argResultInfo.error; // Extract error row from Result type
}

recordCallConstraint(
  ctx,
  expr,
  expr.callee,
  argExpr,
  expr,
  resultType,
  index,
  argumentValueType,
  argumentErrorRow,
);
// ^^^^ Error row attached to call constraint stub
```

This is **implicit constraint source + flow**: When an argument has errors,
they're recorded on the call stub. The plan makes this explicit.

**In `solver.ts` (lines 1150-1290) - `enforceInfectiousMetadata`:**

```typescript
const infectiousCalls = new Map<NodeId, ErrorRowType>();

// Phase 1: Collect error sources from call stubs
for (const stub of stubs) {
  if (stub.kind === "call" && stub.argumentErrorRow) {
    const existing = infectiousCalls.get(stub.result);
    if (existing) {
      // Union errors (row merge operation!)
      infectiousCalls.set(
        stub.result,
        errorRowUnion(existing, stub.argumentErrorRow),
      );
    } else {
      infectiousCalls.set(stub.result, stub.argumentErrorRow);
    }
  }
}

// Phase 2: Check boundary conditions
for (const nodeId of infectiousCalls.keys()) {
  const nodeType = getNodeType(nodeId);
  if (!flattenResultType(nodeType)) {
    // ERROR: Has error constraints but result type is not Result<T, E>!
    reportInfectiousValue(nodeId);
  }
}
```

**This IS constraint propagation!** It's just:

- **Implicit** (error rows attached to call stubs, not separate flow edges)
- **Domain-specific** (hardcoded to error domain only)
- **Single-pass** (no worklist/fixed-point iteration)

#### 3. Pattern Match Discharge (Current Implementation)

**In `infermatch.ts` (lines 285-332) - Eager Discharge:**

```typescript
const dischargeErrorRow = () => {
  const currentInfo = flattenResultType(resolvedResult);
  if (currentInfo) {
    resolvedResult = collapseResultType(currentInfo.value); // Strip error row from type
  }
};

// When pattern match is total (covers Ok and Err):
if (hasAllErrors && !preventsDischarge) {
  dischargedResult = true;
  dischargeErrorRow(); // ← HAPPENS DURING INFERENCE! Modifies types immediately
}

recordBranchJoinConstraint(ctx, expr, branchBodies, scrutineeExpr, {
  dischargesResult: dischargedResult, // ← Flag sent to solver for validation
  errorRowCoverage,
});
```

**Critical Observation:** Discharge happens in **two places**:

1. **Inference (Layer 1):** The result type is modified directly via
   `dischargeErrorRow()`
2. **Solver (Layer 2):** The `dischargesResult` flag is checked to validate the
   discharge was correct

#### 4. Error Row Operations (Already Exist)

From `types.ts` (lines 35-135):

```typescript
// These ARE the carrier operations mentioned in the plan!
export function flattenResultType(type: Type): ResultTypeInfo | null; // Split: Result<T,E> → {T, E}
export function makeResultType(value: Type, error?: Type): Type; // Join: T + E → Result<T,E>
export function collapseResultType(type: Type): Type; // Remove carrier
export function errorRowUnion(left: Type, right: Type): ErrorRowType; // Row merge (domain join)

// Error row type (already exists!)
export type ErrorRowType = Extract<Type, { kind: "error_row" }>;
// { kind: "error_row", cases: Map<string, Type | null>, tail?: Type | null }
```

### Key Architectural Insight: Eager vs. Lazy Discharge

The biggest design change in this refactor is **when** rewrites happen:

**Current System: Eager Discharge (Inference-Time)**

```typescript
// infermatch.ts - happens immediately during type inference
dischargeErrorRow();  // Modifies resolvedResult type in-place
recordBranchJoinConstraint(..., { dischargesResult: true });
// Solver later validates this was correct
```

**Pros:**

- Simple: types reflect actual values immediately
- Works well for single-level matches

**Cons:**

- Nested matches see polluted types (outer errors removed too late)
- Can't compose multiple domains (memory + errors)
- Tight coupling between inference and effect handling

**New System: Lazy Discharge (Solver-Time)**

```typescript
// Inference just records the intent to rewrite
emitConstraintRewrite(ctx, okBranch.id, { remove: [errorLabels], add: [] });
// Types unchanged during inference

// Solver applies rewrite during propagation
applyRewrite(node, rewrite); // Modifies constraint graph, not types directly
```

**Pros:**

- Nested matches see clean types (rewrites applied before inner match)
- Multi-domain composition (memory + errors + holes)
- Constraint graph separate from type inference
- Can rollback/replay constraint solving

**Cons:**

- More complex: types don't reflect constraints until solving
- Need to track constraints separately from types

**Why This Matters:**

Consider nested pattern matches:

```wm
match outerResult {
  Ok(innerResult) => {
    // PROBLEM: With eager discharge, outer errors removed HERE
    match innerResult {
      Ok(x) => x + 1  // Should see Int, but might see Result<Int, outerErrors>
    }
  }
}
```

With eager discharge, the outer error removal happens **after** inferring the
inner match. With lazy discharge, rewrites apply **during propagation** in the
worklist, so the inner match sees the correctly cleaned type.

### Current vs. New Architecture Comparison

| Aspect                | Current System                           | Plan V3                            |
| --------------------- | ---------------------------------------- | ---------------------------------- |
| **Source**            | `argumentErrorRow` on call stubs         | `constraint_source` stubs          |
| **Flow**              | Implicit (via types) + explicit (calls)  | Same (selective `constraint_flow`) |
| **Rewrite**           | Eager (inference: `dischargeErrorRow()`) | Lazy (solver: propagation phase)   |
| **Merge**             | `branch_join` stubs                      | Same (already exists!)             |
| **Propagation**       | Single-pass `enforceInfectiousMetadata`  | Single-pass (stub creation order)  |
| **Domains**           | Hardcoded to error domain                | Generalized to any domain          |
| **Type Modification** | Happens during inference                 | Happens during solving             |

### What the Refactor Really Does

The refactor is **NOT adding new machinery**—it's **generalizing existing
machinery**:

1. **Make constraint tracking explicit**: Replace `argumentErrorRow` attachment
   with explicit `constraint_source` and selective `constraint_flow` stubs (only
   for Result args, matching current optimization)
2. **Move rewrite location**: Shift type modifications from inference-time to
   solver-time
3. **Generalize domain logic**: Replace hardcoded error checks with pluggable
   domain rules
4. **Keep single-pass**: No worklist needed for error domain (matches current
   system)
5. **Separate concerns**: Keep type inference pure, move effect tracking to
   solver

**This is a refinement, not a rewrite.** ~70% of the infrastructure already
exists.

## Implementation Notes - Design Decisions

### 1. Error Row Representation: Full Row vs Individual Labels

**Decision**: Store the **entire `ErrorRowType`** in constraint labels, not
individual error constructors.

**Rationale from existing code** (`solver.ts` lines 1149-1289):

```typescript
const infectiousCalls = new Map<NodeId, ErrorRowType>(); // Stores full row
if (stub.argumentErrorRow) {
  infectiousCalls.set(
    stub.result,
    errorRowUnion(existing, stub.argumentErrorRow),
  );
}
```

Error rows are sets with union semantics. Storing the full row allows:

- Easy union via existing `errorRowUnion()` function
- Proper tail handling (open/closed row polymorphism)
- Matching against pattern coverage checks

### 2. Transient Constraints (Memory Domain - DEFERRED)

Decision: Handle in Phase 5 (memory domain) when needed. Error domain doesn't
require transient labels.

### 3. Identity Management (Memory Domain - DEFERRED)

Decision: Handle in Phase 5 (memory domain). Error domain uses structural labels
(the error row itself), no separate identity tracking needed.

### 4. Propagation Algorithm

**Decision**: Use **single-pass** algorithm initially (same as current
`enforceInfectiousMetadata`).

**Rationale**: The current system works with a single pass because:

- Error propagation is monotonic (only adds, never removes)
- Flow is implicit via type unification during inference
- Discharge happens during inference (types already modified)

A worklist/fixed-point iteration may be needed later for complex multi-domain
interactions, but it's not required for the initial error domain generalization.
The implementation can be changed if needed based on actual requirements.

### 5. Return Boundary Detection

**Current approach** (from source code): Functions have `body: BlockExpr` field,
blocks have `result?: Expr` field. Return position is
`decl.body.result?.id ?? decl.body.id`.

**Limitation**: No support for early returns (language doesn't have them
currently). Only implicit returns from function body expressions are checked.

### 6. Hole Domain Integration

**Decision**: Full refactor of hole tracking into constraint system (not
parallel migration).

**Current implementation**: Holes tracked via
`ctx.holes: Map<HoleId, UnknownInfo>` and `detectConflicts()` in solver.

**New implementation**: Integrate holes as a constraint domain with same
`ConstraintLabel` infrastructure. Reuse existing conflict detection logic but
make it domain-agnostic.

### 7. Branch Join Semantics

**Current behavior**: `branch_join` stubs already represent merge points with
`branches` → `origin` structure.

**Union behavior**: Error rows from different branches are unioned (creating
`<E1 | E2>`). The `dischargesResult` flag indicates when a total pattern match
discharges errors.

**Implementation detail**: The solver processes branch joins to union
constraints from all branches and check for conflicts per domain's rules.

### 8. Rewrite Application Order

**Decision**: Rewrites applied during propagation (in-order traversal),
implementation details deferred to coding phase.

**Rationale**: The type system is single-pass, so the natural traversal order
through the AST should handle rewrites correctly. If nested matches cause
issues, the implementation can be adjusted based on actual test failures.

## Source Code Review Findings

- Every `LetDeclaration` has `body: BlockExpr` field
- Every `BlockExpr` has `result?: Expr` field (the return expression)
- `ctx.nodeTypes` already stores types for all nodes, including function bodies
- We can identify function return positions as:
  `decl.body.result?.id ??
  decl.body.id`

**For New System**:

1. During inference: Track function declarations and their body nodes
2. During solving: Check constraints at body nodes to validate boundaries
3. Error messages can reference the function name from the declaration

**Implementation**:

```typescript
// During solving boundary check
function checkReturnBoundaries(
  program: MProgram,
  flow: ConstraintFlow,
  state: SolverState,
) {
  // For each LetDeclaration in the program
  for (const decl of program.declarations) {
    if (decl.kind !== "let") continue;

    const returnNodeId = decl.body.result?.id ?? decl.body.id;
    const returnType = state.nodeTypeById.get(returnNodeId);
    const constraints = flow.labels.get(returnNodeId);

    // Check if constraints are satisfied
    if (constraints && !isValidBoundary(constraints, returnType)) {
      diagnostics.push({
        origin: returnNodeId,
        reason: "boundary_violation",
        details: { functionName: decl.name },
      });
    }
  }
}
```

**No special tracking needed during inference!** The AST structure already
provides all the information. Just need to pass the marked program to the
boundary checker.

### 10. Type vs Constraint Separation ✅ RESOLVED

**Answer**: Constraints are **separate from types** during inference, then
**validated against types** during solving.

**Evidence**:

- **During inference**: Types don't include constraint info. `Result<T, E>` is
  just a type.
- **Constraint tracking**: Happens via stub fields (`argumentErrorRow`,
  `dischargesResult`)
- **During solving**: Constraints are checked against resolved types

**From `solver.ts` line 1180-1190**:

```typescript
for (const nodeId of infectiousCalls.keys()) {
  const nodeType = getNodeType(nodeId);
  if (!flattenResultType(nodeType)) { // Check if type is Result<T,E>
    reportInfectiousValue(nodeId, row); // Constraint violation!
  }
}
```

**For New System**: Same separation. Types remain unchanged, constraints flow
through separate graph, solver validates constraints against types at
boundaries.

---

## Key Implementation Insights from Source Code

### 1. Pattern Matching Already Extracts Types Correctly

The plan was overthinking pattern bindings! Current code:

```typescript
// infermatch.ts - Pattern creates bindings with EXTRACTED types
const bodyType = withScopedEnv(ctx, () => {
  for (const [name, type] of patternInfo.bindings.entries()) {
    ctx.env.set(name, { quantifiers: [], type: applyCurrentSubst(ctx, type) });
  }
  return inferExpr(ctx, arm.body);
});
```

When matching `Ok(x)` against `Result<T, E>`:

- `inferPattern` returns binding `x: T` (already extracted!)
- Body is inferred with `x: T` in scope
- **No constraint flow needed from scrutinee to binding!**

The discharge happens to the **match result**, not the bindings:

```typescript
dischargeErrorRow(); // Strips Result wrapper from RESULT type
// Bindings already have correct types from pattern inference
```

### 2. Current Propagation is Simpler Than Expected

No worklist, no fixed-point iteration! Just two passes:

```typescript
// Phase 1: Collect sources
for (const stub of stubs) {
  if (stub.argumentErrorRow) {
    infectiousCalls.set(
      stub.result,
      errorRowUnion(existing, stub.argumentErrorRow),
    );
  }
}

// Phase 2: Check boundaries
for (const nodeId of infectiousCalls.keys()) {
  if (!flattenResultType(nodeType)) {
    reportError(nodeId);
  }
}
```

**Why this works**: Error flow is implicit via type unification during
inference! The `Result<T, E>` types already carry the error information.

**For new system**: Can start equally simple. Add iteration only if needed for
complex multi-domain cases.

### 3. Solver Phases Already Exist

```typescript
// solver.ts - Phased solving already in place
Phase 1: Annotations (explicit type info)
Phase 2: Calls & field access (propagate through signatures)
Phase 3: Numeric/boolean (check operand types)
Phase 4: Branch joins (ensure consistency)
Phase 5: Infectious metadata (← our target!)
Phase 6: Conflict detection (for holes)
```

New constraint propagation slots in at Phase 5, **after all type unification**
is complete.

### 4. Branch Join Already Implements Merge

```typescript
recordBranchJoinConstraint(ctx, origin, branchBodies, scrutinee, metadata)

// Creates stub:
{
  kind: "branch_join",
  origin: origin.id,              // Result node
  branches: branchBodies.map(...), // Input nodes
  dischargesResult: boolean,
  errorRowCoverage: { row, coveredConstructors, ... }
}
```

This IS the merge operation! Solver just needs to:

1. Union constraints from `branches`
2. Check for conflicts
3. Attach to `origin`

### 5. Discharge Happens During Inference (Currently)

```typescript
// infermatch.ts line 285-290
const dischargeErrorRow = () => {
  const currentInfo = flattenResultType(resolvedResult);
  if (currentInfo) {
    resolvedResult = collapseResultType(currentInfo.value); // ← MODIFIES TYPE!
  }
};

if (hasAllErrors && !preventsDischarge) {
  dischargedResult = true;
  dischargeErrorRow(); // ← HAPPENS NOW!
}
```

**Key insight**: The type modification (`collapseResultType`) happens
**immediately during inference**, and the `dischargesResult` flag is just sent
to the solver for **validation**.

**For new system**: Move the type modification to solver propagation phase. This
is the core architectural change!

### 6. Error Rows Are Already Constraint Labels

```typescript
type ErrorRowType = {
  kind: "error_row";
  cases: Map<string, Type | null>;
  tail?: Type | null;
};

// This IS the constraint label structure!
// Just wrap it:
type ConstraintLabel = { domain: "error"; row: ErrorRowType };
```

No new data structure needed. Existing `errorRowUnion()` function is the domain
join operation.

### 7. Conflict Detection Already Exists (For Holes)

```typescript
// solver.ts line 1290+
function detectConflicts(holes, constraints, substitution, resolvedTypes) {
  // Group constraints by hole
  // Extract constrained types
  // Try to unify all constraints
  // Report conflicts if unification fails
}
```

**This is the template!** Just generalize to handle multiple domains, not just
holes.

### 8. Function Boundaries Are Already Available

The AST structure already tracks everything needed for boundary checking:

```typescript
// ast.ts - Every function has these fields
interface LetDeclaration {
  name: string; // ← For error messages
  body: BlockExpr; // ← The function body
}

interface BlockExpr {
  result?: Expr; // ← The return expression
}

// infer.ts line 405 - Return types already tracked
ctx.nodeTypes.set(block.result, resolved); // Type at return position
ctx.nodeTypes.set(block, resolved); // Type of whole block
```

**Implementation**: During boundary checking, iterate over all `LetDeclaration`
nodes in the program, check constraints at
`decl.body.result?.id ??
decl.body.id`. No special tracking needed during
inference!

---

**Document Version:** 3.4\
**Last Updated:** November 12, 2025 (Design Clarifications & Direct Refactor
Strategy)\
**Status:** Ready for Implementation

## Summary of Changes from V2

**V2 (Obligation Algebra):**

- Threading `{type, obligations}` through all inference
- Merge obligations at every function application
- Complex "reification" logic for carrier types
- ~5-6 phases, significant refactor

**V3 (Constraint-Based):**

- Inference unchanged (returns just `Type`)
- Emit constraint stubs during inference
- Solver propagates constraints via single-pass (initially)
- Reuses existing hole conflict detection machinery
- ~4-5 phases, direct refactor (~15-22 hours)
- **Same expressive power, simpler implementation**

The key insight: obligations ARE constraints that flow. Instead of threading
them imperatively through inference, emit them declaratively as stubs and let
the solver propagate them.

## Summary of Changes in V3.4 (This Version)

**V3.4 Updates (Design Clarifications):**

- **Added concrete reification semantics**: Shows exactly when and how the "dual
  view of rows" works with TypeScript-like code examples for:
  - Reification at call results and returns
  - Pattern match elimination on carrier types
  - Domain-specific behavior (errors with carrier, memory without carrier)

- **Simplified propagation algorithm**: Confirmed single-pass approach matches
  current system. Worklist/fixed-point iteration deferred as optimization if
  needed later.

- **Direct refactor strategy**: Replaced parallel migration approach with direct
  refactor:
  - No feature flags or parallel systems
  - Estimated 15-22 hours for phases 1-4
  - Commit after each working increment
  - Roll back individual commits if needed

- **Consolidated design decisions**: Moved from "Open Questions" to
  "Implementation Notes" with clear decisions on:
  - Error row representation (full `ErrorRowType`, not individual labels)
  - Propagation (single-pass initially)
  - Return boundaries (implicit returns only, detected from AST)
  - Hole integration (full refactor into constraint system)
  - Branch join semantics (error union with discharge flag)

- **Deferred memory domain details**: Transient labels, identity management, and
  multi-domain interactions explicitly deferred to Phase 5 implementation

- **Removed outdated migration content**: Eliminated parallel system execution,
  comparison diagnostics, and gradual switchover sections

**Key Change:** This is now a **direct refactor** (~15-22 hours), not a gradual
migration. The constraint infrastructure already exists; we're just making it
explicit and general.

## Implementation Confidence

**High Confidence (Already Exists):**

- ✅ Constraint stub collection (`ctx.constraintStubs`)
- ✅ Error row types and operations (`ErrorRowType`, `errorRowUnion`)
- ✅ Carrier operations (`flattenResultType`, `makeResultType`)
- ✅ Discharge semantics (`dischargeErrorRow()` function)
- ✅ Propagation infrastructure (`enforceInfectiousMetadata`)
- ✅ Conflict detection (hole system in solver)

**Medium Confidence (Straightforward Refactor):**

- ⚠️ Explicit flow edges (make implicit flows explicit)
- ⚠️ Multi-domain conflict rules (generalize error-specific logic)
- ⚠️ Lazy rewrite application (move from inference to solver)
- ⚠️ Hole integration (refactor into constraint labels)

**Low Confidence (Future Work - Phase 5):**

- ⚠️ Memory domain (capability tracking, identity management)
- ⚠️ Native function metadata (constraint emission specifications)
- ⚠️ Identity aliasing (union-find for resources)
- ⚠️ Transient constraint handling

**Recommended Approach:**

1. Phase 1: Add constraint IR types (1-2 hours)
2. Phase 2: Refactor inference constraint emission (4-6 hours)
3. Phase 3: Refactor solver propagation (6-8 hours)
4. Phase 4: Test and fix (4-6 hours)
5. Phase 5 (Future): Add memory domain (8-12 hours)

---

## Document Revision Summary

**Version 3.5 (Final)** — November 12, 2025

This revision integrates all clarifications from source code review throughout
the document:

1. **Per-domain singleton invariant** clarified in Constraint IR section and
   propagation algorithm
2. **Single-pass propagation** consistently specified (not worklist) matching
   current `enforceInfectiousMetadata`
3. **Flow edge strategy** explained with optimization path (emit all initially,
   optimize later)
4. **Nested function boundaries** fully specified with recursive traversal logic
5. **Carrier operations** confirmed as already implemented, no new code needed
6. **Error label merging** corrected to use `Map<domain, label>` structure
7. **Rewrite timing** clarified as in-place mutation during stub traversal

All ambiguities resolved. Ready for implementation.
