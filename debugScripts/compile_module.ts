import { compileProject } from "../backends/esm/src/compile.ts";
import { formatWorkmanError } from "../src/error.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

async function main() {
  if (Deno.args.length === 0) {
    console.error("Usage: deno run -A debugScripts/compile_module.ts <entry.wm>");
    Deno.exit(1);
  }

  const cwd = Deno.cwd();
  const entryPath = resolve(cwd, Deno.args[0]);

  const result = await compileProject(entryPath, {
    stdRoots: [resolve(cwd, "std")],
    preludeModule: "std/prelude",
  });

  if (result.errors) {
    console.error("Compilation failed:\n");
    for (const error of result.errors) {
      console.error(formatWorkmanError(error));
      console.error("");
    }
    Deno.exit(1);
  }

  console.log(`Compiled ${result.modules.size} modules successfully.`);
}

await main();
