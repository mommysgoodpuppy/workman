import * as path from "path";
import * as fs from "fs";
import { ExtensionContext, window, workspace } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel("Workman Language Server");
  outputChannel.appendLine("Workman extension activating...");

  try {
    const serverDir = context.asAbsolutePath(
      path.join("server"),
    );

    outputChannel.appendLine(`Server directory: ${serverDir}`);

    const compiledWin = path.join(serverDir, "workman-lsp.exe");
    const compiledNix = path.join(serverDir, "workman-lsp");
    const hasCompiled = fs.existsSync(compiledWin) || fs.existsSync(compiledNix);

    const serverOptions: ServerOptions = hasCompiled
      ? {
          run: {
            command: fs.existsSync(compiledWin) ? compiledWin : compiledNix,
            args: [],
            transport: TransportKind.stdio,
          },
          debug: {
            command: fs.existsSync(compiledWin) ? compiledWin : compiledNix,
            args: [],
            transport: TransportKind.stdio,
          },
        }
      : {
          run: {
            command: "deno",
            args: ["run", "--allow-all", "src/server.ts"],
            transport: TransportKind.stdio,
            options: { cwd: serverDir },
          },
          debug: {
            command: "deno",
            args: ["run", "--allow-all", "src/server.ts"],
            transport: TransportKind.stdio,
            options: { cwd: serverDir },
          },
        };

    const cfg = workspace.getConfiguration("workman");
    const initializationOptions = {
      stdRoots: cfg.get<string[]>("workman.stdRoots") ?? cfg.get<string[]>("stdRoots") ?? ["std"],
      preludeModule: cfg.get<string>("workman.preludeModule") ?? cfg.get<string>("preludeModule") ?? "std/prelude",
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: "file", language: "wm" }],
      synchronize: {
        fileEvents: workspace.createFileSystemWatcher("**/*.wm"),
      },
      outputChannel,
      traceOutputChannel: outputChannel,
      revealOutputChannelOn: 1, // RevealOutputChannelOn.Info
      initializationOptions,
    };

    // Create the language client
    client = new LanguageClient(
      "workmanLanguageServer",
      "Workman Language Server",
      serverOptions,
      clientOptions,
    );

    // Start the client (this will also launch the server)
    outputChannel.appendLine("Starting language server...");
    await client.start();
    outputChannel.appendLine("Language server started successfully!");
  } catch (error) {
    outputChannel.appendLine(`Error: ${error}`);
    window.showErrorMessage(
      `Workman Language Server failed to start: ${error}`,
    );
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
