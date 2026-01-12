# Grammar (Normative)

## Scope

Defines the concrete syntax and operator precedence for canonical Workman.

## Status

Draft (normative where specified).

## Dependencies

- `../2. Source text/1-lexical-structure.md`

This section defines the concrete syntax of canonical Workman.

This is an early draft. The intent is:

- Keep the grammar small and unambiguous.
- Be strict: reject ambiguous or “alternative” spellings.

Where grammar details are missing, the manual is incomplete and must be extended
before claiming full conformance.

---

## Reserved Words

### Keywords (reserved)

The following are keywords and **must not** be used as identifiers:

- control/flow: `if`, `when`, `else`, `match`
- bindings/types/modules: `let`, `rec`, `and`, `mut`, `type`, `record`, `module`
- infection extension: `infectious`, `domain`, `policy`, `op`
- imports/exports: `from`, `import`, `export`, `as`
- literals: `true`, `false`, `void`
- special forms: `Panic`, `Var`, `assert`, `@lowercasestring`

This list may expand; expanding reserved words is a breaking change.

## Compiler Directives

Directives are meta-instructions to the compiler. They use the spelling
`@name directive_args?;` and can be recognized by both the parser and later
compiler phases. Canonical Workman v1 defines only the `@core;` directive; all
other directives discussed in this chapter are non-normative previews of planned
extensions.

### Syntax reference

- `directive := "@" ident directive_args? ";"`
- `directive_args := "(" directive_arg ("," directive_arg)* ")"`
- `directive_arg := string_lit | number_lit | ident`

Arguments are optional; most directives in v1 are bare markers (`@foo;`).

### Scoping rules

Directives follow lexical block scoping:

- **Module level**: Directives that appear before the first declaration apply to
  the entire module.
- **Block level**: Directives that appear as the first statements inside a block
  (the sequence immediately after `{`) apply to that block and all nested
  sub-blocks. When the block ends, the directive’s effect ends as well.

> **Canonical status**: Block-level directives exist to future-proof the grammar
> for raw/backend modes but have no canonical semantics in v1. Canonical code
> must not depend on block directives beyond the parser accepting them.

Implementations must track directives on a stack so that nested blocks compose
predictably (e.g., a nested `@raw;` overrides the outer checking mode and is
restored at the end of the block).

### Defined directives (v1)

1. `@core;` (module-only, canonical) &mdash; marks the module as part of the
   language core and suppresses automatic prelude imports. Only core
   distribution files should use this directive.

### Planned extensions (non-canonical)

Tooling may experiment with additional directives (e.g., `@raw;`,
`@backend("zig");`, `@target("spirv");`) to integrate backend-specific behavior.
Such directives are explicitly **non-canonical** in v1. Implementations that
support them must:

1. Clearly document their semantics.
2. Ensure they do not change the meaning of canonical programs unless the code
   is explicitly marked as non-canonical/raw.

---

## Operator Precedence (Draft)

Canonical Workman intends to follow a Grain-like operator model:

- Custom infix operators are grouped by prefix and inherit precedence.
- Prefix operators have the highest precedence (after call/member access).

Normative (v1 minimum):

- **Postfix chaining** (function application and member access) has the highest
  precedence and associates left-to-right.
  - `f.g()` parses as `(f.g)()`, i.e. _member access then call_.
  - `f.(g())` is ill-formed: after `.`, canonical Workman requires an identifier
    (no computed/dynamic member access in v1).

### Precedence Table (Normative, v1)

This table defines the required precedence/associativity for canonical v1.
Higher numbers bind tighter.

| Prec. | Kind             | Assoc.        | Operators / forms                            |
| ----: | ---------------- | ------------- | -------------------------------------------- |
|   180 | Grouping         | n/a           | `( expr )`                                   |
|   170 | Postfix chaining | left-to-right | member: `e.ident`, call: `e(args...)`        |
|   150 | Prefix           | right-to-left | `!e`, `-e`                                   |
|   120 | Multiplicative   | left-to-right | `e * e`, `e / e`, `e % e`                    |
|   110 | Additive         | left-to-right | `e + e`, `e - e`, `e ++ e`                   |
|    90 | Comparison       | left-to-right | `e < e`, `e <= e`, `e > e`, `e >= e`         |
|    80 | Equality         | left-to-right | `e == e`, `e != e`                           |
|    40 | Logical AND      | left-to-right | `e && e`                                     |
|    30 | Logical OR       | left-to-right | `e                                           |
|    20 | Pipe             | left-to-right | `e :> e`                                     |
|    10 | Assignment       | right-to-left | `x = e` (restricted form; see `assign_expr`) |

Normative notes:

- Operators in the same row associate as specified and group accordingly.
- Postfix chaining binds tighter than all infix operators. Example: `a.b(c).d`
  parses as `(((a.b)(c)).d)`.

### Custom Operators (Normative, v1)

Custom infix operators (if supported) must:

- be grouped by **prefix**: the precedence/associativity is determined by the
  leading operator token/prefix they begin with (Grain-style).
- reject comment-like spellings (at minimum, `/*` and `//` are not operators).

### Pipe Operator `:>` (Normative, v1)

Canonical Workman defines a built-in forward pipe operator `:>` as surface
syntax for call-like application.

Normative:

- `:>` is left-associative and has the precedence given in the table above.
- `e1 :> e2` is equivalent to applying `e2` to `e1`, with the following
  elaboration rules:
  - `e1` always contributes exactly one argument (even if it is a tuple).
  - If `e2` is a call expression `f(x, y, ...)`, then `e1 :> f(x, y, ...)`
    elaborates to `f(e1, x, y, ...)`.
  - Otherwise, `e1 :> f` elaborates to `f(e1)`.
- Because application is left-associative, chaining respects position:
  `(seed :> f(a)) :> g(b, c)` elaborates to `g(f(seed, a), b, c)`.

Non-normative examples (multi-argument interaction):

```
let clamp = (min, max, value) => {
  if (value < min) { min } else { if (value > max) { max } else { value } }
};

let numbers =
  read_int()
  :> parse_csv("-")
  :> map(string_to_int);

-- Equivalent to clamp(read_int(), 0, 100)
let clamped =
  read_int()
  :> clamp(0, 100);

-- Equivalent to render(render(transform(seed, extra), theme), opts)
let final =
  seed
  :> transform(extra)
  :> render(theme)
  :> render_opts(opts);
```

Tooling note (non-normative):

- Parsers/formatters may preserve `:>` as a distinct operator node rather than
  elaborating immediately, but the canonical meaning is the elaboration above.

---

## Concrete Syntax (Sketch)

The grammar is presented in an EBNF-like style.

### Block Enforceability (Normative)

To ensure consistent formatting and avoid ambiguity, all branching constructs
and function bodies **must** be delimited by braces `{ ... }`.

- `match` arms must use braces: `pat => { expr }`
- Lambdas must use braces: `args => { expr }`
- `if` / `else` bodies must use braces.

Shorthand syntax (e.g., `x => x + 1`) is **not** canonical Workman. Tooling may
insert braces automatically when user intent is unambiguous.

### Modules

- `module := directive* decl*`
- `decl := import_decl | export_decl | type_decl | record_decl | value_decl`
- Module-level directives must appear before the first declaration; later
  directives are parsed as part of the next block.

### Blocks

- `block := "{" directive* expr "}"`
- Directives inside a block must precede the first non-directive expression.
- Blocks are expressions; their value is the value of the final `expr`.

### Value declarations

- `value_decl := "let" let_modifiers? binding ("and" binding)* ";"?`
- `let_modifiers := ("rec" | "mut")*`
- `binding := binding_name (":" type_expr)? "=" expr ";"?`
- `binding_name := ident | operator_ident`
  - Note: `rec` and `mut` may appear in any order; duplicates are not allowed.

### Expressions (core)

- `expr := let_expr | if_expr | match_expr | assign_expr | lambda | call_or_atom`

- `let_expr := "let" let_modifiers? binding ("and" binding)* ";" expr`

- `if_expr := "if" "(" expr ")" block "else" block`
  - Note: `else if` is not part of the grammar.
    - Rationale (canonical): `if/else` is an expression form with exactly two
      branches. Multi-way branching is expressed by (a) nesting `if` inside the
      `else` block, or (b) using `match` with `when` guards.
    - Canonical rewrite pattern:
      `if (c1) { b1 } else { if (c2) { b2 } else { b3 } }`.
    - Tooling guidance (non-normative):
      - Implementations should emit a dedicated parse error for `else if` that
        suggests rewriting to either a nested `if` in the `else` block or a
        `match` with `when` guards.
      - Tooling may warn (lint) on deeply nested `if` chains and suggest a
        `match` rewrite when the nesting resembles multi-way branching.

- `match_expr := "match" "(" expr ")" "{" match_arm_list "}"`
- `match_arm_list := match_arm ("," match_arm)* (","?)`
- `match_arm := pattern ("when" expr)? "=>" block`
  - Comma is reserved for match-arm composition. Its deeper semantics are
    specified in the pattern matching chapter.

- `assign_expr := ident "=" expr`
- `lambda := "(" params? ")" "=>" block | "=>" block`
- `params := ident ("," ident)*`

### Atoms and application

- `call_or_atom := postfix_expr`
- `postfix_expr := atom postfix*`
- `postfix := call_suffix | member_suffix`
- `call_suffix := "(" args? ")"`
- `member_suffix := "." ident`
- `args := expr ("," expr)*`
- `atom := literal | ident | operator_ident | tuple | record_lit | "(" expr ")"`

### Operator identifiers (Grain-style)

Canonical Workman treats operators as value identifiers when parenthesized.

Normative:

- An operator identifier is written as `(op)` where `op` is an operator token
  (e.g., `(+)`, `(*)`, `(++)`, `(!=)`).
- Operator identifiers may appear anywhere an identifier can appear in the value
  namespace (e.g., `let (+) = add;`).

Grammar:

- `operator_ident := "(" operator_token ")"`
- `operator_token :=` any operator spelling accepted by the lexer for infix or
  prefix use, excluding comment openers such as `/*` and `//`.

### Tuples

- `tuple := "(" expr "," expr ("," expr)* ")"`

### Records

- `record_lit := ".{" record_fields? "}"`
- `record_fields := record_field ("," record_field)* (","?)`
- `record_field := ident ("=" expr)? | ".." expr`

### Literals

- `literal := number_lit | bool_lit | byte_lit | string_lit | "void"`
- `bool_lit := "true" | "false"`

### Numeric literals (draft)

- `number_lit := int_lit | float_lit`
- `int_lit := digit (digit | "_" digit)*`
- `float_lit := int_lit "." digit (digit | "_" digit)* (exp_part)? | int_lit exp_part`
- `exp_part := ("e" | "E") ("+" | "-")? digit (digit | "_" digit)*`

This chapter defines the canonical v1 operator precedence/associativity table.
Future versions that add new operators or new precedence tiers must extend this
chapter and update the table accordingly.
