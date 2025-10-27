// Module resolution and dependency graph building for ESM backend

import { dirname, extname, isAbsolute, join, resolve } from "https://deno.land/std@0.208.0/path/mod.ts";
import { existsSync } from "https://deno.land/std@0.208.0/fs/mod.ts";
import type { Program, ModuleImport, ModuleReexport } from "../../../src/ast.ts";
import { lex } from "../../../src/lexer.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";

export interface ModuleResolverOptions {
  stdRoots?: string[];
  preludeModule?: string;
}

export interface ModuleGraph {
  entry: string;
  prelude?: string;
  order: string[]; // Topologically sorted module paths
  modules: Map<string, ModuleNode>;
}

export interface ModuleNode {
  path: string;
  program: Program;
  source: string;
  imports: ResolvedImport[];
  exports: ExportInfo;
}

export interface ResolvedImport {
  sourcePath: string;
  specifiers: ImportSpecifier[];
  isTypeOnly: boolean;
}

export interface ImportSpecifier {
  imported: string;
  local: string;
}

export interface ExportInfo {
  values: Set<string>;
  types: Set<string>;
  typeConstructors: Map<string, string[]>; // type name -> constructor names
}

interface ResolverContext {
  options: ModuleResolverOptions;
  modules: Map<string, ModuleNode>;
  visitState: Map<string, "visiting" | "visited">;
  order: string[];
  preludePath?: string;
}

/**
 * Build a module dependency graph from an entry point
 */
export async function buildModuleGraph(
  entryPath: string,
  options: ModuleResolverOptions = {}
): Promise<ModuleGraph> {
  const normalizedEntry = resolveEntryPath(entryPath);
  const normalizedOptions = normalizeOptions(options);

  let preludePath: string | undefined;
  if (normalizedOptions.preludeModule) {
    preludePath = resolveModuleSpecifier(
      normalizedEntry,
      normalizedOptions.preludeModule,
      normalizedOptions
    );
  }

  const ctx: ResolverContext = {
    options: normalizedOptions,
    modules: new Map(),
    visitState: new Map(),
    order: [],
    preludePath,
  };

  // Visit prelude first if it exists
  if (preludePath) {
    await visitModule(preludePath, ctx);
  }

  // Visit entry module
  await visitModule(normalizedEntry, ctx);

  return {
    entry: normalizedEntry,
    prelude: preludePath,
    order: ctx.order,
    modules: ctx.modules,
  };
}

/**
 * Visit a module and its dependencies (DFS with cycle detection)
 */
async function visitModule(path: string, ctx: ResolverContext): Promise<void> {
  const state = ctx.visitState.get(path);

  if (state === "visited") {
    return; // Already processed
  }

  if (state === "visiting") {
    throw new Error(`Circular dependency detected: ${path}`);
  }

  ctx.visitState.set(path, "visiting");

  // Load and parse module
  const source = await Deno.readTextFile(path);
  const tokens = lex(source, path);
  const program = parseSurfaceProgram(tokens, source);

  // Resolve imports
  const resolvedImports: ResolvedImport[] = [];
  for (const imp of program.imports) {
    const sourcePath = resolveModuleSpecifier(path, imp.source, ctx.options);
    const specifiers = imp.specifiers.map((spec) => ({
      imported: spec.imported,
      local: spec.local ?? spec.imported,
    }));
    resolvedImports.push({
      sourcePath,
      specifiers,
      isTypeOnly: false,
    });

    // Visit dependency
    await visitModule(sourcePath, ctx);
  }

  // For M1: Skip re-exports (we'll add them in M2)
  // Just track them for now
  for (const reexp of program.reexports) {
    const sourcePath = resolveModuleSpecifier(path, reexp.source, ctx.options);
    // Visit dependency
    await visitModule(sourcePath, ctx);
  }

  // Collect exports
  const exports = collectExports(program);

  // Create module node
  const node: ModuleNode = {
    path,
    program,
    source,
    imports: resolvedImports,
    exports,
  };

  ctx.modules.set(path, node);
  ctx.visitState.set(path, "visited");
  ctx.order.push(path);
}

/**
 * Collect what this module exports
 */
function collectExports(program: Program): ExportInfo {
  const values = new Set<string>();
  const types = new Set<string>();
  const typeConstructors = new Map<string, string[]>();

  for (const decl of program.declarations) {
    if (decl.kind === "let" && decl.exported) {
      values.add(decl.name);
    } else if (decl.kind === "type" && decl.exported) {
      types.add(decl.name);
      // Collect constructor names
      const ctorNames = decl.constructors.map((c) => c.name);
      typeConstructors.set(decl.name, ctorNames);
      // Constructors are also exported as values
      for (const ctorName of ctorNames) {
        values.add(ctorName);
      }
    } else if (decl.kind === "infix" && decl.exported) {
      // For M1: Skip operator exports
      // We'll handle them in M2
    }
  }

  // For M1: Skip re-exports
  // We'll add them in M2

  return { values, types, typeConstructors };
}

/**
 * Resolve a module specifier to an absolute path
 */
function resolveModuleSpecifier(
  importerPath: string,
  specifier: string,
  options: ModuleResolverOptions
): string {
  // Relative imports
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolve(dirname(importerPath), specifier);
    return ensureWmExtension(target);
  }

  // Absolute imports
  if (isAbsolute(specifier)) {
    return ensureWmExtension(specifier);
  }

  // Std library imports
  if (specifier.startsWith("std/")) {
    for (const root of options.stdRoots ?? []) {
      const candidate = ensureWmExtension(join(root, specifier.slice(4)));
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Module not found in std roots: '${specifier}' imported by '${importerPath}'`);
  }

  throw new Error(`Unsupported module specifier '${specifier}' in '${importerPath}'`);
}

/**
 * Ensure path has .wm extension
 */
function ensureWmExtension(path: string): string {
  if (extname(path) === "") {
    return `${path}.wm`;
  }
  return path;
}

/**
 * Resolve entry path to absolute
 */
function resolveEntryPath(path: string): string {
  if (isAbsolute(path)) {
    return ensureWmExtension(path);
  }
  return ensureWmExtension(resolve(Deno.cwd(), path));
}

/**
 * Normalize resolver options
 */
function normalizeOptions(options: ModuleResolverOptions): ModuleResolverOptions {
  // If preludeModule is explicitly provided (even as empty string or undefined), use it
  // Otherwise default to "std/prelude"
  const hasPreludeOption = "preludeModule" in options;
  
  return {
    stdRoots: options.stdRoots ?? [resolve(Deno.cwd(), "std")],
    preludeModule: hasPreludeOption ? options.preludeModule : "std/prelude",
  };
}
