import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

import { buildModuleGraph } from "../backends/esm/src/module_resolver.ts";
import { compileModuleGraph } from "../backends/esm/src/module_compiler.ts";
import { formatScheme } from "../src/type_printer.ts";

async function main() {
  if (Deno.args.length === 0) {
    console.error("Usage: deno run -A debugScripts/inspect_module_types.ts <module-path>");
    Deno.exit(1);
  }

  const cwd = Deno.cwd();
  const entryPath = resolve(cwd, Deno.args[0]);

  const graph = await buildModuleGraph(entryPath, {
    stdRoots: [resolve(cwd, "std")],
    preludeModule: "std/prelude",
  });

  const result = compileModuleGraph(graph);
  if (result.errors && result.errors.length > 0) {
    console.error("Compilation errors:");
    for (const error of result.errors) {
      console.error("  -", error);
    }
    Deno.exit(1);
  }

  const moduleInfo = result.modules.get(entryPath);
  if (!moduleInfo) {
    console.error(`Module ${entryPath} not found in compiled output.`);
    Deno.exit(1);
  }

  console.log(`Exported value schemes for ${entryPath}:`);
  const entries = [...moduleInfo.inferResult.env.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, scheme] of entries) {
    console.log(`  ${name}: ${formatScheme(scheme)}`);
  }
}

await main();
