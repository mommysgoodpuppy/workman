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
import type { RuntimeValue } from "./value.ts";
import { lookupValue } from "./value.ts";
import { formatScheme } from "./type_printer.ts";
import { IO, isNotFoundError, toFileUrl } from "./io.ts";
import {
  collectInfectionDeclarations,
  InfectionRegistry,
  type InfectionSummary,
} from "./infection_registry.ts";
import {
  compileWorkmanGraph,
  type WorkmanCompilerOptions,
} from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";

export interface ModuleLoaderOptions {
  stdRoots?: string[];
  preludeModule?: string;
  infectionModule?: string;
  skipEvaluation?: boolean;
  /** Map of absolute file paths to their in-memory content (for LSP) */
  sourceOverrides?: Map<string, string>;
  /** Enable tolerant parsing (used by LSP for incomplete code) */
  tolerantParsing?: boolean;
  /** Optional foreign type provider for C header imports in raw mode */
  foreignTypes?: ForeignTypeConfig;
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

type ModuleSourceKind = "workman" | "js" | "zig" | "c_header";

export interface ForeignTypeRequest {
  headerPath: string;
  specifiers: NamedImportRecord[];
  includeDirs: string[];
  defines: string[];
  buildWmPath?: string;
  importerPath: string;
  rawMode: boolean;
}

export interface ForeignTypeResult {
  values: Map<string, TypeScheme>;
  types: Map<string, TypeInfo>;
  diagnostics?: { message: string; detail?: string }[];
}

export type ForeignTypeProvider = (
  request: ForeignTypeRequest,
) => Promise<ForeignTypeResult>;

export interface ForeignTypeConfig {
  provider?: ForeignTypeProvider;
  includeDirs?: string[];
  defines?: string[];
  // When using C headers in raw mode, build.wm should supply include/define info.
  buildWmPath?: string;
}

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
  infection: InfectionSummary;
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

export function isStdCoreModule(program: Program): boolean {
  return program.core === true;
}

export async function loadModuleGraph(
  entryPath: string,
  options: ModuleLoaderOptions = {},
): Promise<ModuleGraph> {
  //console.log("  [DEBUG] loadModuleGraph: starting");
  const normalizedEntry = resolveEntryPath(entryPath);
  //console.log("  [DEBUG] loadModuleGraph: entry resolved to", normalizedEntry);
  const normalizedOptions = normalizeOptions(options);
  //console.log("  [DEBUG] loadModuleGraph: options normalized");

  let preludePath: string | undefined;
  if (normalizedOptions.preludeModule) {
    //console.log("  [DEBUG] loadModuleGraph: resolving prelude");
    preludePath = resolveModuleSpecifier(
      normalizedEntry,
      normalizedOptions.preludeModule,
      normalizedOptions,
    );
    //console.log("  [DEBUG] loadModuleGraph: prelude resolved to", preludePath);
  }

  const rawPreludePath = resolveModuleSpecifier(
    normalizedEntry,
    "std/zig/prelude",
    normalizedOptions,
  );
  const isUsingRawPrelude = preludePath === rawPreludePath;

  //console.log("  [DEBUG] loadModuleGraph: creating context");
  const ctx: LoaderContext = {
    options: normalizedOptions,
    programCache: new Map(),
    visitState: new Map(),
    stack: [],
    nodes: new Map(),
    order: [],
    preludePath,
  };
  //console.log("  [DEBUG] loadModuleGraph: context created");

  if (preludePath) {
    //console.log("  [DEBUG] loadModuleGraph: visiting prelude");
    await visitModule(preludePath, ctx);
  }

  //console.log("  [DEBUG] loadModuleGraph: visiting entry module");
  await visitModule(normalizedEntry, ctx);

  // Check if entry module is in raw mode and we're not already using raw prelude
  const entryNode = ctx.nodes.get(normalizedEntry);
  if (entryNode?.program.mode === "raw" && !isUsingRawPrelude) {
    // Restart with raw prelude
    return loadModuleGraph(entryPath, {
      ...options,
      preludeModule: "std/zig/prelude",
    });
  }

  //console.log("  [DEBUG] loadModuleGraph: done");
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
  const compilerOptions: WorkmanCompilerOptions = {
    loader: {
      ...options,
      skipEvaluation: options.skipEvaluation ?? true,
    },
  };

  const { coreGraph, modules } = await compileWorkmanGraph(
    entryPath,
    compilerOptions,
  );
  const entryKey = coreGraph.entry;
  const artifact = modules.get(entryKey);
  if (!artifact) {
    throw moduleError(
      `Internal error: failed to locate entry module artifacts for '${entryKey}'`,
    );
  }

  const hasTypeErrors = artifact.analysis.layer2.diagnostics.length > 0 ||
    artifact.analysis.layer3.diagnostics.solver.length > 0 ||
    artifact.analysis.layer3.diagnostics.conflicts.length > 0 ||
    artifact.analysis.layer3.diagnostics.flow.length > 0;
  if (hasTypeErrors) {
    throw moduleError(
      `Type errors detected in '${artifact.node.path}'`,
      artifact.node.path,
    );
  }

  const types = artifact.analysis.layer3.summaries.map((summary) => ({
    name: summary.name,
    type: formatScheme(summary.scheme),
  }));

  const tmpDir = await IO.makeTempDir({ prefix: "workman-run-" });
  const runtimeLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    const message = args.map((arg) => safeToString(arg)).join(" ");
    runtimeLogs.push(message);
  };
  try {
    const emitResult = await emitModuleGraph(coreGraph, {
      outDir: tmpDir,
      invokeEntrypoint: false,
    });
    const moduleUrl = toFileUrl(emitResult.entryPath).href;
    const moduleExports = await import(moduleUrl) as Record<string, unknown>;
    const values = [];
    for (const summary of artifact.analysis.layer3.summaries) {
      const exportedName = summary.name;
      if (!Object.prototype.hasOwnProperty.call(moduleExports, exportedName)) {
        values.push({ name: exportedName, value: "<unavailable>" });
        continue;
      }
      const rawValue = moduleExports[exportedName];
      const evaluated = await evaluateExportedValue(rawValue);
      values.push({
        name: exportedName,
        value: formatCompiledValueLegacy(evaluated),
      });
    }

    return { types, values, runtimeLogs };
  } finally {
    console.log = originalConsoleLog;
    await IO.remove(tmpDir, { recursive: true });
  }
}

export async function loadModuleSummaries(
  entryPath: string,
  options: ModuleLoaderOptions = {},
): Promise<{
  graph: ModuleGraph;
  summaries: Map<string, ModuleSummary>;
}> {
  try {
    //console.log("  [DEBUG] loadModuleSummaries: about to call loadModuleGraph");
    const graph = await loadModuleGraph(entryPath, options);
    //console.log("  [DEBUG] loadModuleSummaries: graph loaded");
    const { moduleSummaries } = await summarizeGraph(graph, options);
    //console.log("  [DEBUG] loadModuleSummaries: summaries created");
    return { graph, summaries: moduleSummaries };
  } catch (e) {
    console.log("  [DEBUG] Error in loadModuleSummaries:", e);
    throw e;
  }
}

export async function buildInfectionRegistryForModule(
  graph: ModuleGraph,
  summaries: Map<string, ModuleSummary>,
  modulePath: string,
  options: ModuleLoaderOptions = {},
): Promise<InfectionRegistry> {
  const normalizedOptions = normalizeOptions(options);
  const infectionPreludeRegistry = await loadInfectionPreludeRegistry(
    graph,
    normalizedOptions,
  );
  const registry = infectionPreludeRegistry.clone();
  const node = graph.nodes.get(modulePath);
  if (!node) {
    return registry;
  }

  for (const record of node.imports) {
    if (record.kind !== "workman") {
      continue;
    }
    const provider = summaries.get(record.sourcePath);
    if (provider) {
      registry.mergeSummary(provider.infection);
    }
  }

  const preludePath = graph.prelude;
  if (
    preludePath && modulePath !== preludePath && !isStdCoreModule(node.program)
  ) {
    const preludeSummary = summaries.get(preludePath);
    if (preludeSummary) {
      registry.mergeSummary(preludeSummary.infection);
    }
  }

  return registry;
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

async function readSourceWithOverrides(
  path: string,
  options: ModuleLoaderOptions,
): Promise<string> {
  const override = options.sourceOverrides?.get(path);
  if (override !== undefined) {
    return override;
  }
  return await IO.readTextFile(path);
}

async function loadInfectionPreludeRegistry(
  graph: ModuleGraph,
  options: ModuleLoaderOptions,
): Promise<InfectionRegistry> {
  const registry = new InfectionRegistry();
  const infectionModule = options.infectionModule ?? "std/infection/domains";
  if (!infectionModule) {
    return registry;
  }

  const basePath = graph.prelude ?? graph.entry;
  const infectionPath = resolveModuleSpecifier(
    basePath,
    infectionModule,
    options,
  );
  const source = await readSourceWithOverrides(infectionPath, options);
  const tokens = lex(source, infectionPath);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    undefined,
    undefined,
    { tolerant: options.tolerantParsing ?? false },
  );
  const summary = collectInfectionDeclarations(program);
  registry.mergeSummary(summary);
  return registry;
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
  const infectionPreludeRegistry = await loadInfectionPreludeRegistry(
    graph,
    normalizedOptions,
  );

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
    // Skip prelude for std/core modules only
    // Raw mode modules now use the zig prelude (set via restart in loadModuleGraph)
    const isRawMode = node.program.mode === "raw";
    const skipPrelude = isStdCoreModule(node.program);
    const initialRegistry = infectionPreludeRegistry.clone();

    for (const record of node.imports) {
      if (record.kind === "js" || record.kind === "zig") {
        seedForeignImports(record, initialEnv);
        continue;
      }
      if (record.kind === "c_header") {
        const handled = await applyForeignTypeImports(
          record,
          initialEnv,
          initialAdtEnv,
          normalizedOptions,
          isRawMode,
        );
        if (handled) {
          continue;
        }
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
        isRawMode,
      );
      initialRegistry.mergeSummary(provider.infection);
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
        // In raw mode, also register type names in the value environment so they can be
        // used as type arguments (e.g., allocArrayUninit(U8, 1024))
        if (isRawMode && !initialEnv.has(name)) {
          const parameterIds = info.parameters;
          const parameterTypes = parameterIds.map((id) => ({
            kind: "var" as const,
            id,
          }));
          const typeRefScheme: TypeScheme = {
            quantifiers: parameterIds,
            type: {
              kind: "constructor",
              name,
              args: parameterTypes,
            },
          };
          initialEnv.set(name, typeRefScheme);
        }
      }
      initialRegistry.mergeSummary(preludeSummary.infection);
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
        infectionRegistry: initialRegistry,
        rawMode: isRawMode,
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
        // Check if there's a record that might be what the user intended
        // Look for records with similar names (e.g., LetDecl -> LetDeclaration)
        const records = Array.from(inference.adtEnv.entries()).filter(
          ([name, info]) => info.recordFields !== undefined,
        );
        if (records.length > 0) {
          // Check for exact match with different casing or common variations
          const similarRecord = records.find(
            ([name]) =>
              name.toLowerCase() === typeName.toLowerCase() ||
              name.startsWith(typeName) ||
              typeName.startsWith(name),
          );
          const suggestion = similarRecord
            ? `Did you mean to export the record '${
              similarRecord[0]
            }'? Use 'export record ${similarRecord[0]}' instead.`
            : `If you want to export a record, use 'export record <name>' instead of 'export type <name>'.`;
          throw moduleError(
            `Exported type '${typeName}' was not defined in '${path}'. ${suggestion}`,
          );
        }
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

    runtimeExports = new Map<string, RuntimeValue>();
    letRuntime = new Map<string, RuntimeValue>();
    letValueOrder = [];

    const infectionSummary = collectInfectionDeclarations(node.program, {
      onlyExported: true,
    });

    moduleSummaries.set(path, {
      exports: {
        values: exportedValues,
        types: exportedTypes,
        operators: node.exportedOperators,
      },
      infection: infectionSummary,
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
  const infectionModule = options.infectionModule ?? "std/infection/domains";
  const skipEvaluation = options.skipEvaluation ?? true;
  const sourceOverrides = options.sourceOverrides;
  const tolerantParsing = options.tolerantParsing ?? false;
  const foreignTypes = options.foreignTypes;
  return {
    stdRoots,
    preludeModule,
    infectionModule,
    skipEvaluation,
    sourceOverrides,
    tolerantParsing,
    foreignTypes,
  };
}

async function evaluateExportedValue(value: unknown): Promise<unknown> {
  if (typeof value !== "function") {
    return value;
  }
  if (value.length > 0) {
    return value;
  }
  const result = value();
  if (isPromiseLike(result)) {
    return await result;
  }
  return result;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function";
}

function formatCompiledValueLegacy(
  value: unknown,
  seen: Set<unknown> = new Set(),
): string {
  if (value === undefined) return "()";
  if (value === null) return "null";
  const valueType = typeof value;
  if (valueType === "number" || valueType === "bigint") {
    return String(value);
  }
  if (valueType === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value;
  }
  if (valueType === "function") {
    return "<function>";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "<cyclic>";
    }
    seen.add(value);
    return `[${
      value.map((item) => formatCompiledValueLegacy(item, seen)).join(", ")
    }]`;
  }
  if (valueType === "object") {
    if (seen.has(value)) {
      return "<cyclic>";
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (isTaggedValue(record)) {
      return formatTaggedValueLegacy(record, seen);
    }
    return formatPlainObjectLegacy(record, seen);
  }
  return String(value);
}

function isTaggedValue(value: Record<string, unknown>): boolean {
  return typeof value.tag === "string" && typeof value.type === "string";
}

function formatTaggedValueLegacy(
  value: Record<string, unknown>,
  seen: Set<unknown>,
): string {
  const fieldNames = Object.keys(value)
    .filter((name) => name.startsWith("_"))
    .sort((a, b) => {
      const left = Number.parseInt(a.slice(1), 10);
      const right = Number.parseInt(b.slice(1), 10);
      if (Number.isNaN(left) || Number.isNaN(right)) {
        return a.localeCompare(b);
      }
      return left - right;
    });
  if (fieldNames.length === 0) {
    return String(value.tag);
  }
  const rendered = fieldNames.map((name) =>
    formatCompiledValueLegacy(value[name], seen)
  );
  return `${value.tag} ${rendered.join(" ")}`;
}

function formatPlainObjectLegacy(
  value: Record<string, unknown>,
  seen: Set<unknown>,
): string {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{ }";
  }
  const rendered = entries.map(([key, entry]) =>
    `${key}: ${formatCompiledValueLegacy(entry, seen)}`
  );
  return `{ ${rendered.join(", ")} }`;
}

function safeToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveEntryPath(path: string): string {
  const normalized = isAbsolute(path) ? path : resolve(path);
  return ensureWmExtension(normalized);
}

async function visitModule(path: string, ctx: LoaderContext): Promise<void> {
  //console.log("  [DEBUG] visitModule: starting for", path);
  const state = ctx.visitState.get(path);
  if (state === "visiting") {
    const cycle = [...ctx.stack, path];
    throw moduleError(`Circular import detected: ${cycle.join(" -> ")}`);
  }
  if (state === "visited") {
    return;
  }

  //console.log("  [DEBUG] visitModule: setting state to visiting");
  ctx.visitState.set(path, "visiting");
  ctx.stack.push(path);
  try {
    // First pass: try to parse without operators to discover imports
    // If this fails due to unknown operators, we'll retry after collecting them
    let program: Program | null = null;
    let imports: ModuleImportRecord[] = [];
    let reexports: ModuleReexportRecord[] = [];

    try {
      //console.log("  [DEBUG] visitModule: about to loadProgram");
      program = await loadProgram(path, ctx);
      //console.log("  [DEBUG] visitModule: program loaded");
      imports = resolveImports(path, program.imports, ctx);
      reexports = collectReexports(
        program.reexports,
        path,
        ctx.options,
        ctx.preludePath,
      );
    } catch (error) {
      //console.log("  [DEBUG] visitModule: error in loadProgram", error);
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
      // Visit prelude if available (if parse failed, we assume we need prelude)
      if (ctx.preludePath && path !== ctx.preludePath) {
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
    const skipPrelude = program ? isStdCoreModule(program) : false;
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
  //console.log("  [DEBUG] loadSource: path=", path);
  // Check for in-memory override (e.g., from LSP)
  const override = ctx.options.sourceOverrides?.get(path);
  if (override !== undefined) {
    //console.log("  [DEBUG] loadSource: using override");
    return override;
  }

  //console.log("  [DEBUG] loadSource: checking if file exists");
  const exists = existsSync(path);
  //console.log("  [DEBUG] loadSource: exists=", exists);

  try {
    //console.log("  [DEBUG] loadSource: about to call IO.readTextFile");
    const result = await IO.readTextFile(path);
    return result;
  } catch (error) {
    //console.log("  [DEBUG] loadSource: caught error", error);
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
  //console.log("  [DEBUG] loadProgram: starting for", path);
  const cached = ctx.programCache.get(path);
  if (cached) {
    //console.log("  [DEBUG] loadProgram: returning cached");
    return cached;
  }
  //console.log("  [DEBUG] loadProgram: loading source");
  const source = await loadSource(path, ctx);
  //console.log("  [DEBUG] loadProgram: source loaded, length=", source.length);
  let program: Program;
  try {
    //console.log("  [DEBUG] loadProgram: lexing");
    const tokens = lex(source, path);
    //console.log("  [DEBUG] loadProgram: parsing, tokens=", tokens.length);
    program = parseSurfaceProgram(
      tokens,
      source,
      false,
      operators,
      prefixOperators,
      { tolerant: ctx.options.tolerantParsing ?? false },
    );

    //console.log("  [DEBUG] loadProgram: parsed successfully");
  } catch (error) {
    //console.log("  [DEBUG] loadProgram: error during lex/parse", error);
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
    if (
      (kind === "js" || kind === "zig" || kind === "c_header") &&
      !existsSync(resolvedPath)
    ) {
      throw moduleError(
        `Foreign module '${entry.source}' imported by '${path}' was not found at '${resolvedPath}'`,
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
    if ((decl.kind === "type" || decl.kind === "record_decl") && decl.export) {
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
  // Handle relative imports (including .zig and .h files)
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolve(dirname(importerPath), specifier);
    return ensureWmExtension(target);
  }

  const ext = extname(specifier).toLowerCase();

  // Handle bare .h imports - search include directories first, then fall back to relative
  if (ext === ".h") {
    // First check include directories from foreignTypes config
    const includeDirs = options.foreignTypes?.includeDirs ?? [];
    for (const includeDir of includeDirs) {
      const candidate = join(includeDir, specifier);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    // Fall back to relative to importer
    return resolve(dirname(importerPath), specifier);
  }

  // Handle bare .zig imports (treat as relative to importer)
  if (ext === ".zig") {
    return resolve(dirname(importerPath), specifier);
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
  if (extension === ".zig") {
    return "zig";
  }
  if (extension === ".h") {
    return "c_header";
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
  rawMode?: boolean,
): void {
  const autoImportedTypes = new Set<string>();
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

      for (const [typeName, info] of provider.exports.types.entries()) {
        if (!info.constructors.some((ctor) => ctor.name === spec.imported)) {
          continue;
        }
        if (!targetAdtEnv.has(typeName)) {
          targetAdtEnv.set(typeName, cloneTypeInfo(info));
          autoImportedTypes.add(typeName);
        }
        break;
      }
    }

    if (typeExport) {
      if (spec.local !== spec.imported) {
        throw moduleError(
          `Type import aliasing is not supported in Stage M1 (imported '${spec.imported}' as '${spec.local}')`,
        );
      }
      if (targetAdtEnv.has(spec.imported)) {
        if (autoImportedTypes.has(spec.imported)) {
          continue;
        }
        throw moduleError(
          `Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`,
        );
      }
      targetAdtEnv.set(spec.imported, cloneTypeInfo(typeExport));
      // In raw mode, also register type names in the value environment so they can be
      // used as type arguments (e.g., allocArrayUninit(U8, 1024))
      if (rawMode && !targetEnv.has(spec.imported)) {
        const parameterIds = typeExport.parameters;
        const parameterTypes = parameterIds.map((id) => ({
          kind: "var" as const,
          id,
        }));
        const typeRefScheme: TypeScheme = {
          quantifiers: parameterIds,
          type: {
            kind: "constructor",
            name: spec.imported,
            args: parameterTypes,
          },
        };
        targetEnv.set(spec.imported, typeRefScheme);
      }
    }
  }
}

async function applyForeignTypeImports(
  record: ModuleImportRecord,
  targetEnv: Map<string, TypeScheme>,
  targetAdtEnv: Map<string, TypeInfo>,
  options: ModuleLoaderOptions,
  rawMode: boolean,
): Promise<boolean> {
  if (record.kind !== "c_header") {
    return false;
  }
  if (!rawMode) {
    seedForeignImports(record, targetEnv);
    return true;
  }
  const config = options.foreignTypes;
  const provider = config?.provider;
  if (!provider) {
    seedForeignImports(record, targetEnv);
    return true;
  }
  const result = await provider({
    headerPath: record.sourcePath,
    specifiers: record.specifiers,
    includeDirs: config?.includeDirs ?? [],
    defines: config?.defines ?? [],
    buildWmPath: config?.buildWmPath,
    importerPath: record.importerPath,
    rawMode: true,
  });
  applyForeignTypeResult(record, result, targetEnv, targetAdtEnv);
  return true;
}

function applyForeignTypeResult(
  record: ModuleImportRecord,
  result: ForeignTypeResult,
  targetEnv: Map<string, TypeScheme>,
  targetAdtEnv: Map<string, TypeInfo>,
): void {
  for (const spec of record.specifiers) {
    const valueExport = result.values.get(spec.imported);
    const typeExport = result.types.get(spec.imported);

    if (valueExport) {
      if (targetEnv.has(spec.local)) {
        throw moduleError(
          `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
        );
      }
      targetEnv.set(spec.local, cloneTypeScheme(valueExport));
    }

    if (typeExport && spec.local === spec.imported) {
      if (targetAdtEnv.has(spec.imported)) {
        throw moduleError(
          `Duplicate imported type '${spec.imported}' in module '${record.importerPath}'`,
        );
      }
      targetAdtEnv.set(spec.imported, cloneTypeInfo(typeExport));
    }

    if (!valueExport && !typeExport) {
      seedForeignImportSpec(record, spec, targetEnv);
    }
  }
}

function seedForeignImports(
  record: ModuleImportRecord,
  targetEnv: Map<string, TypeScheme>,
): void {
  for (const spec of record.specifiers) {
    seedForeignImportSpec(record, spec, targetEnv);
  }
}

function seedForeignImportSpec(
  record: ModuleImportRecord,
  spec: NamedImportRecord,
  targetEnv: Map<string, TypeScheme>,
): void {
  if (targetEnv.has(spec.local)) {
    throw moduleError(
      `Duplicate imported binding '${spec.local}' in module '${record.importerPath}'`,
    );
  }
  targetEnv.set(spec.local, createForeignImportScheme(spec, record));
}

function createForeignImportScheme(
  spec: NamedImportRecord,
  record: ModuleImportRecord,
): TypeScheme {
  return {
    quantifiers: [],
    type: unknownType({
      kind: "incomplete",
      reason:
        `${record.kind} import '${spec.imported}' from '${record.rawSource}' in '${record.importerPath}'`,
    }),
  };
}
