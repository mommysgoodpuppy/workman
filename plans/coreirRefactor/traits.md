# Trait Domain Integration Plan

This document captures how trait/typeclass-style requirements plug into the infection/domain framework without forcing traits into the value-domain stack. Traits remain "domains" conceptually, but they live in the constraint/evidence layer rather than the runtime value layer.

## 1. Domain Kinds Recap

| Kind | Examples | Representation |
| --- | --- | --- |
| `carrier` | `async`, `result` | Value-domain stack + explicit carrier ops. |
| `capability` | `mem`, `raw` | Value-domain stack + capability ops/constraints. |
| `trait` | `Print`, `Eq`, protocol evidences | Constraint sets + explicit evidence parameters; no value wrapping. |

Traits share the registry machinery (name, state type, ordering), but they discharge via evidence rather than unwrap/bind.

## 2. Constraint Representation

Add trait constraints to type schemes and function metadata instead of stacking them on values:

```ts
type TraitConstraint = {
  trait: string;         // e.g. "Print"
  args: Type[];          // type arguments for the trait
  state?: Type;          // optional dictionary layout / extra info
};

interface TypeScheme {
  type: Type;                     // existing base type (already includes value domains)
  vars: readonly TypeVarId[];
  traitConstraints: readonly TraitConstraint[]; // obligations
}
```

Constraints attach to:
- exported bindings (so callers know what evidence to supply)
- lambda/let nodes (so elaboration knows what obligations must be satisfied)

## 3. Core IR Extensions

1. **Lambda metadata**: track implicit evidence parameters.
   ```ts
   interface CoreLambdaExpr {
     ...
     implicitParams?: readonly { name: string; type: Type; trait: string }[];
   }
   ```
2. **Instance declarations**: Core modules record available trait instances.
   ```ts
   interface CoreInstanceDecl {
     trait: string;
     forType: Type;
     evidence: CoreExpr; // dictionary or monomorphized implementation
     exported: boolean;
   }
   ```
3. **Trait operations**: either introduce explicit nodes (`trait_call`, `trait_dict`) or annotate existing calls with evidence
   metadata. Preferred explicit form:
   ```ts
   { kind: "trait_call", trait: string, method: string, evidence: CoreExpr, args: CoreExpr[] }
   ```

## 4. Elaborated Core Responsibilities

During the Layer-B pass:
1. Collect trait obligations from usage sites (`print(x)` ⇒ `Print(typeOf(x))`).
2. Propagate obligations outward (similar to existing infection propagation).
3. Resolve obligations:
   - Use in-scope implicit params (from lambda or module-level instance)
   - Or select a global instance.
4. Insert explicit evidence:
   - Add implicit params to lambdas as needed.
   - Rewrite trait method calls into `trait_call` nodes referencing evidence expressions.
5. Record resolution results (optional but useful for debugging).

## 5. Backend Lowering Policies

Each backend chooses between dictionary passing vs monomorphization:
- **Zig runtime backend**: dictionaries (structs of function pointers) or partial specialization.
- **Zig raw backend**: likely monomorphize to avoid runtime allocation.
- **JS backend**: can use records/objects as dictionaries.
- **Future GLSL backend**: enforce monomorphization (no function pointers).

The Target IR simply needs enough information to either inline evidence or clone functions per concrete type.

## 6. Validation

Add validation checks after elaboration:
- Every trait constraint on a binding/lambda has explicit evidence.
- Trait calls reference compatible evidence (matching trait + args).
- No trait constraint remains in the type scheme of a fully resolved value unless it’s intentionally exported.

## 7. Incremental Tasks

1. Extend `TypeScheme` and Core serialization with `traitConstraints`.
2. Add `CoreInstanceDecl` to module graphs.
3. Teach elaboration pass to gather/resolve trait obligations and emit `trait_call` nodes.
4. Update emitters/runtimes to handle trait evidence explicitly (dictionary passing or specialization).
5. Add validator + optional debugging data (`CoreResolvedConstraint`) for inspection.
6. Document backend policies (which traits can be specialized vs dictionary-based per backend).

With this plan, traits integrate with the infection/domain story without mutating value representations, keeping Core IR portable and backend strategies explicit.
