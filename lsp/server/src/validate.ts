
import { Type, typeToString } from "../../../src/types.ts";

import {
  ConstraintDiagnosticWithSpan,
  FlowDiagnostic,
  Layer3Result,
} from "../../../src/layer3/mod.ts";
import { InferError, LexError, ParseError } from "../../../src/error.ts";
import { ModuleLoaderError } from "../../../src/module_loader.ts";
import { estimateRangeFromMessage, getWordAtOffset, offsetToPosition, positionToOffset } from "./util.ts";
import type { WorkmanLanguageServer } from "./server.ts";
import { computeStdRoots, uriToFsPath } from "./fsio.ts";
type LspServerContext = WorkmanLanguageServer;

  export function ensureValidation(ctx: LspServerContext, uri: string, text: string) {
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
    );
    ctx.moduleContexts.set(uri, context);
    ctx.log(`[LSP] Module analysis completed (${entryPath})`);
    appendSolverDiagnostics(
      diagnostics,
      context.layer3.diagnostics.solver,
      text,
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
      let range;
      let message = String(error.message);
      let source = "workman-modules";
      let code = "module-error";

      if (cause instanceof LexError) {
        const position = offsetToPosition(text, cause.position);
        const endPos = offsetToPosition(text, cause.position + 1);
        range = { start: position, end: endPos };
        message = cause.format(text);
        source = "workman-lexer";
        code = "lex-error";
      } else if (cause instanceof ParseError) {
        const startPos = offsetToPosition(text, cause.token.start);
        const endPos = offsetToPosition(text, cause.token.end);
        range = { start: startPos, end: endPos };
        message = cause.format(text);
        source = "workman-parser";
        code = "parse-error";
      } else if (cause instanceof InferError) {
        range = cause.span
          ? {
            start: offsetToPosition(text, cause.span.start),
            end: offsetToPosition(text, cause.span.end),
          }
          : estimateRangeFromMessage(text, cause.message);
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
          const errorOffset = positionToOffset(text, {
            line,
            character: column,
          });
          const { word, start, end } = getWordAtOffset(
            text,
            errorOffset,
          );
          // Use the word boundaries if we found a word, otherwise just highlight the position
          if (word && word.length > 0) {
            range = {
              start: offsetToPosition(text, start),
              end: offsetToPosition(text, end),
            };
          } else {
            range = {
              start: { line, character: column },
              end: { line, character: column + 1 },
            };
          }
        } else {
          range = estimateRangeFromMessage(text, message);
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

  ctx.diagnostics.set(uri, diagnostics);
  ctx.log(`[LSP] Sending ${diagnostics.length} diagnostics for ${uri}`);

  // Send diagnostics notification
  try {
    await ctx.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics,
    });
    ctx.log(`[LSP] Diagnostics sent successfully`);
  } catch (error) {
    ctx.log(`[LSP] Failed to send diagnostics: ${error}`);
  }
}

function appendSolverDiagnostics(
  target: any[],
  diagnostics: ConstraintDiagnosticWithSpan[],
  text: string,
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
    target.push({
      range,
      severity: 1,
      message: formatSolverDiagnostic( diag),
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
      const expected = ctx.substituteTypeWithLayer3(
        conflict.details.expected,
        layer3,
      );
      const actual = ctx.substituteTypeWithLayer3(
        conflict.details.actual,
        layer3,
      );
      const expectedStr = typeToString(expected);
      const actualStr = typeToString(actual);
      message = `Type mismatch: expected ${expectedStr}, got ${actualStr}`;
    } else if (conflict.message) {
      message = conflict.message;
    } else if (conflict.details) {
      message += `. Details: ${JSON.stringify(conflict.details)}`;
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
): string {
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
      {
        const comparison = formatTypeComparisonDetails( diag);
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
      const row = diag.details?.effectRow as Type | undefined;
      const rowLabel = row ? typeToString(row) : "an unresolved error row";
      base =
        `This call must remain infectious because an argument carries ${rowLabel}`;
      break;
    }
    case "infectious_match_result_mismatch": {
      const row = diag.details?.effectRow as Type | undefined;
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
        const formatted = tryFormatDiagnosticValue(value);
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
): string | null {
  if (diag.reason !== "type_mismatch") {
    return null;
  }
  const details = diag.details as Record<string, unknown> | undefined;
  if (!details) {
    return null;
  }
  const expected = tryFormatDiagnosticValue( details.expected);
  const actual = tryFormatDiagnosticValue( details.actual);
  if (!expected && !actual) {
    return null;
  }
  const parts: string[] = [];
  if (expected) parts.push(`Expected: ${expected}`);
  if (actual) parts.push(`---Actual: ${actual}`);
  return parts.join("\n");
}

function tryFormatDiagnosticValue(
  value: unknown,
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
      return `[Array with ${value.length} items]`;
    }
    const typeStr = tryFormatType(value);
    if (typeStr) {
      return typeStr;
    }
    return "[Object]";
  }
  return String(value);
}

  function tryFormatType( value: unknown): string | null {
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
          return typeToString(value as Type);
        } catch {
          return null;
        }
      default:
        return null;
    }
  }
