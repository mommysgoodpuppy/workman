#!/usr/bin/env -S deno run --allow-all

/**
 * Workman Language Server
 * Provides type inference, diagnostics, and hover information for .wm files
 */

// Redirect console.log to stderr to prevent polluting LSP stdout with debug messages
console.log = console.error;

import { formatType } from "../../../src//type_printer.ts";
import {
  getCarrierRegistrySize,
  getProvenance,
  ensureRow,
  isHoleType,
  splitCarrier,
  type Type,
  type TypeScheme,
} from "../../../src/types.ts";
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
      adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>;
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
    tolerantParsing: boolean = false,
  ) {
    return buildModuleContext(
      this,
      entryPath,
      stdRoots,
      preludeModule,
      sourceOverrides,
      tolerantParsing,
    );
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
  replaceIResultFormats(
    input: string,
    options: { showState?: boolean } = {},
  ): string {
    if (!input || input.indexOf("IResult<") === -1) return input;
    let out = "";
    let idx = 0;
    const needle = "IResult<";
    const showState = options.showState ?? true;
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

      // Desired display: ⚡<first> [<second>]
      out += showState ? `⚡${first} [${second}]` : `⚡${first}`;

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
    adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
  ): string {
    const substitutedScheme = this.applyHoleSolutionsToScheme(
      scheme,
      layer3,
    );
    let renderType = substitutedScheme.type;

    // Check if this binding has partial type information from Layer 3
    const holeId = this.extractHoleId(scheme);
    if (holeId !== undefined) {
      const solution = layer3.holeSolutions.get(holeId);
      if (solution?.state === "partial" && solution.partial?.known) {
        // Show the partial type instead of error provenance (without suffix)
        renderType = this.substituteTypeWithLayer3(
          solution.partial.known,
          layer3,
        );
      } else if (solution?.state === "conflicted" && solution.conflicts) {
        // Show conflict information
        return `? (conflicted: ${solution.conflicts.length} conflicts)`;
      } else {
        // For unsolved holes, just show "?" without error provenance
        renderType = this.substituteTypeWithLayer3(
          substitutedScheme.type,
          layer3,
        );
      }
    }

    const printCtx = { names: new Map(), next: 0 };
    let typeStr = formatTypeWithNominalRecordDetails(
      renderType,
      printCtx,
      adtEnv,
    );
    typeStr = typeStr.replace(/\?\([^)]+\)/g, "?");

    // Check for infected Result types in return type
    let returnType = renderType;
    while (returnType.kind === "func") {
      returnType = returnType.to;
    }
    const summary = this.summarizeEffectRowFromType(returnType, adtEnv);
    if (
      summary && returnType && returnType.kind === "constructor" &&
      returnType.args.length > 0
    ) {
      // Replace the IResult<...> in typeStr with the formatted version
      const ctx = { names: new Map(), next: 0 };
      const fullResultStr = formatType(returnType, ctx, 0);
      const formatted = `⚡${
        formatTypeWithNominalRecordDetails(returnType.args[0], ctx, adtEnv)
      } [<${summary}>]`;
      typeStr = typeStr.replace(fullResultStr, formatted);
    }

    // Post-process to format remaining IResult occurrences
    typeStr = this.replaceIResultFormats(typeStr);

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
    adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
  ): string | null {
    if (!type) return null;
    const carrier = splitCarrier(type);
    if (!carrier || carrier.domain !== "effect") return null;
    const errArg = carrier.state;
    const ensureRow = (
      t: Type,
    ): import("../../../src/types.ts").EffectRowType => (
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
}

const GENERIC_NAMES = ["T", "U", "V", "W", "X", "Y", "Z"];

function nextName(index: number): string {
  const base = GENERIC_NAMES[index % GENERIC_NAMES.length];
  const suffix = Math.floor(index / GENERIC_NAMES.length);
  return suffix === 0 ? base : `${base}${suffix + 1}`;
}

function ensureName(
  context: { names: Map<number, string>; next: number },
  id: number,
): string {
  const existing = context.names.get(id);
  if (existing) {
    return existing;
  }
  const name = nextName(context.next);
  context.names.set(id, name);
  context.next += 1;
  return name;
}

export function formatTypeWithNominalRecordDetails(
  type: Type,
  ctx: { names: Map<number, string>; next: number },
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string {
  return formatTypeWithNominalRecordDetailsInternal(type, ctx, 0, adtEnv);
}

function formatTypeWithNominalRecordDetailsInternal(
  type: Type,
  ctx: { names: Map<number, string>; next: number },
  prec: number,
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string {
  switch (type.kind) {
    case "var":
      return ensureName(ctx, type.id);
    case "func": {
      const left = formatTypeWithNominalRecordDetailsInternal(
        type.from,
        ctx,
        1,
        adtEnv,
      );
      const right = formatTypeWithNominalRecordDetailsInternal(
        type.to,
        ctx,
        0,
        adtEnv,
      );
      const result = `${left} -> ${right}`;
      return prec > 0 ? `(${result})` : result;
    }
    case "constructor": {
      const info = adtEnv.get(type.name);
      if (info && info.alias && info.alias.kind === "record") {
        if (info.parameters.length === 0) {
          return `${type.name}${formatRecordAliasDetails(
            info.alias,
            ctx,
            adtEnv,
          )}`;
        }
      }
      if (type.args.length === 0) {
        return type.name;
      }
      const args = type.args.map((arg) =>
        formatTypeWithNominalRecordDetailsInternal(arg, ctx, 2, adtEnv)
      ).join(", ");
      return `${type.name}<${args}>`;
    }
    case "tuple": {
      const elements = type.elements.map((el) =>
        formatTypeWithNominalRecordDetailsInternal(el, ctx, 0, adtEnv)
      ).join(", ");
      return `(${elements})`;
    }
    case "array":
      return `[${type.length}]${
        formatTypeWithNominalRecordDetailsInternal(type.element, ctx, 2, adtEnv)
      }`;
    case "record": {
      const name = findNominalRecordName(type, adtEnv);
      const details = formatRecordDetails(type, ctx, adtEnv);
      return name ? `${name}${details}` : details;
    }
    case "effect_row": {
      let flattenedType = type;
      if (type.tail?.kind === "effect_row") {
        flattenedType = ensureRow(type);
      }
      const entries = Array.from(flattenedType.cases.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const parts = entries.map(([label, payload]) =>
        payload
          ? `${label}(${formatTypeWithNominalRecordDetailsInternal(
            payload,
            ctx,
            0,
            adtEnv,
          )})`
          : label
      );
      if (flattenedType.tail) {
        const tailStr = formatTypeWithNominalRecordDetailsInternal(
          flattenedType.tail,
          ctx,
          0,
          adtEnv,
        );
        if (parts.length === 0) {
          return `<${tailStr}>`;
        }
        parts.push(`..${tailStr}`);
      } else if (parts.length === 0) {
        return `<>`;
      }
      return `<${parts.join(" | ")}>`;
    }
    case "unit":
      return "Void";
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    default:
      return "?";
  }
}

function formatRecordAliasDetails(
  alias: import("../../../src/types.ts").Type,
  ctx: { names: Map<number, string>; next: number },
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string {
  if (alias.kind !== "record") {
    return "";
  }
  return formatRecordDetails(alias, ctx, adtEnv);
}

function formatRecordDetails(
  record: Extract<Type, { kind: "record" }>,
  ctx: { names: Map<number, string>; next: number },
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string {
  const entries = Array.from(record.fields.entries());
  entries.sort(([a], [b]) => a.localeCompare(b));
  const parts = entries.map(([field, fieldType]) => {
    const fieldStr = formatTypeWithNominalRecordDetails(fieldType, ctx, adtEnv);
    return `${field}: ${fieldStr}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function findNominalRecordName(
  type: Extract<Type, { kind: "record" }>,
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string | null {
  const fieldNames = new Set(type.fields.keys());
  const matches: string[] = [];
  for (const [name, info] of adtEnv.entries()) {
    if (!info.alias || info.alias.kind !== "record") continue;
    if (info.parameters.length > 0) continue;
    if (info.alias.fields.size !== fieldNames.size) continue;
    let ok = true;
    for (const aliasField of info.alias.fields.keys()) {
      if (!fieldNames.has(aliasField)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(name);
      if (matches.length > 1) {
        return null;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Start the server
export async function startWorkmanLanguageServer(): Promise<void> {
  const server = new WorkmanLanguageServer();
  await server.start();
}

if (import.meta.main) {
  await startWorkmanLanguageServer();
}
