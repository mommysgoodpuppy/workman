#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

// Redirect console.log to stderr to prevent polluting LSP stdout with debug messages
console.log = console.error;

import { lex } from "@workman/lexer.ts";
import {
  ParseError,
  parseSurfaceProgram,
  type OperatorInfo,
} from "@workman/parser.ts";
import { InferError } from "@workman/layer1/infer.ts";
import { LexError, WorkmanError } from "@workman/error.ts";
import { formatScheme } from "@workman/type_printer.ts";
import {
  loadModuleGraph,
  ModuleLoaderError,
  type ModuleImportRecord,
} from "@workman/module_loader.ts";
import { dirname, fromFileUrl, isAbsolute, join } from "std/path/mod.ts";
import {
  cloneTypeInfo,
  cloneTypeScheme,
  TypeInfo,
  TypeScheme,
  typeToString,
  unknownType,
} from "@workman/types.ts";
import {
  analyzeProgram,
  type AnalysisResult,
} from "@workman/pipeline.ts";
import {
  findNodeAtOffset,
  presentProgram,
  type ConstraintDiagnosticWithSpan,
  type Layer3Result,
  type NodeView,
  type PartialType,
} from "@workman/layer3/mod.ts";
import type {
  MLetDeclaration,
  MProgram,
} from "@workman/ast_marked.ts";

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
  private preludeOperatorCache = new Map<string, {
    operators: Map<string, OperatorInfo>;
    prefixOperators: Set<string>;
  }>();
  private moduleContexts = new Map<
    string,
    {
      env: Map<string, TypeScheme>;
      layer3: Layer3Result;
      program: MProgram;
      entryPath: string;
    }
  >();

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
    let buffer = new Uint8Array(0);

    for await (const chunk of Deno.stdin.readable) {
      //@ts-expect-error deno bug
      buffer = this.concatBuffers(buffer, chunk);

      while (true) {
        const headerEnd = this.findHeaderBoundary(buffer);
        if (headerEnd === -1) break;

        const headerBytes = buffer.slice(0, headerEnd);
        const header = decoder.decode(headerBytes);
        const contentLength = this.extractContentLength(header);

        if (contentLength === null) {
          this.log(`[LSP] Invalid header: ${header}`);
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const messageStart = headerEnd + 4;

        if (buffer.length < messageStart + contentLength) {
          break; // Wait for more data
        }

        const messageBytes = buffer.slice(
          messageStart,
          messageStart + contentLength,
        );
        const messageContent = decoder.decode(messageBytes);
        buffer = buffer.slice(messageStart + contentLength);

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

  private concatBuffers(existing: Uint8Array, incoming: Uint8Array): Uint8Array {
    if (existing.length === 0) {
      return incoming.slice();
    }
    const combined = new Uint8Array(existing.length + incoming.length);
    combined.set(existing);
    combined.set(incoming, existing.length);
    return combined;
  }

  private findHeaderBoundary(buffer: Uint8Array): number {
    for (let i = 0; i <= buffer.length - 4; i++) {
      if (
        buffer[i] === 13 &&
        buffer[i + 1] === 10 &&
        buffer[i + 2] === 13 &&
        buffer[i + 3] === 10
      ) {
        return i;
      }
    }
    return -1;
  }

  private extractContentLength(header: string): number | null {
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      return null;
    }
    const length = Number.parseInt(match[1], 10);
    return Number.isNaN(length) ? null : length;
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

      case "textDocument/definition":
        return await this.handleDefinition(message);

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
        try {
          roots.push(fromFileUrl(params.rootUri));
        } catch {}
      } else if (typeof params.rootPath === "string") {
        roots.push(params.rootPath);
      }
      if (Array.isArray(params.workspaceFolders)) {
        for (const wf of params.workspaceFolders) {
          if (wf && typeof wf.uri === "string") {
            try {
              roots.push(fromFileUrl(wf.uri));
            } catch {}
          }
        }
      }
      this.workspaceRoots = Array.from(new Set(roots));
      this.log(`[LSP] Workspace roots: ${this.workspaceRoots.join(", ")}`);
      const init = params.initializationOptions ?? {};
      if (init && Array.isArray(init.stdRoots)) {
        this.initStdRoots = init.stdRoots.filter((s: unknown) =>
          typeof s === "string"
        );
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
          definitionProvider: true,
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

  private async handleDidChange(
    message: LSPMessage,
  ): Promise<LSPMessage | null> {
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

    this.moduleContexts.delete(uri);
    const entryPath = this.uriToFsPath(uri);
    const stdRoots = this.computeStdRoots(entryPath);

    // First, try to parse the current document directly to get better error positions
    try {
      const tokens = lex(text, uri);
      const { operators, prefixOperators } = await this.getPreludeOperatorSets(
        entryPath,
        stdRoots,
      );
      const program = parseSurfaceProgram(
        tokens,
        text,
        false,
        operators.size > 0 ? operators : undefined,
        prefixOperators.size > 0 ? prefixOperators : undefined,
      );
      // If parsing succeeds, try full module analysis without executing the program
      try {
        const context = await this.buildModuleContext(
          entryPath,
          stdRoots,
          this.preludeModule,
        );
        this.moduleContexts.set(uri, context);
        this.log(`[LSP] Module analysis completed (${entryPath})`);
        this.appendSolverDiagnostics(
          diagnostics,
          context.layer3.diagnostics.solver,
          text,
        );
        this.appendConflictDiagnostics(
          diagnostics,
          context.layer3.diagnostics.conflicts,
          text,
        );
      } catch (moduleError) {
        // Module-level errors (imports, type errors, etc.)
        this.log(`[LSP] Module validation error: ${moduleError}`);
        if (moduleError instanceof InferError) {
          const range = moduleError.span
            ? {
              start: this.offsetToPosition(text, moduleError.span.start),
              end: this.offsetToPosition(text, moduleError.span.end),
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
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
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
            end: this.offsetToPosition(text, error.span.end),
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
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
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

  private appendSolverDiagnostics(
    target: any[],
    diagnostics: ConstraintDiagnosticWithSpan[],
    text: string,
  ): void {
    for (const diag of diagnostics) {
      const range = diag.span
        ? {
          start: this.offsetToPosition(text, diag.span.start),
          end: this.offsetToPosition(text, Math.max(diag.span.end, diag.span.start + 1)),
        }
        : {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        };
      target.push({
        range,
        severity: 1,
        message: this.formatSolverDiagnostic(diag),
        source: "workman-layer2",
        code: diag.reason,
      });
    }
  }

  private appendConflictDiagnostics(
    target: any[],
    conflicts: any[],
    text: string,
  ): void {
    for (const conflict of conflicts) {
      const range = conflict.span
        ? {
          start: this.offsetToPosition(text, conflict.span.start),
          end: this.offsetToPosition(text, Math.max(conflict.span.end, conflict.span.start + 1)),
        }
        : {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        };
      target.push({
        range,
        severity: 1,
        message: conflict.message,
        source: "workman-conflicts",
        code: "unfillable-hole",
      });
    }
  }

  private formatSolverDiagnostic(diag: ConstraintDiagnosticWithSpan): string {
    let base: string;
    switch (diag.reason) {
      case "not_function":
        base = "Expected a function but found a non-function value";
        break;
      case "branch_mismatch":
        base = "Branches in this expression do not agree on a type";
        break;
      case "missing_field":
        base = "Record is missing a required field";
        break;
      case "not_record":
        base = "Expected a record value here";
        break;
      case "occurs_cycle":
        base = "Occurs check failed while solving types";
        break;
      case "type_mismatch":
        base = "Conflicting type requirements";
        break;
      case "arity_mismatch":
        base = "Function arity does not match the call";
        break;
      case "not_numeric":
        base = "Numeric operation expected numbers";
        break;
      case "not_boolean":
        base = "Boolean operation expected booleans";
        break;
      case "free_variable": {
        const name = typeof diag.details?.name === "string"
          ? diag.details.name
          : "value";
        base = `Unbound variable ${name}`;
        break;
      }
      case "unsupported_expr": {
        const exprKind = typeof diag.details?.exprKind === "string"
          ? diag.details.exprKind
          : undefined;
        base = exprKind
          ? `This expression form (${exprKind}) is not supported here`
          : "This expression form is not supported here";
        break;
      }
      case "non_exhaustive_match":
        base = "Match expression is not exhaustive";
        break;
      case "type_expr_unknown": {
        const reason = typeof diag.details?.reason === "string"
          ? diag.details.reason
          : "Unknown type expression";
        base = reason;
        break;
      }
      case "type_expr_arity":
        base = "Type expression was given the wrong number of arguments";
        break;
      case "type_expr_unsupported":
        base = "This type expression form is not supported";
        break;
      case "type_decl_duplicate":
        base = "Duplicate type declaration";
        break;
      case "type_decl_invalid_member":
        base = "Invalid member in this type declaration";
        break;
      case "internal_error":
        base = "Internal type inference error";
        break;
      default:
        base = `Solver diagnostic: ${diag.reason}`;
        break;
    }
    if (diag.details && Object.keys(diag.details).length > 0) {
      try {
        base = `${base}. Details: ${JSON.stringify(diag.details)}`;
      } catch {
        // Ignore stringify errors
      }
    }
    return base;
  }

  private renderNodeView(view: NodeView, holeSolutions?: Map<number, any>): string | null {
    const typeStr = this.partialTypeToString(view.finalType);
    if (!typeStr) {
      return null;
    }
    
    let result = "```workman\n" + typeStr + "\n```";
    
    // Check if this node has a hole solution with partial information
    if (holeSolutions && view.nodeId !== undefined) {
      const solution = holeSolutions.get(view.nodeId);
      if (solution) {
        // Show provenance for unknown types
        if (solution.provenance && solution.provenance.provenance) {
          const prov = solution.provenance.provenance;
          if (prov.kind === "incomplete" && prov.reason) {
            result += `\n\n_${prov.reason}_`;
          } else if (prov.kind === "expr_hole") {
            result += "\n\n_Explicit type hole_";
          } else if (prov.kind === "user_hole") {
            result += "\n\n_User-specified type hole_";
          }
        }
        
        if (solution.state === "partial" && solution.partial) {
          result += "\n\n**Partial Type Information:**\n";
          if (solution.partial.known) {
            result += `- Known: \`${typeToString(solution.partial.known)}\`\n`;
          }
          if (solution.partial.possibilities && solution.partial.possibilities.length > 0) {
            result += `- Possibilities: ${solution.partial.possibilities.length}\n`;
            // Show first few possibilities
            const maxShow = 3;
            for (let i = 0; i < Math.min(maxShow, solution.partial.possibilities.length); i++) {
              result += `  - \`${typeToString(solution.partial.possibilities[i])}\`\n`;
            }
            if (solution.partial.possibilities.length > maxShow) {
              result += `  - ... and ${solution.partial.possibilities.length - maxShow} more\n`;
            }
          }
          result += "\n_Some type information is inferred, but not everything is known yet._";
        } else if (solution.state === "conflicted" && solution.conflicts) {
          result += "\n\n**⚠️ Type Conflict Detected:**\n";
          for (const conflict of solution.conflicts) {
            const types = conflict.types.map((t: any) => typeToString(t)).join(" vs ");
            result += `- Conflicting types: \`${types}\`\n`;
            result += `- Reason: ${conflict.reason}\n`;
          }
          result += "\n_This type hole has incompatible constraints._";
        } else if (solution.state === "unsolved") {
          result += "\n\n_Type is not fully determined yet._";
        }
      }
    }
    
    return result;
  }

  private partialTypeToString(partial: PartialType): string | null {
    switch (partial.kind) {
      case "unknown":
        return "?";
      case "concrete":
        return partial.type ? typeToString(partial.type) : null;
      default:
        return null;
    }
  }

  private async handleHover(message: LSPMessage): Promise<LSPMessage> {
    const { textDocument, position } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);

    this.log(
      `[LSP] Hover at line ${position.line}, char ${position.character}`,
    );

    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }

    try {
      const entryPath = this.uriToFsPath(uri);
      const stdRoots = this.computeStdRoots(entryPath);
      let context = this.moduleContexts.get(uri);
      if (!context) {
        context = await this.buildModuleContext(
          entryPath,
          stdRoots,
          this.preludeModule,
        );
        this.moduleContexts.set(uri, context);
      }
      const { layer3, env } = context;
      const offset = this.positionToOffset(text, position);
      const nodeId = findNodeAtOffset(layer3.spanIndex, offset);
      if (nodeId) {
        const view = layer3.nodeViews.get(nodeId);
        if (view) {
          const rendered = this.renderNodeView(view, layer3.holeSolutions);
          if (rendered) {
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                contents: {
                  kind: "markdown",
                  value: rendered,
                },
              },
            };
          }
        }
      }
      const { word } = this.getWordAtOffset(text, offset);
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

  private async handleDefinition(
    message: LSPMessage,
  ): Promise<LSPMessage> {
    const { textDocument, position } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);

    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }

    try {
      const entryPath = this.uriToFsPath(uri);
      const stdRoots = this.computeStdRoots(entryPath);
      let context = this.moduleContexts.get(uri);
      if (!context) {
        context = await this.buildModuleContext(
          entryPath,
          stdRoots,
          this.preludeModule,
        );
        this.moduleContexts.set(uri, context);
      }
      const offset = this.positionToOffset(text, position);
      const { word, start } = this.getWordAtOffset(text, offset);
      if (!word) {
        return { jsonrpc: "2.0", id: message.id, result: null };
      }
      if (start > 0) {
        const prevChar = text[start - 1];
        if (prevChar === `"` || prevChar === `'`) {
          return { jsonrpc: "2.0", id: message.id, result: null };
        }
      }

      const decl = this.findTopLevelLet(context.program, word);
      if (!decl) {
        return { jsonrpc: "2.0", id: message.id, result: null };
      }

      const span = context.layer3.spanIndex.get(decl.id);
      if (!span) {
        return { jsonrpc: "2.0", id: message.id, result: null };
      }

      const range = {
        start: this.offsetToPosition(text, span.start),
        end: this.offsetToPosition(text, span.end),
      };

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: [
          {
            uri,
            range,
          },
        ],
      };
    } catch (error) {
      this.log(`[LSP] Definition error: ${error}`);
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
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
      let context = this.moduleContexts.get(uri);
      if (!context) {
        context = await this.buildModuleContext(
          entryPath,
          stdRoots,
          this.preludeModule,
        );
        this.moduleContexts.set(uri, context);
      }
      const { env } = context;
      for (const [name, scheme] of env.entries()) {
        if (name.startsWith("__op_") || name.startsWith("__prefix_")) {
          continue;
        }
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\blet\\s+(?:rec\\s+)?${escapedName}\\b`, "g");
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
          this.log(
            `[LSP] Type hint: ${name} : ${typeStr} at line ${position.line}, char ${position.character}`,
          );
        }
      }
      this.log(`[LSP] Returning ${hints.length} inlay hints`);
    } catch (error) {
      this.log(`[LSP] Inlay hint error: ${error}`);
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }

    return { jsonrpc: "2.0", id: message.id, result: hints };
  }

  private offsetToPosition(
    text: string,
    offset: number,
  ): { line: number; character: number } {
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

  private positionToOffset(
    text: string,
    position: { line: number; character: number },
  ): number {
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

  private getWordAtOffset(
    text: string,
    offset: number,
  ): { word: string; start: number; end: number } {
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

    return { word: text.substring(start, end), start, end };
  }

  private isStdCoreModule(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.includes("/std/core/")) return true;
    return normalized.endsWith("/std/list/core.wm") ||
      normalized.endsWith("/std/option/core.wm") ||
      normalized.endsWith("/std/result/core.wm");
  }

  private async buildModuleContext(
    entryPath: string,
    stdRoots: string[],
    preludeModule?: string,
  ): Promise<{
    env: Map<string, TypeScheme>;
    layer3: Layer3Result;
    program: MProgram;
    entryPath: string;
  }> {
    const graph = await loadModuleGraph(entryPath, { stdRoots, preludeModule });
    const summaries = new Map<string, {
      exportsValues: Map<string, TypeScheme>;
      exportsTypes: Map<string, TypeInfo>;
      env: Map<string, TypeScheme>;
      adtEnv: Map<string, TypeInfo>;
    }>();
    const preludePath = graph.prelude;
    let preludeSummary: {
      exportsValues: Map<string, TypeScheme>;
      exportsTypes: Map<string, TypeInfo>;
    } | undefined = undefined;
    let preludeEnv: Map<string, TypeScheme> | undefined = undefined;
    let entryAnalysis: AnalysisResult | null = null;

    for (const path of graph.order) {
      const node = graph.nodes.get(path)!;
      const initialEnv = new Map<string, TypeScheme>();
      const initialAdtEnv = new Map<string, TypeInfo>();

      for (const record of node.imports) {
        if (record.kind === "js") {
          seedJsImport(record, initialEnv);
          continue;
        }
        const provider = summaries.get(record.sourcePath);
        if (!provider) {
          throw new ModuleLoaderError(
            `Module '${path}' depends on '${record.sourcePath}' which failed to load`,
          );
        }
        for (const spec of record.specifiers) {
          const val = provider.exportsValues.get(spec.imported);
          const typ = provider.exportsTypes.get(spec.imported);
          if (!val && !typ) {
            throw new ModuleLoaderError(
              `Module '${record.sourcePath}' does not export '${spec.imported}' (imported by '${record.importerPath}')`,
            );
          }
          if (val) {
            initialEnv.set(spec.local, cloneTypeScheme(val));
          }
          if (typ) {
            if (spec.local !== spec.imported) {
              throw new ModuleLoaderError(
                `Type import aliasing is not supported in Stage M1 (imported '${spec.imported}' as '${spec.local}')`,
              );
            }
            if (initialAdtEnv.has(spec.imported)) {
              throw new ModuleLoaderError(
                `Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`,
              );
            }
            initialAdtEnv.set(spec.imported, cloneTypeInfo(typ));
          }
        }
      }

      if (
        preludeSummary && path !== preludePath && !this.isStdCoreModule(path)
      ) {
        for (const [name, scheme] of preludeSummary.exportsValues.entries()) {
          if (!initialEnv.has(name)) {
            initialEnv.set(name, cloneTypeScheme(scheme));
          }
        }
        for (const [name, info] of preludeSummary.exportsTypes.entries()) {
          if (!initialAdtEnv.has(name)) {
            initialAdtEnv.set(name, cloneTypeInfo(info));
          }
        }
        if (preludeEnv) {
          const preludeNode = graph.nodes.get(preludePath!);
          if (preludeNode) {
            for (const decl of preludeNode.program.declarations) {
              if (decl.kind === "infix") {
                const opName = `__op_${decl.operator}`;
                const scheme = preludeEnv.get(opName);
                if (scheme && !initialEnv.has(opName)) {
                  initialEnv.set(opName, cloneTypeScheme(scheme));
                }
              } else if (decl.kind === "prefix") {
                const opName = `__prefix_${decl.operator}`;
                const scheme = preludeEnv.get(opName);
                if (scheme && !initialEnv.has(opName)) {
                  initialEnv.set(opName, cloneTypeScheme(scheme));
                }
              }
            }
          }
        }
      }

      const analysis = analyzeProgram(node.program, {
        initialEnv,
        initialAdtEnv,
        resetCounter: true,
        source: node.source,
      });

      const exportedValues = new Map<string, TypeScheme>();
      const exportedTypes = new Map<string, TypeInfo>();

      for (const record of node.reexports) {
        const provider = summaries.get(record.sourcePath);
        if (!provider) {
          throw new ModuleLoaderError(
            `Module '${path}' depends on '${record.sourcePath}' which failed to load`,
          );
        }
        for (const typeExport of record.typeExports) {
          const providedType = provider.exportsTypes.get(typeExport.name);
          if (!providedType) {
            throw new ModuleLoaderError(
              `Module '${record.importerPath}' re-exports type '${typeExport.name}' from '${record.rawSource}' which does not export it`,
            );
          }
          if (exportedTypes.has(typeExport.name)) {
            throw new ModuleLoaderError(
              `Duplicate export '${typeExport.name}' in '${record.importerPath}'`,
            );
          }
          const clonedInfo = cloneTypeInfo(providedType);
          exportedTypes.set(typeExport.name, clonedInfo);
          if (typeExport.exportConstructors) {
            for (const ctor of clonedInfo.constructors) {
              const providedScheme = provider.exportsValues.get(ctor.name);
              if (!providedScheme) {
                throw new ModuleLoaderError(
                  `Module '${record.importerPath}' re-exports constructor '${ctor.name}' from '${record.rawSource}' but runtime type is missing in provider`,
                );
              }
              if (exportedValues.has(ctor.name)) {
                throw new ModuleLoaderError(
                  `Duplicate export '${ctor.name}' in '${record.importerPath}'`,
                );
              }
              exportedValues.set(ctor.name, cloneTypeScheme(providedScheme));
            }
          }
        }
      }

      const letSchemeMap = new Map(
        analysis.layer1.summaries.map((
          { name, scheme },
        ) => [name, scheme] as const),
      );
      for (const name of node.exportedValueNames) {
        const scheme = letSchemeMap.get(name) ??
          analysis.layer1.env.get(name);
        if (!scheme) {
          throw new ModuleLoaderError(
            `Exported let '${name}' was not inferred in '${path}'`,
          );
        }
        if (exportedValues.has(name)) {
          throw new ModuleLoaderError(
            `Duplicate export '${name}' in '${path}'`,
          );
        }
        exportedValues.set(name, cloneTypeScheme(scheme));
      }

      for (const typeName of node.exportedTypeNames) {
        const info = analysis.layer1.adtEnv.get(typeName);
        if (!info) {
          throw new ModuleLoaderError(
            `Exported type '${typeName}' was not defined in '${path}'`,
          );
        }
        if (exportedTypes.has(typeName)) {
          throw new ModuleLoaderError(
            `Duplicate export '${typeName}' in '${path}'`,
          );
        }
        const clonedInfo = cloneTypeInfo(info);
        exportedTypes.set(typeName, clonedInfo);
        for (const ctor of clonedInfo.constructors) {
          const scheme = analysis.layer1.env.get(ctor.name);
          if (!scheme) {
            throw new ModuleLoaderError(
              `Constructor '${ctor.name}' for type '${typeName}' missing in '${path}'`,
            );
          }
          if (exportedValues.has(ctor.name)) {
            throw new ModuleLoaderError(
              `Duplicate export '${ctor.name}' in '${path}'`,
            );
          }
          exportedValues.set(ctor.name, cloneTypeScheme(scheme));
        }
      }

      summaries.set(path, {
        exportsValues: exportedValues,
        exportsTypes: exportedTypes,
        env: analysis.layer1.env,
        adtEnv: analysis.layer1.adtEnv,
      });
      if (path === preludePath) {
        preludeSummary = {
          exportsValues: exportedValues,
          exportsTypes: exportedTypes,
        };
        preludeEnv = analysis.layer1.env;
      }
      if (path === graph.entry) {
        entryAnalysis = analysis;
      }
    }

    const entry = summaries.get(graph.entry);
    if (!entry) {
      throw new ModuleLoaderError(
        `Internal error: failed to load entry module '${graph.entry}'`,
      );
    }
    if (!entryAnalysis) {
      throw new ModuleLoaderError(
        `Internal error: missing analysis for entry module '${graph.entry}'`,
      );
    }
    const layer3 = presentProgram(entryAnalysis.layer2);
    return {
      env: entry.env,
      layer3,
      program: entryAnalysis.layer1.markedProgram,
      entryPath: graph.entry,
    };
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

  private findTopLevelLet(program: MProgram, name: string): MLetDeclaration | undefined {
    for (const decl of program.declarations ?? []) {
      if (decl.kind !== "let") continue;
      if (decl.name === name) {
        return decl;
      }
      if (decl.mutualBindings) {
        for (const binding of decl.mutualBindings) {
          if (binding.name === name) {
            return binding;
          }
        }
      }
    }
    return undefined;
  }

  private async getPreludeOperatorSets(
    entryPath: string,
    stdRoots: string[],
  ): Promise<{
    operators: Map<string, OperatorInfo>;
    prefixOperators: Set<string>;
  }> {
    const emptyResult = {
      operators: new Map<string, OperatorInfo>(),
      prefixOperators: new Set<string>(),
    };

    if (!this.preludeModule) {
      return emptyResult;
    }

    const cacheKey = `${[...stdRoots].sort().join(";")}::${this.preludeModule}`;
    const cached = this.preludeOperatorCache.get(cacheKey);
    if (cached) {
      return {
        operators: new Map(cached.operators),
        prefixOperators: new Set(cached.prefixOperators),
      };
    }

    const preludePath = this.resolvePreludePath(entryPath, stdRoots);
    if (!preludePath) {
      this.log(
        `[LSP] Unable to resolve prelude module '${this.preludeModule}' for '${entryPath}'`,
      );
      return emptyResult;
    }

    let source: string;
    try {
      source = await Deno.readTextFile(preludePath);
    } catch (error) {
      this.log(
        `[LSP] Failed to read prelude '${preludePath}': ${error instanceof Error ? error.message : error}'`,
      );
      return emptyResult;
    }

    let program;
    try {
      const tokens = lex(source, preludePath);
      program = parseSurfaceProgram(tokens, source);
    } catch (error) {
      this.log(
        `[LSP] Failed to parse prelude '${preludePath}': ${error instanceof Error ? error.message : error}'`,
      );
      return emptyResult;
    }

    const operators = new Map<string, OperatorInfo>();
    const prefixOperators = new Set<string>();
    for (const decl of program.declarations ?? []) {
      if (decl.kind === "infix") {
        operators.set(decl.operator, {
          precedence: decl.precedence,
          associativity: decl.associativity,
        });
      } else if (decl.kind === "prefix") {
        prefixOperators.add(decl.operator);
      }
    }

    this.preludeOperatorCache.set(cacheKey, {
      operators: new Map(operators),
      prefixOperators: new Set(prefixOperators),
    });

    return { operators, prefixOperators };
  }

  private resolvePreludePath(
    entryPath: string,
    stdRoots: string[],
  ): string | null {
    if (!this.preludeModule) {
      return null;
    }

    const ensureExists = (candidate: string): string | null => {
      const withExt = this.ensureWmExtension(candidate);
      try {
        const stat = Deno.statSync(withExt);
        if (stat.isFile) {
          return withExt;
        }
      } catch {
        return null;
      }
      return null;
    };

    const spec = this.preludeModule;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const candidate = ensureExists(join(dirname(entryPath), spec));
      if (candidate) return candidate;
    } else if (isAbsolute(spec)) {
      const candidate = ensureExists(spec);
      if (candidate) return candidate;
    } else if (spec.startsWith("std/")) {
      const remainder = spec.slice(4);
      for (const root of stdRoots) {
        const candidate = ensureExists(join(root, remainder));
        if (candidate) return candidate;
      }
    } else {
      for (const root of this.workspaceRoots) {
        const candidate = ensureExists(join(root, spec));
        if (candidate) return candidate;
      }
    }

    return null;
  }

  private ensureWmExtension(path: string): string {
    if (path.endsWith(".wm")) {
      return path;
    }
    return `${path}.wm`;
  }

  private estimateRangeFromMessage(text: string, msg: string) {
    const quoted = Array.from(msg.matchAll(/["']([^"']+)["']/g)).map((m) =>
      m[1]
    );
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

function seedJsImport(
  record: ModuleImportRecord,
  env: Map<string, TypeScheme>,
): void {
  for (const spec of record.specifiers) {
    if (env.has(spec.local)) {
      throw new ModuleLoaderError(
        `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
      );
    }
    env.set(spec.local, {
      quantifiers: [],
      type: unknownType({
        kind: "incomplete",
        reason: `js import '${spec.imported}' from '${record.rawSource}' in '${record.importerPath}'`,
      }),
    });
  }
}

// Start the server
if (import.meta.main) {
  const server = new WorkmanLanguageServer();
  await server.start();
}
