import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

import { loadModuleGraph } from "../src/module_loader.ts";

async function main() {
  const [entryArg, stdRootArg] = Deno.args;
  if (!entryArg) {
    console.error("Usage: deno run -A debugScripts/test_module_loader.ts <entry.wm> [stdRoot]");
    Deno.exit(1);
  }

  const cwd = Deno.cwd();
  const entryPath = resolve(cwd, entryArg);
  const stdRoot = stdRootArg ? stdRootArg : resolve(cwd, "std");

  console.error(`entryPath=${entryPath}`);
  console.error(`stdRoot=${stdRoot}`);

  try {
    const graph = await loadModuleGraph(entryPath, {
      stdRoots: [stdRoot],
      preludeModule: "std/prelude",
    });
    console.log(`Loaded modules (order=${graph.order.length}):`);
    for (const path of graph.order) {
      console.log(`  ${path}`);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    Deno.exit(1);
  }
}

await main();
