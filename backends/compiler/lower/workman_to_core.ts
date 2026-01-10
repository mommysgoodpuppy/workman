import type { ModuleNode, ModuleSummary } from "../../../src/module_loader.ts";
import type { AnalysisResult } from "../../../src/pipeline.ts";
import {
  CoreExport,
  CoreImport,
  CoreModule,
  CoreRecordField,
  CoreTypeConstructor,
  CoreTypeDeclaration,
  CoreTypeRecordField,
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
      const error = createDiagnosticError(
        diagnostic,
        span,
        node.source,
        spanIndex,
      );
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
      analysis.layer1.adtEnv,
      node.program?.mode === "raw",
    ),
    exports: convertExports(node, input.summary),
    mode: node.program?.mode,
    core: node.program?.core,
  };
}

function isStdModule(path: string): boolean {
  return path.includes("\\std\\") || path.includes("/std/");
}

function convertImports(
  node: ModuleNode,
  summary?: ModuleSummary,
): CoreImport[] {
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
                const importedName = /^[A-Za-z_$]/.test(sanitized)
                  ? sanitized
                  : `_${sanitized}`;
                constructorsToImport.push(importedName);
              }
            }
          }
        }
      }

      // Find existing import for this source or create new one
      let existingImport = imports.find((imp) =>
        imp.source === reexport.sourcePath
      );
      if (existingImport) {
        // Add constructor specifiers to existing import (but avoid duplicates)
        const existingNames = new Set(
          existingImport.specifiers.map((s) => s.imported),
        );
        const newSpecifiers = constructorsToImport
          .filter((name) => !existingNames.has(name))
          .map((name) => ({
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
          const index = imports.findIndex((imp) =>
            imp.source === reexport.sourcePath
          );
          imports[index] = existingImport;
        }
      } else if (constructorsToImport.length > 0) {
        // Create new import with constructor specifiers
        imports.push({
          source: reexport.sourcePath,
          specifiers: constructorsToImport.map((name) => ({
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
      const alreadyImported = imports.some((imp) =>
        imp.source === reexport.sourcePath
      );
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
    // Handle ADT-style type declarations
    if (topLevel.kind === "type") {
      const constructors: CoreTypeConstructor[] = [];
      for (const member of topLevel.members) {
        if (member.kind !== "constructor") continue;
        constructors.push({
          name: member.name,
          arity: member.typeArgs.length,
          exported: Boolean(topLevel.export),
          span: member.span,
        });
      }

      // Extract infectious metadata if present
      let infectious: CoreTypeDeclaration["infectious"] = undefined;
      if (topLevel.infectious) {
        const valueCtors = topLevel.members.filter(
          (m): m is import("../../../src/ast.ts").ConstructorAlias =>
            m.kind === "constructor" && m.annotation === "value",
        );
        const effectCtors = topLevel.members.filter(
          (m): m is import("../../../src/ast.ts").ConstructorAlias =>
            m.kind === "constructor" && m.annotation === "effect",
        );

        infectious = {
          domain: topLevel.infectious.domain,
          valueConstructor: valueCtors.length > 0
            ? valueCtors[0].name
            : undefined,
          effectConstructors: effectCtors.length > 0
            ? effectCtors.map((c) => c.name)
            : undefined,
        };
      }

      decls.push({
        name: topLevel.name,
        constructors,
        exported: Boolean(topLevel.export),
        infectious,
        span: topLevel.span,
      });
    }

    // Handle record declarations (for raw mode struct emission)
    if (topLevel.kind === "record_decl") {
      const recordFields: CoreTypeRecordField[] = [];
      for (const member of topLevel.members) {
        if (member.kind === "record_typed_field") {
          recordFields.push({
            name: member.name,
            typeAnnotation: typeExprToZigType(member.annotation),
          });
        } else if (member.kind === "record_value_field" && member.annotation) {
          recordFields.push({
            name: member.name,
            typeAnnotation: typeExprToZigType(member.annotation),
          });
        }
      }

      decls.push({
        name: topLevel.name,
        constructors: [], // Records have no ADT constructors
        exported: Boolean(topLevel.export),
        recordFields,
        span: topLevel.span,
      });
    }
  }
  return decls;
}

/** Convert a TypeExpr AST node to a Zig type string for raw mode emission */
function typeExprToZigType(
  typeExpr: import("../../../src/ast.ts").TypeExpr,
): string {
  switch (typeExpr.kind) {
    case "type_var":
      return typeExpr.name;
    case "type_ref": {
      // Map Workman primitive types to Zig types
      const name = typeExpr.name;
      const zigPrimitives: Record<string, string> = {
        "I8": "i8",
        "I16": "i16",
        "I32": "i32",
        "I64": "i64",
        "I128": "i128",
        "U8": "u8",
        "U16": "u16",
        "U32": "u32",
        "U64": "u64",
        "U128": "u128",
        "Isize": "isize",
        "Usize": "usize",
        "F16": "f16",
        "F32": "f32",
        "F64": "f64",
        "F128": "f128",
        "Bool": "bool",
        "Void": "void",
        "CShort": "c_short",
        "CUShort": "c_ushort",
        "CInt": "c_int",
        "CUInt": "c_uint",
        "CLong": "c_long",
        "CULong": "c_ulong",
        "CLongLong": "c_longlong",
        "CULongLong": "c_ulonglong",
        "CChar": "c_char",
      };
      if (zigPrimitives[name]) {
        return zigPrimitives[name];
      }
      if (typeExpr.typeArgs.length === 0) {
        return name;
      }
      const args = typeExpr.typeArgs.map(typeExprToZigType).join(", ");
      return `${name}(${args})`;
    }
    case "type_fn": {
      const params = typeExpr.parameters.map(typeExprToZigType).join(", ");
      return `fn(${params}) ${typeExprToZigType(typeExpr.result)}`;
    }
    case "type_tuple": {
      const elements = typeExpr.elements.map(typeExprToZigType).join(", ");
      return `struct { ${elements} }`;
    }
    case "type_array":
      return `[${typeExpr.length}]${typeExprToZigType(typeExpr.element)}`;
    case "type_unit":
      return "void";
    case "type_pointer":
      return `*${typeExprToZigType(typeExpr.pointee)}`;
    case "type_record": {
      const fields = typeExpr.fields.map((f) =>
        `${f.name}: ${typeExprToZigType(f.type)}`
      ).join(", ");
      return `struct { ${fields} }`;
    }
    default:
      return "anytype";
  }
}

function convertExports(
  node: ModuleNode,
  summary?: ModuleSummary,
): CoreExport[] {
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
            const exportedName = /^[A-Za-z_$]/.test(sanitized)
              ? sanitized
              : `_${sanitized}`;
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
  spanIndex?: Map<NodeId, SourceSpan>,
): InferError {
  const message = formatDiagnosticMessage(diagnostic, source, spanIndex);
  return new InferError(message, span, source);
}

// Format type for error messages - shows explicit Ptr<T> instead of ⚡T
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
        fields.map(([k, v]) => `${k}: ${simpleFormatType(v)}`).join(", ")
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

// Get a short description of the outermost type structure
function getOutermostType(type: Type): string {
  switch (type.kind) {
    case "var":
      return `type variable T${type.id}`;
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

function formatDiagnosticMessage(
  diagnostic: ConstraintDiagnostic,
  source?: string,
  spanIndex?: Map<NodeId, SourceSpan>,
): string {
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
      // Layer1 uses expected/actual, Layer2 uses left/right
      const expected = diagnostic.details?.expected ?? diagnostic.details?.left;
      const actual = diagnostic.details?.actual ?? diagnostic.details?.right;
      if (expected && actual) {
        const expectedType = expected as Type;
        const actualType = actual as Type;
        const actualCarrier = unwrapCarrier(actualType);
        const expectedCarrier = unwrapCarrier(expectedType);
        const expectedLabel = simpleFormatType(expectedType);
        const actualLabel = simpleFormatType(actualType);
        const extraNotes: string[] = [];
        const actualValueType = actualCarrier?.value ?? actualType;

        // Detect when types look identical but are different (carrier state mismatch)
        if (expectedLabel === actualLabel && expectedCarrier && actualCarrier) {
          extraNotes.push(
            `Note: Both types are '${expectedCarrier.name}' carriers but have incompatible infection states.`,
          );
          extraNotes.push(
            `This typically happens when the same pointer is used in different control flow branches with different states.`,
          );
        }

        if (
          expectedType.kind === "record" && actualValueType.kind === "record"
        ) {
          const expectedFields = listRecordFields(expectedType);
          const actualFields = listRecordFields(actualValueType);
          const missing = expectedFields.filter((f) =>
            !actualFields.includes(f)
          );
          const extra = actualFields.filter((f) => !expectedFields.includes(f));
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
          } else if (actualCarrier && !expectedCarrier) {
            extraNotes.push(
              `Note: '${actualCarrier.name}' is infectious; its value type is ${
                simpleFormatType(actualCarrier.value)
              }.`,
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
        } else if (actualCarrier && !expectedCarrier) {
          extraNotes.push(
            `Note: '${actualCarrier.name}' is infectious; its value type is ${
              simpleFormatType(actualCarrier.value)
            }.`,
          );
        }

        const noteSuffix = extraNotes.length > 0
          ? `\n  ${extraNotes.join("\n  ")}`
          : "";
        return `Type mismatch: expected ${expectedLabel}, but got ${actualLabel}${noteSuffix}`;
      }
      return "Type mismatch between incompatible types";
    }
    case "branch_mismatch": {
      const expectedType = diagnostic.details?.expectedType as Type | undefined;
      const actualType = diagnostic.details?.actualType as Type | undefined;
      const branchIndex = diagnostic.details?.branchIndex;
      const branchNum = typeof branchIndex === "number" ? branchIndex + 1 : "N";
      const firstBranchNodeId = diagnostic.details?.firstBranchNodeId as
        | number
        | undefined;
      const mismatchBranchNodeId = diagnostic.details?.mismatchBranchNodeId as
        | number
        | undefined;

      // Helper to get line number for a node
      const getLineNumber = (nodeId: number | undefined): number | null => {
        if (!nodeId || !source || !spanIndex) return null;
        const span = spanIndex.get(nodeId);
        if (!span) return null;
        let line = 1;
        for (let i = 0; i < span.start && i < source.length; i++) {
          if (source[i] === "\n") line++;
        }
        return line;
      };

      // Helper to get a multi-line snippet of source for a branch body
      // Shows the END of the block since that's what determines return type
      const getBranchSnippet = (
        nodeId: number | undefined,
        indent: string,
      ): string | null => {
        if (!nodeId || !source || !spanIndex) return null;
        const span = spanIndex.get(nodeId);
        if (!span) return null;

        const content = source.slice(span.start, span.end);
        const lines = content.split("\n");

        // Helper to check if line is just braces/whitespace
        const isJustBraces = (line: string) => /^[\s\}\)\]]*$/.test(line);

        // Find the last meaningful line (not just closing braces)
        let lastMeaningfulIdx = lines.length - 1;
        while (
          lastMeaningfulIdx > 0 && isJustBraces(lines[lastMeaningfulIdx])
        ) {
          lastMeaningfulIdx--;
        }

        // Count trailing brace-only lines
        const trailingBraceCount = lines.length - 1 - lastMeaningfulIdx;

        // Format with proper indentation
        const maxLines = 6;
        const result: string[] = [];

        if (lines.length <= maxLines) {
          // Show full block
          for (const line of lines) {
            result.push(indent + line.trimEnd());
          }
        } else {
          // Show first line (opening brace)
          result.push(indent + lines[0].trimEnd());
          result.push(indent + "  ...");

          // Show the last meaningful line
          if (lastMeaningfulIdx > 0) {
            result.push(indent + lines[lastMeaningfulIdx].trimEnd());
          }

          // Show closing braces - if more than 1 brace line, just show "...}"
          if (trailingBraceCount > 1) {
            result.push(indent + "  ...}");
          } else if (trailingBraceCount === 1) {
            result.push(indent + lines[lines.length - 1].trimEnd());
          }
        }

        return result.join("\n");
      };

      const line1 = getLineNumber(firstBranchNodeId);
      const lineN = getLineNumber(mismatchBranchNodeId);

      let message = "";

      if (expectedType && actualType) {
        const expectedCarrier = unwrapCarrier(expectedType);
        const actualCarrier = unwrapCarrier(actualType);

        // Case 1: One branch returns Option<T>, another returns T directly
        if (actualCarrier && !expectedCarrier) {
          message =
            `Branch ${branchNum} returns '${actualCarrier.name}' but branch 1 returns unwrapped value`;
        } else if (expectedCarrier && !actualCarrier) {
          message =
            `Branch 1 returns '${expectedCarrier.name}' but branch ${branchNum} returns unwrapped value`;
        } else if (
          expectedCarrier && actualCarrier &&
          expectedCarrier.name !== actualCarrier.name
        ) {
          message =
            `Branch 1 returns '${expectedCarrier.name}' but branch ${branchNum} returns '${actualCarrier.name}'`;
        } else {
          // General type mismatch
          const expectedOuter = getOutermostType(expectedType);
          const actualOuter = getOutermostType(actualType);
          if (expectedOuter !== actualOuter) {
            message =
              `Match arms have incompatible types: branch 1 is ${expectedOuter}, branch ${branchNum} is ${actualOuter}`;
          } else {
            message = `Match arms have incompatible types`;
          }
        }

        // Add branch locations and snippets to help identify the issue
        const firstSnippet = getBranchSnippet(firstBranchNodeId, "    ");
        const mismatchSnippet = getBranchSnippet(mismatchBranchNodeId, "    ");

        const line1Str = line1 ? ` (line ${line1})` : "";
        const lineNStr = lineN ? ` (line ${lineN})` : "";

        if (firstSnippet) {
          message += `\n  Branch 1${line1Str}:\n${firstSnippet}`;
        }

        if (mismatchSnippet) {
          message += `\n  Branch ${branchNum}${lineNStr}:\n${mismatchSnippet}`;
        }

        return message;
      }
      return "Match arms have incompatible types";
    }
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
      return `Record literal must match exactly one nominal record type (found ${
        matches ?? 0
      } matches)`;
    }
    case "not_record": {
      const ctorName = diagnostic.details?.constructorName;
      const missingDef = diagnostic.details?.missingDefinition;
      if (missingDef && ctorName) {
        return `Cannot access field on type '${ctorName}' because its definition is not visible (try importing it)`;
      }
      return "Cannot project field from non-record type";
    }
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
    case "require_not_state": {
      const domain = diagnostic.details?.domain as string | undefined;
      const forbidden = diagnostic.details?.forbidden as string[] | undefined;
      const actual = diagnostic.details?.actual as string | undefined;
      const sourceNodes = diagnostic.details?.sourceNodes as
        | number[]
        | undefined;
      const forbiddenOrigins = diagnostic.details?.forbiddenOrigins as
        | number[]
        | undefined;
      const domainLabel = domain ? `'${domain}'` : "memory";
      const forbiddenLabel = forbidden && forbidden.length > 0
        ? forbidden.join(", ")
        : "certain states";
      const actualLabel = actual ? ` (current state: ${actual})` : "";
      let originLabel = "";
      if (
        forbiddenOrigins && forbiddenOrigins.length > 0 && spanIndex && source
      ) {
        const originLocations = forbiddenOrigins
          .map((nodeId) => {
            const span = spanIndex.get(nodeId);
            if (span) {
              const line = getLineNumber(source, span.start);
              return `line ${line}`;
            }
            return null;
          })
          .filter((loc): loc is string => loc !== null);
        if (originLocations.length > 0) {
          originLabel = `\n  [${forbiddenLabel}] state introduced at: ${
            originLocations.join(", ")
          }`;
        }
      }
      let sourceLabel = "";
      if (sourceNodes && sourceNodes.length > 0 && spanIndex && source) {
        const sourceLocations = sourceNodes
          .map((nodeId) => {
            const span = spanIndex.get(nodeId);
            if (span) {
              const line = getLineNumber(source, span.start);
              return `line ${line}`;
            }
            return null;
          })
          .filter((loc): loc is string => loc !== null);
        if (sourceLocations.length > 0) {
          sourceLabel = `\n  State flows from: ${sourceLocations.join(", ")}`;
        }
      }
      return `Operation requires ${domainLabel} state to NOT be [${forbiddenLabel}]${actualLabel}${originLabel}${sourceLabel}`;
    }
    case "require_at_return": {
      const domain = diagnostic.details?.domain as string | undefined;
      const expected = diagnostic.details?.expected as string[] | undefined;
      const actual = diagnostic.details?.actual as string | undefined;
      const policy = diagnostic.details?.policy as string | undefined;
      const domainLabel = domain ? `'${domain}'` : "memory";
      const expectedLabel = expected && expected.length > 0
        ? expected.join(", ")
        : "specific state";
      const actualLabel = actual ? ` (current: ${actual})` : "";
      const policyLabel = policy ? ` [policy: ${policy}]` : "";
      return `Return requires ${domainLabel} state to be [${expectedLabel}]${actualLabel}${policyLabel}`;
    }
    case "incompatible_constraints": {
      const label1 = diagnostic.details?.label1 as string | undefined;
      const label2 = diagnostic.details?.label2 as string | undefined;
      if (label1 && label2) {
        return `Incompatible infection states: '${label1}' conflicts with '${label2}'`;
      }
      return "Incompatible infection states on the same value";
    }
    default:
      return `Type error: ${diagnostic.reason}`;
  }
}

function getLineNumber(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
    }
  }
  return line;
}
