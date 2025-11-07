import { resolve } from "std/path/mod.ts";

import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";

const target = Deno.args[0];
if (!target) {
  console.error("Usage: deno run -A debugScripts/inspect_core.ts <module.wm>");
  Deno.exit(1);
}

const entry = resolve(target);
const { coreGraph } = await compileWorkmanGraph(entry, {
  loader: {
    stdRoots: [resolve("std")],
    preludeModule: "std/prelude",
  },
});

const module = coreGraph.modules.get(coreGraph.entry);
if (!module) {
  console.error("Entry module not found in graph");
  Deno.exit(1);
}

console.log("Imports:");
console.log(JSON.stringify(module.imports, null, 2));
console.log("Values:");
console.log(module.values.map((value) => value.name));
