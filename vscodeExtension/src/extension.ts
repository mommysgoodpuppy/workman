import * as path from 'path';
import { window, workspace, ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel('Workman Language Server');
  outputChannel.appendLine('Workman extension activating...');

  try {
    // Path to the language server
    const serverModule = context.asAbsolutePath(
      path.join('..', 'server', 'src', 'server.ts')
    );
    
    outputChannel.appendLine(`Server path: ${serverModule}`);

    // Use Deno to run the server
    const serverOptions: ServerOptions = {
      run: {
        command: 'deno',
        args: ['run', '--allow-all', serverModule],
        transport: TransportKind.stdio
      },
      debug: {
        command: 'deno',
        args: ['run', '--allow-all', '--inspect-brk', serverModule],
        transport: TransportKind.stdio
      }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'wm' }],
      synchronize: {
        fileEvents: workspace.createFileSystemWatcher('**/*.wm')
      },
      outputChannel,
      traceOutputChannel: outputChannel,
      revealOutputChannelOn: 1 // RevealOutputChannelOn.Info
    };

    // Create the language client
    client = new LanguageClient(
      'workmanLanguageServer',
      'Workman Language Server',
      serverOptions,
      clientOptions
    );

    // Start the client (this will also launch the server)
    outputChannel.appendLine('Starting language server...');
    await client.start();
    outputChannel.appendLine('Language server started successfully!');
  } catch (error) {
    outputChannel.appendLine(`Error: ${error}`);
    window.showErrorMessage(`Workman Language Server failed to start: ${error}`);
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}