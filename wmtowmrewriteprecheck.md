# Workman-to-Workman Rewrite Pre-Check

This checklist is ordered by **when to do things**:

1. **Pre-Rewrite Prep** — easy wins that make writing the compiler nicer
2. **Stdlib Blockers** — required data structures and functions
3. **Bootstrap Phases** — the actual compiler rewrite
4. **Post-Bootstrap** — optimizations, ergonomics, nice-to-haves

---

# Phase 0: Pre-Rewrite Language Improvements

These are **relatively easy to implement** and will significantly improve the
experience of writing the self-hosted compiler. Do these first.

---

## 🟡 Quick Language Wins

### Match Guards (`when` clause) — HIGH VALUE

Without guards, AST processing requires nested matches everywhere:

```
-- Without guards (painful)
match (expr) {
  BinaryExpr(op, l, r) => {
    match (op == "+") {
      true => ...,
      false => match (op == "-") { ... }
    }
  }
}

-- With guards (clean)
match (expr) {
  BinaryExpr(op, l, r) when op == "+" => ...,
  BinaryExpr(op, l, r) when op == "-" => ...,
}
```

- [x] Parser: `Pattern when condition => body`
- [x] AST: add `guard?: Expr` to MatchPatternArm
- [x] Type checker: check guard is Bool
- [x] Exhaustiveness: guards make patterns potentially non-exhaustive
- [x] Codegen: emit conditional check after pattern match

---

### List Literal Syntax — HIGH VALUE

You'll write hundreds of list constructions/patterns in the compiler:

```
-- Without syntax (tedious)
Link(1, Link(2, Link(3, Empty)))
match (tokens) { Link(a, Link(b, rest)) => ... }

-- With syntax (readable)
[1, 2, 3]
match (tokens) { [a, b, ...rest] => ... }
```

#### Expressions

- [x] Parser: `[1, 2, 3]` as list literal
- [x] Parser: `[head, ...tail]` spread syntax
- [x] Desugar to `Link(1, Link(2, Link(3, Empty)))`

#### Patterns

- [x] Parser: `[a, b, c]` in patterns
- [x] Parser: `[first, ...rest]` spread in patterns
- [x] Parser: `[a, b, ..._]` ignore rest
- [x] Desugar to constructor patterns

---

### Record Spread/Update — HIGH VALUE

AST transformations constantly create modified nodes:

```
-- Without spread (error-prone, verbose)
.{ kind = oldNode.kind, value = oldNode.value, id = oldNode.id, span = newSpan }

-- With spread (clean)
.{ ..oldNode, span = newSpan }
```

- [x] Parser: `.{ ..source, field = value }`
- [x] Type checker: source must be same record type
- [x] Codegen: copy all fields, override specified ones

---

### Record Punning — MEDIUM VALUE

```
-- Without punning
.{ name = name, age = age, span = span }

-- With punning
.{ name, age, span }
```

- [x] Parser: `.{ name }` expands to `.{ name = name }`
- [x] Works in record construction

---

### `panic` Expression — REQUIRED

For internal compiler errors (ICE):

```
match (impossible) {
  _ => Panic("unreachable: this should never happen")
}
```

- [x] Parser: `fail "message"`
- [x] Type: `fail : forall a. String -> a` (bottom type)
- [x] Runtime: halt with error message

---

### String Concat Operator — MEDIUM VALUE

```
-- Without operator
stringConcat(stringConcat(a, " "), b)

-- With operator
a ++ " " ++ b
```

- [x] Define `++` infix operator for strings
- [x] `infixl 5 ++ = stringConcat`

---

## 🟢 Nice But Can Wait

These help but aren't as impactful for compiler code:

### Or-patterns

- [ ] `A | B => ...` — share handler for multiple patterns

### As-patterns

- [ ] `pattern as name` — bind whole match to name

### Pipeline Operator

- [ ] `value |> fn1 |> fn2` — nice for transforms but not essential

---

# Phase 1: Stdlib Blockers

These must exist before you can write the compiler.

---

## 🔴 Map & Set (THE stdlib blocker)

A compiler uses maps/sets _everywhere_: environments, scopes, operator tables,
visited sets, free vars.

### StringMap (start here)

- [x] `type StringMap<V>` — association list keyed by String
- [x] `stringMapEmpty : StringMap<V>`
- [x] `stringMapInsert : (String, V, StringMap<V>) -> StringMap<V>`
- [x] `stringMapLookup : (String, StringMap<V>) -> Option<V>`
- [x] `stringMapContains : (String, StringMap<V>) -> Bool`
- [x] `stringMapRemove : (String, StringMap<V>) -> StringMap<V>`
- [x] `stringMapToList : StringMap<V> -> List<(String, V)>`
- [x] `stringMapFromList : List<(String, V)> -> StringMap<V>`
- [x] `stringMapKeys : StringMap<V> -> List<String>`
- [x] `stringMapValues : StringMap<V> -> List<V>`
- [x] `stringMapMap : (V -> W, StringMap<V>) -> StringMap<W>`
- [x] `stringMapFold : ((Acc, String, V) -> Acc, Acc, StringMap<V>) -> Acc`
- [x] `stringMapUnion : (StringMap<V>, StringMap<V>) -> StringMap<V>`

### StringSet

- [x] `type StringSet` — association list
- [x] `stringSetEmpty : StringSet`
- [x] `stringSetInsert : (String, StringSet) -> StringSet`
- [x] `stringSetContains : (String, StringSet) -> Bool`
- [x] `stringSetRemove : (String, StringSet) -> StringSet`
- [x] `stringSetToList : StringSet -> List<String>`
- [x] `stringSetFromList : List<String> -> StringSet`
- [x] `stringSetUnion : (StringSet, StringSet) -> StringSet`
- [x] `stringSetDifference : (StringSet, StringSet) -> StringSet`

### IntMap (for node IDs)

- [x] `type IntMap<V>`
- [x] `intMapEmpty`, `intMapInsert`, `intMapLookup`, `intMapContains`

### IntSet (for visited sets, free vars)

- [x] `type IntSet`
- [x] `intSetEmpty`, `intSetInsert`, `intSetContains`, `intSetUnion`

**Note:** Association-list is O(n) but fine for bootstrap. Upgrade to balanced
tree later.

---

## 🔴 String Operations

### Core (required for lexer/parser)

- [x] `stringLength : String -> Int`
- [x] `stringCharAt : (String, Int) -> Option<Char>`
- [x] `stringSubstring : (String, Int, Int) -> String`
- [x] `stringIndexOf : (Char, String) -> Option<Int>`
- [x] `stringStartsWith : (String, String) -> Bool`
- [x] `stringEndsWith : (String, String) -> Bool`
- [x] `stringContains : (String, String) -> Bool`
- [x] `stringToList : String -> List<Char>`
- [x] `stringFromList : List<Char> -> String`
- [x] `stringIsEmpty : String -> Bool`

### String Building (for codegen/pretty-printing)

Use the "accumulate list, join once" pattern:

- [ ] `stringJoin : (String, List<String>) -> String`
- [ ] `stringConcat : (String, String) -> String`

### Span Helpers

- [ ] `spanSlice : (String, Span) -> String`
- [ ] `spanLineCol : (String, Int) -> (Int, Int)` — for diagnostics

---

## 🔴 Diagnostic / Error Type

- [ ] `type Span = { start: Int, end: Int }`
- [ ] `type Diagnostic = { span: Span, message: String, severity: Severity, notes: List<DiagnosticNote> }`
- [ ] `type DiagnosticNote = { span: Option<Span>, message: String }`
- [ ] `type Severity = Error | Warning | Info | Hint`
- [ ] `diagnosticPrettyPrint : (String, Diagnostic) -> String`

---

## 🔴 Core List Operations

Verify/add these:

- [ ] `listHead : List<A> -> Option<A>`
- [ ] `listTail : List<A> -> Option<List<A>>`
- [ ] `listNth : (Int, List<A>) -> Option<A>`
- [ ] `listZip : (List<A>, List<B>) -> List<(A, B)>`
- [ ] `listZipWith : ((A, B) -> C, List<A>, List<B>) -> List<C>`
- [ ] `listFlatten : List<List<A>> -> List<A>`
- [ ] `listFilterMap : (A -> Option<B>, List<A>) -> List<B>`
- [ ] `listPartition : (A -> Bool, List<A>) -> (List<A>, List<A>)`
- [ ] `listFindIndex : (A -> Bool, List<A>) -> Option<Int>`
- [ ] `listIsEmpty : List<A> -> Bool`
- [ ] `listMapi : ((Int, A) -> B, List<A>) -> List<B>`

---

## 🔴 Result/Option Completeness

- [ ] `resultIsOk : IResult<A, E> -> Bool`
- [ ] `resultIsErr : IResult<A, E> -> Bool`
- [ ] `resultToOption : IResult<A, E> -> Option<A>`
- [ ] `resultSequence : List<IResult<A, E>> -> IResult<List<A>, E>`
- [ ] `resultTraverse : (A -> IResult<B, E>, List<A>) -> IResult<List<B>, E>`
- [ ] `optionToResult : (E, Option<A>) -> IResult<A, E>`
- [ ] `optionSequence : List<Option<A>> -> Option<List<A>>`
- [ ] `optionTraverse : (A -> Option<B>, List<A>) -> Option<List<B>>`

---

## 🔴 Fresh ID Generation

Thread state for pure FP:

- [ ] `type IdGen = { next: Int }`
- [ ] `freshId : IdGen -> (Int, IdGen)`

---

## 🔴 Basic Testing Harness

- [ ] `assert : Bool -> ()`
- [ ] `assertEqual : (A, A) -> ()`
- [ ] `test : (String, () -> ()) -> ()`
- [ ] `runTests : List<Test> -> ()`

---

## ✅ Already Done (via FFI)

- [x] File IO: `readFile`, `writeFile`
- [x] CLI args: `argv`
- [x] Module loading basics
- [x] `print` / stderr output

---

# Phase 2: Bootstrap Compiler

Write the actual compiler in Workman.

---

## Lexer

- [ ] Token type definition
- [ ] Character stream (index into string)
- [ ] Keyword recognition (use StringSet)
- [ ] Operator scanning
- [ ] String/char/number literal parsing
- [ ] Comment handling
- [ ] Span tracking
- [ ] Error recovery with diagnostics

## Parser

- [ ] AST type definitions (big sum type)
- [ ] Recursive descent parser
- [ ] Operator precedence (Pratt or shunting-yard)
- [ ] Pattern parsing
- [ ] Type expression parsing
- [ ] Error recovery
- [ ] Source span on every node

## Type Checker

- [ ] Type representation
- [ ] Type environment (StringMap)
- [ ] Unification algorithm
- [ ] Constraint generation
- [ ] Constraint solving
- [ ] Generalization / instantiation
- [ ] Pattern exhaustiveness
- [ ] Infection/effect tracking

## Code Generation

- [ ] Target: JS (easiest to start)
- [ ] IR or direct emit
- [ ] String building for output

---

# Phase 3: Post-Bootstrap Improvements

Do these **after** the compiler works.

---

## 🔵 Performance Optimizations

### Balanced-Tree Map/Set

- [ ] Replace association-list with AVL or Red-Black tree
- [ ] O(log n) instead of O(n) lookups
- [ ] Same API, swap implementation

### Hash Map (if needed)

- [ ] Requires hashing strategy
- [ ] Only if tree perf is insufficient

---

## 🔵 More Ergonomics

### Mutability (not needed for compiler)

- [ ] `let mut` mutable bindings
- [ ] Reassignment: `x = newValue`
- [ ] Compound assignment: `x += 1`
- [ ] Mutable record fields
- [ ] Early `return`
- [ ] `while` / `for` loops
- [ ] `break` / `continue`

### Arrays

- [ ] Mutable fixed-size arrays
- [ ] O(1) index access

### Functions

- [ ] Default arguments
- [ ] Named arguments at call site

### Other Syntax Sugar

- [ ] Range syntax: `0..10`
- [ ] If-let: `if let Some(x) = option { ... }`

---

## 🔵 Extended Stdlib

### Generic Map/Set (with ordering)

- [ ] Equality/ordering strategy
- [ ] `type Map<K, V>` with generic keys
- [ ] `type Set<A>` with generic elements

### More List Operations

- [ ] `listReject`, `listTakeWhile`, `listDropWhile`
- [ ] `listSpan`, `listIntersperse`, `listUnzip`
- [ ] `listReplicate`, `listSingleton`
- [ ] `listFilteri`, `listInit`

### Char Operations

- [ ] `charIsDigit`, `charIsAlpha`, `charIsAlphaNum`
- [ ] `charIsWhitespace`, `charIsUpper`, `charIsLower`
- [ ] `charToUpper`, `charToLower`
- [ ] `charToInt`, `charFromInt`

### Int Operations

- [ ] `intAbs`, `intMin`, `intMax`, `intClamp`
- [ ] `intSign`, `intPow`
- [ ] `intToString`, `intFromString`
- [ ] `intRange : (Int, Int) -> List<Int>`

### Tuple & Function Combinators

- [ ] `fst`, `snd`, `swap`, `curry`, `uncurry`
- [ ] `identity`, `const`, `flip`, `compose`, `pipe`

### Numeric Types

- [ ] `Float`, `BigInt`, `Rational`

---

## 🔵 Tooling

### Error Messages

- [ ] "Did you mean X?" suggestions
- [ ] Multi-span errors
- [ ] Contextual hints

### Debugging

- [ ] Pretty-print AST
- [ ] Pretty-print types
- [ ] Type inference trace mode

### Documentation

- [ ] Doc comments (`--| ...`)
- [ ] Generate docs from source

### Package Management

- [ ] Proper module resolution
- [ ] Dependency declaration

---

# 📊 Progress Tracking

## Milestones (in order)

- [ ] **M0**: Quick language wins (guards, list literals, record spread, fail)
- [ ] **M1**: StringMap + StringSet + IntMap + IntSet
- [ ] **M2**: String ops + Diagnostics + List ops complete
- [ ] **M3**: Lexer written in Workman
- [ ] **M4**: Parser written in Workman
- [ ] **M5**: Type checker written in Workman
- [ ] **M6**: Full self-hosting achieved 🎉
- [ ] **M7**: Balanced-tree Map/Set (performance)
- [ ] **M8**: Extended ergonomics (mutability, arrays, etc.)

## Current Status

| Category                   | Done | Total | Progress |
| -------------------------- | ---- | ----- | -------- |
| **Phase 0: Language Wins** |      |       |          |
| Match guards               | 5    | 5     | 100%     |
| List literals (expr)       | 3    | 3     | 100%     |
| List literals (pattern)    | 4    | 4     | 100%     |
| Record spread              | 3    | 3     | 100%     |
| Record punning             | 2    | 2     | 100%     |
| `fail` expression          | 0    | 3     | 0%       |
| `++` operator              | 0    | 1     | 0%       |
| **Phase 1: Stdlib**        |      |       |          |
| StringMap                  | 0    | 13    | 0%       |
| StringSet                  | 0    | 9     | 0%       |
| IntMap/IntSet              | 0    | 8     | 0%       |
| String ops                 | ?    | 12    | ?%       |
| Diagnostics                | 0    | 5     | 0%       |
| List ops                   | ~15  | 20    | ~75%     |
| Result/Option              | ~8   | 15    | ~53%     |
| Testing harness            | 0    | 4     | 0%       |

---

## Decision Log

| Decision                       | Rationale                            |
| ------------------------------ | ------------------------------------ |
| Guards before bootstrap        | Makes AST code dramatically cleaner  |
| List literals before bootstrap | Constant use in compiler code        |
| Record spread before bootstrap | AST transformations are much nicer   |
| String-keyed maps first        | Compilers mostly use string keys     |
| Association-list Map/Set       | Simple, correct, upgrade later       |
| `stringJoin` pattern           | Pure FP, simple, fast enough         |
| No `let mut` for bootstrap     | Compiler can be written functionally |
| Balanced tree after bootstrap  | Don't block on optimization          |

---

## Notes

- **Phase 0 is worth the investment** — these features pay off immediately in
  cleaner compiler code
- Association-list Map is O(n) but fine for <10k entries
- Thread state explicitly: `(result, newState) = transform(input, state)`
- Accumulate strings as `List<String>`, join once at end
- Test early and often

---

_Last updated: 2026-01-07_
