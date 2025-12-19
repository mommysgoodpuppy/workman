# Infection Domains: De-Hardcode Plan

Goal: move infection domain semantics out of compiler hardcoding and into
stdlib-declared metadata, while keeping the current constraint flow engine.

See also: `plans/infection-domains-stdlib-refactor.md` for the “stdlib owns everything” version
of this plan (domain/op/policy declarations as compile-time metadata).

## Current State (What is Hardcoded)
- Domain names are fixed in compiler code (`effect`, `taint`, `mem`, `hole`).
- Boundary rules are in `src/layer2/boundary_rules.ts`.
- Conflict rules are in `src/layer2/conflict_rules.ts`.
- Constraint propagation assumes fixed domain behavior (effect row union, mem
  conflict checks, hole rules).

## Target State
- Compiler core understands "domains" generically.
- Stdlib declares:
  - Domain name.
  - Carrier type mapping (already via `infectious` / carrier registry).
  - Boundary rule (when discharge is required at function return).
  - Conflict rule (when labels in a domain are incompatible).
  - Merge rule for label aggregation (e.g., union for effect rows).
  - Operation rules (typed ops) for charge/discharge/shape checks.
- Compiler loads these declarations before typechecking user code.

## Minimal Rule Schema (Std-Declared)
The smallest useful schema should cover:
- `domain`: string (e.g., `effect`, `mem`, `hole`)
- `merge`: how to merge two labels for same domain
  - initial implementation: `union_row`, `keep_left`, `keep_right`
- `conflict`: list of incompatible label pairs (per identity if applicable)
  - initial implementation: table of pairs for a domain
- `boundary`: when return is invalid
  - initial implementation: "must be reified in carrier" or "must be empty"
- `charge/discharge`: optional stubs emitted by typed ops (future extension)
- `purity`: function-level override to reject all infections

## Purity (Global "Reject All Domains")
Add a minimal notion of "pure" functions:
- A pure function rejects all active domain labels at its call boundary.
- Initial implementation is coarse: "no infection of any domain."
- Later evolution can allow per-domain or per-label allowances.

Compiler behavior:
- During typechecking, if a call target is marked `pure`,
  treat it like a boundary: if any domain labels are present on arguments
  or in scope, emit a diagnostic.
- This is independent of carrier types; it is a hard "no infection" rule.

This keeps the compiler simple while enabling std-defined domain behavior.

## Migration Steps
1) **Define a Domain Registry**
   - New core types: `DomainRuleSet`, `DomainRegistry`.
   - Expose registry API to compiler pipeline (loaded before analysis).

2) **Add Std Declarations**
   - Extend AST with `domain` or `infection_rule` declarations.
   - Parse these from stdlib modules (likely in prelude or a dedicated module).

3) **Load Domain Rules**
   - In module loader / pipeline, parse std rules and populate registry.
   - Ensure rules are available to `layer2` solver.

4) **Replace Hardcoded Rules**
   - `boundary_rules.ts` and `conflict_rules.ts` become defaults only.
   - `solver.ts` uses registry to:
     - merge labels
     - check conflicts
     - validate boundaries

5) **Port Existing Domains to Std**
   - `effect` domain: merge = row union, boundary = must be Result (carrier),
     conflicts = none.
   - `taint` domain: same as effect but with Tainted carrier.
   - `mem` domain: merge = keep per-identity labels + conflict table, boundary =
     no MustClose/MustEnd labels at return.
   - `hole` domain: merge = row union, boundary = allowed in Hazel mode.

6) **Back-Compat Defaults**
   - If no domain rules are registered, fall back to current behavior.
   - This keeps compiler usable until std rules are stable.

## Example Std Declarations (Sketch)
These are illustrative; syntax is TBD.

```
domain effect {
  carrier Result
  merge union_row
  conflict none
  boundary must_be_carrier
}

domain mem {
  merge keep_left
  conflict table [
    (DirectRead, Lent),
    (DirectRead, Closed),
    (BorrowRead, Ended),
    (Closed, Open),
    (Open, Lent),
  ]
  boundary must_discharge [MustClose, MustEnd]
}
```

## Risks / Open Questions
- How to express domain rules without a full meta-language?
- How to scope domain rules (global vs per-module)?
- How to version and evolve std-declared rules safely?
- How to serialize rules into summaries for imports?

## Requirements for Zig Compiler In Workman (Infection Capabilities)
To implement a Zig compiler and emit Zig programs from Workman, the infection
system must be able to express at least:
- **Error handling**: short-circuitable failures (Result-like) with row union.
- **Async/await**: infection propagation through async boundaries.
- **IO/FS**: explicit capability and discharge (open/close, read/write).
- **Memory/resource**: allocation, borrowing, and explicit release obligations.
- **FFI/external**: boundary where effects are reified or rejected (pure calls).
- **Capability splitting**: model "can read but not write" style constraints.
- **Transitive propagation**: infections flow through calls, records, tuples.

Non-goals (compatible with Workman philosophy):
- Full linear/affine ownership; restrictions are acceptable if the std APIs are
  designed around explicit discharge operations and limited aliasing.

## Memory Domain: Proposed Rules (Non-Linear, Commutative Labels)
Design goals:
- No linear tracking; labels accumulate and commute.
- "Use and close" is forbidden by *shape requirements*, not temporal tracking.
- Functions either use a resource or close it, but not both in the same scope.

Labels (sketch):
- `Opened` (resource is live and usable)
- `Closed` (resource is closed/discharged)
- `Borrowed` (optional, if you model borrowing)
- `ReadOnly`, `Write` (optional capability split)

Core idea:
- Operations require a *precise label shape*.
  - Example: any function that uses the resource requires exactly
    `Mem<T, <Opened>>` (no extra labels).
  - Closing adds `Closed`, so the shape becomes `Mem<T, <Opened|Closed>>`
    which no longer satisfies use requirements.
- This avoids a `Used` label entirely and keeps the model commutative.

Consequences:
- `Opened + Closed` is valid, but unusable (no further use operations match).
- Any use + close in the same scope becomes impossible by construction:
  once closed, you no longer match the `Opened`-only shape.
- Resource manipulation and resource discharge are forced into separate scopes
  (typically via separate functions).

Possible rule table:
- `use` requires label set: `{Opened}` (exact).
- `close` adds label: `Closed`.
- `borrow` (if used) adds label: `Borrowed` and may require `{Opened}` exact.
- `write` (if capability split) requires `{Opened, Write}` exact.
- `read` requires `{Opened}` or `{Opened, ReadOnly}` exact (pick one rule).

Boundary behavior:
- Functions may return resources with `Opened` or `Opened|Closed`.
- A `no_leak` function would require the presence of `Closed` at return
  (so returning `Opened` alone is rejected).

Notes:
- This model intentionally rejects many classic imperative patterns.
- It aligns with the "separate use and discharge" philosophy.
