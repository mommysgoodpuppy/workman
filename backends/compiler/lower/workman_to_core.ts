import type { ModuleNode, ModuleSummary } from "../../../src/module_loader.ts";
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
import { isHoleType, splitCarrier, typeToString } from "../../../src/types.ts";
import type { Type } from "../../../src/types.ts";
import type { NodeId, SourceSpan } from "../../../src/ast.ts";
import type { MProgram } from "../../../src/ast_marked.ts";

export interface WorkmanLoweringInput {
  readonly node: ModuleNode;
  readonly analysis: AnalysisResult;
  readonly summary?: ModuleSummary;
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
    imports: convertImports(node, input.summary),
    typeDeclarations: extractTypeDeclarations(node),
    values: lowerProgramToValues(
      program,
      analysis.layer2.resolvedNodeTypes,
      analysis.layer1.recordDefaultExprs,
    ),
    exports: convertExports(node, input.summary),
    mode: node.program?.mode,
  };
}

function isStdModule(path: string): boolean {
  return path.includes("\\std\\") || path.includes("/std/");
}

function convertImports(node: ModuleNode, summary?: ModuleSummary): CoreImport[] {
  const imports: CoreImport[] = [];
  
  // Add explicit imports from source
  for (const record of node.imports) {
    imports.push({
      source: record.sourcePath,
      specifiers: record.specifiers.map((specifier) => ({
        kind: "value" as const,
        imported: specifier.imported,
        local: specifier.local,
      })),
    });
  }
  
  // Add imports for type re-exports with constructors
  // When a module re-exports types (e.g., prelude re-exporting IResult),
  // we need to import the constructors if they're being re-exported
  if (summary) {
    for (const reexport of node.reexports) {
      // Check if this re-export has constructors that need to be imported
      const constructorsToImport: string[] = [];
      
      for (const typeExport of reexport.typeExports) {
        if (typeExport.exportConstructors) {
          const typeInfo = summary.exports.types.get(typeExport.name);
          if (typeInfo) {
            for (const ctor of typeInfo.constructors) {
              if (summary.exports.values.has(ctor.name)) {
                const sanitized = ctor.name.replace(/[^A-Za-z0-9_$]/g, "_");
                const importedName = /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
                constructorsToImport.push(importedName);
              }
            }
          }
        }
      }
      
      // Find existing import for this source or create new one
      let existingImport = imports.find(imp => imp.source === reexport.sourcePath);
      if (existingImport) {
        // Add constructor specifiers to existing import (but avoid duplicates)
        const existingNames = new Set(existingImport.specifiers.map(s => s.imported));
        const newSpecifiers = constructorsToImport
          .filter(name => !existingNames.has(name))
          .map(name => ({
            kind: "value" as const,
            imported: name,
            local: name,
          }));
        if (newSpecifiers.length > 0) {
          existingImport = {
            source: existingImport.source,
            specifiers: [...existingImport.specifiers, ...newSpecifiers],
          };
          // Replace in array
          const index = imports.findIndex(imp => imp.source === reexport.sourcePath);
          imports[index] = existingImport;
        }
      } else if (constructorsToImport.length > 0) {
        // Create new import with constructor specifiers
        imports.push({
          source: reexport.sourcePath,
          specifiers: constructorsToImport.map(name => ({
            kind: "value" as const,
            imported: name,
            local: name,
          })),
        });
      } else {
        // Side-effect import only (for infectious type registration)
        imports.push({
          source: reexport.sourcePath,
          specifiers: [],
        });
      }
    }
  } else {
    // Fallback: side-effect imports for re-exports without summary
    for (const reexport of node.reexports) {
      const alreadyImported = imports.some(imp => imp.source === reexport.sourcePath);
      if (!alreadyImported) {
        imports.push({
          source: reexport.sourcePath,
          specifiers: [],
        });
      }
    }
  }
  
  return imports;
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
    
    // Extract infectious metadata if present
    let infectious: CoreTypeDeclaration["infectious"] = undefined;
    if (topLevel.infectious) {
      const valueCtors = topLevel.members.filter(
        (m): m is import("../../../src/ast.ts").ConstructorAlias =>
          m.kind === "constructor" && m.annotation === "value"
      );
      const effectCtors = topLevel.members.filter(
        (m): m is import("../../../src/ast.ts").ConstructorAlias =>
          m.kind === "constructor" && m.annotation === "effect"
      );
      
      infectious = {
        domain: topLevel.infectious.domain,
        valueConstructor: valueCtors.length > 0 ? valueCtors[0].name : undefined,
        effectConstructors: effectCtors.length > 0 ? effectCtors.map(c => c.name) : undefined,
      };
    }
    
    decls.push({
      name: topLevel.name,
      constructors,
      exported: Boolean(topLevel.export),
      infectious,
    });
  }
  return decls;
}

function convertExports(node: ModuleNode, summary?: ModuleSummary): CoreExport[] {
  const exports: CoreExport[] = [];
  
  // Export regular values
  for (const valueName of node.exportedValueNames) {
    exports.push({
      kind: "value",
      local: valueName,
      exported: valueName,
    });
  }
  
  // Export types
  for (const typeName of node.exportedTypeNames) {
    exports.push({
      kind: "type",
      typeName,
      exported: typeName,
    });
  }
  
      // Export constructors from re-exported types
  // When a module re-exports a type with constructors (e.g., std/option re-exporting Option with Some/None),
  // we need to also export the constructors themselves
  // Export constructors from re-exported types
  // When a module re-exports a type with constructors (e.g., std/option re-exporting Option with Some/None),
  // we need to also export the constructors themselves
  if (summary) {
    // Check all types in the summary exports (not just node.exportedTypeNames, which doesn't include re-exports)
    for (const [typeName, typeInfo] of summary.exports.types.entries()) {
      for (const ctor of typeInfo.constructors) {
        // Check if this constructor is actually exported in the summary
        if (summary.exports.values.has(ctor.name)) {
          // Only add if not already exported as a regular value
          const alreadyExported = node.exportedValueNames.includes(ctor.name);
          if (!alreadyExported) {
            const sanitized = ctor.name.replace(/[^A-Za-z0-9_$]/g, "_");
            const exportedName = /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
            exports.push({
              kind: "constructor",
              typeName,
              ctor: ctor.name,
              exported: exportedName,
            });
          }
        }
      }
    }
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
  const carrierInfo = splitCarrier(type);
  if (carrierInfo && carrierInfo.domain !== "hole") {
    const valueStr = simpleFormatType(carrierInfo.value);
    const stateStr = simpleFormatType(carrierInfo.state);
    return `⚡${valueStr} [${stateStr}]`;
  }
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
      return "Void";
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    case "effect_row":
      return typeToString(type);
    case "record":
      const fields = Array.from(type.fields.entries());
      return `{ ${
        fields.map(([k, v]) =>
          `${k}: ${simpleFormatType(v)}`
        ).join(", ")
      } }`;
    default:
      return "?";
  }
}

function listRecordFields(type: Type): string[] {
  if (type.kind !== "record") return [];
  const fields = Array.from(type.fields.keys());
  fields.sort((a, b) => a.localeCompare(b));
  return fields;
}

function unwrapCarrier(type: Type): { name: string; value: Type } | null {
  const info = splitCarrier(type);
  if (!info || type.kind !== "constructor") return null;
  return { name: type.name, value: info.value };
}

function formatDiagnosticMessage(diagnostic: ConstraintDiagnostic): string {
  switch (diagnostic.reason) {
    case "not_function": {
      const calleeType = diagnostic.details?.calleeType as Type | undefined;
      if (calleeType) {
        // For hole types (especially incomplete JS imports), we don't know if it's a function
        if (isHoleType(calleeType)) {
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
        const expectedType = expected as Type;
        const actualType = actual as Type;
        const actualCarrier = unwrapCarrier(actualType);
        const expectedLabel = simpleFormatType(expectedType);
        const actualLabel = simpleFormatType(actualType);
        const extraNotes: string[] = [];

        const actualValueType = actualCarrier?.value ?? actualType;

        if (
          expectedType.kind === "record" && actualValueType.kind === "record"
        ) {
          const expectedFields = listRecordFields(expectedType);
          const actualFields = listRecordFields(actualValueType);
          const missing = expectedFields.filter((f) =>
            !actualFields.includes(f)
          );
          const extra = actualFields.filter((f) =>
            !expectedFields.includes(f)
          );
          if (missing.length > 0) {
            extraNotes.push(`Missing fields: ${missing.join(", ")}`);
          }
          if (extra.length > 0) {
            extraNotes.push(`Extra fields: ${extra.join(", ")}`);
          }
        } else if (expectedType.kind === "record") {
          const expectedFields = listRecordFields(expectedType);
          if (expectedFields.length > 0) {
            extraNotes.push(
              `Expected record fields: ${expectedFields.join(", ")}`,
            );
          }
          if (actualValueType.kind === "tuple") {
            extraNotes.push(
              "Note: tuples are positional; records require named fields.",
            );
          } else if (actualCarrier) {
            extraNotes.push(
              `Note: '${actualCarrier.name}' is infectious; its value type is ${simpleFormatType(actualCarrier.value)}.`,
            );
          } else if (actualType.kind === "constructor") {
            extraNotes.push(
              `Note: '${actualType.name}' is a constructor, not a record.`,
            );
          }
        } else if (actualValueType.kind === "record") {
          const actualFields = listRecordFields(actualValueType);
          if (actualFields.length > 0) {
            extraNotes.push(
              `Found record fields: ${actualFields.join(", ")}`,
            );
          }
          if (expectedType.kind === "tuple") {
            extraNotes.push(
              "Note: tuples are positional; records require named fields.",
            );
          }
        } else if (actualCarrier) {
          extraNotes.push(
            `Note: '${actualCarrier.name}' is infectious; its value type is ${simpleFormatType(actualCarrier.value)}.`,
          );
        }

        const noteSuffix = extraNotes.length > 0
          ? `\n  ${extraNotes.join("\n  ")}`
          : "";
        return `Type mismatch: expected ${expectedLabel}, but got ${actualLabel}${noteSuffix}`;
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
    case "ambiguous_record": {
      const matches = diagnostic.details?.matches as number | undefined;
      const candidates = diagnostic.details?.candidates as string[] | undefined;
      if (matches === 0) {
        return "No nominal record matches this literal";
      }
      if (candidates && candidates.length > 0) {
        return `Record literal is ambiguous among ${candidates.join(", ")}`;
      }
      return `Record literal must match exactly one nominal record type (found ${matches ?? 0} matches)`;
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
      const row = diagnostic.details?.effectRow as Type | undefined;
      const rowLabel = row ? simpleFormatType(row) : "the incoming effect row";
      return `This call must return a Result because its argument carries ${rowLabel}`;
    }
    case "infectious_match_result_mismatch": {
      const row = diagnostic.details?.effectRow as Type | undefined;
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
