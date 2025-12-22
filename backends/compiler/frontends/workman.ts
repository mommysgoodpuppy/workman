import {
  buildInfectionRegistryForModule,
  isStdCoreModule,
  loadModuleSummaries,
  type ModuleGraph,
  type ModuleLoaderOptions,
  type ModuleNode,
  type ModuleSummary,
} from "../../../src/module_loader.ts";
import {
  type AnalysisOptions,
  analyzeAndPresent,
  type PresentationResult,
} from "../../../src/pipeline.ts";
import type { CoreModule, CoreModuleGraph } from "../ir/core.ts";
import {
  lowerAnalyzedModule,
  type WorkmanLoweringOptions,
} from "../lower/workman_to_core.ts";
import {
  cloneTypeInfo,
  cloneTypeScheme,
  type TypeInfo,
  type TypeScheme,
  unknownType,
} from "../../../src/types.ts";

export interface WorkmanCompilerOptions {
  readonly loader?: ModuleLoaderOptions;
  readonly analysis?: AnalysisOptions;
  readonly lowering?: WorkmanLoweringOptions;
}

export interface WorkmanModuleArtifacts {
  readonly node: ModuleNode;
  readonly analysis: PresentationResult;
  readonly core: CoreModule;
}

export interface WorkmanCompileResult {
  readonly loader: ModuleGraph;
  readonly modules: ReadonlyMap<string, WorkmanModuleArtifacts>;
  readonly coreGraph: CoreModuleGraph;
}

export async function compileWorkmanGraph(
  entryPath: string,
  options: WorkmanCompilerOptions = {},
): Promise<WorkmanCompileResult> {
  const loaderOptions: ModuleLoaderOptions = {
    ...options.loader,
    skipEvaluation: options.loader?.skipEvaluation ?? true,
  };

  const analysisOptions = options.analysis ?? {};
  const loweringOptions = options.lowering ?? {};

  const { graph: moduleGraph, summaries } = await loadModuleSummaries(
    entryPath,
    loaderOptions,
  );

  const moduleArtifacts = new Map<string, WorkmanModuleArtifacts>();
  const preludePath = moduleGraph.prelude;
  for (const path of moduleGraph.order) {
    const node = moduleGraph.nodes.get(path);
    if (!node) {
      continue;
    }
    const infectionRegistry = await buildInfectionRegistryForModule(
      moduleGraph,
      summaries,
      path,
      loaderOptions,
    );
    const analysis = analyzeAndPresent(
      node.program,
      {
        ...buildAnalysisOptions(
          node,
          moduleGraph,
          summaries,
          analysisOptions,
          preludePath,
        ),
        infectionRegistry,
      },
    );
    const summary = summaries.get(path);
    const core = lowerAnalyzedModule(
      { node, analysis, summary },
      loweringOptions,
    );
    moduleArtifacts.set(path, { node, analysis, core });
  }

  const coreModules = new Map<string, CoreModule>();
  for (const [path, artifact] of moduleArtifacts.entries()) {
    coreModules.set(path, artifact.core);
  }

  const coreGraph: CoreModuleGraph = {
    entry: moduleGraph.entry,
    order: [...moduleGraph.order],
    modules: coreModules,
    prelude: moduleGraph.prelude,
  };

  return {
    loader: moduleGraph,
    modules: moduleArtifacts,
    coreGraph,
  };
}

function buildAnalysisOptions(
  node: ModuleNode,
  graph: ModuleGraph,
  summaries: Map<string, ModuleSummary>,
  base: AnalysisOptions,
  preludePath?: string,
): AnalysisOptions {
  const seedEnv = cloneSchemeMap(base.initialEnv);
  const seedAdtEnv = cloneAdtMap(base.initialAdtEnv);

  seedImports(node, summaries, seedEnv, seedAdtEnv);
  seedPrelude(node, graph, summaries, seedEnv, seedAdtEnv, preludePath);

  return {
    ...base,
    initialEnv: seedEnv,
    initialAdtEnv: seedAdtEnv,
    registerPrelude: base.registerPrelude ?? true,
    resetCounter: base.resetCounter ?? true,
    source: base.source ?? node.source,
  };
}

function seedImports(
  node: ModuleNode,
  summaries: Map<string, ModuleSummary>,
  env: Map<string, TypeScheme>,
  adtEnv: Map<string, TypeInfo>,
): void {
  for (const record of node.imports) {
    if (record.kind === "js" || record.kind === "zig") {
      for (const spec of record.specifiers) {
        env.set(spec.local, createForeignImportScheme(spec, record));
      }
      continue;
    }
    const provider = summaries.get(record.sourcePath);
    if (!provider) {
      throw new Error(
        `Missing summary for imported module '${record.sourcePath}'`,
      );
    }
    for (const spec of record.specifiers) {
      const valueExport = provider.exports.values.get(spec.imported);
      if (valueExport) {
        env.set(spec.local, cloneTypeScheme(valueExport));
        for (const [typeName, info] of provider.exports.types.entries()) {
          if (!info.constructors.some((ctor) => ctor.name === spec.imported)) {
            continue;
          }
          if (!adtEnv.has(typeName)) {
            adtEnv.set(typeName, cloneTypeInfo(info));
          }
          break;
        }
        continue;
      }
      const typeExport = provider.exports.types.get(spec.imported);
      if (typeExport) {
        if (spec.local !== spec.imported) {
          throw new Error(
            `Type import aliasing is not supported (imported '${spec.imported}' as '${spec.local}')`,
          );
        }
        if (!adtEnv.has(spec.imported)) {
          adtEnv.set(spec.imported, cloneTypeInfo(typeExport));
        }
        continue;
      }
      throw new Error(
        `Module '${record.sourcePath}' does not export '${spec.imported}' (imported by '${node.path}')`,
      );
    }
  }
}

function createForeignImportScheme(
  spec: { imported: string; local: string },
  record: { rawSource: string; importerPath: string; kind: string },
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

function seedPrelude(
  node: ModuleNode,
  graph: ModuleGraph,
  summaries: Map<string, ModuleSummary>,
  env: Map<string, TypeScheme>,
  adtEnv: Map<string, TypeInfo>,
  preludePath?: string,
): void {
  if (!preludePath) return;
  if (node.path === preludePath) return;
  if (isStdCoreModule(node.path)) return;

  const preludeSummary = summaries.get(preludePath);
  if (!preludeSummary) return;

  for (const [name, scheme] of preludeSummary.exports.values.entries()) {
    if (!env.has(name)) {
      env.set(name, cloneTypeScheme(scheme));
    }
  }

  for (const [name, info] of preludeSummary.exports.types.entries()) {
    if (!adtEnv.has(name)) {
      adtEnv.set(name, cloneTypeInfo(info));
    }
  }

  const preludeNode = graph.nodes.get(preludePath);
  if (!preludeNode) return;

  for (const decl of preludeNode.program.declarations) {
    if (decl.kind === "infix") {
      const opName = `__op_${decl.operator}`;
      const implScheme = preludeSummary.exports.values.get(
        decl.implementation,
      );
      if (implScheme && !env.has(opName)) {
        env.set(opName, cloneTypeScheme(implScheme));
      }
    } else if (decl.kind === "prefix") {
      const opName = `__prefix_${decl.operator}`;
      const implScheme = preludeSummary.exports.values.get(
        decl.implementation,
      );
      if (implScheme && !env.has(opName)) {
        env.set(opName, cloneTypeScheme(implScheme));
      }
    }
  }
}

function cloneSchemeMap(
  env?: Map<string, TypeScheme>,
): Map<string, TypeScheme> {
  if (!env) return new Map();
  const cloned = new Map<string, TypeScheme>();
  for (const [name, scheme] of env.entries()) {
    cloned.set(name, cloneTypeScheme(scheme));
  }
  return cloned;
}

function cloneAdtMap(
  env?: Map<string, TypeInfo>,
): Map<string, TypeInfo> {
  if (!env) return new Map();
  const cloned = new Map<string, TypeInfo>();
  for (const [name, info] of env.entries()) {
    cloned.set(name, cloneTypeInfo(info));
  }
  return cloned;
}
