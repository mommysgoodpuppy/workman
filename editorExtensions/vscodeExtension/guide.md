# VS Code Inlay Hints — Extension Author’s Guide

> A practical, copy-pasteable walkthrough for implementing inlay hints in your own VS Code extension.

---

## What are inlay hints?

Inlay hints are tiny, dimmed annotations rendered *inline* with code to convey extra context, like parameter names, inferred types, or return types. VS Code exposes them via the **Inlay Hints** feature (finalized in VS Code 1.65) and many language extensions (TS/JS, Rust, Python, etc.) already ship providers. ([Visual Studio Code][1])

Users can toggle them with `editor.inlayHints.enabled` (`on`, `off`, `onUnlessPressed`, `offUnlessPressed`), and newer releases add UX tweaks like `editor.inlayHints.maximumLength`. ([Visual Studio Code][2])

---

## The API surface (quick map)

* **Register** a provider:

  ```ts
  vscode.languages.registerInlayHintsProvider(selector, provider)
  ```

  Your provider implements:

  * `provideInlayHints(document, range, token)` → `InlayHint[] | Thenable<InlayHint[]>`
  * *(optional)* `onDidChangeInlayHints` to signal recomputation
  * *(optional)* `resolveInlayHint(hint, token)` for lazy details (tooltips, commands, etc.)

  You can introspect inlay hints from other providers with the built-in command:

  ```
  vscode.executeInlayHintProvider(uri, range)
  ```

  which returns an array of `InlayHint` objects. ([Visual Studio Code][3])

> The API was stabilized in **1.65** and has continued to receive small improvements in later versions. ([Visual Studio Code][1])

---

## Minimal working example

### 1) `package.json` (activation & language wiring)

```jsonc
{
  "name": "my-inlay-hints",
  "publisher": "you",
  "engines": { "vscode": "^1.65.0" },
  "activationEvents": [
    "onLanguage:plaintext" // or your language id(s)
  ],
  "main": "./out/extension.js",
  "contributes": {
    "configuration": {
      "properties": {
        "myInlayHints.enable": {
          "type": "boolean",
          "default": true,
          "description": "Enable My Inlay Hints."
        }
      }
    }
  }
}
```

### 2) `extension.ts` (register & provide hints)

```ts
import * as vscode from 'vscode';

export function activate(ctx: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = [{ language: 'plaintext' }];

  const provider: vscode.InlayHintsProvider<vscode.InlayHint> = {
    onDidChangeInlayHints: new vscode.EventEmitter<void>().event,

    // Compute hints for the visible range
    provideInlayHints(document, range, token) {
      const hints: vscode.InlayHint[] = [];

      for (let line = range.start.line; line <= range.end.line; line++) {
        const text = document.lineAt(line).text;
        // toy rule: after every word, show its length
        const regex = /\b([A-Za-z]+)\b/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) && !token.isCancellationRequested) {
          const word = match[1];
          const pos = new vscode.Position(line, match.index + match[0].length);

          // Label can be a string or an array of InlayHintLabelPart for richer behavior
          const label = [{ value: `len=${word.length}`, tooltip: `“${word}” has ${word.length} characters` }];

          const hint = new vscode.InlayHint(pos, label, vscode.InlayHintKind.Parameter);
          hint.paddingLeft = true;      // nice spacing before hint
          hint.paddingRight = true;     // nice spacing after hint

          hints.push(hint);
        }
      }
      return hints;
    },

    // Optional: resolve additional data lazily (e.g., heavy tooltips, commands)
    async resolveInlayHint(hint, _token) {
      // e.g., attach a command when user clicks the hint
      hint.tooltip = "Click to search this token";
      hint.command = {
        title: "Search token",
        command: "vscode.open",
        arguments: [vscode.Uri.parse("https://example.com")]
      };
      return hint;
    }
  };

  ctx.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, provider));
}
```

> Notes:
>
> * `InlayHint.label` accepts a string **or** an array of label parts with `tooltip`, `location`, or `command`, which can be resolved lazily via `resolveInlayHint`. This mirrors the LSP’s inlay hint resolve semantics (e.g., lazily populating `tooltip`, `label.location`, or a `command`). ([Microsoft GitHub][4])
> * The `vscode.executeInlayHintProvider` command is handy in tests to fetch hints your provider returns for a given URI and range. ([Visual Studio Code][3])
> * The API was finalized in 1.65 (Feb 2022). If you target older VS Code, bump your `engines.vscode`. ([Visual Studio Code][1])

---

## UX & settings you should respect

Your provider should **play nicely** with user settings:

* Global toggle and press-to-show/hide behavior:

  ```jsonc
  "editor.inlayHints.enabled": "on" // "off" | "onUnlessPressed" | "offUnlessPressed"
  ```

  Users can hold **Ctrl+Alt** (macOS: **Ctrl+Option**) depending on the mode. ([Visual Studio Code][2])

* Truncation control:

  ```jsonc
  "editor.inlayHints.maximumLength": 30
  ```

  (Added in VS Code 1.94.) ([Visual Studio Code][5])

* Theme colors (your hints should look good with these customized):

  ```jsonc
  "workbench.colorCustomizations": {
    "editorInlayHint.background": "#00000000",
    "editorInlayHint.foreground": "#666666"
  }
  ```

  ([Reddit][6])

If your extension contributes its **own** settings (e.g., enable/disable per hint kind), follow the pattern used by built-ins (like `typescript.inlayHints.*`, `javascript.inlayHints.*`, `python.analysis.inlayHints.*`, etc.). ([Stack Overflow][7])

---

## Performance tips

* **Scope your work to the requested `range`**—don’t scan entire files in `provideInlayHints`. VS Code calls you for the visible region.
* **Use `CancellationToken`** to bail out quickly while the user types or scrolls.
* **Debounce re-computation** by firing `onDidChangeInlayHints` judiciously (e.g., after analysis completes, not on every keypress).
* **Lazy-resolve heavy details** in `resolveInlayHint` (e.g., only compute expensive tooltips on hover). This maps to LSP’s inlay hint resolve behavior. ([Microsoft GitHub][4])

---

## Testing your provider

* Programmatically fetch hints via the built-in command:

  ```ts
  const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
    'vscode.executeInlayHintProvider',
    vscode.Uri.file('/path/to/file.txt'),
    new vscode.Range(new vscode.Position(0,0), new vscode.Position(1000,0))
  );
  ```

  Assert shape/content in your tests. ([Visual Studio Code][3])

* Manually verify UX expectations:

  * Toggle behavior (`onUnlessPressed` / `offUnlessPressed`)
  * Cursor stability while typing (newer VS Code versions improved reflow). ([Visual Studio Code][5])

---

## Design guidelines (what to show)

Keep hints **short, unintrusive, and predictable**:

* Prefer ≤ 1–2 words (users can set truncation, but start concise).
* Avoid duplicating obvious syntax.
* Use `InlayHintKind.Parameter` for parameter labels; `Type` for inferred types when you provide them; or leave undefined if not applicable.
* Use padding (`paddingLeft/Right`) to avoid colliding with tokens.

For inspiration, see how core languages and popular extensions present hints (TS/JS, Rust Analyzer, Python, Dart, ReSharper for VS Code). ([Visual Studio Code][8])

---

## Troubleshooting

* **Hints don’t appear unless I type.** Providers are invoked as the editor needs them; if you require an on-demand refresh, expose a command that fires `onDidChangeInlayHints`. Also, ensure you return positions *inside* the requested range. (See community Q&A around `vscode.executeInlayHintProvider`.) ([Stack Overflow][9])
* **Double-click/command on hints doesn’t do anything.** If you attach `textEdits` or `command` via lazy resolve, ensure you implement `resolveInlayHint` correctly; older versions had a bug interacting with `textEdits` that’s since been addressed. ([GitHub][10])
* **Users complain about clutter.** Remind them of the global toggle and your per-hint settings; document keybindings and short/press-to-show modes. ([Visual Studio Code][2])

---

## Extra: working with a Language Server (LSP)

If your extension is LSP-based, implement `textDocument/inlayHint` and (optionally) `inlayHint/resolve` to populate richer metadata (`label.location`, `tooltip`, `command`) lazily. Ensure your VS Code client advertises `inlayHint.resolveSupport` so the server knows it can defer heavy work. ([Microsoft GitHub][4])

---

## References

* **VS Code API reference** (Inlay hints API; built-in command `vscode.executeInlayHintProvider`). ([Visual Studio Code][3])
* **API finalized in 1.65** (release notes). ([Visual Studio Code][1])
* **Recent UX updates** (`editor.inlayHints.maximumLength`, update strategy). ([Visual Studio Code][5])
* **TS/JS docs** (user-facing overview/examples). ([Visual Studio Code][11])

---

### TL;DR template

1. Add `activationEvents` for your language(s).
2. `registerInlayHintsProvider(selector, provider)`.
3. In `provideInlayHints`, compute small `InlayHint`s **only for the incoming `range`**.
4. Optional: implement `resolveInlayHint` for lazy tooltips/commands.
5. Expose settings to let users tune or disable your hints.
6. Test with `vscode.executeInlayHintProvider` and respect global toggle/truncation. ([Visual Studio Code][3])

Happy hinting!

[1]: https://code.visualstudio.com/updates/v1_65?utm_source=chatgpt.com "February 2022 (version 1.65)"
[2]: https://code.visualstudio.com/updates/v1_67?utm_source=chatgpt.com "April 2022 (version 1.67)"
[3]: https://code.visualstudio.com/api/references/commands?utm_source=chatgpt.com "Built-in Commands | Visual Studio Code Extension API"
[4]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/?utm_source=chatgpt.com "Language Server Protocol Specification - 3.17"
[5]: https://code.visualstudio.com/updates/v1_94?utm_source=chatgpt.com "September 2024 (version 1.94)"
[6]: https://www.reddit.com/r/rust/comments/uki3xp/changing_inlay_hint_color_in_vscode/?utm_source=chatgpt.com "Changing Inlay Hint Color in VSCode? : r/rust"
[7]: https://stackoverflow.com/questions/68698269/how-can-i-toggle-inlay-hints-in-visual-studio-code?utm_source=chatgpt.com "How can I toggle inlay hints in Visual Studio Code?"
[8]: https://code.visualstudio.com/docs/languages/javascript?utm_source=chatgpt.com "JavaScript in Visual Studio Code"
[9]: https://stackoverflow.com/questions/77600708/on-execution-of-vscode-executeinlayhintprovider-comamnd-hints-are-not-getting-a?utm_source=chatgpt.com "On Execution of vscode.executeInlayHintProvider ..."
[10]: https://github.com/microsoft/vscode/issues/193124?utm_source=chatgpt.com "Inlay hints' text edits do not apply when being resolved"
[11]: https://code.visualstudio.com/docs/typescript/typescript-editing?utm_source=chatgpt.com "Editing TypeScript"
 
# VS Code Hovers — Extension Author’s Guide

> A practical, copy-pasteable walkthrough for implementing **hover tooltips** in your VS Code extension.

---

## What are hovers?

Hovers are the info balloons that appear when the user pauses the mouse over a token. They can show Markdown, code blocks, links, and even buttons (via command links). In VS Code, they’re provided by registering a `HoverProvider`.

---

## The API surface (quick map)

* **Register a provider**

  ```ts
  vscode.languages.registerHoverProvider(selector, provider)
  ```
* **Implement**

  ```ts
  interface HoverProvider {
    provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover>;
  }
  ```
* **Return a `Hover`**

  ```ts
  new vscode.Hover(contents: MarkdownString | string | (MarkdownString | string)[], range?: Range)
  ```

**Tip:** Prefer `MarkdownString` over plain strings or deprecated `MarkedString` types.

---

## Minimal working example

### 1) `package.json`

```jsonc
{
  "name": "my-hover",
  "publisher": "you",
  "engines": { "vscode": "^1.70.0" },
  "activationEvents": ["onLanguage:plaintext"],
  "main": "./out/extension.js",
  "contributes": {
    "configuration": {
      "properties": {
        "myHover.enable": {
          "type": "boolean",
          "default": true,
          "description": "Enable My Hover tooltips."
        }
      }
    }
  }
}
```

### 2) `extension.ts`

```ts
import * as vscode from 'vscode';

export function activate(ctx: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = [{ language: 'plaintext' }];

  const provider: vscode.HoverProvider = {
    async provideHover(document, position, token) {
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
      if (!wordRange) return;

      const word = document.getText(wordRange);

      // Build a rich Markdown hover
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['my-hover.searchWeb', 'vscode.open'] }; // allow specific command links
      md.supportThemeIcons = true;

      md.appendMarkdown(`# $(info) **${word}**\n`);
      md.appendMarkdown(`Length: **${word.length}**\n\n`);
      md.appendCodeblock(`// pretend analysis
const len = ${word.length};`, 'typescript');

      // Command links (clickable actions in hover)
      const encoded = encodeURIComponent(JSON.stringify([word]));
      md.appendMarkdown(`\n\n[🔎 Search web](command:my-hover.searchWeb?${encoded})\n`);
      md.appendMarkdown(`[Open docs](https://example.com/docs/${encodeURIComponent(word)})`);

      return new vscode.Hover(md, wordRange);
    }
  };

  ctx.subscriptions.push(vscode.languages.registerHoverProvider(selector, provider));

  // Example command used in hover
  ctx.subscriptions.push(vscode.commands.registerCommand('my-hover.searchWeb', async (w: string) => {
    vscode.env.openExternal(vscode.Uri.parse(`https://duckduckgo.com/?q=${encodeURIComponent(w)}`));
  }));
}
```

> Notes
>
> * `MarkdownString(isTrusted)` must be set (or use the object form) to enable **command:** links. Always **whitelist** only the commands you need.
> * `supportThemeIcons = true` enables `$(iconName)` in text.
> * Returning a `Range` anchors the hover to that span (prevents flicker when moving within the same word).

---

## UX & settings to respect

Users control hover behavior via:

* `editor.hover.enabled`: enable/disable hovers.
* `editor.hover.delay`: ms before showing.
* `editor.hover.sticky`: keep hover when moving mouse into it.
* `editor.hover.maxLines`, `editor.hover.maxWidth`: size constraints (varies by build).
* Some languages also have language-specific toggle settings.

Your extension should:

* Degrade gracefully when disabled.
* Keep content concise; put details behind links or collapsible sections (use short headings and code blocks sparingly).

---

## Authoring great hover content

* **Be concise first, deep on demand.** Start with a one-line summary, then details.
* **Use code blocks** for examples/snippets:

  ```ts
  md.appendCodeblock('let x: Option<string>', 'rust'); // language id for highlighting
  ```
* **Link to docs** and **provide actions**:

  * External: regular `https://` links.
  * Internal actions: command links (requires `isTrusted` and whitelisting).

    ```md
    [Run quick fix](command:myExt.fixThing?%5B"arg1","arg2"%5D)
    ```
* **Avoid UI jitter**: don’t change the first line’s length frequently; prefer stable headings.

---

## Performance tips

* **Compute fast**. Do minimal parsing; avoid scanning the whole file.
* **Use `CancellationToken`**: bail if `token.isCancellationRequested`.
* **Cache** cheap analysis per document/version and invalidate on changes.
* **Bound work to the hovered word** (`getWordRangeAtPosition`) or a tiny window around it.

---

## Testing your hovers

* **Programmatic test**: use the built-in command to fetch hovers.

  ```ts
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    vscode.Uri.file('/path/to/file.txt'),
    new vscode.Position(3, 10)
  );
  // Assert hovers[0].contents, ranges, etc.
  ```
* **Manual checklist**

  * Delays and sticky behavior feel right with user settings.
  * Command links work only when trusted and whitelisted.
  * Works in light/dark themes; icons visible with `supportThemeIcons`.

---

## Troubleshooting

* **Hover doesn’t show**

  * Ensure your `activationEvents` include the file’s language id.
  * Check that the returned `Range` actually covers the current position.
  * Verify `editor.hover.enabled` is true.

* **Command links are disabled**

  * You must set `md.isTrusted` (boolean or `{ enabledCommands: [...] }`).
  * Ensure the command is **registered** before the hover appears.

* **Hover flickers or jumps**

  * Provide a stable `Range` (e.g., the word range).
  * Avoid regenerating wildly different Markdown on minor cursor moves.

* **Too much content**

  * Respect size: keep the first screen scannable. Move detail to external docs or a secondary command.

---

## Extra: Language Server Protocol (LSP)

If your extension uses a language server, implement `textDocument/hover` on the server:

* Return a `Hover` with Markdown (or MarkedString).
* Keep the content small; send links to deeper docs.
* On the VS Code client, use `vscode-languageclient`—no special handling beyond standard hover wiring.

Example (server pseudo-code):

```ts
connection.onHover((params): Hover | null => {
  const { textDocument, position } = params;
  const word = getWordAt(textDocument, position);
  if (!word) return null;
  return {
    contents: {
      kind: 'markdown',
      value: `**Symbol:** ${word}\n\n\`\`\`ts\n// details here\n\`\`\``
    },
    range: word.range
  };
});
```

---

## Secure command links (pattern)

```ts
const md = new vscode.MarkdownString(undefined, true);
// Only allow these commands to be executed from this hover
md.isTrusted = { enabledCommands: ['myExt.actionA', 'vscode.open'] };

// Encode arguments for command URIs:
const args = encodeURIComponent(JSON.stringify([{ id: 123 }]));
md.appendMarkdown(`[Do thing](command:myExt.actionA?${args})`);
```

---

## TL;DR template

1. `registerHoverProvider(selector, provider)`.
2. In `provideHover`, find the word at cursor and return `new Hover(MarkdownString, range)`.
3. Use `MarkdownString` with `appendMarkdown/appendCodeblock`, `supportThemeIcons`, and **whitelisted** `isTrusted` commands.
4. Keep content concise; link out for detail.
5. Test with `vscode.executeHoverProvider`.
6. Mind performance and cancellation.

Happy hovering!
