import {
  compileWorkmanGraph,
  WorkmanModuleArtifacts,
} from "../../../backends/compiler/frontends/workman.ts";
import { TypeScheme, cloneTypeScheme } from "../../../src//types.ts";
import { MProgram } from "../../../src/ast_marked.ts";
import { Layer3Result } from "../../../src/layer3/mod.ts";
import { ModuleGraph, ModuleLoaderError } from "../../../src/module_loader.ts";
import type { WorkmanLanguageServer } from "./server.ts";
type LspServerContext = WorkmanLanguageServer;

export async function buildModuleContext(
  ctx: LspServerContext,
  entryPath: string,
  stdRoots: string[],
  preludeModule?: string,
  sourceOverrides?: Map<string, string>,
  tolerantParsing: boolean = false,
): Promise<{
  env: Map<string, TypeScheme>;
  layer3: Layer3Result;
  program: MProgram;
  adtEnv: Map<string, import("../../../src//types.ts").TypeInfo>;
  entryPath: string;
  graph: ModuleGraph;
  modules: ReadonlyMap<string, WorkmanModuleArtifacts>;
}> {
  const compileResult = await compileWorkmanGraph(entryPath, {
    loader: {
      stdRoots,
      preludeModule,
      skipEvaluation: true,
      sourceOverrides,
      tolerantParsing,
    },
  });

  const entryModulePath = compileResult.coreGraph.entry;
  const entryArtifact = compileResult.modules.get(entryModulePath);
  if (!entryArtifact) {
    throw new ModuleLoaderError(
      `Internal error: missing entry module artifacts for '${entryModulePath}'`,
    );
  }

  const layer3 = entryArtifact.analysis.layer3;
  const adtEnv = entryArtifact.analysis.layer1.adtEnv;
  const transformedEnv = new Map<string, TypeScheme>();

  // Seed the environment with everything visible to the module (imports + locals)
  for (const [name, scheme] of entryArtifact.analysis.layer1.env.entries()) {
    transformedEnv.set(name, cloneTypeScheme(scheme));
  }

  // Overwrite local summaries with their most up-to-date, hole-filled schemes
  for (const { name, scheme } of layer3.summaries) {
    transformedEnv.set(
      name,
      ctx.applyHoleSolutionsToScheme(scheme, layer3),
    );
  }

  return {
    env: transformedEnv,
    layer3,
    program: entryArtifact.analysis.layer1.markedProgram,
    adtEnv,
    entryPath: entryModulePath,
    graph: compileResult.loader,
    modules: compileResult.modules,
  };
}
