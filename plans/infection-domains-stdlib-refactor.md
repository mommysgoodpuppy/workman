# Infection Domains in Stdlib (Full Refactor Plan)

Goal: make the compiler *domain-agnostic*. All infection domains (error/taint/mem/hole/async/…) and
their semantics are declared in Workman stdlib as data. The compiler only:
1) parses/loads those declarations,
2) emits generic constraint stubs during inference based on std-declared rules,
3) runs a generic constraint flow + checking engine in the solver.

This document is the “programming implementation” plan: what needs to change in the compiler and
what stdlib code must exist to define domains, operations, and memory behavior.

---

## 0) Design Principle: Compiler Kernel vs Stdlib Rules

**Compiler kernel (must remain built-in):**
- Parsing and name resolution of std modules.
- HM inference for types (unchanged).
- Generic constraint propagation (graph + merge).
- Generic diagnostics plumbing.

**Stdlib (must own infection semantics):**
- Which domains exist.
- How carrier types are recognized and joined/split.
- Which operations *introduce* constraint labels (charge), *remove* labels (discharge), and which
  operations *require exact state shapes*.
- Which label combinations are invalid (conflicts).
- Boundary rules for functions (what must be true at return, and what can be accepted at call).
- Optional “purity”/“no leak” policies.

The compiler becomes an interpreter of std-declared *rule data*, not an implementer of domain logic.

---

## 1) Stdlib Meta-Declarations (New Workman Surface)

### 1.1 Domain Declaration (data, not executable)
Add a stdlib-only declaration that registers a domain and its rule set.

Sketch syntax (exact syntax TBD):

```wm
domain mem {
  carrier Mem        // type constructor name
  state_kind row     // state is an effect_row-like set of tags

  merge singleton    // one label per node per domain (existing invariant)
  merge_row union    // how to merge rows at joins (if row-like)

  conflict none | table [...]
  boundary rules [...]
}
```

**What compiler stores:**
- `domainName: string`
- `carrierTypeName?: string`
- `stateModel: "row" | "atom" | "custom"` (start with `"row"` and `"atom"`)
- `mergePolicy` (per-domain singleton + how to merge row states)
- `conflictPolicy` (none, table, or later: predicate DSL)
- `boundaryPolicy` (list of checks, initially table-driven)

### 1.2 Carrier Declaration (already exists; make it authoritative)
Workman already has infectious type declarations/modifiers in AST. The refactor requires:
- carrier registration happens by reading stdlib `infectious` declarations, not hardcoded TS.
- domains are just strings.

This gives stdlib control over mapping:
- which constructor is “value”
- which constructors are “effect/short-circuit”

### 1.3 Operation Rule Declaration (typed operations)
To avoid hardcoding names like `close`, stdlib must declare the infection semantics of functions.

Sketch:

```wm
op mem.close {
  domain mem
  effect discharge
  adds Closed
}

op mem.fill {
  domain mem
  effect use
  requires_exact [Opened]
}
```

This is the key piece: **instead of embedding semantics in the typechecker**, stdlib declares rules
that the typechecker interprets.

**Minimal op-rule fields:**
- `symbol`: fully-qualified name (resolved via module path + local name)
- `domain`: string
- `requires_exact`: list of row tags that must be present *and no others*
- `requires_any`: list of tags that must be present (subset check)
- `adds`: tags to add to the row
- `removes`: tags to remove from the row (may be unused for non-linear memory)
- `call_policy`: `pure` (reject all domains), or `accept` (default)

Note: For the “no linear transformation” philosophy, prefer `requires_exact` + `adds`, and avoid
`removes` except when you explicitly want cancellation behavior at boundaries.

### 1.4 Function Policy Declarations (pure / no_leak)
Stdlib must be able to mark *functions* (not just ops) with policies.

Sketch:

```wm
policy pure { rejects_all_domains }
policy no_leak_mem { domain mem; require_at_return [Closed] }

annotate myFn { pure }
annotate parse { no_leak_mem }
```

**MVP shortcut:** allow `@pure` and `@no_leak(mem)` as attributes on `let` declarations in stdlib
(compiler parses them as metadata, not as runtime code).

---

## 2) Compiler Changes (Make Everything Data-Driven)

### 2.1 Parsing + AST
Add AST nodes for:
- `DomainDeclaration`
- `OpRuleDeclaration`
- `PolicyDeclaration` + `AnnotateDeclaration` (or attribute syntax on `let`)

Parser must accept these forms in stdlib modules.

### 2.2 Module Summaries Must Include Rule Metadata
Right now module summaries capture exports and types. Extend summary format to include:
- exported/in-scope domain declarations
- op-rule declarations (for exported ops or for all ops; pick a scoping model)
- policy annotations for exported functions (at least `pure`)

Reason: importers need the rule metadata to typecheck calls without re-parsing all dependencies.

### 2.3 Loader Order / Bootstrap
Domain rules must be known *before* analyzing user code.

Bootstrap strategy:
- Choose a “domain prelude module” in std (e.g. `std/infection/domains.wm`).
- Loader always loads it first (like current prelude injection).
- Its declarations populate the Domain Registry.

### 2.4 Layer1 Inference: Emit Generic Stubs From Op Rules
Layer1 currently emits stubs like `call`, `branch_join`, etc.

Add new stub kinds that are **domain-generic**:
- `require_exact_state { node, domain, tags }`
- `require_any_state { node, domain, tags }`
- `add_state_tags { node, domain, tags, identity? }`
- `boundary_require { returnNode, domain, tags }` (for `no_leak`/policy)
- `call_rejects_infection { callNode, policy }` (for `pure`)

Then, in `infer(call)`:
- Resolve callee symbol.
- Look up op-rule metadata (from registry / summary).
- Emit the corresponding stubs attached to the relevant node IDs.

This is the main “typed operations” integration point, but **the semantics come from std data**.

### 2.5 Layer2 Solver: Enforce Stubs Using Domain Rules
Solver becomes a generic interpreter:
- It propagates per-domain singleton labels as it already does.
- It merges via domain `mergePolicy`.
- It checks conflicts via domain `conflictPolicy`.
- It checks `require_exact_state` by comparing the propagated label set to required tags.
- It checks boundary requirements (e.g. `no_leak`) by ensuring required tags are present at return.

No `if (domain === "effect")` branches in solver: only rule lookups.

---

## 3) Memory Domain Rules (Std-Declared, Non-Linear)

This section pins down the memory semantics you described, in rule form.

### 3.1 Memory State Model
- Use a row/set of tags: `<Opened | Closed | Borrowed | ReadOnly | Write | …>`
- Tags **commute**; there is no temporal “before/after” meaning.
- Operations constrain or extend the set; they do not “sequence” it.

### 3.2 The Key Non-Linear Constraint: Use Requires Exact Shape
**Use is not represented by a `Used` label.**

Instead, every use-capable operation (read/write/fill/etc.) requires:
- `requires_exact [Opened]`

Meaning: the memory state at the use site must be *precisely* `<Opened>` (no extras).

### 3.3 Closing Is Just Adding a Tag
`close` (or `free`) is:
- `adds [Closed]`

This makes “use after close” fail because `<Opened|Closed>` no longer matches the exact shape
`<Opened>`.

Crucially:
- `<Opened|Closed>` is *not* a conflict by itself; it’s just “not usable”.
- This enforces your separation: a function that does any “use” cannot also “close” in the same
  scope, because adding `Closed` would destroy the exact `Opened` shape needed for use.

### 3.4 no_leak (Non-Linear)
Because there is no linear “consume Opened”, `no_leak` must be expressed as:
- at return, require that resources have `Closed` in their state.

So returning something that is “just Opened” is forbidden; returning “Opened|Closed” is allowed.

Std rule (sketch):
```wm
policy no_leak_mem {
  domain mem
  require_at_return [Closed]
}
```

### 3.5 Borrowing (Optional Later)
If you add borrowing:
- `borrow` could require exact `[Opened]` and add `[Borrowed]`
- and any use op would require exact `[Opened]` (so borrowed values are not usable directly),
  forcing explicit "reown/reborrow" style APIs.

This stays non-linear and "type puzzle" driven.

---

## 3.6 State Models: row_set vs row_bag (Do Not Replace effect_row Globally)
The system should support multiple domain state models without hardcoding domain names:

- `row_set` (idempotent set/row semantics)
  - Best for “may happen” facts (classic effect/error rows).
  - Merge is commutative and idempotent (union).
  - Duplicates are meaningless and should collapse.

- `row_bag` (multiset/bag semantics)
  - Needed when multiplicity matters (e.g., close twice, borrow twice).
  - Merge is commutative but not idempotent.

Important: do **not** replace `effect_row` everywhere with a bag type. The error/effect domain is
usually set-like: you care whether an error is possible, not how many times it was introduced. A
bag would make types noisier and merges harder without adding useful information.

Implementation note (MVP):
- `row_set` uses the current `effect_row` representation.
- `row_bag` can be represented using the “holes trick”: encode multiplicity by generating unique
  keys while still storing inside a Map (e.g., `Closed#0`, `Closed#1`). Domain rules can interpret
  “base tag” + count.

---

## 4) Migration of Current Hardcoded Domains Into Std

### 4.1 effect (Result-like short circuit)
Std declares:
- domain `effect`, merge = row union
- carrier `Result` (or `IResult`)
- constructor metadata (`Ok` value, `Err` effect)
- boundary rule: if labels exist at return, return type must be a carrier
- match discharge rules (initially via existing match metadata; later via std rules)

### 4.2 hole (type holes as carrier)
Std declares:
- domain `hole`, merge = row union
- carrier `Hole<T, Row>`
- boundary rule: allowed (Hazel) or forbidden (Total) via policy

### 4.3 taint
Same shape as `effect`, but without short-circuit constructors (or with, if desired).

---

## 4.4 Reification: Reflecting Latent Domain State Into Carrier Types (Generalize)
To make the LSP and downstream backends usable, the system must support reifying latent constraint
state into the value’s carrier type (so the type you hover includes the current row/set/bag).

You can reuse the **pattern** that exists today (latent state + reify points), but the current
implementation is effectively tailored to “short-circuit carriers” (Result-like) in several places
(especially the JS backend runtime and some solver expectations).

Stdlib must be able to declare, per domain:
- **When to reify**: call results, returns, constructions, always, or never.
- **How to reify**: how carrier `join(value, state)` is formed.
- **How to discharge/normalize**: e.g., effect domain may discharge via match on value/effect
  constructors; mem domain may normalize at boundaries (e.g., `Opened+Closed -> discharged`).
- **Whether short-circuit exists**: some domains short-circuit, others only accumulate state.

Compiler kernel requirement:
- A generic reification hook that is driven entirely by std-declared policies (no
  `if (domain === "effect")` branches), even if the engine that applies the policy is built-in.

---

## 5) What "Implemented in Std" Means Operationally

Std does not execute at runtime to register domains; the compiler *reads std source* and treats
domain/op/policy declarations as compile-time metadata.

So “implemented in std” means:
- the meaning of “mem.close” is defined by a std `op` rule, not by TS code
- the meaning of “pure” and “no_leak” are defined by std policies, not by TS code
- the set of domains is defined by std, not by TS enums/maps

The compiler remains a metadata interpreter + generic engine.

---

## 6) Milestone Plan (Minimum Viable Refactor)
1) Add Domain + OpRule declarations and registry plumbing (parse + summaries).
2) Make layer1 emit `require_exact_state` + `add_state_tags` stubs for std ops.
3) Implement solver checks for `require_exact_state`.
4) Implement `pure` policy (reject all infections at call sites).
5) Implement `no_leak_mem` boundary rule (“must include Closed at return”).
6) Port mem domain + 2 ops (`alloc` adds Opened, `close` adds Closed, `fill` requires exact Opened).
7) Delete hardcoded mem boundary/conflict logic.
