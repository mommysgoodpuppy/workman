#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

// Redirect console.log to stderr to prevent polluting LSP stdout with debug messages
console.log = console.error;

import { lex } from "../../../src/lexer.ts";
import {
  type OperatorInfo,
  parseSurfaceProgram,
} from "../../../src//parser.ts";
import { LexError, ParseError, type WorkmanError } from "../../../src//error.ts";
import { formatScheme } from "../../../src//type_printer.ts";
import { ModuleLoaderError } from "../../../src//module_loader.ts";
import { dirname, fromFileUrl, isAbsolute, join } from "std/path/mod.ts";
import { resolve } from "std/path/resolve.ts";
import {
  getProvenance,
  isHoleType,
  type Type,
  type TypeScheme,
  typeToString,
} from "../../../src//types.ts";
import {
  type ConstraintDiagnosticWithSpan,
  findNodeAtOffset,
  type FlowDiagnostic,
  type Layer3Result,
  type MatchCoverageView,
  type NodeView,
  type PartialType,
} from "../../../src//layer3/mod.ts";
import {
  compileWorkmanGraph,
} from "../../../backends/compiler/frontends/workman.ts";
import type { MLetDeclaration, MProgram } from "../../../src//ast_marked.ts";


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
      adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>;
      entryPath: string;
    }
  >();
  private validationInProgress = new Map<string, Promise<void>>();
  private validationTimers = new Map<string, number>();

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
          // Use a replacer to handle circular references and ensure clean serialization
          const messageStr = JSON.stringify(message, (key, value) => {
            // Handle circular references
            if (value instanceof Map) {
              return `[Map with ${value.size} entries]`;
            }
            if (value instanceof Set) {
              return `[Set with ${value.size} entries]`;
            }
            // Avoid serializing large or problematic objects
            if (typeof value === "object" && value !== null) {
              // Check for circular references by tracking seen objects
              // (This is a simple check; a full solution would need a WeakSet)
              if (key === "conflicts" && Array.isArray(value)) {
                // Simplify conflicts to avoid serialization issues
                return value.length;
              }
            }
            return value;
          });
          const bodyBytes = encoder.encode(messageStr);
          const header = `Content-Length: ${bodyBytes.length}\r\n\r\n`;
          const headerBytes = encoder.encode(header);
          const bytes = new Uint8Array(headerBytes.length + bodyBytes.length);
          bytes.set(headerBytes, 0);
          bytes.set(bodyBytes, headerBytes.length);

          let written = 0;
          while (written < bytes.length) {
            const n = await Deno.stdout.write(bytes.subarray(written));
            written += n;
          }

          resolve();
        } catch (error) {
          console.error(`[LSP] Write error: ${error}`);
          console.error(
            `[LSP] Failed message: ${
              JSON.stringify(message, null, 2).substring(0, 500)
            }`,
          );
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

  private concatBuffers(
    existing: Uint8Array,
    incoming: Uint8Array,
  ): Uint8Array {
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

      case "workspace/didChangeWatchedFiles":
        return await this.handleDidChangeWatchedFiles(message);

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
          workspace: {
            fileOperations: {
              didChange: {
                filters: [{ pattern: { glob: "**/*.wm" } }],
              },
            },
          },
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
    await this.ensureValidation(uri, text);

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
      await this.ensureValidation(uri, text);
    }

    return null;
  }

  private async handleDidChangeWatchedFiles(
    message: LSPMessage,
  ): Promise<LSPMessage | null> {
    const { changes } = message.params;

    if (!Array.isArray(changes)) {
      return null;
    }

    // Revalidate all changed files that we have open
    for (const change of changes) {
      const uri = change.uri;
      const text = this.documents.get(uri);

      if (text !== undefined) {
        // File is open in the editor, revalidate it
        await this.ensureValidation(uri, text);
      }
    }

    return null;
  }

  private async validateDocument(uri: string, text: string) {
    const diagnostics: any[] = [];

    this.log(`[LSP] Validating document: ${uri}`);

    // Only clear the context for this specific file, not all contexts
    // This allows caching of dependency analysis
    this.moduleContexts.delete(uri);

    const entryPath = this.uriToFsPath(uri);
    const stdRoots = this.computeStdRoots(entryPath);

    // Use the module loader to parse and analyze the document
    // It will use the in-memory content via sourceOverrides
    try {
      const sourceOverrides = new Map([[entryPath, text]]);
      const context = await this.buildModuleContext(
        entryPath,
        stdRoots,
        this.preludeModule,
        sourceOverrides,
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
      this.appendFlowDiagnostics(
        diagnostics,
        context.layer3.diagnostics.flow,
        text,
      );
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
        // Check if the ModuleLoaderError wraps a WorkmanError with location info
        const cause = (error as any).cause;
        let range;
        let message = String(error.message);
        let source = "workman-modules";
        let code = "module-error";

        if (cause instanceof LexError) {
          const position = this.offsetToPosition(text, cause.position);
          const endPos = this.offsetToPosition(text, cause.position + 1);
          range = { start: position, end: endPos };
          message = cause.format(text);
          source = "workman-lexer";
          code = "lex-error";
        } else if (cause instanceof ParseError) {
          const startPos = this.offsetToPosition(text, cause.token.start);
          const endPos = this.offsetToPosition(text, cause.token.end);
          range = { start: startPos, end: endPos };
          message = cause.format(text);
          source = "workman-parser";
          code = "parse-error";
        } else if (cause instanceof InferError) {
          range = cause.span
            ? {
              start: this.offsetToPosition(text, cause.span.start),
              end: this.offsetToPosition(text, cause.span.end),
            }
            : this.estimateRangeFromMessage(text, cause.message);
          message = cause.format(text);
          source = "workman-typechecker";
          code = "type-error";
        } else {
          // Try to parse location from formatted error message
          const locationMatch = message.match(/at line (\d+), column (\d+)/);
          if (locationMatch) {
            const line = Number.parseInt(locationMatch[1], 10) - 1; // 0-indexed
            const column = Number.parseInt(locationMatch[2], 10) - 1; // 0-indexed
            // Find the token at this location
            const errorOffset = this.positionToOffset(text, {
              line,
              character: column,
            });
            const { word, start, end } = this.getWordAtOffset(
              text,
              errorOffset,
            );
            // Use the word boundaries if we found a word, otherwise just highlight the position
            if (word && word.length > 0) {
              range = {
                start: this.offsetToPosition(text, start),
                end: this.offsetToPosition(text, end),
              };
            } else {
              range = {
                start: { line, character: column },
                end: { line, character: column + 1 },
              };
            }
          } else {
            range = this.estimateRangeFromMessage(text, message);
          }
        }

        diagnostics.push({
          range,
          severity: 1,
          message,
          source,
          code,
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
          end: this.offsetToPosition(
            text,
            Math.max(diag.span.end, diag.span.start + 1),
          ),
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
          end: this.offsetToPosition(
            text,
            Math.max(conflict.span.end, conflict.span.start + 1),
          ),
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

  private appendFlowDiagnostics(
    target: any[],
    flowDiagnostics: FlowDiagnostic[],
    text: string,
  ): void {
    for (const diag of flowDiagnostics) {
      const span = "span" in diag ? diag.span : undefined;
      const range = span
        ? {
          start: this.offsetToPosition(text, span.start),
          end: this.offsetToPosition(text, Math.max(span.end, span.start + 1)),
        }
        : {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        };
      target.push({
        range,
        severity: 2, // warning
        message: diag.message,
        source: "workman-flow",
        code: diag.kind,
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
      case "non_exhaustive_match": {
        base = "Match expression is not exhaustive";
        const missing = Array.isArray(diag.details?.missingCases)
          ? (diag.details.missingCases as string[]).join(", ")
          : null;
        if (missing) {
          base += ` - missing cases: ${missing}`;
        }
        // Add information about the scrutinee type if it's a Result (infectious)
        const scrutineeType = diag.details?.scrutineeType as Type | undefined;
        if (
          scrutineeType?.kind === "constructor" &&
          scrutineeType.name === "Result"
        ) {
          const errorType = scrutineeType.args[1];
          const errorTypeStr = errorType ? typeToString(errorType) : "?";
          base +=
            `\n\nThe scrutinee has type Result<?, ${errorTypeStr}> (infectious Result from an operation that can fail).`;
          base += `\nHandle both Ok and Err cases, or use a wildcard pattern.`;
        }
        break;
      }
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
      case "infectious_call_result_mismatch": {
        const row = diag.details?.errorRow as Type | undefined;
        const rowLabel = row ? typeToString(row) : "an unresolved error row";
        base =
          `This call must remain infectious because an argument carries ${rowLabel}`;
        break;
      }
      case "infectious_match_result_mismatch": {
        const row = diag.details?.errorRow as Type | undefined;
        const missing = Array.isArray(diag.details?.missingConstructors)
          ? (diag.details?.missingConstructors as string[]).join(", ")
          : null;
        const rowLabel = row ? ` for row ${typeToString(row)}` : "";
        base =
          `Match claimed to discharge Result errors${rowLabel} but remained infectious`;
        if (missing && missing.length > 0) {
          base += `. Missing constructors: ${missing}`;
        }
        break;
      }
      default:
        base = `Solver diagnostic: ${diag.reason}`;
        break;
    }
    if (diag.details && Object.keys(diag.details).length > 0) {
      try {
        // Safely stringify details, avoiding circular references
        const safeDetails: Record<string, any> = {};
        for (const [key, value] of Object.entries(diag.details)) {
          if (typeof value === "object" && value !== null) {
            // Don't include complex objects that might have circular refs
            if (Array.isArray(value)) {
              safeDetails[key] = `[Array with ${value.length} items]`;
            } else {
              safeDetails[key] = "[Object]";
            }
          } else {
            safeDetails[key] = value;
          }
        }
        base = `${base}. Details: ${JSON.stringify(safeDetails)}`;
      } catch {
        // Ignore stringify errors
      }
    }
    return base;
  }

  private renderNodeView(
    view: NodeView,
    layer3: Layer3Result,
    coverage?: MatchCoverageView,
    adtEnv?: Map<string, import("../../../src//types.ts").TypeInfo>,
  ): string | null {
    const typeStr = this.partialTypeToString(view.finalType, layer3);
    if (!typeStr) {
      return null;
    }

    let result = "```workman\n" + typeStr + "\n```";
    // If the type is a Result, append an error summary grouped by ADT
    try {
      const resolved = this.substituteTypeWithLayer3(
        (view.finalType.kind === "unknown" && view.finalType.type)
          ? view.finalType.type
          : (view.finalType as any).type ?? (view as any),
        layer3,
      );
      const t = (view.finalType.kind === "concrete")
        ? view.finalType.type
        : resolved;
      const summary = this.summarizeErrorRowFromType(t, adtEnv ?? new Map());
      if (summary) {
        result += `\n\nErrors: ${summary}`;
      }
    } catch {}

    if (coverage) {
      const rowStr = formatScheme({ quantifiers: [], type: coverage.row });
      const handled = [...coverage.coveredConstructors];
      if (coverage.coversTail) {
        handled.push("_");
      }
      const handledLabel = handled.length > 0 ? handled.join(", ") : "(none)";
      if (coverage.missingConstructors.length === 0) {
        if (coverage.dischargesResult) {
          result +=
            `\n\n⚡ Discharges Err row ${rowStr}; constructors: ${handledLabel}`;
        } else {
          result +=
            `\n\n⚠️ Err row ${rowStr} still infectious (handled: ${handledLabel})`;
        }
      } else {
        const missingLabel = coverage.missingConstructors.join(", ");
        result +=
          `\n\n⚠️ Missing Err constructors ${missingLabel} for row ${rowStr} (handled: ${handledLabel})`;
      }
    }

    // Check if this node references a hole with solution information
    const holeSolutions = layer3.holeSolutions;
    if (
      holeSolutions && view.finalType.kind === "unknown" && view.finalType.type
    ) {
      // Extract the actual hole ID from the type
      const holeId = this.extractHoleIdFromType(view.finalType.type);
      if (holeId !== undefined) {
        const solution = holeSolutions.get(holeId);
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
              result += `- Known: \`${
                typeToString(solution.partial.known)
              }\`\n`;
            }
            if (
              solution.partial.possibilities &&
              solution.partial.possibilities.length > 0
            ) {
              result +=
                `- Possibilities: ${solution.partial.possibilities.length}\n`;
              // Show first few possibilities
              const maxShow = 3;
              for (
                let i = 0;
                i < Math.min(maxShow, solution.partial.possibilities.length);
                i++
              ) {
                result += `  - \`${
                  typeToString(solution.partial.possibilities[i])
                }\`\n`;
              }
              if (solution.partial.possibilities.length > maxShow) {
                result += `  - ... and ${
                  solution.partial.possibilities.length - maxShow
                } more\n`;
              }
            }
            result +=
              "\n_Some type information is inferred, but not everything is known yet._";
          } else if (solution.state === "conflicted" && solution.conflicts) {
            result += "\n\n**⚠️ Type Conflict Detected:**\n";
            for (const conflict of solution.conflicts) {
              const types = conflict.types.map((t: any) => typeToString(t))
                .join(" vs ");
              result += `- Conflicting types: \`${types}\`\n`;
              result += `- Reason: ${conflict.reason}\n`;
            }
            result += "\n_This type hole has incompatible constraints._";
          } else if (solution.state === "unsolved") {
            result += "\n\n_Type is not fully determined yet._";
          }
        }
      }
    }

    return result;
  }

  private partialTypeToString(
    partial: PartialType,
    layer3: Layer3Result,
  ): string | null {
    switch (partial.kind) {
      case "unknown": {
        if (!partial.type) return "?";
        const substituted = this.substituteTypeWithLayer3(
          partial.type,
          layer3,
        );
        return substituted ? typeToString(substituted) : "?";
      }
      case "concrete":
        return partial.type
          ? typeToString(this.substituteTypeWithLayer3(partial.type, layer3))
          : null;
      default:
        return null;
    }
  }

  /**
   * Extract hole ID from a Type object.
   * This handles error provenances that wrap the actual hole.
   */
  private extractHoleIdFromType(type: Type): number | undefined {
    if (!isHoleType(type)) {
      return undefined;
    }

    const prov = getProvenance(type);
    if (!prov) return undefined;

    if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
      return (prov as Record<string, unknown>).id as number;
    } else if (prov.kind === "incomplete") {
      return (prov as Record<string, unknown>).nodeId as number;
    } else if (
      prov.kind === "error_not_function" || prov.kind === "error_inconsistent"
    ) {
      // Unwrap error provenance to get the underlying hole
      const calleeType = (prov as Record<string, unknown>).calleeType ||
        (prov as Record<string, unknown>).actual;
      if (calleeType && isHoleType(calleeType as Type)) {
        return this.extractHoleIdFromType(calleeType as Type);
      }
    }

    return undefined;
  }

  /**
   * Extract hole ID from a type scheme that contains an unknown type.
   * This handles error provenances that wrap the actual hole.
   */
  private extractHoleId(scheme: TypeScheme): number | undefined {
    return this.extractHoleIdFromType(scheme.type);
  }

  /**
   * Format a type scheme with Layer 3 partial type information if available.
   * This matches the CLI behavior in wm.ts but without the (partial) suffix.
   */
  private formatSchemeWithPartials(
    scheme: TypeScheme,
    layer3: Layer3Result,
  ): string {
    const substitutedScheme = this.applyHoleSolutionsToScheme(
      scheme,
      layer3,
    );
    let typeStr = formatScheme(substitutedScheme);

    // Check if this binding has partial type information from Layer 3
    const holeId = this.extractHoleId(scheme);
    if (holeId !== undefined) {
      const solution = layer3.holeSolutions.get(holeId);
      if (solution?.state === "partial" && solution.partial?.known) {
        // Show the partial type instead of error provenance (without suffix)
        typeStr = formatScheme({
          quantifiers: substitutedScheme.quantifiers,
          type: this.substituteTypeWithLayer3(
            solution.partial.known,
            layer3,
          ),
        });
      } else if (solution?.state === "conflicted" && solution.conflicts) {
        // Show conflict information
        typeStr = `? (conflicted: ${solution.conflicts.length} conflicts)`;
      } else {
        // For unsolved holes, just show "?" without error provenance
        typeStr = typeStr.replace(/\?\([^)]+\)/g, "?");
      }
    }

    return typeStr;
  }

  private applyHoleSolutionsToScheme(
    scheme: TypeScheme,
    layer3: Layer3Result,
  ): TypeScheme {
    const substitutedType = this.substituteTypeWithLayer3(scheme.type, layer3);
    if (substitutedType === scheme.type) {
      return scheme;
    }
    return {
      quantifiers: scheme.quantifiers,
      type: substitutedType,
    };
  }

  private substituteTypeWithLayer3(type: Type, layer3: Layer3Result): Type {
    switch (type.kind) {
      case "func": {
        const from = this.substituteTypeWithLayer3(type.from, layer3);
        const to = this.substituteTypeWithLayer3(type.to, layer3);
        if (from === type.from && to === type.to) {
          return type;
        }
        return { kind: "func", from, to };
      }
      case "constructor": {
        let changed = false;
        const args = type.args.map((arg) => {
          const substituted = this.substituteTypeWithLayer3(arg, layer3);
          if (substituted !== arg) {
            changed = true;
          }
          return substituted;
        });
        if (!changed) {
          return type;
        }
        return { kind: "constructor", name: type.name, args };
      }
      case "tuple": {
        let changed = false;
        const elements = type.elements.map((el) => {
          const substituted = this.substituteTypeWithLayer3(el, layer3);
          if (substituted !== el) {
            changed = true;
          }
          return substituted;
        });
        if (!changed) {
          return type;
        }
        return { kind: "tuple", elements };
      }
      case "record": {
        let changed = false;
        const fields = new Map<string, Type>();
        for (const [key, fieldType] of type.fields.entries()) {
          const substituted = this.substituteTypeWithLayer3(fieldType, layer3);
          if (substituted !== fieldType) {
            changed = true;
          }
          fields.set(key, substituted);
        }
        if (!changed) {
          return type;
        }
        return { kind: "record", fields };
      }
      default:
        // Handle holes via carrier check
        if (isHoleType(type)) {
          const resolved = this.resolveUnknownType(type, layer3);
          return resolved ?? type;
        }
        return type;
    }
  }

  private resolveUnknownType(
    type: Type,
    layer3: Layer3Result,
  ): Type | null {
    if (!isHoleType(type)) {
      return type;
    }
    const prov = getProvenance(type);
    if (prov?.kind === "error_inconsistent") {
      const expected = (prov as Record<string, unknown>).expected as
        | Type
        | undefined;
      if (expected) {
        return this.substituteTypeWithLayer3(expected, layer3);
      }
    }
    const holeId = this.extractHoleIdFromType(type);
    if (holeId !== undefined) {
      const solution = layer3.holeSolutions.get(holeId);
      if (solution?.state === "partial" && solution.partial?.known) {
        return this.substituteTypeWithLayer3(solution.partial.known, layer3);
      }
    }
    return null;
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
        try {
          const sourceOverrides = new Map([[entryPath, text]]);
          context = await this.buildModuleContext(
            entryPath,
            stdRoots,
            this.preludeModule,
            sourceOverrides,
          );
          this.moduleContexts.set(uri, context);
        } catch (error) {
          this.log(`[LSP] Failed to build module context for hover: ${error}`);
          return { jsonrpc: "2.0", id: message.id, result: null };
        }
      }
      const { layer3, env } = context;
      const offset = this.positionToOffset(text, position);
      const nodeId = findNodeAtOffset(layer3.spanIndex, offset);
      if (nodeId) {
        const view = layer3.nodeViews.get(nodeId);
        if (view) {
          const coverage = layer3.matchCoverages.get(nodeId);
          const rendered = this.renderNodeView(
            view,
            layer3,
            coverage,
            context.adtEnv,
          );
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
        // Use Layer 3 partial types for accurate display
        const typeStr = this.formatSchemeWithPartials(scheme, layer3);
        this.log(`[LSP] Found type for ${word}: ${typeStr}`);

        const hoverText = `\`\`\`workman\n${word} : ${typeStr}\n\`\`\``;

        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: {
              kind: "markdown",
              value: hoverText,
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
        try {
          const sourceOverrides = new Map([[entryPath, text]]);
          context = await this.buildModuleContext(
            entryPath,
            stdRoots,
            this.preludeModule,
            sourceOverrides,
          );
          this.moduleContexts.set(uri, context);
        } catch (error) {
          this.log(
            `[LSP] Failed to build module context for completion: ${error}`,
          );
          return { jsonrpc: "2.0", id: message.id, result: null };
        }
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
        try {
          const sourceOverrides = new Map([[entryPath, text]]);
          context = await this.buildModuleContext(
            entryPath,
            stdRoots,
            this.preludeModule,
            sourceOverrides,
          );
          this.moduleContexts.set(uri, context);
        } catch (error) {
          this.log(
            `[LSP] Failed to build module context for inlay hints: ${error}`,
          );
          return { jsonrpc: "2.0", id: message.id, result: [] };
        }
      }
      const { env, layer3 } = context;
      for (const [name, scheme] of env.entries()) {
        if (name.startsWith("__op_") || name.startsWith("__prefix_")) {
          continue;
        }
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(
          `\\blet\\s+(?:rec\\s+)?${escapedName}\\b`,
          "g",
        );
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const endPos = match.index + match[0].length;
          const position = this.offsetToPosition(text, endPos);
          // Use Layer 3 partial types for accurate display
          const typeStr = this.formatSchemeWithPartials(scheme, layer3);
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

  private ensureValidation(uri: string, text: string) {
    // Clear any pending validation timer for this document
    const existingTimer = this.validationTimers.get(uri);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    // Debounce validation by 50ms to avoid excessive work during rapid typing
    const timer = setTimeout(() => {
      this.validationTimers.delete(uri);
      this.runValidation(uri, text);
    }, 50);
    this.validationTimers.set(uri, timer);
  }

  private async runValidation(uri: string, text: string) {
    const existing = this.validationInProgress.get(uri);
    if (existing) {
      await existing;
    }
    const promise = this.validateDocument(uri, text);
    this.validationInProgress.set(uri, promise);
    try {
      await promise;
    } finally {
      this.validationInProgress.delete(uri);
    }
  }

  private async buildModuleContext(
    entryPath: string,
    stdRoots: string[],
    preludeModule?: string,
    sourceOverrides?: Map<string, string>,
  ): Promise<{
    env: Map<string, TypeScheme>;
    layer3: Layer3Result;
    program: MProgram;
    adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>;
    entryPath: string;
  }> {
    const compileResult = await compileWorkmanGraph(entryPath, {
      loader: {
        stdRoots,
        preludeModule,
        skipEvaluation: true,
        sourceOverrides,
      },
    });

    const entryModulePath = compileResult.coreGraph.entry;
    const entryArtifact = compileResult.modules.get(entryModulePath);
    if (!entryArtifact) {
      throw new ModuleLoaderError(
        `Internal error: missing entry module artifacts for '${entryModulePath}'`,
      );
    }

    const layer3 = entryArtifact.analysis.layer3;
    const adtEnv = entryArtifact.analysis.layer1.adtEnv;
    const transformedEnv = new Map<string, TypeScheme>();
    for (const { name, scheme } of layer3.summaries) {
      transformedEnv.set(
        name,
        this.applyHoleSolutionsToScheme(scheme, layer3),
      );
    }

    return {
      env: transformedEnv,
      layer3,
      program: entryArtifact.analysis.layer1.markedProgram,
      adtEnv,
      entryPath: entryModulePath,
    };
  }

  private summarizeErrorRowFromType(
    type: Type | undefined,
    adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>,
  ): string | null {
    if (!type) return null;
    if (
      type.kind !== "constructor" || type.name !== "Result" ||
      type.args.length !== 2
    ) return null;
    const errArg = type.args[1];
    const ensureRow = (t: Type): import("../../../src//types.ts").ErrorRowType => (
      t.kind === "error_row"
        ? t
        : { kind: "error_row", cases: new Map(), tail: t }
    );
    const row = ensureRow(errArg);
    const caseLabels = new Set<string>(Array.from(row.cases.keys()));
    const fullAdts = new Set<string>();
    if (row.tail && row.tail.kind === "constructor") {
      fullAdts.add(row.tail.name);
    }
    for (const [adtName, info] of adtEnv.entries()) {
      let allCovered = true;
      for (const ctor of info.constructors) {
        if (!caseLabels.has(ctor.name)) {
          allCovered = false;
          break;
        }
      }
      if (allCovered) {
        fullAdts.add(adtName);
        for (const ctor of info.constructors) caseLabels.delete(ctor.name);
      }
    }
    const parts: string[] = [];
    for (const adt of fullAdts) parts.push(adt);
    for (const lbl of caseLabels) parts.push(lbl);
    if (parts.length === 0) return null;
    return parts.join(" | ");
  }

  private uriToFsPath(uri: string): string {
    try {
      if (uri.startsWith("file:")) {
        const fsPath = fromFileUrl(uri);
        // Normalize the path the same way the module loader does (resolveEntryPath)
        const normalized = isAbsolute(fsPath) ? fsPath : resolve(fsPath);
        return this.ensureWmExtension(normalized);
      }
    } catch {
      // Ignore errors
    }
    // Fallback: assume it's a normal path and normalize it
    const normalized = isAbsolute(uri) ? uri : resolve(uri);
    return this.ensureWmExtension(normalized);
  }

  private ensureWmExtension(path: string): string {
    if (path.endsWith(".wm")) {
      return path;
    }
    return `${path}.wm`;
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

  private findTopLevelLet(
    program: MProgram,
    name: string,
  ): MLetDeclaration | undefined {
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
        `[LSP] Failed to read prelude '${preludePath}': ${
          error instanceof Error ? error.message : error
        }'`,
      );
      return emptyResult;
    }

    let program;
    try {
      const tokens = lex(source, preludePath);
      program = parseSurfaceProgram(tokens, source);
    } catch (error) {
      this.log(
        `[LSP] Failed to parse prelude '${preludePath}': ${
          error instanceof Error ? error.message : error
        }'`,
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

// Start the server
if (import.meta.main) {
  const server = new WorkmanLanguageServer();
  await server.start();
}
