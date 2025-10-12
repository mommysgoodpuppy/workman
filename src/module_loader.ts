import { dirname, extname, isAbsolute, join, resolve } from "std/path/mod.ts";
import { lex } from "./lexer.ts";
import { parseSurfaceProgram, ParseError } from "./parser.ts";
import type { ImportSpecifier, ModuleImport, Program, SourceSpan, LetDeclaration } from "./ast.ts";
import type { TypeInfo, TypeScheme } from "./types.ts";
import { cloneTypeInfo, cloneTypeScheme } from "./types.ts";
import { inferProgram, InferError } from "./infer.ts";
import { evaluateProgram } from "./eval.ts";
import type { RuntimeValue } from "./value.ts";
import { lookupValue } from "./value.ts";
import { formatScheme } from "./type_printer.ts";
import { formatRuntimeValue } from "./value_printer.ts";

export interface ModuleLoaderOptions {
  stdRoots?: string[];
}

export interface ModuleGraph {
  entry: string;
  order: string[];
  nodes: Map<string, ModuleNode>;
}

export interface ModuleNode {
  path: string;
  program: Program;
  imports: ModuleImportRecord[];
  exportedValueNames: string[];
  exportedTypeNames: string[];
}

export interface ModuleImportRecord {
  sourcePath: string;
  specifiers: NamedImportRecord[];
  span: SourceSpan;
  rawSource: string;
  importerPath: string;
}

export interface NamedImportRecord {
  imported: string;
  local: string;
  span: SourceSpan;
}

interface LoaderContext {
  options: ModuleLoaderOptions;
  programCache: Map<string, Program>;
  visitState: Map<string, "visiting" | "visited">;
  stack: string[];
  nodes: Map<string, ModuleNode>;
  order: string[];
}

interface ModuleSummary {
  exports: {
    values: Map<string, TypeScheme>;
    types: Map<string, TypeInfo>;
  };
  runtime: Map<string, RuntimeValue>;
  letSchemes: Map<string, TypeScheme>;
  letSchemeOrder: string[];
  letRuntime: Map<string, RuntimeValue>;
  letValueOrder: string[];
}

export class ModuleLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleLoaderError";
  }
}

export async function loadModuleGraph(entryPath: string, options: ModuleLoaderOptions = {}): Promise<ModuleGraph> {
  const normalizedEntry = resolveEntryPath(entryPath);
  const ctx: LoaderContext = {
    options: normalizeOptions(options),
    programCache: new Map(),
    visitState: new Map(),
    stack: [],
    nodes: new Map(),
    order: [],
  };
  await visitModule(normalizedEntry, ctx);
  return {
    entry: normalizedEntry,
    order: ctx.order,
    nodes: ctx.nodes,
  };
}

export async function runEntryPath(entryPath: string, options: ModuleLoaderOptions = {}): Promise<{
  types: { name: string; type: string }[];
  values: { name: string; value: string }[];
  runtimeLogs: string[];
}> {
  const graph = await loadModuleGraph(entryPath, options);
  const moduleSummaries = new Map<string, ModuleSummary>();
  const runtimeLogs: string[] = [];

  for (const path of graph.order) {
    const node = graph.nodes.get(path);
    if (!node) {
      throw new ModuleLoaderError(`Internal error: missing node for '${path}'`);
    }

    const initialEnv = new Map<string, TypeScheme>();
    const initialAdtEnv = new Map<string, TypeInfo>();
    const initialBindings = new Map<string, RuntimeValue>();

    for (const record of node.imports) {
      const provider = moduleSummaries.get(record.sourcePath);
      if (!provider) {
        throw new ModuleLoaderError(`Module '${path}' depends on '${record.sourcePath}' which failed to load`);
      }
      applyImports(record, provider, initialEnv, initialAdtEnv, initialBindings);
    }

    let inference;
    try {
      inference = inferProgram(node.program, {
        initialEnv,
        initialAdtEnv,
        registerPrelude: true,
        resetCounter: true,
      });
    } catch (error) {
      if (error instanceof InferError) {
        throw new ModuleLoaderError(`Type error in '${path}': ${error.message}`);
      }
      throw error;
    }

    const letSchemes = new Map<string, TypeScheme>();
    const letSchemeOrder: string[] = [];
    for (const { name, scheme } of inference.summaries) {
      if (letSchemes.has(name)) {
        throw new ModuleLoaderError(`Duplicate let binding '${name}' inferred in '${path}'`);
      }
      letSchemes.set(name, cloneTypeScheme(scheme));
      letSchemeOrder.push(name);
    }

    const exportedValues = new Map<string, TypeScheme>();
    const exportedTypes = new Map<string, TypeInfo>();

    for (const name of node.exportedValueNames) {
      const scheme = letSchemes.get(name) ?? inference.env.get(name);
      if (!scheme) {
        throw new ModuleLoaderError(`Exported let '${name}' was not inferred in '${path}'`);
      }
      if (exportedValues.has(name)) {
        throw new ModuleLoaderError(`Duplicate export '${name}' in '${path}'`);
      }
      exportedValues.set(name, cloneTypeScheme(scheme));
    }

    for (const typeName of node.exportedTypeNames) {
      const info = inference.adtEnv.get(typeName);
      if (!info) {
        throw new ModuleLoaderError(`Exported type '${typeName}' was not defined in '${path}'`);
      }
      if (exportedTypes.has(typeName)) {
        throw new ModuleLoaderError(`Duplicate export '${typeName}' in '${path}'`);
      }
      const clonedInfo = cloneTypeInfo(info);
      exportedTypes.set(typeName, clonedInfo);
      for (const ctor of clonedInfo.constructors) {
        const scheme = inference.env.get(ctor.name);
        if (!scheme) {
          throw new ModuleLoaderError(`Constructor '${ctor.name}' for type '${typeName}' missing in '${path}'`);
        }
        if (exportedValues.has(ctor.name)) {
          throw new ModuleLoaderError(`Duplicate export '${ctor.name}' in '${path}'`);
        }
        exportedValues.set(ctor.name, cloneTypeScheme(scheme));
      }
    }

    const evaluation = evaluateProgram(node.program, {
      sourceName: path,
      initialBindings,
      onPrint: (text) => {
        runtimeLogs.push(text);
      },
    });

    const letRuntime = new Map<string, RuntimeValue>();
    const letValueOrder: string[] = [];
    for (const summary of evaluation.summaries) {
      letRuntime.set(summary.name, summary.value);
      letValueOrder.push(summary.name);
    }

    const runtimeExports = new Map<string, RuntimeValue>();
    for (const name of exportedValues.keys()) {
      const value = letRuntime.get(name) ?? lookupValue(evaluation.env, name);
      runtimeExports.set(name, value);
    }

    moduleSummaries.set(path, {
      exports: {
        values: exportedValues,
        types: exportedTypes,
      },
      runtime: runtimeExports,
      letSchemes,
      letSchemeOrder,
      letRuntime,
      letValueOrder,
    });
  }

  const entryNode = graph.nodes.get(graph.entry);
  const entrySummary = moduleSummaries.get(graph.entry);
  if (!entryNode || !entrySummary) {
    throw new ModuleLoaderError(`Internal error: failed to load entry module '${graph.entry}'`);
  }
  const types = entrySummary.letSchemeOrder.map((name) => {
    const scheme = entrySummary.letSchemes.get(name);
    if (!scheme) {
      throw new ModuleLoaderError(`Missing type information for '${name}' in '${graph.entry}'`);
    }
    return { name, type: formatScheme(scheme) };
  });

  const values = entrySummary.letValueOrder.map((name) => {
    const value = entrySummary.letRuntime.get(name);
    if (!value) {
      throw new ModuleLoaderError(`Missing runtime value for '${name}' in '${graph.entry}'`);
    }
    return { name, value: formatRuntimeValue(value) };
  });

  return { types, values, runtimeLogs };
}

function normalizeOptions(options: ModuleLoaderOptions): ModuleLoaderOptions {
  if (options.stdRoots && options.stdRoots.length > 0) {
    return { stdRoots: options.stdRoots.map((root) => resolve(root)) };
  }
  return { stdRoots: [resolve("std")] };
}

function resolveEntryPath(path: string): string {
  const normalized = isAbsolute(path) ? path : resolve(path);
  return ensureWmExtension(normalized);
}

async function visitModule(path: string, ctx: LoaderContext): Promise<void> {
  const state = ctx.visitState.get(path);
  if (state === "visiting") {
    const cycle = [...ctx.stack, path];
    throw new ModuleLoaderError(`Circular import detected: ${cycle.join(" -> ")}`);
  }
  if (state === "visited") {
    return;
  }

  ctx.visitState.set(path, "visiting");
  ctx.stack.push(path);
  try {
    const program = await loadProgram(path, ctx);
    const exports = collectExports(program, path);
    const imports = resolveImports(path, program.imports, ctx);

    ctx.nodes.set(path, {
      path,
      program,
      imports,
      exportedValueNames: exports.values,
      exportedTypeNames: exports.types,
    });

    for (const record of imports) {
      await visitModule(record.sourcePath, ctx);
    }

    ctx.visitState.set(path, "visited");
    ctx.order.push(path);
  } finally {
    ctx.stack.pop();
  }
}

async function loadProgram(path: string, ctx: LoaderContext): Promise<Program> {
  const cached = ctx.programCache.get(path);
  if (cached) {
    return cached;
  }
  let source: string;
  try {
    source = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ModuleLoaderError(`Module not found: '${path}'`);
    }
    throw new ModuleLoaderError(`Failed to read '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  let program: Program;
  try {
    const tokens = lex(source);
    program = parseSurfaceProgram(tokens);
  } catch (error) {
    if (error instanceof ParseError) {
      throw new ModuleLoaderError(`Parse error in '${path}': ${error.message}`);
    }
    throw error;
  }
  ctx.programCache.set(path, program);
  return program;
}

function resolveImports(path: string, imports: ModuleImport[], ctx: LoaderContext): ModuleImportRecord[] {
  const records: ModuleImportRecord[] = [];
  for (const entry of imports) {
    const resolvedPath = resolveModuleSpecifier(path, entry.source, ctx.options);
    const specifiers = entry.specifiers.map((specifier) => parseImportSpecifier(specifier, path));
    records.push({
      sourcePath: resolvedPath,
      specifiers,
      span: entry.span,
      rawSource: entry.source,
      importerPath: path,
    });
  }
  return records;
}

function parseImportSpecifier(specifier: ImportSpecifier, path: string): NamedImportRecord {
  if (specifier.kind === "namespace") {
    throw new ModuleLoaderError(`Namespace imports are not supported in Stage M1 (${path})`);
  }
  return {
    imported: specifier.imported,
    local: specifier.local,
    span: specifier.span,
  };
}

function collectExports(program: Program, path: string): { values: string[]; types: string[] } {
  const valueNames: string[] = [];
  const typeNames: string[] = [];
  const valueSet = new Set<string>();
  const typeSet = new Set<string>();

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      forEachLetBinding(decl, (binding) => {
        if (binding.export) {
          if (valueSet.has(binding.name)) {
            throw new ModuleLoaderError(`Duplicate export '${binding.name}' in '${path}'`);
          }
          valueSet.add(binding.name);
          valueNames.push(binding.name);
        }
      });
    }
    if (decl.kind === "type" && decl.export) {
      if (typeSet.has(decl.name)) {
        throw new ModuleLoaderError(`Duplicate export '${decl.name}' in '${path}'`);
      }
      typeSet.add(decl.name);
      typeNames.push(decl.name);
    }
  }

  return { values: valueNames, types: typeNames };
}

function forEachLetBinding(decl: LetDeclaration, fn: (binding: LetDeclaration) => void): void {
  fn(decl);
  if (decl.mutualBindings) {
    for (const binding of decl.mutualBindings) {
      fn(binding);
    }
  }
}

function resolveModuleSpecifier(importerPath: string, specifier: string, options: ModuleLoaderOptions): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolve(dirname(importerPath), specifier);
    return ensureWmExtension(target);
  }

  if (isAbsolute(specifier)) {
    return ensureWmExtension(specifier);
  }

  if (specifier.startsWith("std/")) {
    for (const root of options.stdRoots ?? []) {
      const candidate = ensureWmExtension(join(root, specifier.slice(4)));
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    throw new ModuleLoaderError(`Module not found in std roots: '${specifier}' imported by '${importerPath}'`);
  }

  throw new ModuleLoaderError(`Unsupported module specifier '${specifier}' in '${importerPath}'`);
}

function ensureWmExtension(path: string): string {
  if (extname(path) === "") {
    return `${path}.wm`;
  }
  return path;
}

function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function applyImports(
  record: ModuleImportRecord,
  provider: ModuleSummary,
  targetEnv: Map<string, TypeScheme>,
  targetAdtEnv: Map<string, TypeInfo>,
  targetRuntime: Map<string, RuntimeValue>,
): void {
  for (const spec of record.specifiers) {
    const valueExport = provider.exports.values.get(spec.imported);
    const typeExport = provider.exports.types.get(spec.imported);
    if (!valueExport && !typeExport) {
      throw new ModuleLoaderError(
        `Module '${record.sourcePath}' does not export '${spec.imported}' (imported by '${record.importerPath}')`,
      );
    }

    if (valueExport) {
      if (targetEnv.has(spec.local)) {
        throw new ModuleLoaderError(
          `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
        );
      }
      targetEnv.set(spec.local, cloneTypeScheme(valueExport));
      const runtimeValue = provider.runtime.get(spec.imported);
      if (!runtimeValue) {
        throw new ModuleLoaderError(
          `Missing runtime value for export '${spec.imported}' from '${record.sourcePath}'`,
        );
      }
      targetRuntime.set(spec.local, runtimeValue);
    }

    if (typeExport) {
      if (spec.local !== spec.imported) {
        throw new ModuleLoaderError(
          `Type import aliasing is not supported in Stage M1 (imported '${spec.imported}' as '${spec.local}')`,
        );
      }
      if (targetAdtEnv.has(spec.imported)) {
        throw new ModuleLoaderError(
          `Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`,
        );
      }
      targetAdtEnv.set(spec.imported, cloneTypeInfo(typeExport));
    }
  }
}
