# Core IR (typed, semantic source of truth)

Purpose: One canonical, typed representation for semantics. Interpreter and compiler consume Core.

## Types (carried from inference)
- Base: `Int | Bool | Char | String | Unit`
- Tuples: `Tuple<T...>`
- Functions: `Func<Params... -> Result>`
- ADT instance: `Data<TypeName, Args...>`
- Type variable: `TyVar(id)` (for polymorphism; generalized at let)

## Terms
- `Var(name)` — variable reference
- `Lit(value)` — int/bool/char/string/unit
- `Lam(params: name[], body: Core)` — n-ary functions
- `App(fn, args[])` — function call (fully applied in M1)
- `Let(name, rhs, inBody)` — non-recursive let
- `LetRec(bindings: [name, Lam]+, inBody)` — recursive/mutual
- `Ctor(typeName, ctorName, fields[])` — data constructor application
- `Match(scrut, cases: [Pattern -> Core]+)` — pattern match
- `Prim(name, args[])` — host primitives: `add, sub, mul, div, cmpInt, charEq, print`

## Patterns
- `PWildcard`
- `PVar(name)`
- `PLit(value)`
- `PTuple([...])`
- `PCtor(ctorName, subpatterns[])`

## Invariants
- Types annotate all nodes
- Arity correctness checked before codegen
- Match exhaustiveness checked earlier (or runtime error fallback)
- Operators in surface either become `Prim` (built-ins) or `App(Var("__op_*"), ...)` (unsupported in M1 unless mapped)
