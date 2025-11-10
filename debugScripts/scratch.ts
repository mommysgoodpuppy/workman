import { loadModuleGraph } from "../src/module_loader.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { presentProgram } from "../src/layer3/mod.ts";
import { cloneTypeScheme, cloneTypeInfo, TypeScheme, TypeInfo } from "../src/types.ts";

const entryPath = "tests/fixtures/compiler/result_infectious/main.wm";
const stdRoots = ["std"];
const preludeModule = "std/prelude";

const graph = await loadModuleGraph(entryPath, { stdRoots, preludeModule });
const summaries = new Map<string, { exportsValues: Map<string, TypeScheme>; exportsTypes: Map<string, TypeInfo>; env: Map<string, TypeScheme>; adtEnv: Map<string, TypeInfo>; }>();
let entryAnalysis = null;
let entryLayer3 = null;

for (const path of graph.order) {
  const node = graph.nodes.get(path)!;
  const env = new Map<string, TypeScheme>();
  const adtEnv = new Map<string, TypeInfo>();
  // naive: bring in previous envs
  const analysis = analyzeProgram(node.program, { initialEnv: env, initialAdtEnv: adtEnv, resetCounter: true, source: node.source });
  const layer3 = presentProgram(analysis.layer2);
  summaries.set(path, {
    exportsValues: new Map(),
    exportsTypes: new Map(),
    env: analysis.layer1.env,
    adtEnv: analysis.layer1.adtEnv,
  });
  if (path === graph.entry) {
    entryAnalysis = analysis;
    entryLayer3 = layer3;
  }
}

if (!entryAnalysis || !entryLayer3) {
  throw new Error("missing entry analysis");
}

console.log("solver diags", entryLayer3.diagnostics.solver);
console.log("top-level types");
for (const summary of entryLayer3.summaries) {
  console.log(summary.name, summary.scheme.type);
}
