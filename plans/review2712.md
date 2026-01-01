# Workman Language Architecture Review

**Date:** December 27, 2024\
**Scope:** Core design, architecture, and implementation patterns

---

## Executive Summary

Workman is an ambitious functional programming language targeting Zig with
manual memory management, positioned as the "Go of FP." The codebase
demonstrates sophisticated type system design with innovative features like
infectious types, effect rows, and a multi-layer analysis pipeline. This review
focuses on architectural concerns and design decisions rather than obvious gaps.

---

## Architecture Overview

### Compilation Pipeline

```
Source → Lexer → Parser → AST → Layer1 (Infer) → Layer2 (Solve) → Layer3 (Present)
                                      ↓
                              Marked AST (MProgram)
                                      ↓
                              Core IR → Zig Emitter
```

The pipeline is well-structured with clear separation:

- **Layer 1**: Type inference, constraint collection, hole tracking
- **Layer 2**: Constraint solving, type resolution, conflict detection
- **Layer 3**: Presentation layer for diagnostics and LSP

---

## Strengths

### 1. Carrier Type Abstraction

The generic carrier system (`types.ts:230-420`) is well-designed and extensible:

```typescript
interface CarrierOperations {
  is: (type: Type) => boolean;
  split: (type: Type) => CarrierInfo | null;
  join: (value: Type, state: Type) => Type;
  collapse: (type: Type) => Type;
  unionStates: (left: Type, right: Type) => Type;
}
```

This allows `Result<T, E>`, `Hole<T, Row>`, `Mem<T, S>` to share infrastructure
while having domain-specific semantics.

### 2. Hazel-Style Error Recovery

The compiler follows Hazel's philosophy of compiling through errors. Marked AST
nodes (`ast_marked.ts`) like `MMarkFreeVar`, `MMarkNotFunction`,
`MMarkInconsistent` preserve error information while allowing compilation to
continue.

### 3. Infectious Type System

The `infectious` modifier on types (`infectious effect type IResult<T, E>`) with
`@value`/`@effect` constructor annotations is an elegant way to model monadic
propagation without explicit monads.

### 4. Declarative Domain Rules

The infection registry system (`infection_registry.ts`) allowing stdlib-defined
domains via `domain`, `op`, and `policy` declarations is forward-thinking:

```workman
domain mem {
  stateKind: rowBag,
  boundary: requireClean
}
```

---

## Architectural Concerns

### 1. Layer 1/Layer 2 Boundary Blur

**Issue:** The constraint system spans both layers with unclear ownership.

`context.ts` defines 12+ constraint stub types that are collected in Layer 1 but
solved in Layer 2. However, Layer 1 (`infer.ts`) also performs direct
unification (`unify` function) and applies substitutions. This creates two
"sources of truth" for type information.

**Evidence:**

- `ctx.subst` is modified in Layer 1 during inference
- `state.substitution` is built separately in Layer 2's solver
- Both layers emit diagnostics to different arrays (`layer1Diagnostics` vs
  `diagnostics`)

**Recommendation:** Consider one of:

1. Make Layer 1 purely constraint-generating (no unification) with Layer 2 as
   the single solver
2. Merge into a single bidirectional inference pass if the split doesn't provide
   value

### 2. Context Object Sprawl

**Issue:** The `Context` interface (`context.ts:75-124`) has grown to 25+ fields
tracking various state:

```typescript
interface Context {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  subst: Substitution;
  allBindings: Map<string, TypeScheme>;
  nonGeneralizable: Set<number>;
  marks: Map<Expr, MExpr>;
  nodeTypes: Map<NodeId, Type>;
  annotationTypes: Map<NodeId, Type>;
  matchResults: Map<MatchBundle, MatchBranchesResult>;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
  identityBindings: Map<string, Map<string, Set<number>>>;
  identityStates: Map<number, Map<string, Map<string, number>>>;
  exprIdentities: Map<NodeId, Map<string, Set<number>>>;
  identityUsage: Map<number, Map<string, Map<NodeId, ...>>>;
  // ... and more
}
```

**Impact:**

- Hard to understand which fields are used where
- Difficult to reason about invariants
- Complex cloning/scoping logic spread across the codebase

**Recommendation:** Consider decomposing into focused sub-contexts:

- `TypeContext` (env, adtEnv, subst)
- `IdentityContext` (identityBindings, identityStates, etc.)
- `DiagnosticContext` (marks, holes, constraintStubs)

### 3. Runtime Type Erasure vs. Tagged Unions

**Issue:** The Zig runtime uses a fully dynamic `Value` union:

```zig
pub const Value = union(enum) {
    Unit,
    Int: i64,
    Bool: bool,
    String: []const u8,
    Tuple: []Value,
    Record: *std.StringHashMap(Value),
    Data: DataValue,
    Func: FuncValue,
};
```

This means:

- All values are boxed (even `Int` and `Bool`)
- Pattern matching requires runtime tag checks
- No type-directed optimizations possible

**Trade-off Analysis:**

- **Pro:** Simplifies code generation, enables dynamic features
- **Con:** Significant performance cost, loses Zig's compile-time guarantees

**Question for Design:** Is the goal to eventually generate typed Zig code? If
so, the current runtime is a dead-end. If dynamic typing is intentional (like
OCaml bytecode), this is fine but should be documented.

### 4. Memory Management via Constraint Tracking (Clarified)

**Design:** Memory safety is enforced through the same carrier/infection system
as error handling - a **non-linear, unordered constraint model** (not affine
like Rust).

The `mem` domain uses `rowBag` semantics with identity tracking:

```workman
domain mem {
  stateKind rowBag;   -- Tags accumulate as a bag (duplicates allowed)
  merge singleton;
  mergeRow bagUnion;
};

op mem.alloc { domain mem; adds [Opened]; };
op mem.free { domain mem; target arg0; adds [Closed]; };
op mem.write { domain mem; target arg0; requiresExact [Opened]; };
```

**How it works:**

- `alloc(100)` returns `Mem<Buffer, <Opened#r3053@1>>` (identity-tagged)
- `free(buffer)` adds `Closed` tag → `<Opened#r3053@1 | Closed#r3053@1>`
- Use-after-free: `write` requires `Opened` but sees `Closed` → **conflict =
  unfillable hole**
- Double-free: `<Opened#r... | Closed#r...@1 | Closed#r...@2>` → **conflict**
- Closure capture propagates infection state, detecting potential escapes

**Strengths:**

- Unified mechanism with error tracking and holes
- Order-independent (non-linear simplifies reasoning)
- Detects aliasing issues via identity tracking

**Current Gaps:**

- Runtime uses arena allocator (doesn't actually free) - this is tooling, not
  the model
- `policy noLeakMem { requireAtReturn [Closed]; }` not yet enforced
- Documentation of the constraint algebra would help contributors

### 5. Parser Size and Complexity

**Issue:** `parser.ts` is 2800+ lines with complex lookahead logic.

The parser uses a hand-rolled recursive descent approach with:

- Operator precedence climbing for expressions
- Comment preservation for formatting
- Tolerant mode for LSP
- Multiple syntax forms for the same concept (match function variants)

**Specific Concerns:**

- `tryParseTupleLetStatement` has complex backtracking
- Match syntax has 4 forms: `match(x) { ... }`, `match(x) => { ... }`,
  first-class bundles, bundle references
- Negative number lexing interacts poorly with subtraction

**Recommendation:** Consider:

- Extracting expression parsing to a separate module
- Using a more structured precedence table
- Documenting the grammar formally (even informally in comments)

### 6. Module System Complexity

**Issue:** The module loader (`module_loader.ts`, 1400+ lines) handles many
concerns:

- Path resolution with multiple roots
- Prelude injection
- Infection registry building per-module
- Source overrides for LSP
- Compiled JS evaluation
- Cycle detection

The `ModuleSummary` interface exposes internal typing details:

```typescript
interface ModuleSummary {
  exports: { values: Map<string, TypeScheme>; types: Map<string, TypeInfo>; ... };
  infection: InfectionSummary;
  runtime: Map<string, RuntimeValue>;
  letSchemes: Map<string, TypeScheme>;
  // ...
}
```

**Recommendation:** Consider separating:

- Module resolution (pure path/dependency logic)
- Module analysis (type checking)
- Module evaluation (runtime)

### 7. Constraint Propagation Architecture

**Issue:** The constraint flow system (`solver.ts`) builds a separate graph:

```typescript
const constraintFlow = buildConstraintFlow(
  input.constraintStubs,
  infectionRegistry,
);
propagateConstraints(constraintFlow, input.constraintStubs, infectionRegistry);
reifyConstraintLabelsIntoTypes(
  constraintFlow,
  resolvedNodeTypes,
  infectionRegistry,
);
```

This runs _after_ the main unification-based solving, creating:

- Two type resolution passes
- Potential for inconsistencies between them
- Complexity in understanding what's resolved where

**Recommendation:** Integrate constraint flow into the main solving loop or
document clearly why the two-phase approach is necessary.

### 8. Effect Row Representation

**Issue:** Effect rows use string keys with embedded metadata:

```typescript
// Identity tags encoded in strings
tagWithIdentity(tag: string, identityId: number): string {
  return `${tag}#r${identityId}`;
}
```

This leads to string parsing throughout:

```typescript
function splitIdentityTag(tag: string): number | null {
  const match = /#r(\d+)(?:@(\d+))?$/.exec(tag);
  // ...
}
```

**Impact:**

- Fragile string manipulation
- Hard to extend with new metadata
- Poor type safety

**Recommendation:** Consider a structured representation:

```typescript
type EffectTag = {
  name: string;
  identity?: number;
  index?: number;
  payload?: Type;
};
```

---

## Design Decisions to Revisit

### 1. Single vs. Multi-Backend

The codebase has:

- `backends/compiler/zig/` - Zig emitter (primary)
- `backends/compiler/js/` - JS emitter (for Deno evaluation)

**Question:** Is JS a first-class target or just for tooling? If tooling-only,
consider simplifying by always going through Zig → WASM for in-editor
evaluation.

### 2. Global Mutable State

Several modules use module-level mutable state:

- `nextTypeVarId` in `types.ts`
- `nextResourceId`, `nextBorrowId` in `types.ts`
- `CARRIER_REGISTRY` in `types.ts`

This makes testing harder and creates implicit coupling. Consider passing state
explicitly or using a context object.

### 3. Node ID Strategy

Every AST/IR node has a unique numeric ID:

```typescript
export type NodeId = number;
```

IDs are reset via `resetNodeIds(0)` before parsing. This works for single-file
compilation but could cause issues with:

- Incremental compilation
- Multi-file caching
- Parallel compilation

**Recommendation:** Consider stable IDs (e.g., hash-based) for incremental
compilation support.

---

## Code Quality Observations

### Well-Structured Areas

- **Type definitions** (`types.ts`): Clean sum types, good use of TypeScript's
  type system
- **Core IR** (`ir/core.ts`): Well-defined, minimal, suitable for optimization
  passes
- **Error types** (`error.ts`): Good structured error hierarchy

### Areas Needing Attention

- **Large files:** `parser.ts` (2800 lines), `infer.ts` (4100 lines),
  `solver.ts` (2600 lines) - consider splitting
- **Console.log debugging:** Several commented-out debug logs remain in
  production code
- **Type assertions:** Heavy use of `as` casts in lowering code

---

## Recommendations Priority

### High Priority

1. **Clarify Layer 1/2 responsibilities** - The Hazel-based design has grown
   significantly with the general infection system; documenting the boundary
   would help contributors
2. **Structured effect row tags** - Reduces string parsing bugs, improves type
   safety

### Medium Priority

3. **Runtime typing decision** - Determines optimization ceiling
4. **Module loader separation** - Enables better testing
5. **Document constraint algebra** - The mem/effect/hole domain semantics are
   novel; formal docs would help

### Lower Priority

6. **Decompose Context object** - Nice-to-have for maintainability
7. **Parser modularization** - Quality of life for parser work
8. **Stable node IDs** - Important for incremental compilation
9. **Remove global mutable state** - Testing and parallelization

---

## Conclusion

Workman has a solid foundation with innovative ideas around infectious types and
effect tracking. The main architectural risks are:

1. **Runtime performance ceiling** due to dynamic typing
2. **Memory constraint enforcement is partial** (semantics defined, policies not
   fully enforced)
3. **Complexity accumulation** in the Context object and module loader

The codebase would benefit from documentation on intended semantics (especially
around memory) and some structural decomposition as it grows.

---

_Review by Claude | Architecture analysis based on codebase exploration_
