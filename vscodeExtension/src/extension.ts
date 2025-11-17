import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, spawnSync } from "child_process";
import {
  commands,
  type ExtensionContext,
  languages,
  Position,
  Range,
  TextEdit,
  window,
  workspace,
} from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel("Workman Language Server");
  const formatterChannel = window.createOutputChannel("Workman Formatter");
  context.subscriptions.push(outputChannel, formatterChannel);
  outputChannel.appendLine("Workman extension activating...");
  formatterChannel.appendLine("Workman formatter logging initialized.");

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

    const formattingRegistration = languages.registerDocumentFormattingEditProvider(
      { language: "wm", scheme: "file" },
      {
        provideDocumentFormattingEdits: async (document) => {
          if (!systemWm) {
            const message =
              "Workman formatter requires the 'wm' CLI to be available on PATH.";
            formatterChannel.appendLine(message);
            window.showErrorMessage(message);
            return [];
          }
          if (document.uri.scheme !== "file") {
            formatterChannel.appendLine(
              `Skipping format for non-file document (${document.uri.toString()})`,
            );
            window.showWarningMessage(
              "Workman formatter only supports file-backed documents.",
            );
            return [];
          }
          const sourceText = document.getText();
          formatterChannel.appendLine(
            `[${new Date().toISOString()}] Formatting request for ${
              document.uri.fsPath
            } (length=${sourceText.length})`,
          );
          try {
            const folder = workspace.getWorkspaceFolder(document.uri);
            const cwd = folder?.uri.fsPath ??
              path.dirname(document.uri.fsPath);
            const outputFile = createFormatterTempFilePath();
            const formatted = await runFormatterCli(
              systemWm,
              document.uri.fsPath,
              cwd,
              sourceText,
              formatterChannel,
              outputFile,
            );
            if (formatted === sourceText) {
              formatterChannel.appendLine(
                "Formatter reported no changes (already formatted).",
              );
              return [];
            }
            const endPosition = document.lineCount > 0
              ? document.lineAt(document.lineCount - 1).range.end
              : new Position(0, 0);
            const fullRange = new Range(new Position(0, 0), endPosition);
            formatterChannel.appendLine(
              `Formatter produced updated output (length=${formatted.length}).`,
            );
            return [TextEdit.replace(fullRange, formatted)];
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : String(error);
            formatterChannel.appendLine(`Formatter failed: ${message}`);
            window.showErrorMessage(`Workman formatter failed: ${message}`);
            return [];
          }
        },
      },
    );
    context.subscriptions.push(formattingRegistration);

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

function runFormatterCli(
  wmCommand: string,
  filePath: string,
  cwd: string | undefined,
  sourceText: string,
  formatterChannel: import("vscode").OutputChannel,
  outputFile: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "fmt",
      "--stdin-filepath",
      filePath,
      "--output",
      outputFile,
    ];
    const start = Date.now();
    formatterChannel.appendLine(
      `> ${wmCommand} ${args.join(" ")} (cwd=${
        cwd ?? "<workspace-root>"
      }, input=${sourceText.length})`,
    );
    const child = spawn(wmCommand, args, {
      cwd,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        formatterChannel.append(chunk);
      });
    }
    child.on("error", (error) => {
      formatterChannel.appendLine(`Formatter process error: ${error}`);
      reject(error);
    });
    child.on("close", (code) => {
      const duration = Date.now() - start;
      const finalize = async () => {
        if (code === 0) {
          let formatted = "";
          try {
            formatted = await fs.promises.readFile(outputFile, "utf8");
          } catch (error) {
            throw new Error(
              `Formatter completed but failed to read output: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            await cleanupOutputFile(outputFile);
          }
          formatterChannel.appendLine(
            `Formatter completed (exit=0, output=${formatted.length}, ${duration}ms).`,
          );
          resolve(formatted);
        } else {
          await cleanupOutputFile(outputFile);
          const message = (stderr || "").trim() ||
            `Formatter exited with code ${code ?? "unknown"}`;
          formatterChannel.appendLine(
            `Formatter failed (exit=${code}, ${duration}ms): ${message}`,
          );
          reject(new Error(message));
        }
      };
      finalize().catch((error) => {
        cleanupOutputFile(outputFile).finally(() => reject(error));
      });
    });
    if (child.stdin) {
      child.stdin.setDefaultEncoding("utf8");
      child.stdin.write(sourceText);
      child.stdin.end();
    } else {
      child.kill();
      const error = new Error("Formatter stdin is not writable.");
      formatterChannel.appendLine(error.message);
      reject(error);
    }
  });
}

function createFormatterTempFilePath(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `workman-fmt-${unique}.wm`);
}

async function cleanupOutputFile(target: string): Promise<void> {
  try {
    await fs.promises.unlink(target);
  } catch {
    // Ignore cleanup errors
  }
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
