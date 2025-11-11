import type { ModuleNode } from "../../../src/module_loader.ts";
import type { AnalysisResult } from "../../../src/pipeline.ts";
import type {
  CoreExport,
  CoreImport,
  CoreModule,
  CoreTypeConstructor,
  CoreTypeDeclaration,
} from "../ir/core.ts";
import { lowerProgramToValues } from "./marked_to_core.ts";
import { InferError } from "../../../src/error.ts";
import type { ConstraintDiagnostic } from "../../../src/diagnostics.ts";
import { typeToString } from "../../../src/types.ts";
import type { Type } from "../../../src/types.ts";
import type { NodeId, SourceSpan } from "../../../src/ast.ts";
import type { MProgram } from "../../../src/ast_marked.ts";

export interface WorkmanLoweringInput {
  readonly node: ModuleNode;
  readonly analysis: AnalysisResult;
}

export interface WorkmanLoweringOptions {
  // Show all type errors (for type-check mode)
  showAllErrors?: boolean;
}

/**
 * Temporary lowering stub that records module metadata while the expression lowering
 * pipeline is implemented. This keeps the compiler frontend usable for integration
 * tests that only rely on loader + analysis for now.
 */
export function lowerAnalyzedModule(
  input: WorkmanLoweringInput,
  _options: WorkmanLoweringOptions = {},
): CoreModule {
  const { node, analysis } = input;

  // Report type errors but don't block compilation (Hazel-style)
  const diagnostics = analysis.layer2.diagnostics;
  if (diagnostics.length > 0 && _options.showAllErrors) {
    const spanIndex = collectSpans(analysis.layer2.remarkedProgram);
    console.error(`\n⚠️  Type errors in ${node.path}:\n`);
    for (const diagnostic of diagnostics) {
      const span = spanIndex.get(diagnostic.origin);
      const error = createDiagnosticError(diagnostic, span, node.source);
      console.error(error.format(node.source));
      console.error(); // blank line between errors
    }
  } else if (diagnostics.length > 0) {
    console.error(`\n⚠️  Type errors in ${node.path}:\n`);
  }

  const program = analysis.layer2.remarkedProgram;
  return {
    path: node.path,
    imports: convertImports(node),
    typeDeclarations: extractTypeDeclarations(node),
    values: lowerProgramToValues(program, analysis.layer2.resolvedNodeTypes),
    exports: convertExports(node),
  };
}

function isStdModule(path: string): boolean {
  return path.includes("\\std\\") || path.includes("/std/");
}

function convertImports(node: ModuleNode): CoreImport[] {
  if (node.imports.length === 0) {
    return [];
  }
  return node.imports.map((record) => ({
    source: record.sourcePath,
    specifiers: record.specifiers.map((specifier) => ({
      kind: "value" as const,
      imported: specifier.imported,
      local: specifier.local,
    })),
  }));
}

function extractTypeDeclarations(node: ModuleNode): CoreTypeDeclaration[] {
  const decls: CoreTypeDeclaration[] = [];
  for (const topLevel of node.program.declarations) {
    if (topLevel.kind !== "type") continue;
    const constructors: CoreTypeConstructor[] = [];
    for (const member of topLevel.members) {
      if (member.kind !== "constructor") continue;
      constructors.push({
        name: member.name,
        arity: member.typeArgs.length,
        exported: Boolean(topLevel.export),
      });
    }
    decls.push({
      name: topLevel.name,
      constructors,
      exported: Boolean(topLevel.export),
    });
  }
  return decls;
}

function convertExports(node: ModuleNode): CoreExport[] {
  const exports: CoreExport[] = [];
  for (const valueName of node.exportedValueNames) {
    exports.push({
      kind: "value",
      local: valueName,
      exported: valueName,
    });
  }
  for (const typeName of node.exportedTypeNames) {
    exports.push({
      kind: "type",
      typeName,
      exported: typeName,
    });
  }
  return exports;
}

function collectSpans(program: MProgram): Map<NodeId, SourceSpan> {
  const spans = new Map<NodeId, SourceSpan>();
  // Traverse the program and collect all spans
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if ("id" in node && "span" in node && typeof node.id === "number") {
      spans.set(node.id, node.span);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(program);
  return spans;
}

function createDiagnosticError(
  diagnostic: ConstraintDiagnostic,
  span: SourceSpan | undefined,
  source?: string,
): InferError {
  const message = formatDiagnosticMessage(diagnostic);
  return new InferError(message, span, source);
}

function simpleFormatType(type: Type): string {
  switch (type.kind) {
    case "var":
      return `T${type.id}`;
    case "func":
      return `${simpleFormatType(type.from)} -> ${simpleFormatType(type.to)}`;
    case "constructor":
      if (type.args.length === 0) return type.name;
      return `${type.name}<${type.args.map(simpleFormatType).join(", ")}>`;
    case "tuple":
      return `(${type.elements.map(simpleFormatType).join(", ")})`;
    case "unit":
      return "Unit";
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    case "unknown":
      return "?";
    case "error_row":
      return typeToString(type);
    case "record":
      return `{ ${
        Object.entries(type.fields).map(([k, v]) =>
          `${k}: ${simpleFormatType(v)}`
        ).join(", ")
      } }`;
    default:
      return "?";
  }
}

function formatDiagnosticMessage(diagnostic: ConstraintDiagnostic): string {
  switch (diagnostic.reason) {
    case "not_function": {
      const calleeType = diagnostic.details?.calleeType as Type | undefined;
      if (calleeType) {
        // For unknown types (especially incomplete JS imports), we don't know if it's a function
        if (calleeType.kind === "unknown") {
          return `Calling value of unknown type ${
            simpleFormatType(calleeType)
          }`;
        }
        return `Cannot call non-function value of type ${
          simpleFormatType(calleeType)
        }`;
      }
      return "Cannot call a non-function value";
    }
    case "type_mismatch": {
      const expected = diagnostic.details?.expected;
      const actual = diagnostic.details?.actual;
      if (expected && actual) {
        return `Type mismatch: expected ${
          simpleFormatType(expected as Type)
        }, but got ${simpleFormatType(actual as Type)}`;
      }
      return "Type mismatch between incompatible types";
    }
    case "branch_mismatch":
      return "Match arms have incompatible types";
    case "missing_field": {
      const field = diagnostic.details?.field;
      return field
        ? `Record is missing field '${field}'`
        : "Record is missing a required field";
    }
    case "not_record":
      return "Cannot project field from non-record type";
    case "occurs_cycle":
      return "Infinite type detected (occurs check failed)";
    case "arity_mismatch": {
      const expected = diagnostic.details?.expected;
      const actual = diagnostic.details?.actual;
      if (expected !== undefined && actual !== undefined) {
        return `Arity mismatch: expected ${expected} argument(s), but got ${actual}`;
      }
      return "Function called with wrong number of arguments";
    }
    case "not_numeric":
      return "Numeric operation requires numeric type";
    case "not_boolean":
      return "Boolean operation requires boolean type";
    case "free_variable": {
      const name = diagnostic.details?.name;
      return name
        ? `Unknown identifier '${name}'`
        : "Reference to undefined variable";
    }
    case "unsupported_expr":
      return "Unsupported expression type";
    case "duplicate_record_field": {
      const field = diagnostic.details?.field;
      return field
        ? `Duplicate record field '${field}'`
        : "Duplicate field in record";
    }
    case "non_exhaustive_match": {
      const missing = diagnostic.details?.missingCases as string[] | undefined;
      const scrutineeType = diagnostic.details?.scrutineeType as
        | Type
        | undefined;
      let message = "Match expression is not exhaustive";

      if (missing && missing.length > 0) {
        message += ` - missing cases: ${missing.join(", ")}`;
      } else {
        message += " - some cases are not handled";
      }

      // Add helpful context for infectious Results
      if (
        scrutineeType?.kind === "constructor" && scrutineeType.name === "Result"
      ) {
        const errorType = scrutineeType.args[1];
        const errorTypeStr = errorType ? simpleFormatType(errorType) : "?";
        message +=
          `\n\n  The scrutinee has type Result<?, ${errorTypeStr}> (infectious Result from an operation that can fail)`;
        message +=
          `\n  Handle both Ok and Err cases, or use a wildcard pattern`;
      }

      return message;
    }
    case "all_errors_outside_result":
      return "`AllErrors` can only appear when matching a Result value";
    case "all_errors_requires_err":
      return "`AllErrors` must be paired with at least one `Err` arm";
    case "error_row_partial_coverage": {
      const missing = diagnostic.details?.constructors as string[] | undefined;
      if (missing && missing.length > 0) {
        return `Match does not cover error constructors: ${missing.join(", ")}`;
      }
      return "Match does not cover all error constructors";
    }
    case "infectious_call_result_mismatch": {
      const row = diagnostic.details?.errorRow as Type | undefined;
      const rowLabel = row ? simpleFormatType(row) : "the incoming error row";
      return `This call must return a Result because its argument carries ${rowLabel}`;
    }
    case "infectious_match_result_mismatch": {
      const row = diagnostic.details?.errorRow as Type | undefined;
      const missing = diagnostic.details?.missingConstructors as
        | string[]
        | undefined;
      const rowLabel = row ? ` for row ${simpleFormatType(row)}` : "";
      const missingLabel = missing && missing.length > 0
        ? `; missing constructors: ${missing.join(", ")}`
        : "";
      return `Match claimed to discharge a Result but remained infectious${rowLabel}${missingLabel}`;
    }
    case "type_expr_unknown":
      return "Unknown type in type expression";
    case "type_expr_arity":
      return "Type constructor applied with wrong number of arguments";
    case "type_expr_unsupported":
      return "Unsupported type expression";
    case "type_decl_duplicate":
      return "Duplicate type declaration";
    case "type_decl_invalid_member":
      return "Invalid type declaration member";
    case "internal_error":
      return "Internal compiler error during type checking";
    default:
      return `Type error: ${diagnostic.reason}`;
  }
}
