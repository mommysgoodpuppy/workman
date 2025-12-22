# Workman VSCode Extension Setup

## Prerequisites

- **Deno** installed (for language server)
- **Node.js** and **npm** installed (for VSCode extension)

## Setup Steps

### 1. Install Extension Dependencies

```bash
cd vscodeExtension/workman-language
npm install
```

### 2. Compile TypeScript

```bash
npm run compile
```

### 3. Test the Language Server (Optional)

```bash
cd ../server
deno run --allow-all src/server.ts
```

The server will wait for LSP messages on stdin.

### 4. Run Extension in Development Mode

1. Open `vscodeExtension/workman-language` in VSCode
2. Press `F5` to launch Extension Development Host
3. In the new window, open a `.wm` file
4. You should see:
   - Syntax highlighting
   - Type errors as diagnostics
   - Inlay hints showing inferred types
   - Hover over identifiers to see types

### 5. Compile Language Server Binary (Optional)

To create a standalone executable:

```bash
cd vscodeExtension/server
deno task compile
```

This creates `workman-lsp.exe` (or `workman-lsp` on Unix).

Then update `src/extension.ts` to use the compiled binary instead of `deno run`.

## Testing

1. Create a test file `test.wm`:

```workman
type Option<T> = None | Some<T>;

let identity = (x) => { x };

let rec map = (f) => {
  (list) => {
    match(list) {
      Cons(x, rest) => { Cons(f(x), map(f)(rest)) },
      Nil => { Nil }
    }
  }
};
```

2. Open in VSCode with the extension running
3. You should see inlay hints like:
   - `let identity = : T -> T`
   - `let rec map = : (T -> U) -> List<T> -> List<U>`

## Troubleshooting

### Server not starting

Check the Output panel (View → Output → Workman Language Server) for errors.

### No inlay hints

1. Make sure inlay hints are enabled in VSCode settings
2. Check that the file is recognized as `.wm` (bottom right of editor)
3. Look for errors in the Output panel

### Type errors not showing

The server sends diagnostics on file open/change. Check the Problems panel (View → Problems).

## Publishing

When ready to publish to VSCode Marketplace:

```bash
npm install -g @vscode/vsce
vsce package
vsce publish
```

## Next Steps

- [ ] Improve hover to show types for all identifiers
- [ ] Add go-to-definition support
- [ ] Add auto-completion for constructors
- [ ] Better error messages with source locations
- [ ] Semantic highlighting
