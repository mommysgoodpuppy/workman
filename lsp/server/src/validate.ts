import { splitCarrier, Type } from "../../../src/types.ts";
import { formatTypeWithCarriers } from "../../../src/type_printer.ts";

import {
  ConstraintDiagnosticWithSpan,
  FlowDiagnostic,
  Layer3Result,
} from "../../../src/layer3/mod.ts";
import { InferError, LexError, ParseError } from "../../../src/error.ts";
import { ModuleLoaderError } from "../../../src/module_loader.ts";
import {
  estimateRangeFromMessage,
  getWordAtOffset,
  offsetToPosition,
  positionToOffset,
} from "./util.ts";
import type { WorkmanLanguageServer } from "./server.ts";
import { computeStdRoots, pathToUri, uriToFsPath } from "./fsio.ts";
type LspServerContext = WorkmanLanguageServer;

export function ensureValidation(
  ctx: LspServerContext,
  uri: string,
  text: string,
) {
  // Clear any pending validation timer for this document
  const existingTimer = ctx.validationTimers.get(uri);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  // Debounce validation by 50ms to avoid excessive work during rapid typing
  const timer = setTimeout(() => {
    ctx.validationTimers.delete(uri);
    runValidation(ctx, uri, text);
  }, 50);
  ctx.validationTimers.set(uri, timer);
}

async function runValidation(ctx: LspServerContext, uri: string, text: string) {
  const existing = ctx.validationInProgress.get(uri);
  if (existing) {
    await existing;
  }
  const promise = validateDocument(ctx, uri, text);
  ctx.validationInProgress.set(uri, promise);
  try {
    await promise;
  } finally {
    ctx.validationInProgress.delete(uri);
  }
}

export async function validateDocument(
  ctx: LspServerContext,
  uri: string,
  text: string,
) {
  const diagnostics: any[] = [];
  const diagnosticsByUri = new Map<string, any[]>();
  diagnosticsByUri.set(uri, diagnostics);

  ctx.log(`[LSP] Validating document: ${uri}`);

  // Only clear the context for this specific file, not all contexts
  // This allows caching of dependency analysis
  ctx.moduleContexts.delete(uri);

  const entryPath = uriToFsPath(uri);
  const stdRoots = computeStdRoots(ctx, entryPath);

  // Use the module loader to parse and analyze the document
  // It will use the in-memory content via sourceOverrides
  try {
    const sourceOverrides = new Map([[entryPath, text]]);
    const context = await ctx.buildModuleContext(
      entryPath,
      stdRoots,
      ctx.preludeModule,
      sourceOverrides,
      true,
    );
    ctx.moduleContexts.set(uri, context);
    ctx.log(`[LSP] Module analysis completed (${entryPath})`);
    appendSolverDiagnostics(
      ctx,
      diagnostics,
      context.layer3.diagnostics.solver,
      text,
      context.layer3,
    );
    appendConflictDiagnostics(
      ctx,
      diagnostics,
      context.layer3.diagnostics.conflicts,
      text,
      context.layer3,
    );
    appendFlowDiagnostics(
      diagnostics,
      context.layer3.diagnostics.flow,
      text,
    );
  } catch (error) {
    ctx.log(`[LSP] Validation error: ${error}`);

    // Check if this is a WorkmanError (which includes LexError, ParseError, InferError)
    // These might be wrapped in ModuleLoaderError
    if (error instanceof LexError) {
      const position = offsetToPosition(text, error.position);
      const endPos = offsetToPosition(text, error.position + 1);
      diagnostics.push({
        range: { start: position, end: endPos },
        severity: 1,
        message: error.format(text),
        source: "workman-lexer",
        code: "lex-error",
      });
    } else if (error instanceof ParseError) {
      // For parse errors, underline the exact token that caused the issue
      const startPos = offsetToPosition(text, error.token.start);
      const endPos = offsetToPosition(text, error.token.end);
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
          start: offsetToPosition(text, error.span.start),
          end: offsetToPosition(text, error.span.end),
        }
        : estimateRangeFromMessage(text, error.message);
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
      const inferredModulePath =
        error.modulePath ?? extractModulePathFromMessage(String(error.message));
      const targetPath = inferredModulePath ?? entryPath;
      const targetUri = targetPath ? pathToUri(targetPath) : uri;
      const targetDiagnostics = ensureDiagnosticsBucket(
        diagnosticsByUri,
        targetUri,
      );
      const targetText = await getModuleSourceText(
        ctx,
        targetPath,
        entryPath,
        text,
        targetUri,
      );
      const rangeFallback = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      };
      let range = rangeFallback;
      let message = String(error.message);
      let source = "workman-modules";
      let code = "module-error";

      if (cause instanceof LexError) {
        if (targetText) {
          const position = offsetToPosition(targetText, cause.position);
          const endPos = offsetToPosition(targetText, cause.position + 1);
          range = { start: position, end: endPos };
        }
        message = cause.format(targetText);
        source = "workman-lexer";
        code = "lex-error";
      } else if (cause instanceof ParseError) {
        if (targetText) {
          const startPos = offsetToPosition(targetText, cause.token.start);
          const endPos = offsetToPosition(targetText, cause.token.end);
          range = { start: startPos, end: endPos };
        }
        message = cause.format(targetText);
        source = "workman-parser";
        code = "parse-error";
      } else if (cause instanceof InferError) {
        if (cause.span && targetText) {
          range = {
            start: offsetToPosition(targetText, cause.span.start),
            end: offsetToPosition(targetText, cause.span.end),
          };
        } else if (targetText) {
          range = estimateRangeFromMessage(targetText, cause.message) ??
            rangeFallback;
        }
        message = cause.format(targetText);
        source = "workman-typechecker";
        code = "type-error";
      } else {
        if (targetText) {
          const locationMatch = message.match(/at line (\d+), column (\d+)/);
          if (locationMatch) {
            const line = Number.parseInt(locationMatch[1], 10) - 1;
            const column = Number.parseInt(locationMatch[2], 10) - 1;
            const errorOffset = positionToOffset(targetText, {
              line,
              character: column,
            });
            const { word, start, end } = getWordAtOffset(
              targetText,
              errorOffset,
            );
            if (word && word.length > 0) {
              range = {
                start: offsetToPosition(targetText, start),
                end: offsetToPosition(targetText, end),
              };
            } else {
              range = {
                start: { line, character: column },
                end: { line, character: column + 1 },
              };
            }
          } else {
            range = estimateRangeFromMessage(targetText, message) ??
              rangeFallback;
          }
        }
      }

      targetDiagnostics.push({
        range,
        severity: 1,
        message,
        source,
        code,
      });
    } else {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const range = estimateRangeFromMessage(text, errorMsg) || {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      };
      diagnostics.push({
        range,
        severity: 1,
        message: `Internal error: ${error}`,
        source: "workman",
        code: "internal-error",
      });
    }
  }

  await publishDiagnostics(ctx, diagnosticsByUri);
}

async function getModuleSourceText(
  ctx: LspServerContext,
  modulePath: string | undefined,
  entryPath: string,
  entryText: string,
  moduleUri: string,
): Promise<string | undefined> {
  if (!modulePath || modulePath === entryPath) {
    return entryText;
  }
  const openDocument = ctx.documents.get(moduleUri);
  if (openDocument !== undefined) {
    return openDocument;
  }
  try {
    return await Deno.readTextFile(modulePath);
  } catch {
    return undefined;
  }
}

function ensureDiagnosticsBucket(
  buckets: Map<string, any[]>,
  targetUri: string,
): any[] {
  let bucket = buckets.get(targetUri);
  if (!bucket) {
    bucket = [];
    buckets.set(targetUri, bucket);
  }
  return bucket;
}

async function publishDiagnostics(
  ctx: LspServerContext,
  diagnosticsByUri: Map<string, any[]>,
) {
  for (const [targetUri, list] of diagnosticsByUri.entries()) {
    ctx.diagnostics.set(targetUri, list);
    ctx.log(`[LSP] Sending ${list.length} diagnostics for ${targetUri}`);
    try {
      await ctx.sendNotification("textDocument/publishDiagnostics", {
        uri: targetUri,
        diagnostics: list,
      });
    } catch (error) {
      ctx.log(`[LSP] Failed to send diagnostics for ${targetUri}: ${error}`);
    }
  }
}

function extractModulePathFromMessage(message: string): string | undefined {
  const inMatch = message.match(/\bin ['"]([^'"]+\.wm)['"]/i);
  if (inMatch) {
    return inMatch[1];
  }
  const pathMatch = message.match(/['"]([a-zA-Z]:\\[^'"]+\.wm)['"]/);
  if (pathMatch) {
    return pathMatch[1];
  }
  return undefined;
}

function appendSolverDiagnostics(
  ctx: LspServerContext,
  target: any[],
  diagnostics: ConstraintDiagnosticWithSpan[],
  text: string,
  layer3: Layer3Result,
): void {
  for (const diag of diagnostics) {
    const range = diag.span
      ? {
        start: offsetToPosition(text, diag.span.start),
        end: offsetToPosition(
          text,
          Math.max(diag.span.end, diag.span.start + 1),
        ),
      }
      : {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      };
    if (hasExistingDiagnostic(target, range, diag.reason)) {
      continue;
    }
    target.push({
      range,
      severity: 1,
      message: formatSolverDiagnostic(diag, ctx, layer3),
      source: "workman-layer2",
      code: diag.reason,
    });
  }
}

function appendConflictDiagnostics(
  ctx: LspServerContext,
  target: any[],
  conflicts: any[],
  text: string,
  layer3: Layer3Result,
): void {
  for (const conflict of conflicts) {
    const range = conflict.span
      ? {
        start: offsetToPosition(text, conflict.span.start),
        end: offsetToPosition(
          text,
          Math.max(conflict.span.end, conflict.span.start + 1),
        ),
      }
      : {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      };
    let message = "Conflicting type requirements";
    if (
      conflict.details && conflict.details.expected && conflict.details.actual
    ) {
      const expectedStr = formatTypeForDiagnostics(
        ctx,
        conflict.details.expected,
        layer3,
      );
      const actualStr = formatTypeForDiagnostics(
        ctx,
        conflict.details.actual,
        layer3,
      );
      message = `Type mismatch: expected ${expectedStr}, got ${actualStr}`;
    } else if (conflict.message) {
      message = conflict.message;
    } else if (conflict.details) {
      message += `. Details: ${JSON.stringify(conflict.details)}`;
    }

    if (hasExistingDiagnostic(target, range, "type_mismatch")) {
      continue;
    }
    target.push({
      range,
      severity: 1,
      message,
      source: "workman-layer2",
      code: "type_mismatch",
    });
  }
}

function appendFlowDiagnostics(
  target: any[],
  flowDiagnostics: FlowDiagnostic[],
  text: string,
): void {
  for (const diag of flowDiagnostics) {
    const span = "span" in diag ? diag.span : undefined;
    const range = span
      ? {
        start: offsetToPosition(text, span.start),
        end: offsetToPosition(text, Math.max(span.end, span.start + 1)),
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

function formatSolverDiagnostic(
  diag: ConstraintDiagnosticWithSpan,
  ctx: LspServerContext,
  layer3: Layer3Result,
): string {
  let base: string;
  let shouldAppendDetails = true;
  switch (diag.reason) {
    case "not_function":
      base = "Expected a function but found a non-function value";
      break;
    case "branch_mismatch": {
      const details = diag.details as Record<string, unknown> | undefined;
      const branchIndex = details?.branchIndex;
      const branchNum = typeof branchIndex === "number" ? branchIndex + 1 : "N";
      const expectedType = details?.expectedType as Type | undefined;
      const actualType = details?.actualType as Type | undefined;

      if (expectedType && actualType) {
        const expectedCarrier = unwrapCarrierForDiag(expectedType);
        const actualCarrier = unwrapCarrierForDiag(actualType);

        // Case 1: One branch returns Option<T>, another returns T directly
        if (actualCarrier && !expectedCarrier) {
          base =
            `Branch ${branchNum} returns '${actualCarrier.name}' but branch 1 returns its inner value directly\n` +
            `Hint: Branch ${branchNum} may be missing a match/unwrap, or branch 1 needs to wrap in '${actualCarrier.name}'`;
          break;
        }
        if (expectedCarrier && !actualCarrier) {
          base =
            `Branch 1 returns '${expectedCarrier.name}' but branch ${branchNum} returns its inner value directly\n` +
            `Hint: Branch 1 may be missing a match/unwrap, or branch ${branchNum} needs to wrap in '${expectedCarrier.name}'`;
          break;
        }

        // Case 2: Both are carriers but different kinds
        if (
          expectedCarrier && actualCarrier &&
          expectedCarrier.name !== actualCarrier.name
        ) {
          const expectedFmt =
            tryFormatDiagnosticValue(expectedType, ctx, layer3) ?? "?";
          const actualFmt = tryFormatDiagnosticValue(actualType, ctx, layer3) ??
            "?";
          base =
            `Branch 1 returns '${expectedCarrier.name}' but branch ${branchNum} returns '${actualCarrier.name}'\n` +
            `Branch 1 type: ${expectedFmt}\n` +
            `Branch ${branchNum} type: ${actualFmt}`;
          break;
        }

        // Case 3: General type mismatch
        const expectedFmt =
          tryFormatDiagnosticValue(expectedType, ctx, layer3) ?? "?";
        const actualFmt = tryFormatDiagnosticValue(actualType, ctx, layer3) ??
          "?";

        // If types are long, show a simplified summary
        if (expectedFmt.length > 60 || actualFmt.length > 60) {
          const expectedOuter = getOutermostTypeName(expectedType);
          const actualOuter = getOutermostTypeName(actualType);
          if (expectedOuter !== actualOuter) {
            base = `Match arms have incompatible types\n` +
              `Branch 1 is: ${expectedOuter}\n` +
              `Branch ${branchNum} is: ${actualOuter}`;
            break;
          }
        }

        base = `Match arms have incompatible types\n` +
          `Branch 1 type: ${expectedFmt}\n` +
          `Branch ${branchNum} type: ${actualFmt}`;
      } else {
        base = "Match arms have incompatible types";
      }
      break;
    }
    case "missing_field":
      base = "Record is missing a required field";
      break;
    case "not_record":
      if (
        diag.details?.missingDefinition &&
        typeof diag.details.constructorName === "string"
      ) {
        base =
          `Cannot access field on type '${diag.details.constructorName}' because its definition is not visible (try importing it)`;
      } else {
        base = "Expected a record value here";
      }
      break;
    case "occurs_cycle":
      base = "Occurs check failed while solving types";
      break;
    case "type_mismatch":
      base = "Conflicting type requirements";
      {
        const comparison = formatTypeComparisonDetails(diag, ctx, layer3);
        if (comparison) {
          base += `\n${comparison}`;
        }
      }
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
    case "pattern_binding_required": {
      const name = typeof diag.details?.name === "string"
        ? diag.details.name
        : "value";
      base =
        `Pattern '${name}' would introduce a new binding. Use Var(${name}) to bind it.`;
      break;
    }
    case "mutable_shadowing": {
      const name = typeof diag.details?.name === "string"
        ? diag.details.name
        : "value";
      base = `Mutable binding '${name}' shadows an existing mutable binding`;
      break;
    }
    case "non_exhaustive_match": {
      base = "Match expression is not exhaustive\n";
      const missing = Array.isArray(diag.details?.missingCases)
        ? (diag.details.missingCases as string[]).join(", ")
        : null;
      if (missing) {
        base += ` - missing cases: ${missing}`;
      }
      const hint = typeof diag.details?.hint === "string"
        ? diag.details.hint
        : null;
      if (hint) {
        base += `\nHint: ${hint}`;
      }
      // Add information about the scrutinee type if it's a Result (infectious)
      const scrutineeType = diag.details?.scrutineeType as Type | undefined;
      if (
        scrutineeType?.kind === "constructor" &&
        scrutineeType.name === "Result"
      ) {
        const errorType = scrutineeType.args[1];
        const errorTypeStr = errorType
          ? formatTypeForDiagnostics(ctx, errorType, layer3)
          : "?";
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
      const row = diag.details?.effectRow as Type | undefined;
      const rowLabel = row
        ? formatTypeForDiagnostics(ctx, row, layer3)
        : "an unresolved error row";
      base =
        `This call must remain infectious because an argument carries ${rowLabel}`;
      break;
    }
    case "infectious_match_result_mismatch": {
      const row = diag.details?.effectRow as Type | undefined;
      const missing = Array.isArray(diag.details?.missingConstructors)
        ? (diag.details?.missingConstructors as string[]).join(", ")
        : null;
      const rowLabel = row
        ? ` for row ${formatTypeForDiagnostics(ctx, row, layer3)}`
        : "";
      base =
        `Match claimed to discharge Result errors${rowLabel} but remained infectious`;
      if (missing && missing.length > 0) {
        base += `. Missing constructors: ${missing}`;
      }
      break;
    }
    case "require_exact_state":
    case "require_any_state": {
      const domain = diag.details?.domain ?? "unknown";
      const expected = Array.isArray(diag.details?.expected)
        ? diag.details.expected.join(", ")
        : String(diag.details?.expected ?? "?");
      const actual = String(diag.details?.actual ?? "?");
      const verb = diag.reason === "require_exact_state"
        ? "exactly"
        : "at least one of";
      base =
        `Memory state error: operation requires ${verb} [${expected}] but value has state ${actual}`;
      break;
    }
    case "ambiguous_record": {
      shouldAppendDetails = false;
      const explicitMessage = typeof diag.details?.message === "string"
        ? diag.details.message
        : null;
      if (explicitMessage) {
        base = explicitMessage;
        break;
      }
      const matches = typeof diag.details?.matches === "number"
        ? diag.details.matches
        : null;
      const candidates = Array.isArray(diag.details?.candidates)
        ? (diag.details?.candidates as unknown[]).filter((name): name is string =>
          typeof name === "string"
        )
        : [];
      const matchLabel = matches && matches > 1
        ? `${matches} record definitions`
        : candidates.length > 1
        ? `${candidates.length} record definitions`
        : "multiple record definitions";
      base = `Record is ambiguous (${matchLabel} match the visible fields).`;
      if (candidates.length > 0) {
        const maxToShow = 5;
        const rendered = candidates.slice(0, maxToShow).join(", ");
        const remaining = candidates.length - maxToShow;
        base += `\nCandidates: ${rendered}`;
        if (remaining > 0) {
          base += `, … (+${remaining} more)`;
        }
      }
      base += "\nHint: add a type annotation to pick the intended record.";
      break;
    }
    default:
      base = `Solver diagnostic: ${diag.reason}`;
      break;
  }
  if (
    shouldAppendDetails && diag.details && Object.keys(diag.details).length > 0
  ) {
    try {
      // Safely stringify details, avoiding circular references
      const safeDetails: Record<string, any> = {};
      for (const [key, value] of Object.entries(diag.details)) {
        const formatted = tryFormatDiagnosticValue(value, ctx, layer3);
        safeDetails[key] = formatted ?? value;
      }
      base = `${base}
        
Details: ${JSON.stringify(safeDetails)}`;
    } catch {
      // Ignore stringify errors
    }
  }
  return base;
}

function formatTypeComparisonDetails(
  diag: ConstraintDiagnosticWithSpan,
  ctx: LspServerContext,
  layer3: Layer3Result,
): string | null {
  if (diag.reason !== "type_mismatch") {
    return null;
  }
  const details = diag.details as Record<string, unknown> | undefined;
  if (!details) {
    return null;
  }
  const expected = tryFormatDiagnosticValue(details.expected, ctx, layer3);
  const actual = tryFormatDiagnosticValue(details.actual, ctx, layer3);
  if (!expected && !actual) {
    return null;
  }
  const parts: string[] = [];
  if (expected) parts.push(`Expected: ${expected}`);
  if (actual) parts.push(`--Actual: ${actual}`);
  return parts.join("\n");
}

function tryFormatDiagnosticValue(
  value: unknown,
  ctx: LspServerContext,
  layer3: Layer3Result,
  depth = 0,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const maxDepth = 3;
      if (depth >= maxDepth) {
        return `[Array(${value.length})]`;
      }
      const maxItems = 5;
      const rendered = value.slice(0, maxItems).map((item) => {
        const formatted = tryFormatDiagnosticValue(
          item,
          ctx,
          layer3,
          depth + 1,
        );
        if (formatted === null) {
          if (typeof item === "string") return `"${item}"`;
          if (typeof item === "number" || typeof item === "boolean") {
            return String(item);
          }
          return "[?]";
        }
        return formatted;
      });
      if (value.length > maxItems) {
        rendered.push(`… (+${value.length - maxItems} more)`);
      }
      return `[${rendered.join(", ")}]`;
    }
    const typeStr = tryFormatType(value, ctx, layer3);
    if (typeStr) {
      return typeStr;
    }
    const maxDepth = 2;
    if (depth >= maxDepth) {
      return "[Object]";
    }
    try {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        return "{}";
      }
      const maxEntries = 5;
      const renderedEntries = entries.slice(0, maxEntries).map(
        ([key, entryValue]) => {
          const formatted = tryFormatDiagnosticValue(
            entryValue,
            ctx,
            layer3,
            depth + 1,
          );
          return `${key}: ${formatted ?? "[?]"}`;
        },
      );
      if (entries.length > maxEntries) {
        renderedEntries.push(`… (+${entries.length - maxEntries} more)`);
      }
      return `{ ${renderedEntries.join(", ")} }`;
    } catch {
      return "[Object]";
    }
  }
  return String(value);
}

function tryFormatType(
  value: unknown,
  ctx: LspServerContext,
  layer3: Layer3Result,
): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const kind = (value as { kind?: string }).kind;
  if (typeof kind !== "string") {
    return null;
  }
  switch (kind) {
    case "var":
    case "func":
    case "constructor":
    case "tuple":
    case "record":
    case "effect_row":
    case "unit":
    case "int":
    case "bool":
    case "char":
    case "string":
      try {
        return formatTypeForDiagnostics(ctx, value as Type, layer3);
      } catch {
        return null;
      }
    default:
      return null;
  }
}

function formatTypeForDiagnostics(
  ctx: LspServerContext,
  type: Type,
  layer3: Layer3Result,
): string {
  const substituted = ctx.substituteTypeWithLayer3(type, layer3);
  return formatTypeWithCarriers(substituted, { forDiagnostic: true });
}

function hasExistingDiagnostic(
  diagnostics: Array<{ range?: any; code?: string; source?: string }>,
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
  code: string,
): boolean {
  return diagnostics.some((diag) => {
    if (diag.code !== code || diag.source !== "workman-layer2") {
      return false;
    }
    if (!diag.range) return false;
    return diag.range.start.line === range.start.line &&
      diag.range.start.character === range.start.character &&
      diag.range.end.line === range.end.line &&
      diag.range.end.character === range.end.character;
  });
}

function unwrapCarrierForDiag(
  type: Type,
): { name: string; value: Type } | null {
  const info = splitCarrier(type);
  if (!info || type.kind !== "constructor") return null;
  return { name: type.name, value: info.value };
}

function getOutermostTypeName(type: Type): string {
  switch (type.kind) {
    case "var":
      return `type variable`;
    case "func":
      return "a function";
    case "constructor":
      if (type.args.length === 0) return type.name;
      return `${type.name}<...>`;
    case "tuple":
      return `a ${type.elements.length}-tuple`;
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
    case "record":
      return "a record";
    default:
      return "unknown";
  }
}
