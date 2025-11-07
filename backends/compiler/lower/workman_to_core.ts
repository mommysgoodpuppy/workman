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

export interface WorkmanLoweringInput {
  readonly node: ModuleNode;
  readonly analysis: AnalysisResult;
}

export interface WorkmanLoweringOptions {
  // Placeholder for future lowering configuration (e.g., ABI tweaks, diagnostics).
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
