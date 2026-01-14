# Control Flow and Pattern Matching (Normative)

## Scope

Defines `match` and `if/else` behavior, arm selection, and exhaustiveness.

## Status

Draft (normative where specified).

## Dependencies

- `../4. Static semantics/2-type-inference.md`

This section defines `match` and `if/else` (as sugar), including evaluation, arm
selection, and the contract for exhaustiveness.

---

## `if/else`

Normative:

- `if/else` is syntax sugar for a boolean match.
- `else` is mandatory.
  - An `if` without an `else` branch is ill-formed: it has no value, so it
    cannot appear in expression position (v1 static error).
- `else if` is not part of the language.

---

## `match`

### Scrutinee evaluation

Normative:

- The scrutinee expression is evaluated exactly once before arm selection.

### Arm selection

Normative:

- Arms are considered in source order (left-to-right).
- The first arm whose pattern matches and whose guard (if present) evaluates to
  `true` is selected.
- If a guard is present, it is evaluated only after the pattern match succeeds.

### Pattern binding

Normative:

- Bindings introduced by a successful pattern are in scope for the guard and the
  arm body.

---

## Exhaustiveness and Non-Exhaustive Matches

Normative (v1 rule):

- Matches must be exhaustive.
- For _closed_ sum types (algebraic data types with a known, finite set of
  constructors in scope), a match is exhaustive if all constructors are covered
  by unguarded arms.
- A wildcard arm (`_ => { ... }`) counts as exhaustive for any scrutinee type.
- For non-sum types, or when constructor coverage cannot be proven, a wildcard
  arm is required in v1.
- Guarded arms do not contribute to exhaustiveness unless the guard is
  statically provable (v1: treat as not provable).

This is a major semantic commitment and must be paired with precise diagnostics.
The rigorous coverage model is specified separately:

- `../9. Appendices/1-formal-core.md` (future formal core)
- and design notes in `../../coreirRefactor/match_refactor_plan.md`

Until a formal coverage proof system is defined, implementations must enforce
the wildcard-arm rule above.

---

## Match Bundles and Conjunction (Canonical Model)

This section formalizes the intended _canonical_ model that the v1 surface
syntax desugars into. It is normative for coverage and diagnostics.

Normative:

- A **match bundle** is a first-class value that represents a _product_ of
  inverse constructor clauses (a disjunctive product).
- `match { ... }` constructs a bundle; `match(scrutinee) { ... }` applies a
  bundle to a scrutinee.
- A bundle is composed from **arms**. Each arm introduces one inverse clause
  (constructor test + bindings).
- Commas in a bundle form a **conjunction** of inverse clauses. Conjunction is
  associative and does not introduce implicit wildcard coverage.

Normative (bundle reference):

- A bundle reference inside a bundle (e.g., `match { bundleRef, ... }`) is
  equivalent to splicing the referenced bundle's arms in place.
- Bundle references **do not** imply `_` coverage.

Normative (coverage model):

- The coverage of a bundle over a closed sum type is the union of constructors
  handled by its unguarded arms (including those from referenced bundles).
- Guarded arms do not add coverage in v1.
- A bundle is exhaustive for a closed sum type iff its coverage includes all
  constructors of the type.

Non-normative note:

- This model aligns with the "inverse constructor + conjunction" formulation in
  `plans/match/inv.md` and `plans/match/or.md`, and the `MatchType`/coverage
  tables described in `plans/coreirRefactor/match_refactor_plan.md`.

---

## Pattern Forms (Dynamic Meaning)

This chapter specifies only dynamic matching behavior; typing is specified in
the static semantics chapters.

### Summary (non-normative)

Workman has two different meanings for identifier-shaped patterns:

- A **binding** introduces a fresh name for (part of) the scrutinee.
- A **pin** refers to an existing name and matches only if the scrutinee equals
  that existing value.

This inversion applies specifically to `match` patterns; other binding sites
(lambda parameters, `let` bindings, record fields, etc.) continue to treat bare
identifiers as fresh bindings and therefore never require `Var`.

In particular:

- `Some(x)` binds `x` (constructor fields bind, even if `x` is already in
  scope).
  - `Some(Var(x))` is permitted but redundant.
  - To compare a constructor payload to an existing value, bind it and use a
    guard (e.g. `Some(v) when v == expected`).
- `x` (a pattern that is exactly one identifier) is a pin: it is never a binder.
- `(x, y, z)` and `[x, y, z]` are tuples/lists of pins; use `Var(...)` per
  element to bind: `(Var(x), Var(y), Var(z))`, `[Var(x), Var(y), Var(z)]`.

### Concrete example (non-normative)

Read the slogan as "destructuring binds, bare identifiers pin, `Var` binds the
whole value." The surface looks just like familiar `if (lhs == rhs)` checks, but
you write them with `match`.

```
let opt_value = compute();
let sentinel = true;
let expected = 42;

let payload = "outer";

match(opt_value) {
  Some(payload) => { log("Some payload: " ++ payload) },  -- binds (shadows outer `payload`)
  Var(copy) => { log("Fallback copy: " ++ copy) },        -- bind whole scrutinee
};

let x = read_int();
let y = expected;

-- if (x == sentinel) { ... } else if (x == y) { ... } else { ... }
match(x) {
  sentinel => { log("pinned compare to sentinel") },      -- bare identifier pins
  y => { log("pinned compare to y") },                    -- bare identifier pins
  Var(fresh) => { log("fresh binding: " ++ fresh) },      -- explicit binder
};
```

`Some(payload)` binds `payload`, `Var(copy)` binds the entire scrutinee, and the
bare identifiers (`sentinel`, `y`) simply compare against the values already in
scope.

### Guards + tuple pins vs explicit binding (non-normative)

Guards see bindings introduced earlier in the arm. Use `Var(...)` to capture
either the whole scrutinee or just the positions you want to guard on.

```
let expectedX = 10;
let expectedY = -4;
let expectedZ = 0;
let limit = 5;

match(read_sensor()) {
  Var(point) when point.distance > limit => {
    log("far away: " ++ point.id)
  },
  (expectedX, expectedY, expectedZ) => {
    log("exactly at the calibration tuple")
  },                                            -- tuple of pins
  (Var(x), Var(y), Var(z)) when z > limit => {
    log("fresh tuple bindings: " ++ x ++ ", " ++ y ++ ", " ++ z)
  },                                            -- explicit tuple binding
  (Ok(x), Ok(y), Ok(z)) => {
    log("triple success payload: " ++ x ++ y ++ z)
  },                                            -- constructors keep destructuring ergonomic
  _ => { log("fallback") }
};
```

Normative:

- Wildcard (`_`) matches any value.
- Literal patterns match if the scrutinee equals the literal value.
- Tuple patterns match if the scrutinee is a tuple of the same arity and each
  element pattern matches.
- Constructor patterns match if the scrutinee has the same constructor and all
  field patterns match.

Pinned vs binding (canonical rule, normative):

- Workman distinguishes **structural patterns** from **bare identifier
  patterns**.
- Structural patterns bind "as usual" when the pattern introduces shape (a
  constructor, tuple/list delimiter, or another explicit pattern form):
  - Constructor patterns bind their field identifiers: `Some(x)` binds `x`,
    `(Ok(x), Ok(y), Ok(z))` binds all three `x/y/z`, `[head, ..tail]` binds
    `head` and `tail`.
    - In particular, `Some(x)` binds `x` even if a value named `x` is already in
      scope; constructor fields are not treated as pins.
  - Tuples/lists apply the rule element-wise: structural subpatterns bind, but
    an element that is itself "just an identifier" is still treated as a pin.
  - Writing `Var(name)` in any position forces that position to bind, regardless
    of surrounding structure.
- A pattern that is _exactly one identifier_ is **not** a binder; it is a pinned
  reference:
  - `match(x) { y => { ... } }` treats `y` as a reference to an existing value
    named `y` (like a literal), not a new binding.
  - If a value named `y` is in scope at the pattern site, the arm matches iff
    the scrutinee equals the value of `y`.
  - If no value named `y` is in scope at the pattern site, the program is
    ill-formed (v1: a static error).
- To bind the whole scrutinee without destructuring, use `Var(name)`:
  - `match(x) { Var(y) => { ... } }` binds `y` to the scrutinee value.

### Tuple/list literals made of identifiers (Normative)

- `(x, y, z)` and `[x, y, z]` are interpreted as tuples/lists of pins.
  - Each identifier must already be in scope; the arm matches only when the
    scrutinee’s components equal those pinned values.
- To destructure into fresh bindings, wrap each identifier with `Var`:
  `(Var(x), Var(y), Var(z))`, `[Var(first), Var(second), ..Var(rest)]`.
- Mixed forms follow the rule element-wise. Example: `(Var(head), tail)` binds
  `head` (because of `Var`) but pins `tail`. Adding constructors restores the
  usual destructuring ergonomics: `(Ok(x), Ok(y), Ok(z))` binds all fields
  without extra `Var(...)`.

Non-normative explanation (the "inversion"):

- Canonical Workman chooses "`identifier` means pin" for the _bare identifier
  pattern_, and uses `Var(identifier)` for the _bare binder pattern_.
- This keeps constructor destructuring ergonomic (`Some(x)`, `Ok(x)`, etc.)
  while making the "match a named value" case explicit and consistent with
  literal matching.
- Users coming from more conventional `if`/`else` languages can translate mental
  models directly: `if (x == y) { body } else { other }` is desugared as
  `match(x) { y => { body }, _ => { other } }`. A bare identifier arm is just
  “the `== y` test” spelled as a pattern.
- Even functional-language veterans still rely on `if/else`, so nothing about
  this inversion should feel alien—`match` simply makes the comparison explicit
  and enforces that every branch produces a value.

Non-normative example (why this is consistent):

- Common confusion: `Some(x)` binds, it does not pin.
  ```
  let x = 1;

  match(Some(1)) {
    Some(x) => { log("binds x (shadows outer x): " ++ x) },
    _ => { log("no match") }
  };

  match(Some(1)) {
    Some(v) when v == x => { log("pins by guard: payload equals outer x") },
    _ => { log("other") }
  };
  ```

Non-normative example (guards + tuple pins vs explicit binding):

- Tuple/list pins vs bindings show up most often when matching against named
  tuples/lists.
  ```
  let expectedX = 10;
  let expectedY = -4;

  match(read_pair()) {
    (expectedX, expectedY) => { log("tuple of pins") },
    (Var(x), Var(y)) => { log("fresh bindings: " ++ x ++ ", " ++ y) },
    _ => { log("fallback") }
  };
  ```
