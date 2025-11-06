# MIR → ESM Codegen

## Emission structure
- File prologue: inline `WM` helpers
- Tag tables for each `type` in program
- Function declarations for each MIR function
- Top-level lets bound in dependency order
- Exports: `export const name = ...`; for exported types, export constructors too

## Mapping rules
- `const k` → JS literal
- `make_tuple(a,b)` → `[a,b]`
- `get_tuple(t,i)` → `t[i]`
- `alloc_ctor(tag, tuple)` → `WM.mk(tag, ...tuple)`
- `get_tag(v)` → `v.tag`
- `get_field(v,i)` → `v["_"+i]`
- `prim add/sub/mul/div/charEq/print` → `WM.add/...`
- `prim cmpInt` → `WM.cmpInt`
- `call f(args...)` → `f(a,b,...)` (M1 direct n-ary)
- `tailcall self(args...)` → loopify:
  - Transform function body to `for(;;){ ... if (tail){ a=newA; b=newB; continue } return result }`
- `switch tag` → `switch (v.tag) { case Tag_T.Ctor: ... }`

## Recursion and mutual recursion
- Self recursion: loopify as above
- Mutual recursion: no special handling in M1; regular function calls

## Constructors and types
- If a `type T` is exported, emit `Tag_T` and per-ctor JS factory exported
- If a `type T` is not exported, still emit internal `const Tag_T` to build values
