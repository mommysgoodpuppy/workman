# MIR (portable, backend-agnostic)

ANF-ish, closure-converted, explicit control flow. No target layouts.

## Values
- `i32/i64/f64` (intent only; JS will use number)
- `bool`
- `char` (int code point)
- `tuple` (abstract)
- `closure { code: fun_id, env: tuple }`
- `adt { tag: u32, fields: tuple }`

## Instructions (within basic blocks)
- `v = const k`
- `v = prim op(args...)`           // add/sub/mul/div/cmpInt/charEq/print
- `v = make_tuple(args...)`
- `v = get_tuple(t, idx)`
- `v = make_closure(fun_id, env_tuple)`
- `v = call(fun, args...)`
- `tailcall fun(args...)`          // tail position marker
- `v = alloc_ctor(tag_id, fields_tuple)`
- `v = get_tag(v)`
- `v = get_field(v, i)`
- `switch v { case k -> bb_k, ... }`
- `br bb`
- `ret v`

## Functions
- `fn f(params: v[]):` blocks in SSA-lite (ANF names suffice; no global SSA required)
- Tail-call info preserved for self-loop elimination in backends

## Notes
- No pointer arithmetic or layout assumptions
- Allocation ops abstract; backends choose GC/RC/arena or host GC (JS)
- Polymorphism: MIR can carry instantiated types when needed; M1 JS erases them
