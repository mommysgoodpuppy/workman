import { toFileUrl } from "./io.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { createDefaultForeignTypeConfig } from "./foreign_types/c_header_provider.ts";
import { formatScheme } from "./type_printer.ts";
import {
  collectCompiledValues,
  invokeMainIfPresent,
} from "./runtime_display.ts";

import { IO } from "./io.ts";
import { InferError, ParseError } from "./error.ts";

if (import.meta.main) {
  if (IO.args.length === 0) {
    console.error("Usage: workman <file.wm> [...file.wm]");
    IO.exit(1);
  }

  let hadError = false;

  for (const path of IO.args) {
    if (!path.endsWith(".wm")) {
      console.error(`Skipping '${path}': expected a .wm source file.`);
      hadError = true;
      continue;
    }

    let source: string;
    try {
      source = await IO.readTextFile(path);
    } catch (error) {
      console.error(
        `Failed to read '${path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      hadError = true;
      continue;
    }

    console.log(`\n# ${path}`);

    try {
      const compileResult = await compileWorkmanGraph(path, {
        loader: {
          foreignTypes: createDefaultForeignTypeConfig(path),
        },
      });
      const entryKey = compileResult.coreGraph.entry;
      const artifact = compileResult.modules.get(entryKey);
      const coreModule = compileResult.coreGraph.modules.get(entryKey);
      if (!artifact || !coreModule) {
        throw new Error(
          `Failed to locate entry module artifacts for '${entryKey}'`,
        );
      }

      const typeSummaries = artifact.analysis.layer1.summaries.map((
        { name, scheme },
      ) => ({
        name,
        type: formatScheme(scheme),
      }));

      console.log("\n## Types");
      if (typeSummaries.length === 0) {
        console.log("(no top-level let bindings)");
      } else {
        for (const { name, type } of typeSummaries) {
          console.log(`${name} : ${type}`);
        }
      }

      console.log("\n## Runtime");

      const tempDir = await IO.makeTempDir({ prefix: "workman-cli-" });
      let runtimeValues: { name: string; value: string }[] = [];
      try {
        const emitResult = await emitModuleGraph(compileResult.coreGraph, {
          outDir: tempDir,
        });
        const moduleUrl = toFileUrl(emitResult.entryPath).href;
        const moduleExports = await import(moduleUrl) as Record<
          string,
          unknown
        >;
        const forcedValueNames = coreModule.values.map((binding) =>
          binding.name
        );
        await invokeMainIfPresent(moduleExports);
        runtimeValues = collectCompiledValues(moduleExports, coreModule, {
          forcedValueNames,
        });
      } finally {
        try {
          await IO.remove(tempDir, { recursive: true });
        } catch {
          // Ignore cleanup errors; directory may have already been removed.
        }
      }

      if (runtimeValues.length === 0) {
        console.log("(no exported runtime values)");
      } else {
        console.log("values:");
        for (const { name, value } of runtimeValues) {
          console.log(`${name} = ${value}`);
        }
      }
    } catch (error) {
      hadError = true;
      if (error instanceof ParseError) {
        const { line, column } = positionToLineColumn(
          source,
          error.token.start,
        );
        console.error(
          `Parse error (${path}:${line}:${column}): ${error.message}`,
        );
      } else if (error instanceof InferError) {
        console.error(`Type error in '${path}': ${error.message}`);
      } else {
        console.error(
          `Unexpected error in '${path}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (hadError) {
    IO.exit(1);
  }
}

function positionToLineColumn(
  text: string,
  index: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
