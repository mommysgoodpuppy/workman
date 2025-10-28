// Multi-module compilation orchestrator

import type { ModuleGraph, ModuleNode } from "./module_resolver.ts";
import { inferProgram } from "../../../src/layer1infer.ts";
import type { InferResult } from "../../../src/layer1infer.ts";
import type { TypeEnv, TypeEnvADT } from "../../../src/types.ts";
import { lowerToCore } from "./lower_to_core.ts";
import { lowerToMir } from "./lower_to_mir.ts";
import { generateESM } from "./codegen.ts";
import type { CoreProgram } from "./core_ir.ts";
import type { MirProgram } from "./mir.ts";
import { ModuleError, WorkmanError } from "../../../src/error.ts";

export interface CompiledModule {
  path: string;
  source: string;
  jsCode: string;
  jsPath: string; // Output path for the JS file
  inferResult: InferResult;
  core: CoreProgram;
  mir: MirProgram;
}

function normalizeCompilationError(error: unknown, modulePath: string): WorkmanError {
  if (error instanceof WorkmanError) {
    return error;
  }

  if (error instanceof AggregateError) {
    const nestedErrors = error.errors.map((inner) => normalizeCompilationError(inner, modulePath));
    const message = error.message || "Aggregate compilation error";
    const aggregate = new ModuleError(`${message}`, modulePath);
    (aggregate as { causes?: WorkmanError[] }).causes = nestedErrors;
    return aggregate;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ModuleError(`Error compiling module: ${message}`, modulePath);
}

export interface CompilationResult {
  modules: Map<string, CompiledModule>;
  entryPath: string;
  errors?: WorkmanError[];
}

/**
 * Compile a module graph to JavaScript
 */
export function compileModuleGraph(graph: ModuleGraph): CompilationResult {
  const compiledModules = new Map<string, CompiledModule>();
  const errors: WorkmanError[] = [];

  // Global type environment (accumulates across modules)
  let globalTypeEnv: TypeEnv = new Map();
  let globalAdtEnv: TypeEnvADT = new Map();

  // Compile modules in topological order
  for (const modulePath of graph.order) {
    const node = graph.modules.get(modulePath);
    if (!node) {
      errors.push(new ModuleError(`Module not found in graph`, modulePath));
      continue;
    }

    try {
      const compiled = compileModule(
        node,
        graph,
        globalTypeEnv,
        globalAdtEnv,
        compiledModules
      );
      compiledModules.set(modulePath, compiled);

      // Update global environments with this module's exports
      globalTypeEnv = new Map([...globalTypeEnv, ...compiled.inferResult.env]);
      globalAdtEnv = new Map([...globalAdtEnv, ...compiled.inferResult.adtEnv]);
    } catch (error) {
      errors.push(normalizeCompilationError(error, modulePath));
    }
  }

  return {
    modules: compiledModules,
    entryPath: graph.entry,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Compile a single module
 */
function compileModule(
  node: ModuleNode,
  graph: ModuleGraph,
  globalTypeEnv: TypeEnv,
  globalAdtEnv: TypeEnvADT,
  compiledModules: Map<string, CompiledModule>
): CompiledModule {
  // Build initial type environment from imports
  const initialEnv: TypeEnv = new Map();
  const initialAdtEnv: TypeEnvADT = new Map();

  // Add prelude if this is not the prelude itself AND not a std library module
  // Std library modules should be self-contained and not depend on prelude
  const isStdModule = node.path.includes("/std/") || node.path.includes("\\std\\");
  const shouldImportPrelude = graph.prelude && node.path !== graph.prelude && !isStdModule;
  
  if (shouldImportPrelude) {
    const preludeModule = compiledModules.get(graph.prelude);
    if (preludeModule) {
      // Import all prelude exports
      for (const [name, scheme] of preludeModule.inferResult.env) {
        initialEnv.set(name, scheme);
      }
      for (const [name, info] of preludeModule.inferResult.adtEnv) {
        initialAdtEnv.set(name, info);
      }
    }
  }

  // Add imports from dependencies
  for (const imp of node.imports) {
    const depModule = compiledModules.get(imp.sourcePath);
    if (!depModule) {
      throw new Error(`Dependency not compiled: ${imp.sourcePath}`);
    }

    for (const spec of imp.specifiers) {
      // Import value
      const scheme = depModule.inferResult.env.get(spec.imported);
      if (scheme) {
        initialEnv.set(spec.local, scheme);
      }

      // Import type (if it's a type name)
      const typeInfo = depModule.inferResult.adtEnv.get(spec.imported);
      if (typeInfo) {
        initialAdtEnv.set(spec.local, typeInfo);
      }
      
      // If importing a constructor, also import its parent type
      // Find which type this constructor belongs to
      for (const [typeName, info] of depModule.inferResult.adtEnv) {
        const hasConstructor = info.constructors.some(c => c.name === spec.imported);
        if (hasConstructor) {
          // Import the type definition
          initialAdtEnv.set(typeName, info);
          break;
        }
      }
    }
  }

  // Debug: Log what's in the ADT environment
  // console.log(`\n=== Type checking ${node.path} ===`);
  // console.log("ADT env keys:", Array.from(initialAdtEnv.keys()));
  // for (const [name, info] of initialAdtEnv) {
  //   console.log(`  ${name}: constructors = [${info.constructors.map(c => c.name).join(", ")}]`);
  // }

  // Type inference
  // Note: We need to register prelude natives (like nativeAdd) even if we're not
  // importing the prelude module, because std modules use them directly
  const inferResult = inferProgram(node.program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: true, // Register native functions
    source: node.source,
  });

  // Lower to Core IR
  const core = lowerToCore(node.program, inferResult);

  // Collect tag tables from imported modules
  const importedTagTables = new Map<string, any>();
  for (const imp of node.imports) {
    const depModule = compiledModules.get(imp.sourcePath);
    if (depModule) {
      // Add all tag tables from the dependency
      for (const tagTable of depModule.mir.tagTables) {
        importedTagTables.set(tagTable.typeName, tagTable);
      }
    }
  }

  // Lower to MIR with imported tag tables
  const mir = lowerToMir(core, importedTagTables);

  // Generate JavaScript with module-aware imports/exports
  const jsCode = generateESMModule(mir, node, graph, compiledModules);

  // Determine output path
  const jsPath = node.path.replace(/\.wm$/, ".js");

  return {
    path: node.path,
    source: node.source,
    jsCode,
    jsPath,
    inferResult,
    core,
    mir,
  };
}

/**
 * Generate ESM JavaScript with proper imports/exports
 */
function generateESMModule(
  mir: MirProgram,
  node: ModuleNode,
  graph: ModuleGraph,
  compiledModules: Map<string, CompiledModule>
): string {
  const lines: string[] = [];

  // Generate imports
  const imports = generateImports(node, graph);
  if (imports.length > 0) {
    lines.push(...imports);
    lines.push("");
  }

  // Generate the module body (runtime, tag tables, functions)
  const body = generateESM(mir);
  lines.push(body);

  return lines.join("\n");
}

/**
 * Generate ESM import statements
 */
function generateImports(node: ModuleNode, graph: ModuleGraph): string[] {
  const lines: string[] = [];

  for (const imp of node.imports) {
    const importPath = rewriteImportPath(node.path, imp.sourcePath);
    const specifiers = imp.specifiers.map((s) => 
      s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`
    ).join(", ");

    lines.push(`import { ${specifiers} } from "${importPath}";`);
  }

  return lines;
}

/**
 * Rewrite import path for JavaScript
 * - Converts .wm to .js
 * - Makes relative paths explicit
 */
function rewriteImportPath(importerPath: string, targetPath: string): string {
  // Convert to .js extension
  let jsPath = targetPath.replace(/\.wm$/, ".js");

  // Make path relative to importer
  const importerDir = dirname(importerPath);
  let relativePath = relative(importerDir, jsPath);

  // Ensure relative paths start with ./
  if (!relativePath.startsWith(".") && !relativePath.startsWith("/")) {
    relativePath = "./" + relativePath;
  }

  // Normalize path separators for URLs
  return relativePath.replaceAll("\\", "/");
}

// Helper to compute relative path
function relative(from: string, to: string): string {
  const fromParts = from.split(/[/\\]/);
  const toParts = to.split(/[/\\]/);

  // Find common prefix
  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  // Build relative path
  const upCount = fromParts.length - commonLength;
  const upParts = Array(upCount).fill("..");
  const downParts = toParts.slice(commonLength);

  return [...upParts, ...downParts].join("/");
}

function dirname(path: string): string {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join("/");
}
