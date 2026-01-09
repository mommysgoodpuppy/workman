Yep — if you want **2 Zig backends + more later** without the Core IR turning into a grab-bag, you basically want to *lock in* a few “this is absolutely backend-agnostic” invariants, and push everything else into **one of two places**:

1. **elaboration passes** (typed rewrites, like infection / sugar / evidence insertion)
2. **backend lowering** (Core → TargetIR → pretty printer)

Below is the set of Core IR tweaks I’d consider *“must do”* (not “nice to have”) for sanity.

---

## 0) Adopt a 3-layer contract (this avoids 90% of future pain)

### Layer A — **Core IR (portable)**

* no Zig strings
* no JS runtime helper names
* no “if backend X then …” decisions
* only semantics you expect **every backend** to be able to represent

### Layer B — **Elaborated Core (still portable, but more explicit)**

* sugar gone
* infection / effects / auto-unwrap made explicit *as IR nodes*, not emitter heuristics
* trait evidence insertion (if you go there)

### Layer C — **Target IR per backend family**

* ZigTargetIR (raw vs runtime can share this and diverge later)
* JSTargetIR
* GLSLTargetIR
* etc.

You can keep the current Core shape, but you’ll want to move several things out of it or formalize them so they don’t leak backend strategy.

---

## 1) Remove Zig-specific type strings from Core (replace with structured ABI types)

Right now `CoreTypeDeclaration.recordFields[].typeAnnotation?: string` is the classic “it’ll spread everywhere” infection (the bad kind 😅).

**Fix: define a backend-neutral “ABI type” tree**, and only render it to Zig/C/etc in the backend.

Example sketch:

```ts
type AbiType =
  | { kind: "int"; signed: boolean; bits: 8|16|32|64|128 }
  | { kind: "float"; bits: 16|32|64|128 }
  | { kind: "bool" }
  | { kind: "void" }
  | { kind: "ptr"; to: AbiType; mutable: boolean }
  | { kind: "array"; len: number; of: AbiType }
  | { kind: "struct"; fields: { name: string; type: AbiType }[] }
  | { kind: "named"; name: string; args?: AbiType[] }        // for imported C types etc
  | { kind: "opaque"; name: string };
```

Then record decl fields become `abi?: AbiType` (optional) instead of `typeAnnotation?: string`.

This single change is *huge* for “2 Zig backends + others”.

---

## 2) Preserve **polymorphism / generalization** explicitly in Core

Your nodes all have `type: Type` (monotype), but codegen across modules will eventually need to know:

* what is generalized (`forall`)
* what are the type params for a value/type (and stable ordering!)

Otherwise Zig backend #1 invents one scheme, Zig backend #2 invents another, and JS backend just ignores it — and your “same Core, multiple backends” promise breaks.

**Add schemes at binding boundaries**:

```ts
type TypeScheme = { type: Type; vars: number[] /* or names */ };

interface CoreValueBinding {
  name: string;
  value: CoreExpr;
  scheme: TypeScheme;        // <--- new
  exported: boolean;
  origin?: NodeId;
}
```

And for ADTs/records:

```ts
interface CoreTypeDeclaration {
  name: string;
  typeParams: number[];      // <--- new
  constructors: { name: string; fields: Type[]; exported: boolean }[];
  recordFields?: { name: string; type: Type; abi?: AbiType }[];
}
```

Even if JS ignores it, Zig (and future backends) will thank you.

---

## 3) Split “portable semantics” from “backend strategy” for infection

Right now your JS emitter decides things like “if carrier type then callInfectious/callAsync/matchPromise”.

That’s fine for one backend, but it becomes unmaintainable when Zig backend #2 wants different calling conventions.

**Make infection lowering a pass that produces explicit IR**, instead of emitter heuristics.

Two good options:

### Option A — Introduce explicit carrier ops in ElaboratedCore

* `carrier_call`
* `carrier_match`
* `carrier_bind/map`
* `await` / `promise_match` (if async domain)

Then each backend maps those to its own runtime strategy.

### Option B — Add `callKind` / `matchKind`

If you want minimal changes:

```ts
type CallKind = "plain" | "infectious" | "async";
interface CoreCallExpr { kind:"call"; callKind: CallKind; ... }

type MatchKind = "plain" | "carrier" | "promise";
interface CoreMatchExpr { kind:"match"; matchKind: MatchKind; ... }
```

Either way: **the decision moves out of the printer**.

That’s one of the biggest “keep multiple backends sane” rules.

---

## 4) Add stable symbol identity (don’t let name sanitization leak into Core)

Today: JS backend sanitizes identifiers and reuses the scope map to avoid reserved words, etc.

That’s correct… but if Core only stores raw strings, every backend will reinvent:

* symbol shadowing rules
* export naming
* “what is the canonical identity of this thing?”

**Add a SymbolId layer** in Core (or at least in the module interface):

* Core uses `SymbolId` internally
* each backend has a `mangler(SymbolId) -> string`

Even a lightweight version helps:

```ts
type SymbolId = number;

interface CoreVarExpr { name: string; sym?: SymbolId; ... } // sym optional at first
interface CoreValueBinding { name: string; sym: SymbolId; ... }
interface CoreImportSpecifier { imported: SymbolId | string; localSym: SymbolId; ... }
```

If you do only one “compiler infrastructure” upgrade, make it this.

---

## 5) Make module interfaces complete: value/type/ctor namespaces + reexports

You already bumped into this with constructor re-export importing/exporting.

To avoid backend-specific patch logic, represent this *structurally*:

* imports can import **values**, **types**, **constructors**, **namespace**
* exports similarly
* re-exports are explicit (not “recompute from summary”)

So:

```ts
type ImportKind = "value" | "type" | "ctor" | "namespace";

type CoreImportSpecifier =
  | { kind:"value"; imported: string; localSym: SymbolId }
  | { kind:"type";  imported: string }
  | { kind:"ctor";  typeName: string; ctor: string; localSym: SymbolId }
  | { kind:"namespace"; localName: string };
```

Then your backends don’t need “summary-based reconstruction”. They just follow the interface.

---

## 6) Give ADTs/records enough info for *all* backends without reaching back into the AST

If your Zig backend wants to generate:

* tagged unions
* payload layouts
* or constructor helpers

…it needs constructor field types (and ideally type params).

Right now CoreTypeConstructor only has `{name, arity}`.

That’s too little long-term.

**Store constructor payload types** at least as `Type[]`. (AbiType only if you need raw layout.)

---

## 7) Fix “record field” naming collision and make Core nodes obviously distinct

You currently have `CoreRecordField` twice (expr-field vs decl-field). Even if TS tolerates it via shadowing/import order, it’s a future footgun.

Rename:

* `CoreRecordExprField` (value expression field)
* `CoreRecordDeclField` (type declaration field)

This matters because backends will want to pattern match quickly and reliably.

---

## 8) Add one sequencing primitive that all backends can lower cleanly

Even if you stay “expression-only”, having an explicit sequencing form makes Zig raw-mode and JS emission both simpler and more uniform.

Something like:

```ts
type CoreExpr =
  | ...
  | { kind:"block"; items: CoreExpr[]; result: CoreExpr; ... }
  | { kind:"assign"; target: CoreExpr; value: CoreExpr; ... }   // optional
```

You can keep it strict and expression-valued (like Zig blocks). This is especially important once you add your limited `while` form.

Without this, each backend will encode sequencing differently (IIFEs vs blocks vs temp vars) and your “two Zig backends” will diverge rapidly.

---

## 9) Keep debug metadata, but consider moving it to a side table

`origin/span` on every node is great. For multi-backend scaling, one tweak helps:

* store `metaId` on nodes
* store `{type, origin, span, maybe extra}` in a table

That lets you:

* strip metadata cheaply for release codegen
* add backend-specific tracing without changing node shapes

Not strictly required, but it’s one of those “save yourself later” moves.

---

# If you do only 5 changes, do these (in order)

1. **Replace Zig type strings with structured `AbiType`**
2. **Add TypeSchemes / typeParams to preserve polymorphism**
3. **Move infection decisions into an elaboration pass or explicit IR tags**
4. **Introduce SymbolId + per-backend mangling**
5. **Enrich type declarations with constructor field types**

Those five keep “2 Zig backends + others” sane.
