"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
async function activate(context) {
    const outputChannel = vscode_1.window.createOutputChannel('Workman Language Server');
    outputChannel.appendLine('Workman extension activating...');
    try {
        // Path to the language server
        const serverModule = context.asAbsolutePath(path.join('..', 'server', 'src', 'server.ts'));
        outputChannel.appendLine(`Server path: ${serverModule}`);
        // Use Deno to run the server
        const serverOptions = {
            run: {
                command: 'deno',
                args: ['run', '--allow-all', serverModule],
                transport: node_1.TransportKind.stdio
            },
            debug: {
                command: 'deno',
                args: ['run', '--allow-all', '--inspect-brk', serverModule],
                transport: node_1.TransportKind.stdio
            }
        };
        // Options to control the language client
        const clientOptions = {
            documentSelector: [{ scheme: 'file', language: 'wm' }],
            synchronize: {
                fileEvents: vscode_1.workspace.createFileSystemWatcher('**/*.wm')
            },
            outputChannel,
            traceOutputChannel: outputChannel,
            revealOutputChannelOn: 1 // RevealOutputChannelOn.Info
        };
        // Create the language client
        client = new node_1.LanguageClient('workmanLanguageServer', 'Workman Language Server', serverOptions, clientOptions);
        // Start the client (this will also launch the server)
        outputChannel.appendLine('Starting language server...');
        await client.start();
        outputChannel.appendLine('Language server started successfully!');
    }
    catch (error) {
        outputChannel.appendLine(`Error: ${error}`);
        vscode_1.window.showErrorMessage(`Workman Language Server failed to start: ${error}`);
    }
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
//# sourceMappingURL=extension.js.map