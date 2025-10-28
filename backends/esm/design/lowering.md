# Lowering Pipeline

```
Surface AST (parser) + Types (infer) 
    -> Core IR (typed, desugared) 
    -> MIR (ANF + closure conversion + pattern→switch)
    -> JS ESM (M1)
```

## Surface → Core
- Use `inferProgram` results (types, ADT env) to annotate.
- Tuple params already lowered earlier.
- Binary/unary:
  - Built-in integer ops: `Prim(add|sub|mul|div)`
  - Else: keep as `App(Var("__op_*"), [...])` (unsupported in M1)
- Constructors: `Ctor(Type, Ctor, fields)`
- `match_fn`: `Lam([param], Match(param, ...))`

## Core → MIR
- ANF: name all intermediate results
- Closure conversion:
  - Compute free vars of each `Lam`
  - Create `env_tuple`, use `make_closure(fun_id, env)`
  - Parameter list remains n-ary
- Pattern → switch:
  - Scrutinee bound once
  - For ADT: `t = get_tag(s); switch t { ... }` then extract fields with `get_field`
  - Literals/bool: if/else chains (M1)
  - Tuple: guard arity, decompose via `get_tuple`

## Tag assignment
- For each `type T = | C0 | C1<A> | ...`, define `Tag_T = { C0:0, C1:1, ... }`
- MIR uses numeric `tag_id` from this table
- JS backend emits these tables and JS constructor factories when `type T` is exported

## Tail-call marking
- Mark tail position in Core
- MIR uses `tailcall` for self calls
- JS M1: loopify self tail calls only
