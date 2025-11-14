import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { loadModuleSummaries } from "../src/module_loader.ts";
import { resolve } from "std/path/mod.ts";

const entryPath = resolve("std/option.wm");
const { coreGraph, loader, modules } = await compileWorkmanGraph(entryPath, {
  loader: { skipEvaluation: true }
});

const { summaries } = await loadModuleSummaries(entryPath, { skipEvaluation: true });

const optionModule = coreGraph.modules.get(entryPath);
const optionNode = loader.nodes.get(entryPath);
const optionSummary = summaries.get(entryPath);

console.log("=== std/option.wm node info ===");
console.log("exportedTypeNames:", optionNode?.exportedTypeNames);
console.log("exportedValueNames:", optionNode?.exportedValueNames);

console.log("\n=== std/option.wm summary exports ===");
if (optionSummary) {
  console.log("Exported types:", Array.from(optionSummary.exports.types.keys()));
  console.log("Exported values:", Array.from(optionSummary.exports.values.keys()));
}

if (optionModule) {
  console.log("\n=== std/option.wm core exports ===");
  for (const exp of optionModule.exports) {
    console.log(JSON.stringify(exp, null, 2));
  }
}
