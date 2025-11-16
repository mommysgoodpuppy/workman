import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { commands, type ExtensionContext, window, workspace } from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel("Workman Language Server");
  outputChannel.appendLine("Workman extension activating...");

  try {
    const systemWm = detectSystemWm(outputChannel);
    const bundledServerDir = context.asAbsolutePath("server");
    const compiledWin = path.join(bundledServerDir, "workman-lsp.exe");
    const compiledNix = path.join(bundledServerDir, "workman-lsp");
    const hasCompiled = fs.existsSync(compiledWin) || fs.existsSync(compiledNix);

    const workspaceServerDir = path.resolve(
      context.extensionPath,
      "..",
      "lsp",
      "server",
    );
    const workspaceServerEntry = path.join(
      workspaceServerDir,
      "src",
      "server.ts",
    );
    const hasWorkspaceSource = fs.existsSync(workspaceServerEntry);

    outputChannel.appendLine(
      `Bundled server dir: ${bundledServerDir}`,
    );
    outputChannel.appendLine(
      `Workspace server dir: ${workspaceServerDir}`,
    );

    if (!hasCompiled && !hasWorkspaceSource) {
      const message =
        "Workman language server binary not found and workspace source missing. Run `npm run build-server` or ensure lsp/server/src/server.ts exists.";
      outputChannel.appendLine(message);
      window.showErrorMessage(message);
      return;
    }

    let serverDescription = "";
    const serverOptions: ServerOptions = systemWm
      ? {
        run: {
          command: systemWm,
          args: ["lsp"],
          transport: TransportKind.stdio,
          options: process.platform === "win32" ? { shell: true } : undefined,
        },
        debug: {
          command: systemWm,
          args: ["lsp"],
          transport: TransportKind.stdio,
          options: process.platform === "win32" ? { shell: true } : undefined,
        },
      }
      : hasCompiled
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
      : hasWorkspaceSource
      ? {
        run: {
          command: "deno",
          args: ["run", "--allow-all", workspaceServerEntry],
          transport: TransportKind.stdio,
          options: { cwd: workspaceServerDir },
        },
        debug: {
          command: "deno",
          args: ["run", "--allow-all", workspaceServerEntry],
          transport: TransportKind.stdio,
          options: { cwd: workspaceServerDir },
        },
      }
      : {
        run: {
          command: "deno",
          args: ["run", "--allow-all", "src/server.ts"],
          transport: TransportKind.stdio,
          options: { cwd: bundledServerDir },
        },
        debug: {
          command: "deno",
          args: ["run", "--allow-all", "src/server.ts"],
          transport: TransportKind.stdio,
          options: { cwd: bundledServerDir },
        },
      };
    if (systemWm) {
      serverDescription = `system '${systemWm} lsp'`;
    } else if (hasCompiled) {
      serverDescription = `bundled binary (${fs.existsSync(compiledWin) ? "windows" : "unix"})`;
    } else if (hasWorkspaceSource) {
      serverDescription = "workspace Deno source (lsp/server/src/server.ts)";
    } else {
      serverDescription = "bundled Deno source (vscodeExtension/server/src/server.ts)";
    }
    outputChannel.appendLine(`Language server transport: ${serverDescription}`);

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

    const restartCommand = commands.registerCommand(
      "workman.restartLanguageServer",
      async () => {
        if (!client) {
          window.showInformationMessage(
            "Workman language server is not running.",
          );
          return;
        }
        outputChannel.appendLine("Restarting Workman language server...");
        await client.stop();
        await client.start();
        outputChannel.appendLine("Workman language server restarted.");
      },
    );
    context.subscriptions.push(restartCommand);

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

function detectSystemWm(outputChannel: import("vscode").OutputChannel): string | null {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "cmd.exe" : "wm";
  const args = isWindows ? ["/c", "wm", "--help"] : ["--help"];
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    outputChannel.appendLine(
      "Using system 'wm' command for Workman language server.",
    );
    return "wm";
  } catch (error) {
    outputChannel.appendLine(
      `System 'wm' command not available: ${error}`,
    );
    return null;
  }
}
