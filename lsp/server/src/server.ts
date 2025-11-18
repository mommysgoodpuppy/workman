#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

// Redirect console.log to stderr to prevent polluting LSP stdout with debug messages
console.log = console.error;

import { formatScheme } from "../../../src//type_printer.ts";
import {
  getProvenance,
  isHoleType,
  type Type,
  type TypeScheme,
  typeToString,
} from "../../../src//types.ts";
import { type Layer3Result } from "../../../src//layer3/mod.ts";
import type {
  WorkmanModuleArtifacts,
} from "../../../backends/compiler/frontends/workman.ts";
import type { ModuleGraph } from "../../../src//module_loader.ts";
import type {
  MBlockExpr,
  MExpr,
  MLetDeclaration,
  MMatchBundle,
  MProgram,
  MTopLevel,
} from "../../../src//ast_marked.ts";
import type { ConstructorAlias, TypeDeclaration } from "../../../src//ast.ts";
import { handleMessage } from "./handlers.ts";
import { writeMessage } from "./stdio.ts";
import { ensureValidation } from "./validate.ts";
import {
  concatBuffers,
  extractContentLength,
  findHeaderBoundary,
  offsetToPosition,
} from "./util.ts";
import { pathToUri } from "./fsio.ts";
import { buildModuleContext } from "./modulecontext.ts";

export interface LSPMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export class WorkmanLanguageServer {
  documents = new Map<string, string>();
  diagnostics = new Map<string, any[]>();
  writeLock = false;
  writeQueue: Array<() => Promise<void>> = [];
  workspaceRoots: string[] = [];
  initStdRoots: string[] | undefined = undefined;
  preludeModule: string | undefined = undefined;
  moduleContexts = new Map<
    string,
    {
      env: Map<string, TypeScheme>;
      layer3: Layer3Result;
      program: MProgram;
      adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>;
      entryPath: string;
      graph: ModuleGraph;
      modules: ReadonlyMap<string, WorkmanModuleArtifacts>;
    }
  >();
  validationInProgress = new Map<string, Promise<void>>();
  validationTimers = new Map<string, number>();

  private handleMessage(message: LSPMessage): Promise<LSPMessage | null> {
    return handleMessage(this, message);
  }

  private writeMessage(message: any) {
    return writeMessage(this, message);
  }

  ensureValidation(uri: string, text: string) {
    return ensureValidation(this, uri, text);
  }

  buildModuleContext(
    entryPath: string,
    stdRoots: string[],
    preludeModule?: string,
    sourceOverrides?: Map<string, string>,
  ) {
    return buildModuleContext(this, entryPath, stdRoots, preludeModule, sourceOverrides);
  }

  log(message: string) {
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

  // Replace top-level IResult<A, B> occurrences with a prettier form.
  // Handles nested angle brackets, braces, parens and quoted strings so that
  // commas inside nested types (like records) don't break the split.
  replaceIResultFormats(input: string): string {
    if (!input || input.indexOf("IResult<") === -1) return input;
    let out = "";
    let idx = 0;
    const needle = "IResult<";
    while (true) {
      const pos = input.indexOf(needle, idx);
      if (pos === -1) {
        out += input.slice(idx);
        break;
      }
      out += input.slice(idx, pos);
      let i = pos + needle.length;

      // Stack to track nested delimiters. Start with the initial '<'.
      const stack: string[] = ["<"];
      let commaIndex = -1;
      let foundClosing = false;

      for (; i < input.length; i++) {
        const ch = input[i];
        if (ch === "<" || ch === "{" || ch === "(" || ch === "[") {
          stack.push(ch);
        } else if (ch === ">") {
          if (stack.length > 0 && stack[stack.length - 1] === "<") {
            stack.pop();
            if (stack.length === 0) {
              foundClosing = true;
              break;
            }
          } else {
            // attempt to recover
            stack.pop();
          }
        } else if (ch === "}") {
          if (stack.length > 0 && stack[stack.length - 1] === "{") stack.pop();
        } else if (ch === ")") {
          if (stack.length > 0 && stack[stack.length - 1] === "(") stack.pop();
        } else if (ch === "]") {
          if (stack.length > 0 && stack[stack.length - 1] === "[") stack.pop();
        } else if (ch === ",") {
          // top-level comma separating IResult args when only the initial '<' remains
          if (stack.length === 1 && commaIndex === -1) {
            commaIndex = i;
          }
        } else if (ch === '"' || ch === "'") {
          // skip quoted strings
          const quote = ch;
          i++;
          while (i < input.length && input[i] !== quote) {
            if (input[i] === "\\") i++; // skip escaped char
            i++;
          }
        }
      }

      if (!foundClosing) {
        // Couldn't parse properly; copy remainder and bail
        out += input.slice(pos);
        break;
      }

      if (commaIndex === -1) {
        // No top-level comma found; copy matched region as-is
        out += input.slice(pos, i + 1);
        idx = i + 1;
        continue;
      }

      const first = input.slice(pos + needle.length, commaIndex).trim();
      const second = input.slice(commaIndex + 1, i).trim();

      // Desired display: ⚡<first>, <second>
      out += `⚡${first} (${second})`;

      idx = i + 1;
    }
    return out;
  }

  async start() {
    this.log("[LSP] Workman Language Server starting...");

    const decoder = new TextDecoder();
    let buffer = new Uint8Array(0);

    for await (const chunk of Deno.stdin.readable) {
      //@ts-expect-error deno bug
      buffer = concatBuffers(buffer, chunk);

      while (true) {
        const headerEnd = findHeaderBoundary(buffer);
        if (headerEnd === -1) break;

        const headerBytes = buffer.slice(0, headerEnd);
        const header = decoder.decode(headerBytes);
        const contentLength = extractContentLength(header);

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

  async sendNotification(method: string, params: any) {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    await this.writeMessage(notification);
  }

  /**
   * Extract hole ID from a Type object.
   * This handles error provenances that wrap the actual hole.
   */
  extractHoleIdFromType(type: Type): number | undefined {
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
  extractHoleId(scheme: TypeScheme): number | undefined {
    return this.extractHoleIdFromType(scheme.type);
  }

  /**
   * Format a type scheme with Layer 3 partial type information if available.
   * This matches the CLI behavior in wm.ts but without the (partial) suffix.
   */
  formatSchemeWithPartials(
    scheme: TypeScheme,
    layer3: Layer3Result,
    adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>,
  ): string {
    const substitutedScheme = this.applyHoleSolutionsToScheme(
      scheme,
      layer3,
    );
    let typeStr = formatScheme(substitutedScheme);

    // Post-process to format Result types using a robust replacer
    typeStr = this.replaceIResultFormats(typeStr);

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

    // Check for infected Result types in return type
    let returnType = substitutedScheme.type;
    while (returnType.kind === "func") {
      returnType = returnType.to;
    }
    const summary = this.summarizeEffectRowFromType(returnType, adtEnv);
    if (
      summary && returnType && returnType.kind === "constructor" &&
      returnType.args.length > 0
    ) {
      // Replace the IResult<...> in typeStr with the formatted version
      const fullResultStr = typeToString(returnType);
      const formatted = `⚡${typeToString(returnType.args[0])} <${summary}>`;
      typeStr = typeStr.replace(fullResultStr, formatted);
    }

    return typeStr;
  }

  applyHoleSolutionsToScheme(
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

  substituteTypeWithLayer3(type: Type, layer3: Layer3Result): Type {
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

  resolveUnknownType(
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

  summarizeEffectRowFromType(
    type: Type | undefined,
    adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>,
  ): string | null {
    if (!type) return null;
    if (
      type.kind !== "constructor" ||
      type.args.length !== 2
    ) return null;
    const errArg = type.args[1];
    const ensureRow = (
      t: Type,
    ): import("../../../src//types.ts").EffectRowType => (
      t.kind === "effect_row"
        ? t
        : { kind: "effect_row", cases: new Map(), tail: t }
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

  findTopLevelLet(
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

  findTypeDeclaration(
    program: MProgram,
    name: string,
  ): TypeDeclaration | undefined {
    for (const decl of program.declarations ?? []) {
      if (decl.kind === "type" && decl.node.name === name) {
        return decl.node;
      }
    }
    return undefined;
  }

  findConstructorDeclaration(
    program: MProgram,
    name: string,
  ): { declaration: TypeDeclaration; member: ConstructorAlias } | undefined {
    for (const decl of program.declarations ?? []) {
      if (decl.kind !== "type") continue;
      for (const member of decl.node.members) {
        if (member.kind === "constructor" && member.name === name) {
          return { declaration: decl.node, member };
        }
      }
    }
    return undefined;
  }

  findModuleDefinitionLocations(
    modulePath: string,
    name: string,
    modules: ReadonlyMap<string, WorkmanModuleArtifacts>,
  ): Array<{
    uri: string;
    span: { start: number; end: number };
    sourceText: string;
  }> {
    const artifact = modules.get(modulePath);
    if (!artifact) {
      return [];
    }
    return this.collectDefinitionLocationsFromArtifact(
      artifact,
      modulePath,
      name,
    );
  }

  findGlobalDefinitionLocations(
    name: string,
    modules: ReadonlyMap<string, WorkmanModuleArtifacts>,
  ): Array<{
    uri: string;
    span: { start: number; end: number };
    sourceText: string;
  }> {
    const results: Array<{
      uri: string;
      span: { start: number; end: number };
      sourceText: string;
    }> = [];
    for (const [modulePath, artifact] of modules.entries()) {
      results.push(
        ...this.collectDefinitionLocationsFromArtifact(
          artifact,
          modulePath,
          name,
        ),
      );
    }
    return results;
  }

  collectDefinitionLocationsFromArtifact(
    artifact: WorkmanModuleArtifacts,
    modulePath: string,
    name: string,
  ): Array<{
    uri: string;
    span: { start: number; end: number };
    sourceText: string;
  }> {
    const results: Array<{
      uri: string;
      span: { start: number; end: number };
      sourceText: string;
    }> = [];
    const program = artifact.analysis.layer1.markedProgram;
    const layer3 = artifact.analysis.layer3;
    const sourceText = artifact.node.source;
    const uri = pathToUri(modulePath);
    const pushSpan = (span: { start: number; end: number }) => {
      results.push({
        uri,
        span,
        sourceText,
      });
    };

    const letDecl = this.findTopLevelLet(program, name);
    if (letDecl) {
      const span = layer3.spanIndex.get(letDecl.id);
      if (span) {
        pushSpan(span);
      }
    }

    const typeDecl = this.findTypeDeclaration(program, name);
    if (typeDecl) {
      pushSpan(typeDecl.span);
    }

    const ctorDecl = this.findConstructorDeclaration(program, name);
    if (ctorDecl) {
      pushSpan(ctorDecl.member.span);
    }

    return results;
  }

  collectIdentifierReferences(
    program: MProgram,
    name: string,
  ): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    const visitedDecls = new Set<number>();

    const visitExpr = (expr?: MExpr): void => {
      if (!expr) return;
      switch (expr.kind) {
        case "identifier":
          if (expr.name === name) {
            spans.push(expr.span);
          }
          break;
        case "constructor":
          for (const arg of expr.args) visitExpr(arg);
          break;
        case "tuple":
          for (const element of expr.elements) visitExpr(element);
          break;
        case "record_literal":
          for (const field of expr.fields) visitExpr(field.value);
          break;
        case "call":
          visitExpr(expr.callee);
          for (const arg of expr.arguments) visitExpr(arg);
          break;
        case "record_projection":
          visitExpr(expr.target);
          break;
        case "binary":
          visitExpr(expr.left);
          visitExpr(expr.right);
          break;
        case "unary":
          visitExpr(expr.operand);
          break;
        case "arrow":
          visitBlock(expr.body);
          break;
        case "block":
          visitBlock(expr);
          break;
        case "match":
          visitExpr(expr.scrutinee);
          visitMatchBundle(expr.bundle);
          break;
        case "match_fn":
          for (const param of expr.parameters) {
            visitExpr(param);
          }
          visitMatchBundle(expr.bundle);
          break;
        case "match_bundle_literal":
          visitMatchBundle(expr.bundle);
          break;
        case "mark_free_var":
          if (expr.name === name) {
            spans.push(expr.span);
          }
          break;
        case "mark_not_function":
          visitExpr(expr.callee);
          for (const arg of expr.args) visitExpr(arg);
          break;
        case "mark_occurs_check":
          visitExpr(expr.subject);
          break;
        case "mark_inconsistent":
        case "mark_unfillable_hole":
          visitExpr(expr.subject);
          break;
        default:
          break;
      }
    };

    const visitMatchBundle = (bundle: MMatchBundle): void => {
      for (const arm of bundle.arms) {
        if (arm.kind === "match_pattern") {
          visitExpr(arm.body);
        }
      }
    };

    const visitBlock = (block?: MBlockExpr): void => {
      if (!block) return;
      for (const stmt of block.statements) {
        if (stmt.kind === "let_statement") {
          visitLet(stmt.declaration);
        } else if (stmt.kind === "expr_statement") {
          visitExpr(stmt.expression);
        }
      }
      if (block.result) {
        visitExpr(block.result);
      }
    };

    const visitLet = (decl: MLetDeclaration): void => {
      if (visitedDecls.has(decl.id)) {
        return;
      }
      visitedDecls.add(decl.id);
      visitBlock(decl.body);
      if (decl.mutualBindings) {
        for (const binding of decl.mutualBindings) {
          visitLet(binding);
        }
      }
    };

    for (const decl of program.declarations ?? []) {
      if (decl.kind === "let") {
        visitLet(decl);
      }
    }

    return spans;
  }

  findLetDeclaration(
    program: MProgram,
    layer3: Layer3Result,
    name: string,
    offset: number,
  ): MLetDeclaration | undefined {
    const findInTopLevels = (
      decls: MTopLevel[],
    ): MLetDeclaration | undefined => {
      for (const decl of decls) {
        if (decl.kind === "let") {
          const span = layer3.spanIndex.get(decl.id);
          if (span && span.start <= offset && offset < span.end) {
            if (decl.name === name) return decl;
            if (decl.mutualBindings) {
              for (const b of decl.mutualBindings) {
                if (b.name === name) return b;
              }
            }
            // recurse into body
            const found = findInBlock(decl.body);
            if (found) return found;
          }
        }
      }
      return undefined;
    };

    const findInBlock = (block: MBlockExpr): MLetDeclaration | undefined => {
      for (const stmt of block.statements) {
        if (stmt.kind === "let_statement") {
          const decl = stmt.declaration;
          const span = layer3.spanIndex.get(decl.id);
          if (span && span.start <= offset && offset < span.end) {
            if (decl.name === name) return decl;
            if (decl.mutualBindings) {
              for (const b of decl.mutualBindings) {
                if (b.name === name) return b;
              }
            }
            const found = findInBlock(decl.body);
            if (found) return found;
          }
        } else if (stmt.kind === "expr_statement") {
          const found = findInExpr(stmt.expression);
          if (found) return found;
        }
      }
      if (block.result) {
        const found = findInExpr(block.result);
        if (found) return found;
      }
      return undefined;
    };

    const findInExpr = (expr: MExpr): MLetDeclaration | undefined => {
      switch (expr.kind) {
        case "block":
          return findInBlock(expr);
        case "call": {
          let found = findInExpr(expr.callee);
          if (found) return found;
          for (const arg of expr.arguments) {
            found = findInExpr(arg);
            if (found) return found;
          }
          break;
        }
        case "match": {
          let found = findInExpr(expr.scrutinee);
          if (found) return found;
          for (const arm of expr.bundle.arms) {
            if (arm.kind === "match_pattern") {
              found = findInExpr(arm.body);
              if (found) return found;
            }
          }
          break;
        }
        case "tuple":
          for (const el of expr.elements) {
            const found = findInExpr(el);
            if (found) return found;
          }
          break;
        case "record_literal":
          for (const field of expr.fields) {
            const found = findInExpr(field.value);
            if (found) return found;
          }
          break;
        case "record_projection":
          return findInExpr(expr.target);
        case "constructor":
          for (const arg of expr.args) {
            const found = findInExpr(arg);
            if (found) return found;
          }
          break;
        // add more cases as needed
        default:
          break;
      }
      return undefined;
    };

    return findInTopLevels(program.declarations ?? []);
  }

  findNearestLetBeforeOffset(
    program: MProgram,
    layer3: Layer3Result,
    name: string,
    offset: number,
  ): MLetDeclaration | undefined {
    let best:
      | { decl: MLetDeclaration; spanStart: number }
      | undefined;

    const considerDecl = (decl: MLetDeclaration | undefined) => {
      if (!decl || decl.name !== name) {
        return;
      }
      const span = layer3.spanIndex.get(decl.id);
      if (!span || span.start > offset) {
        return;
      }
      if (!best || span.start >= best.spanStart) {
        best = { decl, spanStart: span.start };
      }
    };

    const visitTopLevels = (decls: MTopLevel[]) => {
      for (const decl of decls) {
        if (decl.kind === "let") {
          considerDecl(decl);
          if (decl.mutualBindings) {
            for (const binding of decl.mutualBindings) {
              considerDecl(binding);
              visitBlock(binding.body);
            }
          }
          visitBlock(decl.body);
        }
      }
    };

    const visitBlock = (block?: MBlockExpr) => {
      if (!block) return;
      for (const stmt of block.statements) {
        if (stmt.kind === "let_statement") {
          const decl = stmt.declaration;
          considerDecl(decl);
          if (decl.mutualBindings) {
            for (const binding of decl.mutualBindings) {
              considerDecl(binding);
              visitBlock(binding.body);
            }
          }
          visitBlock(decl.body);
        } else if (stmt.kind === "expr_statement") {
          visitExpr(stmt.expression);
        }
      }
      if (block.result) {
        visitExpr(block.result);
      }
    };

    const visitExpr = (expr: MExpr) => {
      switch (expr.kind) {
        case "block":
          visitBlock(expr);
          break;
        case "arrow":
          visitBlock(expr.body);
          break;
        case "call":
          visitExpr(expr.callee);
          for (const arg of expr.arguments) {
            visitExpr(arg);
          }
          break;
        case "constructor":
          for (const arg of expr.args) {
            visitExpr(arg);
          }
          break;
        case "tuple":
          for (const element of expr.elements) {
            visitExpr(element);
          }
          break;
        case "record_literal":
          for (const field of expr.fields) {
            visitExpr(field.value);
          }
          break;
        case "record_projection":
          visitExpr(expr.target);
          break;
        case "binary":
          visitExpr(expr.left);
          visitExpr(expr.right);
          break;
        case "unary":
          visitExpr(expr.operand);
          break;
        case "match":
          visitExpr(expr.scrutinee);
          visitMatchBundle(expr.bundle);
          break;
        case "match_fn":
          for (const param of expr.parameters) {
            visitExpr(param);
          }
          visitMatchBundle(expr.bundle);
          break;
        case "match_bundle_literal":
          visitMatchBundle(expr.bundle);
          break;
        default:
          break;
      }
    };

    const visitMatchBundle = (bundle: MMatchBundle) => {
      for (const arm of bundle.arms) {
        if (arm.kind === "match_pattern") {
          visitExpr(arm.body);
        }
      }
    };

    visitTopLevels(program.declarations ?? []);

    return best?.decl;
  }

  estimateRangeFromMessage(text: string, msg: string) {
    // Check for line and column in "at line X, column Y" format (e.g., Parse Error at line 100, column 7)
    const locationMatch = msg.match(/at line (\d+),\s*column (\d+)/i);
    if (locationMatch) {
      const line = parseInt(locationMatch[1], 10) - 1; // Convert to 0-indexed
      const column = parseInt(locationMatch[2], 10); // 0-indexed already in the match
      // Estimate end position by looking at the character or next few locations
      // For simplicity, highlight from the specified column for 1 character,
      // or find the end of the line/token if possible
      const start = { line, character: Math.max(0, column) };
      const end = { line, character: Math.max(1, column + 1) };
      return { start, end };
    }

    // Fallback to quoted strings in the message
    const quoted = Array.from(msg.matchAll(/["']([^"']+)["']/g)).map((m) =>
      m[1]
    );
    for (const q of quoted) {
      const idx = text.indexOf(q);
      if (idx !== -1) {
        const start = offsetToPosition(text, idx);
        const end = offsetToPosition(text, idx + q.length);
        return { start, end };
      }
    }

    // Default range at the beginning of the document
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  }
}

// Start the server
export async function startWorkmanLanguageServer(): Promise<void> {
  const server = new WorkmanLanguageServer();
  await server.start();
}

if (import.meta.main) {
  await startWorkmanLanguageServer();
}
