# Workman Language Support for Helix

This directory contains everything needed to add Workman language support to
[Helix](https://helix-editor.com/).

## Quick Install

### 1. Copy Language Configuration

Append the contents of `languages.toml` to your Helix languages config:

| Platform        | Location                         |
| --------------- | -------------------------------- |
| **Linux/macOS** | `~/.config/helix/languages.toml` |
| **Windows**     | `%AppData%\helix\languages.toml` |

Or for **per-project** config, copy to: `<project>/.helix/languages.toml`

### 2. Copy Query Files

Copy the `queries/workman/` directory to your Helix runtime:

| Platform        | Destination                                |
| --------------- | ------------------------------------------ |
| **Linux/macOS** | `~/.config/helix/runtime/queries/workman/` |
| **Windows**     | `%AppData%\helix\runtime\queries\workman/` |

### 3. Fetch & Build the Tree-sitter Grammar

```bash
hx --grammar fetch
hx --grammar build
```

### 4. Restart Helix

Changes to `languages.toml` require a full restart of Helix (`:config-reload`
does NOT reload language configs).

---

## LSP Configuration Options

The `languages.toml` includes three options for running the language server:

### Option 1: System `wm` Command (Default)

If you have `wm` installed globally on your PATH:

```toml
[language-server.workman-lsp]
command = "wm"
args = ["lsp"]
```

### Option 2: Deno (Development / Hot Reload)

Run the LSP directly from source for development:

```toml
[language-server.workman-lsp]
command = "deno"
args = ["run", "--allow-all", "C:/GIT/workman/lsp/server/src/server.ts"]
```

**This enables "hot reload"** — when you modify the LSP source code, simply run
`:lsp-restart` in Helix to pick up changes without restarting the editor.

### Option 3: Compiled Binary

Use a pre-compiled LSP binary:

```toml
[language-server.workman-lsp]
command = "C:/GIT/workman/editorExtensions/vscodeExtension/server/workman-lsp.exe"
args = []
```

---

## Hot Reload Workflow (Development)

When developing the Workman language server:

1. **Configure Helix to use Deno** (Option 2 above)
2. **Edit LSP source code** in `lsp/server/src/`
3. **In Helix**, run `:lsp-restart` to restart the language server
4. The new code takes effect immediately!

> **Note:** Unlike VS Code's "Restart Language Server" command, Helix's
> `:lsp-restart` will re-launch the Deno process, picking up any source changes.

---

## Troubleshooting

### LSP Not Starting

1. **Check the server is on PATH:**
   ```bash
   hx --health workman
   ```

2. **View logs:**
   - Start Helix with verbose logging: `hx -v`
   - Open the log: `:log-open`

3. **Test the LSP manually:**
   ```bash
   wm lsp
   # or
   deno run --allow-all path/to/server.ts
   ```
   The server should wait for JSON-RPC messages on stdin.

### No Syntax Highlighting

1. Ensure query files are in the correct location
2. Verify the grammar was built: `hx --grammar build`
3. Check that the file extension is `.wm`

### Grammar Build Fails

Make sure you have a C compiler available (gcc, clang, or MSVC on Windows).

---

## File Structure

```
helixExtension/
├── README.md              # This file
├── languages.toml         # Language + LSP configuration
├── example.wm             # Example Workman file for testing
├── install.ps1            # Windows install script
├── install.sh             # Linux/macOS install script
└── queries/
    └── workman/
        ├── highlights.scm # Syntax highlighting
        ├── indents.scm    # Indentation rules
        └── injections.scm # Language injections (empty)
```

---

## Helix Commands Reference

| Command                | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `:lsp-restart`         | Restart the language server (hot reload!)      |
| `:log-open`            | Open Helix log file                            |
| `:tree-sitter-subtree` | Show parse tree for selection (debugging)      |
| `:config-reload`       | Reload config (does NOT reload languages.toml) |

---

## See Also

- [Helix Language Configuration Docs](https://docs.helix-editor.com/languages.html)
- [Adding Languages to Helix](https://docs.helix-editor.com/guides/adding_languages.html)
- [tree-sitter-workman](https://github.com/mommysgoodpuppy/tree-sitter-workman)
