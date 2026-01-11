Raw Mode ADT Monomorphization Status

Overview
- Raw mode keeps ADTs in source but monomorphizes them to concrete Zig types.
- Generic ADTs are instantiated per used type arguments; raw mode never emits a true generic runtime type.

What Works Now
- Monomorphization for constructor ADTs and alias types.
- Constructors lowered to `union(enum)` with sanitized tags.
- Pattern matching works against monomorphized types.
- Self-recursive ADTs are rewritten to `Ptr<Self, <>` so Zig can compile them.
- Foreign/cimport type args (ex: `SDL_Window`) are localized to the using module to avoid cross-module `@cImport` mismatches.

Current Limitations
- Mutual recursion across multiple ADTs is not fully handled (only direct self-recursion is rewritten).
- Branch "join" typing in raw mode is limited to coercion rules, not a full Zig-like peer type algorithm.
- Layout/ABI guarantees are not formalized (currently relies on Zig `union(enum)` defaults).
- No higher-kinded or runtime-polymorphic ADT representation (by design).

Notes for Future Work
- Add a mutual-recursion pass or box strategy for multi-type cycles.
- Add peer-type resolution for `if/match` joins in raw mode.
- Decide on layout constraints if raw ABI stability matters.
