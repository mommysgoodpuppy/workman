#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

import { lex } from "@workman/lexer.ts";
import { parseSurfaceProgram, ParseError } from "@workman/parser.ts";
import { inferProgram, InferError } from "@workman/infer.ts";
import { LexError, WorkmanError } from "@workman/error.ts";
import { formatScheme } from "@workman/type_printer.ts";
import { runEntryPath, ModuleLoaderError, loadModuleGraph } from "@workman/module_loader.ts";
import { dirname, fromFileUrl, join, isAbsolute } from "std/path/mod.ts";
import { TypeScheme, TypeInfo, cloneTypeInfo, cloneTypeScheme } from "@workman/types.ts";

interface LSPMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class WorkmanLanguageServer {
  private documents = new Map<string, string>();
  private diagnostics = new Map<string, any[]>();
  private writeLock = false;
  private writeQueue: Array<() => Promise<void>> = [];
  private workspaceRoots: string[] = [];
  private initStdRoots: string[] | undefined = undefined;
  private preludeModule: string | undefined = undefined;

  private log(message: string) {
    const timestamp = new Date().toISOString();
    const fullMessage = `${timestamp} ${message}`;
    const notification = {
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: {
        type: 4, // Log
        message: fullMessage,
      },
    };

    this.writeMessage(notification).catch(() => {
      // As a fallback, emit to stderr without breaking LSP output on stdout
      console.error(fullMessage);
    });
  }

  private async writeMessage(message: any) {
    // Simple mutex-based queue to prevent interleaving
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          const encoder = new TextEncoder();
          const messageStr = JSON.stringify(message);
          const header = `Content-Length: ${messageStr.length}\r\n\r\n`;
          const fullMessage = header + messageStr;
          const bytes = encoder.encode(fullMessage);

          let written = 0;
          while (written < bytes.length) {
            const n = await Deno.stdout.write(bytes.subarray(written));
            written += n;
          }

          resolve();
        } catch (error) {
          console.error(`[LSP] Write error: ${error}`);
          reject(error);
        }
      });

      this.processWriteQueue();
    });
  }

  private async processWriteQueue() {
    if (this.writeLock || this.writeQueue.length === 0) {
      return;
    }
    
    this.writeLock = true;
    const writer = this.writeQueue.shift()!;
    try {
      await writer();
    } catch (error) {
      console.error(`[LSP] Queue processing error: ${error}`);
    }
    this.writeLock = false;
    
    // Process next item if any
    if (this.writeQueue.length > 0) {
      this.processWriteQueue();
    }
  }

  async start() {
    this.log("[LSP] Workman Language Server starting...");
    
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    let buffer = "";
    
    for await (const chunk of Deno.stdin.readable) {
      buffer += decoder.decode(chunk);
      
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        
        const header = buffer.substring(0, headerEnd);
        const contentLengthMatch = header.match(/Content-Length: (\d+)/);
        
        if (!contentLengthMatch) {
          this.log(`[LSP] Invalid header: ${header}`);
          break;
        }
        
        const contentLength = parseInt(contentLengthMatch[1]);
        const messageStart = headerEnd + 4;
        
        if (buffer.length < messageStart + contentLength) {
          break; // Wait for more data
        }
        
        const messageContent = buffer.substring(messageStart, messageStart + contentLength);
        buffer = buffer.substring(messageStart + contentLength);
        
        try {
          const message: LSPMessage = JSON.parse(messageContent);
          const response = await this.handleMessage(message);
          
          if (response) {
            await this.writeMessage(response);
          }
        } catch (error) {
          this.log(`[LSP] Error handling message: ${error}`);
        }
      }
    }
  }

  private async handleMessage(message: LSPMessage): Promise<LSPMessage | null> {
    this.log(`[LSP] Received: ${message.method}`);
    
    if (!message.method) {
      return null;
    }

    switch (message.method) {
      case "initialize":
        return this.handleInitialize(message);
      
      case "initialized":
        return null;
      
      case "textDocument/didOpen":
        return await this.handleDidOpen(message);
      
      case "textDocument/didChange":
        return await this.handleDidChange(message);
      
      case "textDocument/hover":
        return await this.handleHover(message);
      
      case "textDocument/inlayHint":
        return await this.handleInlayHint(message);
      
      case "shutdown":
        return { jsonrpc: "2.0", id: message.id, result: null };
      
      case "exit":
        Deno.exit(0);
      
      default:
        this.log(`[LSP] Unhandled method: ${message.method}`);
        return null;
    }
  }

  private handleInitialize(message: LSPMessage): LSPMessage {
    try {
      const params: any = message.params ?? {};
      const roots: string[] = [];
      if (typeof params.rootUri === "string") {
        try { roots.push(fromFileUrl(params.rootUri)); } catch {}
      } else if (typeof params.rootPath === "string") {
        roots.push(params.rootPath);
      }
      if (Array.isArray(params.workspaceFolders)) {
        for (const wf of params.workspaceFolders) {
          if (wf && typeof wf.uri === "string") {
            try { roots.push(fromFileUrl(wf.uri)); } catch {}
          }
        }
      }
      this.workspaceRoots = Array.from(new Set(roots));
      this.log(`[LSP] Workspace roots: ${this.workspaceRoots.join(", ")}`);
      const init = params.initializationOptions ?? {};
      if (init && Array.isArray(init.stdRoots)) {
        this.initStdRoots = init.stdRoots.filter((s: unknown) => typeof s === "string");
      }
      if (init && typeof init.preludeModule === "string") {
        this.preludeModule = init.preludeModule;
      }
    } catch (e) {
      this.log(`[LSP] Failed to parse workspace roots: ${e}`);
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: {
            openClose: true,
            change: 1, // Full sync
          },
          hoverProvider: true,
          inlayHintProvider: true,
        },
        serverInfo: {
          name: "workman-language-server",
          version: "0.0.1",
        },
      },
    };
  }

  private async handleDidOpen(message: LSPMessage): Promise<LSPMessage | null> {
    const { textDocument } = message.params;
    const uri = textDocument.uri;
    const text = textDocument.text;
    
    this.documents.set(uri, text);
    await this.validateDocument(uri, text);
    
    return null;
  }

  private async handleDidChange(message: LSPMessage): Promise<LSPMessage | null> {
    const { textDocument, contentChanges } = message.params;
    const uri = textDocument.uri;
    
    if (contentChanges.length > 0) {
      const text = contentChanges[0].text;
      this.documents.set(uri, text);
      await this.validateDocument(uri, text);
    }
    
    return null;
  }

  private async validateDocument(uri: string, text: string) {
    const diagnostics: any[] = [];
    
    this.log(`[LSP] Validating document: ${uri}`);
    
    // First, try to parse the current document directly to get better error positions
    try {
      const tokens = lex(text, uri);
      const program = parseSurfaceProgram(tokens, text);
      // If parsing succeeds, try full module validation
      try {
        const entryPath = this.uriToFsPath(uri);
        const stdRoots = this.computeStdRoots(entryPath);
        await runEntryPath(entryPath, { stdRoots, preludeModule: this.preludeModule });
        this.log(`[LSP] Module graph validated OK (${entryPath})`);
      } catch (moduleError) {
        // Module-level errors (imports, type errors, etc.)
        this.log(`[LSP] Module validation error: ${moduleError}`);
        if (moduleError instanceof InferError) {
          const range = moduleError.span 
            ? { 
                start: this.offsetToPosition(text, moduleError.span.start),
                end: this.offsetToPosition(text, moduleError.span.end)
              }
            : this.estimateRangeFromMessage(text, moduleError.message);
          diagnostics.push({
            range,
            severity: 1,
            message: moduleError.format(text),
            source: "workman-typechecker",
            code: "type-error",
          });
        } else if (moduleError instanceof ModuleLoaderError) {
          const msg = String(moduleError.message);
          const range = this.estimateRangeFromMessage(text, msg);
          diagnostics.push({
            range,
            severity: 1,
            message: msg,
            source: "workman-modules",
            code: "module-error",
          });
        } else {
          diagnostics.push({
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: `Internal error: ${moduleError}`,
            source: "workman",
            code: "internal-error",
          });
        }
      }
    } catch (error) {
      this.log(`[LSP] Validation error: ${error}`);
      
      // Check if this is a WorkmanError (which includes LexError, ParseError, InferError)
      // These might be wrapped in ModuleLoaderError
      if (error instanceof LexError) {
        const position = this.offsetToPosition(text, error.position);
        const endPos = this.offsetToPosition(text, error.position + 1);
        diagnostics.push({
          range: { start: position, end: endPos },
          severity: 1,
          message: error.format(text),
          source: "workman-lexer",
          code: "lex-error",
        });
      } else if (error instanceof ParseError) {
        // For parse errors, underline the exact token that caused the issue
        const startPos = this.offsetToPosition(text, error.token.start);
        const endPos = this.offsetToPosition(text, error.token.end);
        diagnostics.push({
          range: { start: startPos, end: endPos },
          severity: 1,
          message: error.format(text),
          source: "workman-parser",
          code: "parse-error",
        });
      } else if (error instanceof InferError) {
        const range = error.span 
          ? { 
              start: this.offsetToPosition(text, error.span.start),
              end: this.offsetToPosition(text, error.span.end)
            }
          : this.estimateRangeFromMessage(text, error.message);
        diagnostics.push({
          range,
          severity: 1,
          message: error.format(text),
          source: "workman-typechecker",
          code: "type-error",
        });
      } else if (error instanceof ModuleLoaderError) {
        const msg = String(error.message);
        const range = this.estimateRangeFromMessage(text, msg);
        diagnostics.push({
          range,
          severity: 1,
          message: msg,
          source: "workman-modules",
          code: "module-error",
        });
      } else {
        diagnostics.push({
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: `Internal error: ${error}`,
          source: "workman",
          code: "internal-error",
        });
      }
    }
    
    this.diagnostics.set(uri, diagnostics);
    this.log(`[LSP] Sending ${diagnostics.length} diagnostics for ${uri}`);
    
    // Send diagnostics notification
    try {
      await this.sendNotification("textDocument/publishDiagnostics", {
        uri,
        diagnostics,
      });
      this.log(`[LSP] Diagnostics sent successfully`);
    } catch (error) {
      this.log(`[LSP] Failed to send diagnostics: ${error}`);
    }
  }

  private async sendNotification(method: string, params: any) {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    await this.writeMessage(notification);
  }

  private async handleHover(message: LSPMessage): Promise<LSPMessage> {
    const { textDocument, position } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);
    
    this.log(`[LSP] Hover at line ${position.line}, char ${position.character}`);
    
    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
    
    try {
      const entryPath = this.uriToFsPath(uri);
      const stdRoots = this.computeStdRoots(entryPath);
      const env = await this.buildModuleEnv(entryPath, stdRoots, this.preludeModule);
      const offset = this.positionToOffset(text, position);
      const word = this.getWordAtOffset(text, offset);
      this.log(`[LSP] Word at cursor: '${word}'`);
      const scheme = env.get(word);
      if (scheme) {
        const typeStr = formatScheme(scheme);
        this.log(`[LSP] Found type for ${word}: ${typeStr}`);
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: {
              kind: "markdown",
              value: `\`\`\`workman\n${word} : ${typeStr}\n\`\`\``,
            },
          },
        };
      }
      this.log(`[LSP] No type found for '${word}'`);
    } catch (error) {
      this.log(`[LSP] Hover error: ${error}`);
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
    return { jsonrpc: "2.0", id: message.id, result: null };
  }

  private async handleInlayHint(message: LSPMessage): Promise<LSPMessage> {
    const { textDocument } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);
    
    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }
    
    const hints: any[] = [];
    
    try {
      const entryPath = this.uriToFsPath(uri);
      const stdRoots = this.computeStdRoots(entryPath);
      const env = await this.buildModuleEnv(entryPath, stdRoots, this.preludeModule);
      for (const [name, scheme] of env.entries()) {
        const regex = new RegExp(`\\blet\\s+(?:rec\\s+)?${name}\\b`, "g");
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const endPos = match.index + match[0].length;
          const position = this.offsetToPosition(text, endPos);
          const typeStr = formatScheme(scheme);
          hints.push({
            position,
            label: `: ${typeStr}`,
            kind: 1,
            paddingLeft: true,
            paddingRight: false,
          });
          this.log(`[LSP] Type hint: ${name} : ${typeStr} at line ${position.line}, char ${position.character}`);
        }
      }
      this.log(`[LSP] Returning ${hints.length} inlay hints`);
    } catch (error) {
      this.log(`[LSP] Inlay hint error: ${error}`);
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }
    
    return { jsonrpc: "2.0", id: message.id, result: hints };
  }

  private offsetToPosition(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let character = 0;
    
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === "\n") {
        line++;
        character = 0;
      } else {
        character++;
      }
    }
    
    return { line, character };
  }

  private positionToOffset(text: string, position: { line: number; character: number }): number {
    let offset = 0;
    let currentLine = 0;
    
    for (let i = 0; i < text.length; i++) {
      if (currentLine === position.line) {
        return offset + position.character;
      }
      if (text[i] === "\n") {
        currentLine++;
      }
      offset++;
    }
    
    return offset;
  }

  private getWordAtOffset(text: string, offset: number): string {
    let start = offset;
    let end = offset;
    
    // Move start back to word boundary
    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
      start--;
    }
    
    // Move end forward to word boundary
    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
      end++;
    }
    
    return text.substring(start, end);
  }

  private isStdCoreModule(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.includes("/std/core/")) return true;
    return normalized.endsWith("/std/list/core.wm")
      || normalized.endsWith("/std/option/core.wm")
      || normalized.endsWith("/std/result/core.wm");
  }

  private async buildModuleEnv(entryPath: string, stdRoots: string[], preludeModule?: string): Promise<Map<string, TypeScheme>> {
    const graph = await loadModuleGraph(entryPath, { stdRoots, preludeModule });
    const summaries = new Map<string, {
      exportsValues: Map<string, TypeScheme>;
      exportsTypes: Map<string, TypeInfo>;
      env: Map<string, TypeScheme>;
      adtEnv: Map<string, TypeInfo>;
    }>();
    const preludePath = graph.prelude;
    let preludeSummary: { exportsValues: Map<string, TypeScheme>; exportsTypes: Map<string, TypeInfo> } | undefined = undefined;

    for (const path of graph.order) {
      const node = graph.nodes.get(path)!;
      const initialEnv = new Map<string, TypeScheme>();
      const initialAdtEnv = new Map<string, TypeInfo>();

      for (const record of node.imports) {
        const provider = summaries.get(record.sourcePath);
        if (!provider) {
          throw new ModuleLoaderError(`Module '${path}' depends on '${record.sourcePath}' which failed to load`);
        }
        for (const spec of record.specifiers) {
          const val = provider.exportsValues.get(spec.imported);
          const typ = provider.exportsTypes.get(spec.imported);
          if (!val && !typ) {
            throw new ModuleLoaderError(`Module '${record.sourcePath}' does not export '${spec.imported}' (imported by '${record.importerPath}')`);
          }
          if (val) {
            initialEnv.set(spec.local, cloneTypeScheme(val));
          }
          if (typ) {
            if (spec.local !== spec.imported) {
              throw new ModuleLoaderError(`Type import aliasing is not supported in Stage M1 (imported '${spec.imported}' as '${spec.local}')`);
            }
            if (initialAdtEnv.has(spec.imported)) {
              throw new ModuleLoaderError(`Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`);
            }
            initialAdtEnv.set(spec.imported, cloneTypeInfo(typ));
          }
        }
      }

      if (preludeSummary && path !== preludePath && !this.isStdCoreModule(path)) {
        for (const [name, scheme] of preludeSummary.exportsValues.entries()) {
          if (!initialEnv.has(name)) initialEnv.set(name, cloneTypeScheme(scheme));
        }
        for (const [name, info] of preludeSummary.exportsTypes.entries()) {
          if (!initialAdtEnv.has(name)) initialAdtEnv.set(name, cloneTypeInfo(info));
        }
      }

      const inference = inferProgram(node.program, { initialEnv, initialAdtEnv, resetCounter: true });

      const exportedValues = new Map<string, TypeScheme>();
      const exportedTypes = new Map<string, TypeInfo>();

      for (const record of node.reexports) {
        const provider = summaries.get(record.sourcePath);
        if (!provider) {
          throw new ModuleLoaderError(`Module '${path}' depends on '${record.sourcePath}' which failed to load`);
        }
        for (const typeExport of record.typeExports) {
          const providedType = provider.exportsTypes.get(typeExport.name);
          if (!providedType) {
            throw new ModuleLoaderError(`Module '${record.importerPath}' re-exports type '${typeExport.name}' from '${record.rawSource}' which does not export it`);
          }
          if (exportedTypes.has(typeExport.name)) {
            throw new ModuleLoaderError(`Duplicate export '${typeExport.name}' in '${record.importerPath}'`);
          }
          const clonedInfo = cloneTypeInfo(providedType);
          exportedTypes.set(typeExport.name, clonedInfo);
          if (typeExport.exportConstructors) {
            for (const ctor of clonedInfo.constructors) {
              const providedScheme = provider.exportsValues.get(ctor.name);
              if (!providedScheme) {
                throw new ModuleLoaderError(`Module '${record.importerPath}' re-exports constructor '${ctor.name}' from '${record.rawSource}' but runtime type is missing in provider`);
              }
              if (exportedValues.has(ctor.name)) {
                throw new ModuleLoaderError(`Duplicate export '${ctor.name}' in '${record.importerPath}'`);
              }
              exportedValues.set(ctor.name, cloneTypeScheme(providedScheme));
            }
          }
        }
      }

      const letSchemeMap = new Map(inference.summaries.map(({ name, scheme }) => [name, scheme] as const));
      for (const name of node.exportedValueNames) {
        const scheme = letSchemeMap.get(name) ?? inference.env.get(name);
        if (!scheme) {
          throw new ModuleLoaderError(`Exported let '${name}' was not inferred in '${path}'`);
        }
        if (exportedValues.has(name)) {
          throw new ModuleLoaderError(`Duplicate export '${name}' in '${path}'`);
        }
        exportedValues.set(name, cloneTypeScheme(scheme));
      }

      for (const typeName of node.exportedTypeNames) {
        const info = inference.adtEnv.get(typeName);
        if (!info) {
          throw new ModuleLoaderError(`Exported type '${typeName}' was not defined in '${path}'`);
        }
        if (exportedTypes.has(typeName)) {
          throw new ModuleLoaderError(`Duplicate export '${typeName}' in '${path}'`);
        }
        const clonedInfo = cloneTypeInfo(info);
        exportedTypes.set(typeName, clonedInfo);
        for (const ctor of clonedInfo.constructors) {
          const scheme = inference.env.get(ctor.name);
          if (!scheme) {
            throw new ModuleLoaderError(`Constructor '${ctor.name}' for type '${typeName}' missing in '${path}'`);
          }
          if (exportedValues.has(ctor.name)) {
            throw new ModuleLoaderError(`Duplicate export '${ctor.name}' in '${path}'`);
          }
          exportedValues.set(ctor.name, cloneTypeScheme(scheme));
        }
      }

      summaries.set(path, { exportsValues: exportedValues, exportsTypes: exportedTypes, env: inference.env, adtEnv: inference.adtEnv });
      if (path === preludePath) {
        preludeSummary = { exportsValues: exportedValues, exportsTypes: exportedTypes };
      }
    }

    const entry = summaries.get(graph.entry);
    if (!entry) throw new ModuleLoaderError(`Internal error: failed to load entry module '${graph.entry}'`);
    return entry.env;
  }

  private uriToFsPath(uri: string): string {
    try {
      if (uri.startsWith("file:")) return fromFileUrl(uri);
    } catch {}
    // Fallback: assume it's a normal path
    return uri;
  }

  private computeStdRoots(entryPath: string): string[] {
    const roots = new Set<string>();
    if (this.initStdRoots && this.initStdRoots.length > 0) {
      for (const r of this.initStdRoots) {
        if (isAbsolute(r)) {
          roots.add(r);
        } else {
          for (const ws of this.workspaceRoots) {
            roots.add(join(ws, r));
          }
          roots.add(join(dirname(entryPath), r));
        }
      }
    }
    for (const root of this.workspaceRoots) {
      roots.add(join(root, "std"));
    }
    let dir = dirname(entryPath);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "std");
      try {
        const stat = Deno.statSync(candidate);
        if (stat.isDirectory) {
          roots.add(candidate);
          break;
        }
      } catch {
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const arr = Array.from(roots);
    this.log(`[LSP] stdRoots => ${arr.join(", ")}`);
    return arr.length > 0 ? arr : [join(dirname(entryPath), "std")];
  }

  private estimateRangeFromMessage(text: string, msg: string) {
    const quoted = Array.from(msg.matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
    for (const q of quoted) {
      const idx = text.indexOf(q);
      if (idx !== -1) {
        const start = this.offsetToPosition(text, idx);
        const end = this.offsetToPosition(text, idx + q.length);
        return { start, end };
      }
    }
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  }
}

// Start the server
if (import.meta.main) {
  const server = new WorkmanLanguageServer();
  await server.start();
}
