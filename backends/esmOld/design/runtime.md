# JS Runtime (M1)

Minimal inline helpers; portable shapes for future C/Zig.

## Value representations
- Int → JS number (32-bit ops for add/sub/mul/div via `|0` when needed)
- Bool → JS boolean
- Char → JS number (code point)
- String → JS string
- Unit → `WM.unit` (undefined)
- Tuple → JS array `[v0, v1, ...]`
- ADT → JS object `{ tag: number, _0?: any, _1?: any, ... }`

## Helpers (inline `WM` object)
- `unit`
- `mk(tag, ...fields)` — build ADT
- `getTag(o)` — read tag
- `getField(o, i)` — read field
- `tuple(...es)` — build tuple
- `getTuple(t, i)` — read tuple element
- `ap(f, args)` — apply n-ary functions (M1 uses direct calls where possible)
- Prims:
  - `add(a,b)`, `sub(a,b)`, `mul(a,b)`, `div(a,b)` (truncate via `Math.trunc` or `|0` policy)
  - `charEq(a,b)`
  - `cmpInt(a,b)` → if `Ordering` is present, return `WM.mk(Tag_Ordering.LT/EQ/GT)`; otherwise may be omitted in M1
  - `print(x)` → `console.log(x); return unit`

## Tag tables and constructors
- For each defined `type T`:
  - Emit `export const Tag_T = { Ctor: id, ... }`
  - If `export type T`, also emit JS constructors:
    - `export const Ctor = (...fs) => WM.mk(Tag_T.Ctor, ...fs)`

## Errors
- M1: throw regular JS `Error` for impossible states (constructor arity mismatch, non-exhaustive match if it occurs)
- Future: source-mapped Workman-style errors
