// Test script to compile value_printer_v2.wm with module support

import { compileProject } from "../backends/esm/src/compile.ts";
import { formatWorkmanError } from "./error.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

const entryPath = resolve(Deno.cwd(), "src_bootstrapped/value_printer_v2.wm");

console.log("Compiling value_printer_v2.wm with module support...\n");

const result = await compileProject(entryPath, {
  stdRoots: [resolve(Deno.cwd(), "std")],
  preludeModule: "std/prelude",
});

if (result.errors) {
  console.error("❌ Compilation failed:\n");
  for (const error of result.errors) {
    console.error(formatWorkmanError(error));
    console.error("");
  }
  console.error("\nCompiled modules so far:");
  for (const [path, _] of result.modules) {
    console.error(`  - ${path}`);
  }
  Deno.exit(1);
}

console.log(`✅ Compilation successful!`);
console.log(`\nCompiled ${result.modules.size} modules:`);
for (const [path, module] of result.modules) {
  console.log(`  - ${module.path}`);
}

// Write all modules to disk
console.log("\nWriting compiled modules...");
for (const [_, module] of result.modules) {
  await Deno.writeTextFile(module.path, module.js);
  console.log(`  ✓ ${module.path}`);
}

console.log("\n✨ Done!");
