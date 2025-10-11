# Workman VSCode Extension Development

## Testing the Extension

### 1. Install Dependencies
```bash
cd vscodeExtension/workman-language
npm install
```

### 2. Open in VSCode
```bash
code .
```

### 3. Run Extension
Press `F5` to launch Extension Development Host with the extension loaded.

### 4. Test Syntax Highlighting
Create a test file `test.wm` with:

```workman
-- This is a comment
type Option<T> = None | Some<T>;

let rec map = (f) => {
  (list) => {
    match(list) {
      Cons(x, rest) => { Cons(f(x), map(f)(rest)) },
      Nil => { Nil }
    }
  }
};

let firstUserId = match(list) {
  Cons(id, _) => { Some(id) },
  Nil => { None }
};
```

## Next Steps: Language Server

To add type inference on hover, we need to implement a Language Server Protocol (LSP) server.

### Architecture

```
VSCode Extension (Client)
    ↓ LSP Protocol
Language Server (Deno)
    ↓ Calls
Workman Type Checker (src/infer.ts)
```

### Implementation Plan

1. **Create Language Server** (`vscodeExtension/server/`)
   - Use Deno's LSP libraries
   - Parse `.wm` files
   - Run type inference
   - Return diagnostics and hover info

2. **Update Extension** (`vscodeExtension/workman-language/`)
   - Add LSP client
   - Connect to server
   - Handle requests/responses

3. **Features to Implement**
   - ✅ Syntax highlighting (done)
   - [ ] Diagnostics (type errors)
   - [ ] Hover (show inferred types)
   - [ ] Go to definition
   - [ ] Auto-completion

### File Structure

```
vscodeExtension/
├── workman-language/          # VSCode extension
│   ├── package.json
│   ├── syntaxes/
│   │   └── wm.tmLanguage.json
│   └── src/
│       └── extension.ts       # Extension entry point
└── server/                    # Language server (future)
    ├── deno.json
    └── src/
        ├── server.ts          # LSP server
        └── workman.ts         # Bridge to type checker
```

## Publishing

When ready to publish:

```bash
npm install -g @vscode/vsce
vsce package
vsce publish
```

## Resources

- [VSCode Language Extensions](https://code.visualstudio.com/api/language-extensions/overview)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/)
- [TextMate Grammar](https://macromates.com/manual/en/language_grammars)
