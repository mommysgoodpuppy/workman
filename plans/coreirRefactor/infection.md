# Infection Stack & Domain Integration Plan

This note refines how Workman's infection/meta-type system should integrate with the Core → Elaborated → Target IR pipeline. It assumes traits share the same "domain" machinery as mem/async, but emphasizes that different domain kinds compose differently.

## 1. Domain Taxonomy

Every domain entry shares a uniform registry, but carries a `kind` describing how it composes and what IR support it needs:

| Kind | Examples | Behavior in IR |
| --- | --- | --- |
| `carrier` | `async/promise`, `result/error`, future `io` carrier | Needs `pure/map/bind/match/raise` ops. Ordering matters (outer carriers must be unwrapped before inner ones). |
| `capability` | `mem` open/closed, `raw` mode, borrow regions | No monadic ops. Instead they contribute constraints ("deref requires open", "free closes"). Usually attached directly to the value's type. |
| `trait` | `Print`, `Eq`, future protocol dictionaries | Represented as constraints/evidence. They appear in type schemes (`where Print(a)`) and elaboration inserts implicit evidence parameters. |

### Registry schema (compiler-side distilled summary)

```ts
interface DomainDef {
  id: DomainId;
  name: string; // "mem", "async", "trait.Print"
  kind: "carrier" | "capability" | "trait";
  compose: "flatten" | "nest";  // canonical stack normalization
  orderRank: number;              // total order for canonicalization
  forbidUnder?: DomainId[];       // invalid nesting pairs
  stateMerge?: "left" | "right" | "custom"; // hints for capability state merge
}
```

Domain metadata (compose/ordering) lives here, not on individual type entries, so every pass agrees on normalization.

## 2. Type Representation

Make infection first-class inside the type system so unification and effect tracking cannot ignore it.

```ts
type InfectionEntry = { domain: DomainId; state: Type };

type Type =
  | ... existing variants ...
  | { kind: "infected"; base: Type; valueDomains: InfectionEntry[]; };

interface TypeScheme {
  type: Type;                // already includes value-domain infections
  vars: readonly TypeVarId[];
  traitConstraints: readonly Constraint[]; // trait domains (aka evidence)
}
```

- **Value domains** are ordered stacks (outermost first) limited to capability/carrier kinds.
- **Trait domains** become entries inside `traitConstraints`, so a type can read "`∀a. a -> String where Print(a)`".

## 3. Layer Responsibilities

### Core IR
- Stores types with value-domain stacks and trait constraints.
- Graph carries the domain registry summary so later passes do not rely on std modules for policy.

### Elaborated Core (canonicalization pass)
1. **Normalize stacks**: apply `orderRank`, flatten or nest per `compose`, reject forbidden nestings.
2. **Insert carrier ops**: rewrite calls/matches on carrier-marked types into explicit nodes or annotate `callKind/matchKind`.
3. **Insert capability ops**: emit explicit `mem_open`, `mem_close`, etc., or enforce constraints at primitive use sites.
4. **Materialize trait evidence**: each trait constraint becomes an implicit parameter or evidence dictionary (hidden in source but explicit in IR).

### Target IR / backends
- Consume the explicit carrier + capability ops.
- Map trait evidence to backend-specific dictionaries/impls.
- Leverage domain metadata for validation (e.g., Zig raw backend ensures `raw` capability is outermost before emitting FFI pointers, see `std/zig/rawmem.wm`).

## 4. Canonicalization & Validation Rules

- **Ordering:** use `orderRank` as the canonical ordering for value-domain stacks. A simple rule: higher rank = outer layer. Additionally consult `forbidUnder` for domain-specific rules (e.g., `raw` cannot sit under `async`).
- **Flattening:** carriers typically `nest`; some capability domains may `flatten` (e.g., repeated `mem` entries collapse). This is determined solely by the registry.
- **Validation pass:** after Layer B, ensure stacks are canonical, carrier ops match carrier domains, capability states satisfy required predicates, and every trait constraint has evidence in scope.

## 5. Trait Domains as Evidence

Traits remain first-class domains, but they live in the constraint set:

```ts
// Source: let show = (x) => print(x)
// Type:  forall a. a -> () where Print(a)
// Elaborated: show = (print_dict_a, x) => print_with_dict(print_dict_a, x)
```

- Trait constraints use the same registry metadata. They can import extra data (dictionary type) via `state`.
- Elaborated Core tracks implicit parameters (`implicitParams` on lambdas) to carry this evidence.

## 6. Example Flow

1. **Type inference** produces: `Ptr<Int,s>` with `valueDomains = [mem(s)]`.
2. **Async wrapper** produces type: `{ kind:"infected", base: Ptr<Int,s>, valueDomains = [async(state_async), mem(s)] }` (order defined by ranks).
3. **Elaboration** sees a deref on this type:
   - Inserts `carrier_bind(async, ...)` to unwrap async before deref.
   - Ensures mem capability is open when calling `deref` (either by constraint or by inserting `mem_open`).
4. **Backend** lowers `carrier_bind` to either Zig runtime `callInfectious` or raw `async` primitives, and enforces mem state via runtime calls described in `std/zig/rawmem.wm`.

## 7. Integration Tasks to Track

1. Extend Core schema (types + `TypeScheme`) to carry value-domain stacks and trait constraints.
2. Add `DomainDef` summaries to `CoreModuleGraph` (populated from std domain declarations).
3. Implement Layer-B pass that normalizes stacks and inserts explicit carrier/capability/evidence ops.
4. Update backends to consume explicit IR nodes rather than heuristics.
5. Add validators checking canonical stacks and satisfied constraints.

This structure keeps infection data-driven, lets traits share the same registry logic without forcing them into the pointer stack, and gives every backend a uniform contract.
