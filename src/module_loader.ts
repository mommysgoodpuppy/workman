import { dirname, extname, isAbsolute, join, resolve } from "./io.ts";
import { lex } from "./lexer.ts";
import { type OperatorInfo, parseSurfaceProgram } from "./parser.ts";
import { InferError, LexError, ModuleError, ParseError } from "./error.ts";
import type {
  ImportSpecifier,
  LetDeclaration,
  ModuleImport,
  ModuleReexport,
  Program,
  SourceSpan,
} from "./ast.ts";
import type { TypeInfo, TypeScheme } from "./types.ts";
import { cloneTypeInfo, cloneTypeScheme, unknownType } from "./types.ts";
import { inferProgram } from "./layer1/infer.ts";
import { evaluateProgram } from "./eval.ts";
import type { RuntimeValue } from "./value.ts";
import { lookupValue } from "./value.ts";
import { formatScheme } from "./type_printer.ts";
import { formatRuntimeValue } from "./value_printer.ts";
import { IO, isNotFoundError } from "./io.ts";

export interface ModuleLoaderOptions {
  stdRoots?: string[];
  preludeModule?: string;
  skipEvaluation?: boolean;
  /** Map of absolute file paths to their in-memory content (for LSP) */
  sourceOverrides?: Map<string, string>;
}

export interface ModuleGraph {
  entry: string;
  prelude?: string;
  order: string[];
  nodes: Map<string, ModuleNode>;
}

export interface ModuleNode {
  path: string;
  program: Program;
  source: string;
  imports: ModuleImportRecord[];
  reexports: ModuleReexportRecord[];
  exportedValueNames: string[];
  exportedTypeNames: string[];
  exportedOperators: Map<string, OperatorInfo>;
  exportedPrefixOperators: Set<string>;
}

type ModuleSourceKind = "workman" | "js";

export interface ModuleImportRecord {
  sourcePath: string;
  kind: ModuleSourceKind;
  specifiers: NamedImportRecord[];
  span: SourceSpan;
  rawSource: string;
  importerPath: string;
}

export interface ModuleReexportRecord {
  sourcePath: string;
  typeExports: TypeReexportRecord[];
  span: SourceSpan;
  rawSource: string;
  importerPath: string;
}

export interface NamedImportRecord {
  imported: string;
  local: string;
  span: SourceSpan;
}

export interface TypeReexportRecord {
  name: string;
  exportConstructors: boolean;
  span: SourceSpan;
}

interface LoaderContext {
  options: ModuleLoaderOptions;
  programCache: Map<string, Program>;
  visitState: Map<string, "visiting" | "visited">;
  stack: string[];
  nodes: Map<string, ModuleNode>;
  order: string[];
  preludePath?: string;
}

export interface ModuleSummary {
  exports: {
    values: Map<string, TypeScheme>;
    types: Map<string, TypeInfo>;
    operators: Map<string, OperatorInfo>;
  };
  runtime: Map<string, RuntimeValue>;
  letSchemes: Map<string, TypeScheme>;
  letSchemeOrder: string[];
  letRuntime: Map<string, RuntimeValue>;
  letValueOrder: string[];
}

// Re-export ModuleError as ModuleLoaderError for backwards compatibility
export { ModuleError as ModuleLoaderError } from "./error.ts";

// Helper to create module errors
function moduleError(message: string, modulePath?: string): ModuleError {
  return new ModuleError(message, modulePath);
}

function normalizeModulePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function sameModulePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeModulePath(a) === normalizeModulePath(b);
}

function isStdCoreModule(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/std/core/") ||
    normalized.includes("std/core/") || // For relative paths
    normalized.endsWith("/std/list/core.wm") ||
    normalized.endsWith("std/list/core.wm") ||
    normalized.endsWith("/std/option/core.wm") ||
    normalized.endsWith("std/option/core.wm") ||
    normalized.endsWith("/std/result/core.wm") ||
    normalized.endsWith("std/result/core.wm");
}

export async function loadModuleGraph(
  entryPath: string,
  options: ModuleLoaderOptions = {},
): Promise<ModuleGraph> {
  const normalizedEntry = resolveEntryPath(entryPath);
  const normalizedOptions = normalizeOptions(options);

  let preludePath: string | undefined;
  if (normalizedOptions.preludeModule) {
    preludePath = resolveModuleSpecifier(
      normalizedEntry,
      normalizedOptions.preludeModule,
      normalizedOptions,
    );
  }

  const ctx: LoaderContext = {
    options: normalizedOptions,
    programCache: new Map(),
    visitState: new Map(),
    stack: [],
    nodes: new Map(),
    order: [],
    preludePath,
  };

  if (preludePath) {
    await visitModule(preludePath, ctx);
  }

  await visitModule(normalizedEntry, ctx);
  return {
    entry: normalizedEntry,
    prelude: preludePath,
    order: ctx.order,
    nodes: ctx.nodes,
  };
}

function applyReexports(
  record: ModuleReexportRecord,
  provider: ModuleSummary,
  exportedValues: Map<string, TypeScheme>,
  exportedTypes: Map<string, TypeInfo>,
  exportedRuntime?: Map<string, RuntimeValue>,
): void {
  for (const typeExport of record.typeExports) {
    const providedType = provider.exports.types.get(typeExport.name);
    if (!providedType) {
      throw moduleError(
        `Module '${record.importerPath}' re-exports type '${typeExport.name}' from '${record.rawSource}' which does not export it`,
      );
    }
    if (exportedTypes.has(typeExport.name)) {
      throw moduleError(
        `Duplicate export '${typeExport.name}' in '${record.importerPath}'`,
      );
    }
    const clonedInfo = cloneTypeInfo(providedType);
    exportedTypes.set(typeExport.name, clonedInfo);
    if (typeExport.exportConstructors) {
      for (const ctor of clonedInfo.constructors) {
        const providedScheme = provider.exports.values.get(ctor.name);
        if (!providedScheme) {
          throw moduleError(
            `Module '${record.importerPath}' re-exports constructors for type '${typeExport.name}' but constructor '${ctor.name}' is missing in provider`,
          );
        }
        if (exportedValues.has(ctor.name)) {
          throw moduleError(
            `Duplicate export '${ctor.name}' in '${record.importerPath}'`,
          );
        }
        exportedValues.set(ctor.name, cloneTypeScheme(providedScheme));
        if (exportedRuntime) {
          const runtimeValue = provider.runtime.get(ctor.name);
          if (!runtimeValue) {
            throw moduleError(
              `Module '${record.importerPath}' re-exports constructor '${ctor.name}' from '${record.rawSource}' but runtime value is missing in provider`,
            );
          }
          exportedRuntime.set(ctor.name, runtimeValue);
        }
      }
    }
  }
}

export async function runEntryPath(
  entryPath: string,
  options: ModuleLoaderOptions = {},
): Promise<{
  types: { name: string; type: string }[];
  values: { name: string; value: string }[];
  runtimeLogs: string[];
}> {
  const graph = await loadModuleGraph(entryPath, options);
  const { moduleSummaries, runtimeLogs } = await summarizeGraph(graph, options);
  const entryNode = graph.nodes.get(graph.entry);
  const entrySummary = moduleSummaries.get(graph.entry);
  if (!entryNode || !entrySummary) {
    throw moduleError(
      `Internal error: failed to load entry module '${graph.entry}'`,
    );
  }
  const types = entrySummary.letSchemeOrder.map((name) => {
    const scheme = entrySummary.letSchemes.get(name);
    if (!scheme) {
      throw moduleError(
        `Missing type information for '${name}' in '${graph.entry}'`,
      );
    }
    return { name, type: formatScheme(scheme) };
  });

  const values = entrySummary.letValueOrder.map((name) => {
    const value = entrySummary.letRuntime.get(name);
    if (!value) {
      throw moduleError(
        `Missing runtime value for '${name}' in '${graph.entry}'`,
      );
    }
    return { name, value: formatRuntimeValue(value) };
  });

  return { types, values, runtimeLogs };
}

export async function loadModuleSummaries(
  entryPath: string,
  options: ModuleLoaderOptions = {},
): Promise<{
  graph: ModuleGraph;
  summaries: Map<string, ModuleSummary>;
}> {
  const graph = await loadModuleGraph(entryPath, options);
  const { moduleSummaries } = await summarizeGraph(graph, options);
  return { graph, summaries: moduleSummaries };
}

export async function loadPreludeEnvironment(
  options: ModuleLoaderOptions = {},
): Promise<{
  env: Map<string, TypeScheme>;
  adtEnv: Map<string, TypeInfo>;
  operators: Map<string, OperatorInfo>;
  prefixOperators: Set<string>;
}> {
  const normalizedOptions = normalizeOptions(options);
  const preludePath = resolveEntryPath(
    normalizedOptions.preludeModule ?? "std/prelude",
  );
  const { graph, summaries } = await loadModuleSummaries(preludePath, {
    ...normalizedOptions,
    preludeModule: normalizedOptions.preludeModule,
  });
  const preludeSummary = summaries.get(preludePath);
  const preludeNode = graph.nodes.get(preludePath);
  if (!preludeSummary || !preludeNode) {
    throw moduleError(`Failed to load std prelude at '${preludePath}'`);
  }
  const env = new Map<string, TypeScheme>();
  for (const [name, scheme] of preludeSummary.exports.values.entries()) {
    env.set(name, cloneTypeScheme(scheme));
  }
  for (const decl of preludeNode.program.declarations) {
    if (decl.kind === "infix") {
      const opName = `__op_${decl.operator}`;
      const impl = preludeSummary.exports.values.get(decl.implementation);
      if (impl) {
        env.set(opName, cloneTypeScheme(impl));
      }
    }
    if (decl.kind === "prefix") {
      const opName = `__prefix_${decl.operator}`;
      const impl = preludeSummary.exports.values.get(decl.implementation);
      if (impl) {
        env.set(opName, cloneTypeScheme(impl));
      }
    }
  }
  const adtEnv = new Map<string, TypeInfo>();
  for (const [name, info] of preludeSummary.exports.types.entries()) {
    adtEnv.set(name, cloneTypeInfo(info));
  }
  const operators = new Map(preludeNode.exportedOperators);
  const prefixOperators = new Set(preludeNode.exportedPrefixOperators);
  return { env, adtEnv, operators, prefixOperators };
}

async function summarizeGraph(
  graph: ModuleGraph,
  options: ModuleLoaderOptions = {},
): Promise<{
  moduleSummaries: Map<string, ModuleSummary>;
  runtimeLogs: string[];
}> {
  const normalizedOptions = normalizeOptions(options);
  const skipEvaluation = normalizedOptions.skipEvaluation ?? false;
  const moduleSummaries = new Map<string, ModuleSummary>();
  const runtimeLogs: string[] = [];
  const preludePath = graph.prelude;
  let preludeSummary: ModuleSummary | undefined = undefined;

  let counterInitialized = false;
  for (const path of graph.order) {
    const node = graph.nodes.get(path);
    if (!node) {
      throw moduleError(`Internal error: missing node for '${path}'`);
    }

    const hasJsImports = node.imports.some((record) => record.kind === "js");
    if (hasJsImports && !skipEvaluation) {
      throw moduleError(
        `Module '${path}' imports a JavaScript module ('${
          node.imports.find((record) => record.kind === "js")?.rawSource ??
            "unknown"
        }'). ` +
          "Run through the compiler pipeline (e.g., 'wm compile') to enable JS interop.",
        path,
      );
    }

    const initialEnv = new Map<string, TypeScheme>();
    const initialAdtEnv = new Map<string, TypeInfo>();
    const initialBindings = skipEvaluation
      ? undefined
      : new Map<string, RuntimeValue>();
    const skipPrelude = isStdCoreModule(path);

    for (const record of node.imports) {
      if (record.kind === "js") {
        seedJsImports(record, initialEnv);
        continue;
      }
      const provider = moduleSummaries.get(record.sourcePath);
      if (!provider) {
        throw moduleError(
          `Module '${path}' depends on '${record.sourcePath}' which failed to load`,
        );
      }
      applyImports(
        record,
        provider,
        initialEnv,
        initialAdtEnv,
        initialBindings,
      );
    }

    if (preludeSummary && path !== preludePath && !skipPrelude) {
      for (const [name, scheme] of preludeSummary.exports.values.entries()) {
        if (!initialEnv.has(name)) {
          initialEnv.set(name, cloneTypeScheme(scheme));
        }
      }
      for (const [name, info] of preludeSummary.exports.types.entries()) {
        if (!initialAdtEnv.has(name)) {
          initialAdtEnv.set(name, cloneTypeInfo(info));
        }
      }
      if (!skipEvaluation && initialBindings) {
        for (const [name, value] of preludeSummary.runtime.entries()) {
          if (!initialBindings.has(name)) {
            initialBindings.set(name, value);
          }
        }
      }

      // Register operator implementation functions
      const preludeNode = graph.nodes.get(preludePath!);
      if (preludeNode) {
        for (const decl of preludeNode.program.declarations) {
          if (decl.kind === "infix") {
            const opFuncName = `__op_${decl.operator}`;
            const implScheme = preludeSummary.exports.values.get(
              decl.implementation,
            );
            if (implScheme && !initialEnv.has(opFuncName)) {
              initialEnv.set(opFuncName, cloneTypeScheme(implScheme));
            }
            if (!skipEvaluation && initialBindings) {
              const implValue = preludeSummary.runtime.get(decl.implementation);
              if (implValue && !initialBindings.has(opFuncName)) {
                initialBindings.set(opFuncName, implValue);
              }
            }
          }
          if (decl.kind === "prefix") {
            const opFuncName = `__prefix_${decl.operator}`;
            const implScheme = preludeSummary.exports.values.get(
              decl.implementation,
            );
            if (implScheme && !initialEnv.has(opFuncName)) {
              initialEnv.set(opFuncName, cloneTypeScheme(implScheme));
            }
            if (!skipEvaluation && initialBindings) {
              const implValue = preludeSummary.runtime.get(decl.implementation);
              if (implValue && !initialBindings.has(opFuncName)) {
                initialBindings.set(opFuncName, implValue);
              }
            }
          }
        }
      }
    }

    let inference;
    const shouldResetCounter = !counterInitialized;
    try {
      inference = inferProgram(node.program, {
        initialEnv,
        initialAdtEnv,
        resetCounter: shouldResetCounter,
        source: node.source,
      });
    } catch (error) {
      if (error instanceof InferError) {
        // Format the error with location info if available
        const formatted = error.format(node.source);
        throw moduleError(formatted, path);
      }
      throw error;
    }

    const letSchemes = new Map<string, TypeScheme>();
    const letSchemeOrder: string[] = [];
    for (const { name, scheme } of inference.summaries) {
      if (letSchemes.has(name)) {
        throw moduleError(
          `Duplicate let binding '${name}' inferred in '${path}'`,
        );
      }
      letSchemes.set(name, cloneTypeScheme(scheme));
      letSchemeOrder.push(name);
    }

    const exportedValues = new Map<string, TypeScheme>();
    const exportedTypes = new Map<string, TypeInfo>();
    const reexportedRuntime = skipEvaluation
      ? undefined
      : new Map<string, RuntimeValue>();

    for (const record of node.reexports) {
      const provider = moduleSummaries.get(record.sourcePath);
      if (!provider) {
        throw moduleError(
          `Module '${path}' depends on '${record.sourcePath}' which failed to load`,
        );
      }
      applyReexports(
        record,
        provider,
        exportedValues,
        exportedTypes,
        reexportedRuntime,
      );
    }

    for (const name of node.exportedValueNames) {
      const scheme = letSchemes.get(name) ?? inference.env.get(name);
      if (!scheme) {
        throw moduleError(
          `Exported let '${name}' was not inferred in '${path}'`,
        );
      }
      if (exportedValues.has(name)) {
        throw moduleError(`Duplicate export '${name}' in '${path}'`);
      }
      exportedValues.set(name, cloneTypeScheme(scheme));
    }

    for (const typeName of node.exportedTypeNames) {
      const info = inference.adtEnv.get(typeName);
      if (!info) {
        throw moduleError(
          `Exported type '${typeName}' was not defined in '${path}'`,
        );
      }
      if (exportedTypes.has(typeName)) {
        throw moduleError(`Duplicate export '${typeName}' in '${path}'`);
      }
      const clonedInfo = cloneTypeInfo(info);
      exportedTypes.set(typeName, clonedInfo);
      for (const ctor of clonedInfo.constructors) {
        const scheme = inference.env.get(ctor.name);
        if (!scheme) {
          throw moduleError(
            `Constructor '${ctor.name}' for type '${typeName}' missing in '${path}'`,
          );
        }
        if (exportedValues.has(ctor.name)) {
          throw moduleError(`Duplicate export '${ctor.name}' in '${path}'`);
        }
        exportedValues.set(ctor.name, cloneTypeScheme(scheme));
      }
    }

    let letRuntime = new Map<string, RuntimeValue>();
    let letValueOrder: string[] = [];
    let runtimeExports: Map<string, RuntimeValue>;

    if (!skipEvaluation) {
      const evaluation = evaluateProgram(node.program, {
        sourceName: path,
        source: node.source,
        initialBindings: initialBindings ?? new Map<string, RuntimeValue>(),
        onPrint: (text) => {
          runtimeLogs.push(text);
        },
      });

      letRuntime = new Map<string, RuntimeValue>();
      letValueOrder = [];
      for (const summary of evaluation.summaries) {
        letRuntime.set(summary.name, summary.value);
        letValueOrder.push(summary.name);
      }

      runtimeExports = new Map<string, RuntimeValue>(reexportedRuntime);
      for (const name of exportedValues.keys()) {
        if (runtimeExports.has(name)) {
          continue;
        }
        const value = letRuntime.get(name) ?? lookupValue(evaluation.env, name);
        runtimeExports.set(name, value);
      }
    } else {
      runtimeExports = new Map<string, RuntimeValue>();
      letRuntime = new Map<string, RuntimeValue>();
      letValueOrder = [];
    }

    moduleSummaries.set(path, {
      exports: {
        values: exportedValues,
        types: exportedTypes,
        operators: node.exportedOperators,
      },
      runtime: runtimeExports,
      letSchemes,
      letSchemeOrder,
      letRuntime,
      letValueOrder,
    });

    if (path === preludePath) {
      preludeSummary = moduleSummaries.get(path);
    }
    counterInitialized = true;
  }
  return { moduleSummaries, runtimeLogs };
}

function normalizeOptions(options: ModuleLoaderOptions): ModuleLoaderOptions {
  const stdRoots = options.stdRoots && options.stdRoots.length > 0
    ? options.stdRoots.map((root) => resolve(root))
    : [resolve("std")];
  const preludeModule = options.preludeModule ?? "std/prelude";
  const skipEvaluation = options.skipEvaluation ?? false;
  const sourceOverrides = options.sourceOverrides;
  return { stdRoots, preludeModule, skipEvaluation, sourceOverrides };
}

function resolveEntryPath(path: string): string {
  const normalized = isAbsolute(path) ? path : resolve(path);
  return ensureWmExtension(normalized);
}

async function visitModule(path: string, ctx: LoaderContext): Promise<void> {
  const state = ctx.visitState.get(path);
  if (state === "visiting") {
    const cycle = [...ctx.stack, path];
    throw moduleError(`Circular import detected: ${cycle.join(" -> ")}`);
  }
  if (state === "visited") {
    return;
  }

  ctx.visitState.set(path, "visiting");
  ctx.stack.push(path);
  try {
    // First pass: try to parse without operators to discover imports
    // If this fails due to unknown operators, we'll retry after collecting them
    let program: Program | null = null;
    let imports: ModuleImportRecord[] = [];
    let reexports: ModuleReexportRecord[] = [];

    try {
      program = await loadProgram(path, ctx);
      imports = resolveImports(path, program.imports, ctx);
      reexports = collectReexports(
        program.reexports,
        path,
        ctx.options,
        ctx.preludePath,
      );
    } catch (error) {
      // If parse failed, we'll need to parse with operators later
      // For now, just continue - we can't discover imports without parsing
      if (
        error instanceof ModuleError && error.message.includes("Parse Error")
      ) {
        // Parse failed, likely due to operators - we'll handle this after visiting dependencies
        program = null;
      } else {
        throw error;
      }
    }

    // If we couldn't parse, we need to visit prelude/dependencies first
    // For now, assume standard dependencies
    if (!program) {
      // Visit prelude if available
      if (
        ctx.preludePath && path !== ctx.preludePath && !isStdCoreModule(path)
      ) {
        if (!ctx.nodes.has(ctx.preludePath)) {
          await visitModule(ctx.preludePath, ctx);
        }
      }
    } else {
      // Visit dependencies discovered from first parse
      for (const record of imports) {
        if (record.kind === "workman") {
          await visitModule(record.sourcePath, ctx);
        }
      }

      for (const record of reexports) {
        await visitModule(record.sourcePath, ctx);
      }
    }

    // Collect operators from dependencies
    const availableOperators = new Map<string, OperatorInfo>();
    const availablePrefixOperators = new Set<string>();

    // Include prelude operators if this isn't the prelude or a std core module
    const skipPrelude = isStdCoreModule(path);
    if (ctx.preludePath && path !== ctx.preludePath && !skipPrelude) {
      const preludeNode = ctx.nodes.get(ctx.preludePath);
      if (preludeNode) {
        for (const [op, info] of preludeNode.exportedOperators) {
          availableOperators.set(op, info);
        }
        for (const op of preludeNode.exportedPrefixOperators) {
          availablePrefixOperators.add(op);
        }
      }
    }

    // Include operators from explicit imports (if we had a successful first parse)
    if (program) {
      for (const record of imports) {
        const depNode = ctx.nodes.get(record.sourcePath);
        if (depNode) {
          for (const [op, info] of depNode.exportedOperators) {
            availableOperators.set(op, info);
          }
          for (const op of depNode.exportedPrefixOperators) {
            availablePrefixOperators.add(op);
          }
        }
      }
    }

    // Parse or reparse with operators
    let finalProgram: Program;
    if (
      !program || availableOperators.size > 0 ||
      availablePrefixOperators.size > 0
    ) {
      ctx.programCache.delete(path); // Clear cache to force reparse
      finalProgram = await loadProgram(
        path,
        ctx,
        availableOperators,
        availablePrefixOperators,
      );
      // Update imports/reexports from the successful parse
      imports = resolveImports(path, finalProgram.imports, ctx);
      reexports = collectReexports(
        finalProgram.reexports,
        path,
        ctx.options,
        ctx.preludePath,
      );
    } else {
      finalProgram = program;
    }

    // Ensure dependencies are visited even if the initial parse failed
    for (const record of imports) {
      if (
        record.kind === "workman" &&
        ctx.visitState.get(record.sourcePath) !== "visited"
      ) {
        await visitModule(record.sourcePath, ctx);
      }
    }

    for (const record of reexports) {
      if (ctx.visitState.get(record.sourcePath) !== "visited") {
        await visitModule(record.sourcePath, ctx);
      }
    }

    const exports = collectExports(finalProgram, path);

    ctx.nodes.set(path, {
      path,
      program: finalProgram,
      source: await loadSource(path, ctx),
      imports,
      reexports,
      exportedValueNames: exports.values,
      exportedTypeNames: exports.types,
      exportedOperators: exports.operators,
      exportedPrefixOperators: exports.prefixOperators,
    });

    ctx.visitState.set(path, "visited");
    ctx.order.push(path);
  } finally {
    ctx.stack.pop();
  }
}

async function loadSource(path: string, ctx: LoaderContext): Promise<string> {
  // Check for in-memory override (e.g., from LSP)
  const override = ctx.options.sourceOverrides?.get(path);
  if (override !== undefined) {
    return override;
  }

  try {
    return await IO.readTextFile(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw moduleError(`Module not found: '${path}'`);
    }
    throw moduleError(
      `Failed to read '${path}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadProgram(
  path: string,
  ctx: LoaderContext,
  operators?: Map<string, OperatorInfo>,
  prefixOperators?: Set<string>,
): Promise<Program> {
  const cached = ctx.programCache.get(path);
  if (cached) {
    return cached;
  }
  const source = await loadSource(path, ctx);
  let program: Program;
  try {
    const tokens = lex(source, path);
    program = parseSurfaceProgram(
      tokens,
      source,
      false,
      operators,
      prefixOperators,
    );
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      const formatted = error.format(source);
      throw moduleError(`${formatted}`, path);
    }
    throw error;
  }
  ctx.programCache.set(path, program);
  return program;
}

function resolveImports(
  path: string,
  imports: ModuleImport[],
  ctx: LoaderContext,
): ModuleImportRecord[] {
  const records: ModuleImportRecord[] = [];
  for (const entry of imports) {
    const resolvedPath = resolveModuleSpecifier(
      path,
      entry.source,
      ctx.options,
    );
    const kind = detectModuleKind(resolvedPath);
    if (kind === "workman" && sameModulePath(resolvedPath, ctx.preludePath)) {
      throw moduleError(
        `Module '${path}' cannot import '${entry.source}' because the std prelude is loaded automatically.`,
        path,
      );
    }
    if (kind === "js" && !existsSync(resolvedPath)) {
      throw moduleError(
        `JavaScript module '${entry.source}' imported by '${path}' was not found at '${resolvedPath}'`,
        path,
      );
    }
    const specifiers = entry.specifiers.map((specifier) =>
      parseImportSpecifier(specifier, path)
    );
    records.push({
      sourcePath: resolvedPath,
      kind,
      specifiers,
      span: entry.span,
      rawSource: entry.source,
      importerPath: path,
    });
  }
  return records;
}

function parseImportSpecifier(
  specifier: ImportSpecifier,
  path: string,
): NamedImportRecord {
  if (specifier.kind === "namespace") {
    throw moduleError(
      `Namespace imports are not supported in Stage M1 (${path})`,
    );
  }
  return {
    imported: specifier.imported,
    local: specifier.local,
    span: specifier.span,
  };
}

function collectExports(
  program: Program,
  path: string,
): {
  values: string[];
  types: string[];
  operators: Map<string, OperatorInfo>;
  prefixOperators: Set<string>;
} {
  const valueNames: string[] = [];
  const typeNames: string[] = [];
  const operators = new Map<string, OperatorInfo>();
  const prefixOperators = new Set<string>();
  const valueSet = new Set<string>();
  const typeSet = new Set<string>();

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      forEachLetBinding(decl, (binding) => {
        if (binding.export) {
          if (valueSet.has(binding.name)) {
            throw moduleError(
              `Duplicate export '${binding.name}' in '${path}'`,
            );
          }
          valueSet.add(binding.name);
          valueNames.push(binding.name);
        }
      });
    }
    if (decl.kind === "type" && decl.export) {
      if (typeSet.has(decl.name)) {
        throw moduleError(`Duplicate export '${decl.name}' in '${path}'`);
      }
      typeSet.add(decl.name);
      typeNames.push(decl.name);
    }
    if (decl.kind === "infix" && decl.export) {
      operators.set(decl.operator, {
        precedence: decl.precedence,
        associativity: decl.associativity,
      });
    }
    if (decl.kind === "prefix" && decl.export) {
      prefixOperators.add(decl.operator);
    }
  }

  return { values: valueNames, types: typeNames, operators, prefixOperators };
}

function collectReexports(
  reexports: ModuleReexport[],
  path: string,
  options: ModuleLoaderOptions,
  preludePath?: string,
): ModuleReexportRecord[] {
  const records: ModuleReexportRecord[] = [];
  for (const entry of reexports) {
    const resolvedPath = resolveModuleSpecifier(path, entry.source, options);
    const kind = detectModuleKind(resolvedPath);
    if (kind === "js") {
      throw moduleError(
        `Module '${path}' cannot re-export from JavaScript module '${entry.source}'`,
        path,
      );
    }
    if (sameModulePath(resolvedPath, preludePath)) {
      throw moduleError(
        `Module '${path}' cannot re-export from '${entry.source}' because the std prelude is loaded automatically.`,
        path,
      );
    }
    records.push({
      sourcePath: resolvedPath,
      typeExports: entry.typeExports.map((typeExport) => ({
        name: typeExport.name,
        exportConstructors: typeExport.exportConstructors,
        span: typeExport.span,
      })),
      span: entry.span,
      rawSource: entry.source,
      importerPath: path,
    });
  }
  return records;
}

function forEachLetBinding(
  decl: LetDeclaration,
  fn: (binding: LetDeclaration) => void,
): void {
  fn(decl);
  if (decl.mutualBindings) {
    for (const binding of decl.mutualBindings) {
      fn(binding);
    }
  }
}

function resolveModuleSpecifier(
  importerPath: string,
  specifier: string,
  options: ModuleLoaderOptions,
): string {
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
    throw moduleError(
      `Module not found in std roots: '${specifier}' imported by '${importerPath}'`,
    );
  }

  throw moduleError(
    `Unsupported module specifier '${specifier}' in '${importerPath}'`,
  );
}

function ensureWmExtension(path: string): string {
  if (extname(path) === "") {
    return `${path}.wm`;
  }
  return path;
}

function detectModuleKind(path: string): ModuleSourceKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".js" || extension === ".mjs") {
    return "js";
  }
  return "workman";
}

function existsSync(path: string): boolean {
  try {
    IO.statSync(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
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
  targetRuntime?: Map<string, RuntimeValue>,
): void {
  for (const spec of record.specifiers) {
    const valueExport = provider.exports.values.get(spec.imported);
    const typeExport = provider.exports.types.get(spec.imported);
    if (!valueExport && !typeExport) {
      throw moduleError(
        `Module '${record.sourcePath}' does not export '${spec.imported}' (imported by '${record.importerPath}')`,
      );
    }

    if (valueExport) {
      if (targetEnv.has(spec.local)) {
        throw moduleError(
          `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
        );
      }
      targetEnv.set(spec.local, cloneTypeScheme(valueExport));
      if (targetRuntime) {
        const runtimeValue = provider.runtime.get(spec.imported);
        if (!runtimeValue) {
          throw moduleError(
            `Missing runtime value for export '${spec.imported}' from '${record.sourcePath}'`,
          );
        }
        targetRuntime.set(spec.local, runtimeValue);
      }
    }

    if (typeExport) {
      if (spec.local !== spec.imported) {
        throw moduleError(
          `Type import aliasing is not supported in Stage M1 (imported '${spec.imported}' as '${spec.local}')`,
        );
      }
      if (targetAdtEnv.has(spec.imported)) {
        throw moduleError(
          `Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`,
        );
      }
      targetAdtEnv.set(spec.imported, cloneTypeInfo(typeExport));
    }
  }
}

function seedJsImports(
  record: ModuleImportRecord,
  targetEnv: Map<string, TypeScheme>,
): void {
  for (const spec of record.specifiers) {
    if (targetEnv.has(spec.local)) {
      throw moduleError(
        `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
      );
    }
    targetEnv.set(spec.local, createJsImportScheme(spec, record));
  }
}

function createJsImportScheme(
  spec: NamedImportRecord,
  record: ModuleImportRecord,
): TypeScheme {
  return {
    quantifiers: [],
    type: unknownType({
      kind: "incomplete",
      reason:
        `js import '${spec.imported}' from '${record.rawSource}' in '${record.importerPath}'`,
    }),
  };
}
