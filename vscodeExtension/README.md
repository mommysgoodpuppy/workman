# Workman Language Support

Language support for **Workman** - a minimal ML with Hindley-Milner type inference.

## Features

Syntax Highlighting - Keywords, types, constructors, operators, and comments  
Type Inference - Full Hindley-Milner type checking with inlay hints  
Hover Information - See inferred types on hover  
Real-time Diagnostics - Type errors shown in Problems panel  
Stable LSP - No crashes, proper error handling

## Requirements

- **Deno** - The language server runs on Deno
- Install from: https://deno.land/

## Usage

1. Open any `.wm` file
2. The extension will automatically activate
3. See inlay hints showing inferred types after `let` bindings
4. Hover over identifiers to see their types
5. Type errors appear in the Problems panel

## Example

```workman
type Option<T> = None | Some<T>;

let identity = (x) => { x };  -- Shows: : T -> T

let rec map = (f) => {  --Shows: : (T -> U) -> List<T> -> List<U>
  (list) => {
    match(list) {
      Cons(x, rest) => { Cons(f(x), map(f)(rest)) },
      Nil => { Nil }
    }
  }
};
```

## Known Limitations

Single Error Reporting - Currently only the first error is shown per file. This is because the parser and type checker throw on first error rather than collecting multiple errors. Future enhancement planned.

Type Error Positioning - Type errors are shown at line 0 or best-guess position. Better source location tracking planned.

## Extension Settings

- `workman.trace.server` - Trace LSP communication (off/messages/verbose)

## Release Notes

### 0.0.1

Initial release:
- Syntax highlighting for `.wm` files
- LSP with type inference
- Inlay hints and hover support
- Real-time diagnostics
