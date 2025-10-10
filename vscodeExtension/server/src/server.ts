#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

import { lex } from "@workman/lexer.ts";
import { parseSurfaceProgram, ParseError } from "@workman/parser.ts";
import { inferProgram, InferError } from "@workman/infer.ts";
import { formatScheme } from "@workman/type_printer.ts";

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
        return this.handleHover(message);
      
      case "textDocument/inlayHint":
        return this.handleInlayHint(message);
      
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
    
    try {
      const tokens = lex(text);
      this.log(`[LSP] Lexed ${tokens.length} tokens`);
      
      const program = parseSurfaceProgram(tokens);
      this.log(`[LSP] Parsed ${program.declarations.length} declarations`);
      
      const result = inferProgram(program);
      this.log(`[LSP] Type check OK: ${result.summaries.length} bindings`);
    } catch (error) {
      this.log(`[LSP] Validation error: ${error}`);
      
      if (error instanceof ParseError) {
        const position = this.offsetToPosition(text, error.token.start);
        const endPos = this.offsetToPosition(text, error.token.start + error.token.value.length);
        diagnostics.push({
          range: {
            start: position,
            end: endPos,
          },
          severity: 1, // Error
          message: error.message,
          source: "workman-parser",
          code: "parse-error"
        });
      } else if (error instanceof InferError) {
        // Try to extract identifier from error message for better positioning
        const errorMsg = error.message;
        let range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
        
        // Try to find the identifier mentioned in the error
        const identMatch = errorMsg.match(/['"](\w+)['"]/);
        if (identMatch) {
          const ident = identMatch[1];
          const identPos = text.indexOf(ident);
          if (identPos !== -1) {
            const start = this.offsetToPosition(text, identPos);
            const end = this.offsetToPosition(text, identPos + ident.length);
            range = { start, end };
          }
        }
        
        diagnostics.push({
          range,
          severity: 1, // Error
          message: errorMsg,
          source: "workman-typechecker",
          code: "type-error"
        });
      } else {
        // Unknown error
        diagnostics.push({
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 1, // Error
          message: `Internal error: ${error}`,
          source: "workman",
          code: "internal-error"
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

  private handleHover(message: LSPMessage): LSPMessage {
    const { textDocument, position } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);
    
    this.log(`[LSP] Hover at line ${position.line}, char ${position.character}`);
    
    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
    
    try {
      const tokens = lex(text);
      const program = parseSurfaceProgram(tokens);
      const result = inferProgram(program);
      
      // Find binding at position
      const offset = this.positionToOffset(text, position);
      const word = this.getWordAtOffset(text, offset);
      
      this.log(`[LSP] Word at cursor: '${word}'`);
      
      for (const { name, scheme } of result.summaries) {
        if (name === word) {
          const typeStr = formatScheme(scheme);
          this.log(`[LSP] Found type for ${name}: ${typeStr}`);
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contents: {
                kind: "markdown",
                value: `\`\`\`workman\n${name} : ${typeStr}\n\`\`\``,
              },
            },
          };
        }
      }
      
      this.log(`[LSP] No type found for '${word}'`);
    } catch (error) {
      this.log(`[LSP] Hover error: ${error}`);
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
    
    return { jsonrpc: "2.0", id: message.id, result: null };
  }

  private handleInlayHint(message: LSPMessage): LSPMessage {
    const { textDocument } = message.params;
    const uri = textDocument.uri;
    const text = this.documents.get(uri);
    
    if (!text) {
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }
    
    const hints: any[] = [];
    
    try {
      const tokens = lex(text);
      const program = parseSurfaceProgram(tokens);
      const result = inferProgram(program);
      
      // Add type hints for each let binding
      for (const { name, scheme } of result.summaries) {
        const typeStr = formatScheme(scheme);
        
        // Find the position right after "let [rec] name"
        const regex = new RegExp(`let\\s+(rec\\s+)?${name}\\b`, "g");
        let match;
        
        while ((match = regex.exec(text)) !== null) {
          const endPos = match.index + match[0].length;
          const position = this.offsetToPosition(text, endPos);
          
          hints.push({
            position,
            label: `: ${typeStr}`,
            kind: 1, // Type
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
}

// Start the server
if (import.meta.main) {
  const server = new WorkmanLanguageServer();
  await server.start();
}
