# Grammar (Normative)

## Scope

This chapter defines the normative concrete syntax for canonical Workman: the
reserved vocabulary, the operator hierarchy, and the EBNF for modules,
declarations, expressions, patterns, and types.

## Status

Draft (normative where explicitly called out). Sections marked
“implementation-defined” must be documented by conforming compilers.

## Dependencies

- `../2. Source text/1-lexical-structure.md`
- `../3. Program structure/` for semantic stratification of modules/declarations

---

## Notation

The grammar uses standard EBNF:

- `rule := production` introduces a rule.
- `a b` means concatenation.
- `a | b` means choice.
- `x?` means optional.
- `x*` / `x+` mean zero-or-more / one-or-more repetitions.
- Terminals appear in double quotes (`"let"`, `"{"`).
- Non-terminals appear in lower_snake_case (`expr`, `block`).

Unless stated otherwise, terminals refer to tokens defined in the lexical
chapter. Productions are ordered so that earlier clauses are higher-level forms
and later clauses are leaves.

---

## Lexical Summary

Canonical Workman reuses the lexical classes from `1-lexical-structure.md`. The
grammar refers to these terminal families:

- `identifier`: lowercase-first value names.
- `constructor`: uppercase-first type/constructor names.
- `keyword`: reserved vocabulary listed below.
- `number_literal`, `string_literal`, `char_literal`, `bool_literal`.
- `symbol`: punctuation tokens (e.g., `(`, `)`, `{`, `}`, `;`, `,`, `.`, `:`).
- `operator`: multi-character operator tokens accepted by the lexer.
- `operator_token`: references the same lexical `operator` tokens; the separate
  name simply highlights where the grammar expects an infix/prefix operator
  spelling.
- `constructor_void`: a specialization of `constructor` whose lexeme is exactly
  `Void` (see `type_unit`).
- Compound punctuators such as `=>`, `:>`, `..`, `==`, `!=`, `<=`, `>=`, `&&`,
  and `||` are single tokens emitted by the lexer; productions reference them as
  quoted terminals.
- Unless stated otherwise, comma-separated lists permit an optional trailing
  comma to ease multi-line editing and formatting.

Whitespace and comments are insignificant except where explicitly mentioned.

---

## Reserved Words

Reserved words are tokens produced by the lexer as `keyword`. They **must not**
be used as identifiers in canonical code.

### Control / flow keywords

`if`, `else`, `match`, `when`

### Bindings / modules / declarations

`let`, `mut`, `rec`, `and`, `type`, `record`, `from`, `import`, `export`, `as`

### Infection and effect surface

`infectious`, `domain`, `policy`, `op`, `annotate`

### Literals / special forms

`void`, `Panic`, `Var`, `AllErrors`

Normative note: `void` is the unique unit literal. Its corresponding type
constructor `Void` is provided by the prelude (tokenised as a `constructor`, not
a keyword) and appears where `type_unit` is accepted.

Normative note: `bool_literal` tokens (`true`, `false`) come from the lexical
class listed above and are not keywords. Canonical Workman deliberately keeps
the keyword set small; adding a new keyword is a breaking change to the surface
language.

---

## Compiler Directives

Directives are lexically scoped annotations that precede declarations or appear
as the first entries inside a block. Canonical v1 only specifies `@core;`.

```
directive        := "@" identifier directive_args? ";"
directive_args   := "(" directive_arg ("," directive_arg)* ")"
directive_arg    := string_literal | number_literal | identifier
```

Scoping rules:

1. Module-level directives appear before the first top-level declaration and
   apply to the entire module.
2. Block-level directives appear immediately after `{` and apply to that block
   and its nested blocks. They are restored on block exit.

Canonical semantics (v1): only `@core;` is meaningful. Other directives may be
accepted to future-proof the grammar but must have no effect in canonical mode.

---

## Operator Precedence (Normative)

Workman follows a Grain-like model: user-defined operators inherit precedence
from their prefix. Postfix forms (call, projection) bind tighter than any infix
operator. `:>` is a built-in pipe operator.

| Prec. | Assoc. | Forms / Examples                                        |
| ----: | ------ | ------------------------------------------------------- |
|   180 | n/a    | Grouping: `(expr)`                                      |
|   170 | left   | Postfix: `expr(args)`, `expr.field`, `expr[index]`      |
|   150 | right  | Prefix: `!expr`, `-expr`, registered prefix operators   |
|   140 | left   | Exponent-style operators (implementation-defined)       |
|   130 | left   | Multiplicative: `*`, `/`, `%`                           |
|   120 | left   | Additive / concatenation: `+`, `-`, `++`                |
|   100 | left   | Comparison: `<`, `<=`, `>`, `>=`                        |
|    90 | left   | Equality: `==`, `!=`                                    |
|    60 | left   | Logical AND: `&&`                                       |
|    50 | left   | Logical OR: `                                           |
|    30 | left   | Pipe: `:>`                                              |
|    10 | right  | Assignment forms (see statements; not expression-level) |

Notes:

- Postfix chaining is greedy: `a.b(c).d` parses as `(((a.b)(c)).d)`.
- Custom infix operators must avoid spellings that collide with comment openers
  (`/*`, `//`) and must be registered (either via `infix*` declarations or by
  binding a parenthesized identifier Grain-style).
- When `preservePipeOperator` is disabled (canonical mode), `a :> f(b)`
  elaborates to `f(a, b)`.

---

## Modules

Top-level syntax:

```
module          := top_level* EOF
top_level       := directive* top_level_decl
top_level_decl  := import_decl
                |  reexport_decl
                |  value_decl
                |  type_decl
                |  record_decl
                |  operator_decl
                |  infectious_decl
                |  domain_decl
                |  policy_decl
                |  op_decl
                |  annotate_decl
```

Canonical Workman **requires** explicit semicolons after every top-level form
**and** after every directive. No automatic semicolon insertion exists in the
language; tooling may insert missing semicolons as an edit, but the canonical
source text always includes them explicitly. Directives may precede any
top-level declaration; each `directive*` sequence applies to the immediately
following declaration group.

### Imports and re-exports

```
import_decl     := "from" string_literal "import" import_clause ";"
import_clause   := "{" import_spec ("," import_spec)* (","?) "}"
                |  "*" "as" identifier
import_spec     := import_name ("as" identifier)?
import_name     := identifier | constructor | string_literal

reexport_decl   := "export" "from" string_literal "type" type_reexport_list ";"
type_reexport_list := type_reexport ("," type_reexport)* (","?)
type_reexport   := constructor ("(" ".."? ")")?
```

### Value declarations

```
value_decl      := export_modifier? "let" let_modifiers? let_binding
                    ("and" let_binding)* ";"
let_modifiers   := ("rec" | "mut")*
let_binding     := binding_name binding_signature?
                    (":" type_expr)? "=" initializer
binding_name    := identifier | operator_identifier
operator_identifier := "(" operator_token ")"
binding_signature := parameter_list (":" type_expr)?
initializer     := expr

parameter_list  := "(" (parameter ("," parameter)* (","?))? ")"
parameter       := pattern (":" type_expr)?
```

Rules:

1. `rec` enables references to the binding within `initializer`.
2. `mut` marks the binding as reassignable (dynamic semantics defined
   elsewhere).
3. Mutually recursive groups use `and` and inherit the modifiers of the first
   binding.
4. Operator bindings use `let (op) = expr;` and place the operator in the value
   namespace.

### Type declarations

```
type_decl       := export_modifier? "type" "rec"? type_body
                    ("and" (type_body | record_body))* ";"
type_body       := constructor type_params?
                    ("=" (type_sum | alias_type))?
type_params     := "<" type_param ("," type_param)* (","?) ">"
type_param      := identifier  -- lowercase by convention
type_sum        := type_constructor ("|" type_constructor)+
type_constructor := constructor (type_arguments)?
alias_type      := type_expr
```

Opaque types omit `= members` and therefore cannot be constructed directly in
canonical code. A single `constructor` clause without `|` is treated as
`alias_type`, so `type Foo = Bar;` is an alias, while `type Foo = Bar | Baz;`
defines a sum type without requiring a leading `|`.

### Record declarations

```
record_decl     := export_modifier? "record" "rec"? record_body
                    ("and" (record_body | type_body))* ";"
record_body     := constructor type_params?
                    "=" "{" record_member_list "}"
record_member_list := record_member ("," record_member)* (","?)
record_member   := identifier (":" type_expr)? ("=" expr)?
                |  identifier parameter_list (":" type_expr)? "=>" block
```

Field forms:

- `name: Type` declares a typed field.
- `name: Type = expr` declares a field with default value.
- `name(args) => { ... }` declares a method-like helper that elaborates to a
  function-valued field; an optional result annotation may appear between the
  parameter list and `=>`.

### Operator declarations (compatibility)

Canonical Workman prefers Grain-style bindings, but current tooling still
accepts explicit operator declarations for precedence registration:

```
operator_decl   := infix_decl | prefix_decl
infix_decl      := export_modifier? ("infix" | "infixl" | "infixr")
                    number_literal operator_token "=" identifier ";"
prefix_decl     := export_modifier? "prefix" operator_token "=" identifier ";"
```

`infixl`/`infixr` set associativity; `infix` is non-associative. The numeric
literal specifies precedence.

### Infection family declarations

These mirror existing surface forms and will be refined in the infection
chapter.

```
infectious_decl := export_modifier? "infectious" identifier infectious_body ";"
infectious_body := "type" constructor type_params? "=" type_members
                |  constructor type_params  -- legacy form

domain_decl     := export_modifier? "domain" identifier domain_rule_block ";"
policy_decl     := export_modifier? "policy" qualified_name rule_block ";"
op_decl         := export_modifier? "op" qualified_name rule_block ";"
annotate_decl   := export_modifier? "annotate" identifier annotate_payload ";"
```

The detailed EBNF for `qualified_name`, `rule_block`, and infection payloads is
specified in the infection and effect chapters; the grammar here simply
recognises their surface structure.

### Export modifiers

```
export_modifier := "export"
```

When present, the modifier applies to the whole mutually-recursive group.

---

## Blocks and Statements

```
block           := "{" directive* block_item* block_result? "}"
block_item      := let_statement
                |  pattern_let_statement
                |  assign_statement
                |  expr_statement
                |  comment_statement  -- preserved for tooling
block_result    := expr comment_statement*

let_statement           := "let" let_modifiers? let_binding ";"
pattern_let_statement   := "let" "(" pattern ")" "=" expr ";"
assign_statement        := identifier assign_operator expr ";"
assign_operator         := "=" | "+=" | "-=" | "*=" | "/=" | "%="
expr_statement          := expr ";"
comment_statement       := -- see lexer, ignored for canonical semantics
```

Rules:

- Blocks are expressions; only `block_result` yields a value. If it is absent,
  the block evaluates to `void`. Statements that end with `;` always evaluate to
  `void`, so `block_result` is the lone value-returning position inside a block.
- Destructuring lets use the parenthesised form to avoid ambiguity with
  identifier-only bindings (`let (x, y) = expr;`).
- `assign_statement` targets must refer to previously-declared `mut` bindings.
  Compound operators elaborate to read-modify-write (`x += y` ≡ `x = x + y`) and
  always evaluate to `void`.
- If expressions, match arms, and lambda bodies are block-only syntactically; no
  expression-bodied sugar is permitted in canonical Workman.

---

## Expressions

Top-level production:

```
expr            := if_expr
                |  match_expr
                |  lambda_expr
                |  block
                |  pipe_expr

pipe_expr       := binary_expr (":>" binary_expr)*
binary_expr     := as_expr (operator_token as_expr)*
as_expr         := call_expr ("as" type_expr)*
```

Type assertions are encoded via `as_expr`; multiple `as` clauses associate
left-to-right.

### Conditionals

```
if_expr         := "if" "(" expr ")" block "else" block
```

`else if` chains are disallowed; use nested `if` or `match`.

### Match expressions and bundles

```
match_expr      := "match" match_scrutinee match_body
                |  match_bundle_literal
                |  "match" "(" expr ("," expr)* ")" "=>" block
match_scrutinee := "(" expr ("," expr)* ")"
match_body      := "{" match_arm_list "}"
match_bundle_literal := "match" "{" match_arm_list "}"
match_arm_list  := match_arm ("," match_arm)* (","?)
match_arm       := pattern guard_clause? "=>" block
                |  identifier  -- bundle reference
guard_clause    := "when" expr
```

- `match { ... }` parses as `match_bundle_literal` (no nested braces).
- `match(scrutinee) => { ... }` is sugar for a first-class match function; it
  elaborates to `(args) => { match(args) { ... } }`.
- Disambiguation order: after the `match` keyword, `{` always starts a bundle
  literal; `(` starts either a scrutinee (closed by `) {`) or the `match_fn`
  form (when immediately followed by `)=>`).
- Bare identifiers become bundle references only when **not** followed by
  `when`/`=>`. In other words, `Foo => { ... }` always parses as a pattern arm,
  while `Foo,` or `Foo }` (with no guard/body) references a previously-declared
  bundle named `Foo`.

### Lambda expressions

```
lambda_expr     := parameter_list "=>" block
                |  "=>" block              -- zero-arg CoffeeScript form
```

### Binary expressions / postfix chain

```
call_expr       := postfix_expr
postfix_expr    := primary_expr postfix_segment*
postfix_segment := call_suffix | projection_suffix | index_suffix
call_suffix     := "(" (expr ("," expr)* (","?))? ")"
projection_suffix := "." identifier
index_suffix    := "[" expr "]"
```

Implementations map operator precedence using the table above. `postfix_expr`
parses the greedy chain of calls, record projections, and index accesses.

### Primary expressions

```
primary_expr    := literal
                |  identifier
                |  constructor_call
                |  tuple_expr
                |  record_literal
                |  list_literal
                |  parenthesized_expr
                |  block
                |  panic_expr
                |  hole_expr
                |  enum_literal

constructor_call := constructor ("(" expr ("," expr)* (","?) ")")?

tuple_expr      := "(" expr "," expr ("," expr)* (","?) ")"

record_literal  := ".{" record_field_list? "}"
record_field_list := record_field ("," record_field)* (","?)
record_field    := identifier ("=" expr)?
                |  ".." expr                      -- spread

list_literal    := "[" list_element_list? "]"
list_element_list := list_element ("," list_element)* (","?)
list_element    := expr | ".." expr                -- tail spread

parenthesized_expr := "(" expr ")"
panic_expr      := "Panic" "(" expr ")"
hole_expr       := "?"                               -- typed hole
enum_literal    := "." identifier
```

`constructor_call` covers both nullary constructors (`Foo`) and parameterised
ones (`Foo(a, b)`). Tuple literals use `(...)` exclusively; `.{ ... }` is
reserved for record literals with explicit field names/spreads to avoid
ambiguity with punning.

---

## Patterns

```
pattern         := wildcard_pattern
                |  identifier_pattern
                |  literal_pattern
                |  constructor_pattern
                |  var_pattern
                |  tuple_pattern
                |  list_pattern
                |  all_errors_pattern

wildcard_pattern    := "_"
identifier_pattern  := identifier
literal_pattern     := literal
constructor_pattern := constructor ("(" pattern ("," pattern)* ")")?
var_pattern      := "Var" "(" identifier ")"
tuple_pattern       := "(" pattern ("," pattern)+ ")"
list_pattern        := "[" list_pattern_elements? "]"
list_pattern_elements := pattern ("," pattern)* ("," ".." pattern)?
all_errors_pattern  := "AllErrors"
```

Pinning rules (normative):

1. Within `match` patterns, an unadorned identifier is a **pin** that refers to
   an existing binding; the arm matches only if the scrutinee equals that value.
2. `var_pattern` (`Var(identifier)`) introduces a fresh binding inside `match`
   patterns, regardless of surrounding structure.
3. Binding positions outside `match` (lambda parameters, `let` patterns, record
   members, etc.) treat unadorned identifiers as fresh bindings automatically
   and therefore never require `Var`.

Pattern guards (`when expr`) do not contribute to coverage unless provably
total, as specified in the pattern-matching chapter.

---

## Type Expressions

```
type_expr       := type_arrow
type_arrow      := type_primary ("=>" type_expr)?

type_primary    := type_tuple
                |  type_record
                |  type_reference
                |  type_variable
                |  type_unit
                |  type_pointer
                |  type_effect_row

type_tuple      := "(" type_expr ("," type_expr)+ ")"
type_record     := "{" type_record_field ("," type_record_field)* (","?) "}"
type_record_field := identifier ":" type_expr
type_reference  := constructor type_arguments?
type_arguments  := "<" type_expr ("," type_expr)* (","?) ">"
type_variable   := identifier         -- lowercase by convention
type_unit       := constructor_void
constructor_void := constructor        -- literal spelling "Void"
type_pointer    := "Ptr" "<" type_expr ("," identifier)? ">"
type_effect_row := "[" type_effect_case ("," type_effect_case)* tail_wildcard? "]"
type_effect_case := constructor ("(" type_expr ")")?
tail_wildcard   := ".." identifier?
```

The exact set of effect-row constructors is defined in the infection chapter;
the grammar here simply permits their surface syntax. `constructor_void` matches
the constructor token whose lexeme is exactly `Void`.

---

## Literals

```
literal         := number_literal
                |  bool_literal
                |  char_literal
                |  string_literal
                |  "void"
```

Numeric literal forms follow the lexical chapter. String and byte escapes obey
the canonical escape set (`\n`, `\r`, `\t`, `\\`, `\'`, `\"`, `\xHH`).

---

## Canonicality Checklist

Before claiming conformance, implementations must ensure:

1. Reserved words are rejected as identifiers in all namespaces.
2. Every grammar production here has a corresponding parser path.
3. Blocks are enforced for lambdas, matches, and conditional branches.
4. Operator precedence matches the normative table, especially the requirement
   that postfix chains bind tighter than all infix operators.
5. Pattern pinning semantics follow the `Var` convention.

Future revisions may extend the grammar with additional literals, directives, or
declaration forms. Such extensions must update this chapter accordingly.
