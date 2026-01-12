# Lexical Structure (Normative)

## Scope

Defines tokenization rules: characters, whitespace, comments, identifiers, and
literals.

## Status

Draft (normative where specified).

## Dependencies

- `../4. Static semantics/1-types.md` (Byte/String meaning)

This section defines tokenization: characters, whitespace, comments,
identifiers, and literals.

If a tokenization rule is not specified here, it is a bug in the manual.

---

## Characters and Encoding

- Source files **must** be UTF-8.
- String and byte literal contents are treated as bytes in the range
  0..255 (see `../4. Static semantics/1-types.md`).

Normative v1 restriction:
- Non-ASCII characters are **not permitted** in identifiers, character
  literals, or string literals. Use escape sequences instead.

Implementation-defined (must be documented):
- Whether non-ASCII letters are permitted in identifiers as a non-canonical
  extension and how they are normalized.

---

## Whitespace

- Whitespace separates tokens.
- Newlines are not semantically significant, except inside string literals.

---

## Comments

- Line comment forms:
  - `--` starts a comment until end of line.
  - `//` starts a comment until end of line.
- Block comments are not canonical in v1.

---

## Identifiers

### Categories

- **Value identifiers**: start with `_` or a lowercase ASCII letter, followed by
  ASCII letters, digits, or `_`.
- **Type/constructor identifiers**: start with an uppercase ASCII letter,
  followed by ASCII letters, digits, or `_`.

Reserved words are defined in the grammar section.
Implementations **must** treat reserved words as non-identifiers.

---

## Literals

### Numbers

Canonical Workman has a single numeric literal syntax. Literal forms are
classified as:

- **integer literal**: no decimal point and no exponent
- **float literal**: contains a decimal point or an exponent

These map to `Number` values (sum of int/float) per the typing rules.

Grammar is defined in `2-grammar.md`.

### Booleans

- `true`, `false`

### Void

- `void` is the unit value literal.

### Bytes

Byte literals are written with single quotes:

```
'a'
'\\n'
'\\x41'
```

Normative:
- A byte literal denotes exactly one `Byte` value (0..255).
- Escapes produce a single byte.

Canonical escape set (minimum):
- `\\n`, `\\r`, `\\t`, `\\\\`, `\\'`, `\\\"`
- `\\xHH` where `HH` is two hex digits (00..FF)

### Strings

String literals are written with double quotes:

```
"hello"
"\\n"
"\\x41"
```

Normative:
- A string literal denotes a sequence of `Byte` values.
- Escape sequences are interpreted per the same rules as character literals.

Implementation-defined (must be documented):
- Whether additional escape forms are supported (e.g., `\\u{...}`).
