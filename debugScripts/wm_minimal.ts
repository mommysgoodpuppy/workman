import { IO, resolve, toFileUrl } from "../src/io.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import {
  collectCompiledValues,
  invokeMainIfPresent,
} from "../src/runtime_display.ts";

// Minimal CLI: just compile and run aoc.wm with heavy logging
async function main() {
  const filePath = "aoc.wm";

  console.log("=== STARTING COMPILATION ===");
  console.log(`Target file: ${filePath}`);
  console.log(`Resolved path: ${resolve(filePath)}`);
  console.log("");

  try {
    console.log("→ Compiling Workman graph...");
    const compileResult = await compileWorkmanGraph(filePath, {
      loader: {
        stdRoots: [resolve("std")],
        preludeModule: "std/prelude",
        skipEvaluation: true,
      },
    });
    console.log(`✓ Compiled ${compileResult.modules.size} module(s)`);
    console.log(`  Entry key: ${compileResult.coreGraph.entry}`);
    console.log("");

    const entryKey = compileResult.coreGraph.entry;
    const coreModule = compileResult.coreGraph.modules.get(entryKey);
    if (!coreModule) {
      throw new Error(`Failed to locate entry module for '${entryKey}'`);
    }
    console.log(
      `  Entry module has ${coreModule.values.length} value binding(s)`,
    );
    console.log("");

    console.log("→ Creating temporary directory for JS output...");
    const tempDir = await IO.makeTempDir({ prefix: "workman-minimal-" });
    console.log(`  Temp dir: ${tempDir}`);
    console.log("");

    try {
      console.log("→ Emitting JavaScript modules...");
      const emitResult = await emitModuleGraph(compileResult.coreGraph, {
        outDir: tempDir,
      });
      console.log(`✓ Emitted ${emitResult.moduleFiles.size} file(s)`);
      console.log(`  Entry module: ${emitResult.entryPath}`);
      console.log(`  Runtime module: ${emitResult.runtimePath}`);
      console.log("");

      console.log("→ Loading compiled module...");
      const moduleUrl = toFileUrl(emitResult.entryPath).href;
      console.log(`  Module URL: ${moduleUrl}`);
      const moduleExports = await import(moduleUrl) as Record<string, unknown>;
      console.log(
        `✓ Module loaded, ${Object.keys(moduleExports).length} export(s)`,
      );
      console.log("");

      console.log("→ Invoking main function (if present)...");
      await invokeMainIfPresent(moduleExports);
      console.log("✓ Main invoked");
      console.log("");

      console.log("→ Collecting compiled values...");
      const forcedValueNames = coreModule.values.map((binding) => binding.name);
      console.log(`  Forcing evaluation of: ${forcedValueNames.join(", ")}`);
      const values = collectCompiledValues(moduleExports, coreModule, {
        forcedValueNames,
      });
      console.log(`✓ Collected ${values.length} value(s)`);
      console.log("");

      if (values.length > 0) {
        console.log("=== COMPILED VALUES ===");
        for (const { name, value } of values) {
          console.log(`${name} = ${value}`);
        }
        console.log("");
      }

      console.log("→ Cleaning up temporary directory...");
      await IO.remove(tempDir, { recursive: true });
      console.log("✓ Cleanup complete");
      console.log("");
    } catch (error) {
      console.error("✗ Error during execution:");
      console.error(error);
      try {
        await IO.remove(tempDir, { recursive: true });
      } catch {
        console.error("  (cleanup also failed)");
      }
      IO.exit(1);
    }

    console.log("=== EXECUTION COMPLETE ===");
  } catch (error) {
    console.error("✗ Compilation failed:");
    console.error(error instanceof Error ? error.message : error);
    IO.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
