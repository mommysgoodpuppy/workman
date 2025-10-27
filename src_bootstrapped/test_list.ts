// Test compiling just list.wm

import { compileProject } from "../backends/esm/src/compile.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

const entryPath = resolve(Deno.cwd(), "std/list.wm");

console.log("Compiling std/list.wm...\n");

try {
  const result = await compileProject(entryPath, {
    stdRoots: [resolve(Deno.cwd(), "std")],
    preludeModule: undefined, // No prelude
  });

  if (result.errors) {
    console.error("❌ Compilation failed:");
    for (const error of result.errors) {
      console.error("  ", error);
    }
  } else if (result.modules.size === 0) {
    console.error("❌ No modules compiled!");
  } else {
    console.log(`✅ Success! Compiled ${result.modules.size} modules`);
  }
} catch (error) {
  console.error("❌ Exception:", error);
  Deno.exit(1);
}
