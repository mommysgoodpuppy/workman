import { lex } from "./src/lexer.ts";
import { ParseError, parseSurfaceProgram } from "./src/parser.ts";
import { InferError } from "./src/layer1/infer.ts";
import { LexError, WorkmanError } from "./src/error.ts";
import { formatScheme } from "./src/type_printer.ts";
import { evaluateProgram } from "./src/eval.ts";
import { formatRuntimeValue } from "./src/value_printer.ts";
import type { TypeScheme } from "./src/types.ts";
import type { RuntimeValue } from "./src/value.ts";
import { startRepl } from "./tools/repl.ts";
import { runFormatter } from "./tools/fmt.ts";
import { toFileUrl, resolve, relative } from "std/path/mod.ts";
import { compileWorkmanGraph } from "./backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "./backends/compiler/js/graph_emitter.ts";
import { collectCompiledValues, invokeMainIfPresent } from "./src/runtime_display.ts";
import { analyzeProgram } from "./src/pipeline.ts";

export interface RunOptions {
  sourceName?: string;
  onPrint?: (text: string) => void;
  skipEvaluation?: boolean;
}

export interface TypeSummary {
  name: string;
  type: string;
}

export interface RunResult {
  types: TypeSummary[];
  values: ValueSummary[];
  runtimeLogs: string[];
}

export interface ValueSummary {
  name: string;
  value: string;
}

export function runFile(source: string, options: RunOptions = {}): RunResult {
  try {
    const tokens = lex(source, options.sourceName);
    const program = parseSurfaceProgram(tokens, source);
    const analysis = analyzeProgram(program, {
      source,
      sourceName: options.sourceName,
    });
    const types = analysis.layer1.summaries.map((
      entry: { name: string; scheme: TypeScheme },
    ) => ({
      name: entry.name,
      type: formatScheme(entry.scheme),
    }));

    let values: ValueSummary[] = [];
    const runtimeLogs: string[] = [];

    if (!options.skipEvaluation) {
      const evaluation = evaluateProgram(program, {
        sourceName: options.sourceName,
        source,
        onPrint: (text: string) => {
          runtimeLogs.push(text);
          options.onPrint?.(text);
        },
      });
      values = evaluation.summaries.map((
        summary: { name: string; value: RuntimeValue },
      ) => ({
        name: summary.name,
        value: formatRuntimeValue(summary.value),
      }));
    }

    return { types, values, runtimeLogs };
  } catch (error) {
    if (error instanceof WorkmanError) {
      // Format the error with source context
      // Don't override the source if the error already has one (e.g., from a different module)
      const formatted = error.format();
      throw new Error(formatted);
    }
    if (error instanceof Error) {
      throw new Error(`Unhandled error: ${error.message}`);
    }
    throw new Error(`Unknown error: ${String(error)}`);
  }
}

interface CompileArgs {
  entryPath: string;
  outDir?: string;
}

function parseCompileArgs(args: string[]): CompileArgs {
  let entryPath: string | undefined;
  let outDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out-dir" || arg === "-o") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --out-dir");
      }
      outDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown compile option '${arg}'`);
    }
    if (entryPath) {
      throw new Error("Multiple entry paths provided to compile");
    }
    entryPath = arg;
  }

  if (!entryPath) {
    throw new Error("Usage: wm compile <file.wm> [--out-dir <dir>]");
  }

  return { entryPath, outDir };
}

async function compileToDirectory(entryPath: string, outDir?: string): Promise<void> {
  if (!entryPath.endsWith(".wm")) {
    throw new Error("Expected a .wm entry file");
  }

  const resolvedEntry = resolve(entryPath);
  const resolvedOutDir = resolve(outDir ?? "dist");

  const compileResult = await compileWorkmanGraph(resolvedEntry, {
    loader: {
      stdRoots: [resolve("std")],
      preludeModule: "std/prelude",
    },
  });

  const emitResult = await emitModuleGraph(compileResult.coreGraph, {
    outDir: resolvedOutDir,
  });

  console.log(`Emitted ${emitResult.moduleFiles.size} module(s) to ${resolvedOutDir}`);
  const entryRelative = relative(Deno.cwd(), emitResult.entryPath);
  const runtimeRelative = relative(Deno.cwd(), emitResult.runtimePath);
  console.log(`Entry module: ${entryRelative}`);
  console.log(`Runtime module: ${runtimeRelative}`);
}

if (import.meta.main) {
  let debugMode = false;
  const args: string[] = [];
  for (const arg of Deno.args) {
    if (arg === "--debug") {
      debugMode = true;
      continue;
    }
    args.push(arg);
  }

  // Handle special commands
  if (args.length === 0) {
    // Start REPL mode
    await startRepl();
    Deno.exit(0);
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
🗿 Workman - A functional programming language

Usage:
  wm                    Start interactive REPL
  wm <file.wm>          Run a Workman file
  wm --debug <file.wm>  Run a file and print types/values
  wm type <file.wm>     Type-check a file (skip evaluation)
  wm compile <file.wm> [--out-dir <dir>]
                        Emit JavaScript modules for the given entry
  wm fmt <files...>     Format Workman files
  wm --help             Show this help message

Examples:
  wm                    # Start REPL for interactive development
  wm main.wm            # Run main.wm without extra debug output
  wm --debug main.wm    # Run main.wm and show types + values
  wm type main.wm       # Only type-check main.wm
  wm fmt .              # Format all .wm files recursively
  wm compile main.wm    # Emit JS modules into ./dist

REPL Commands:
  :help                 Show REPL-specific commands
  :quit                 Exit the REPL
  :load <file>          Load and evaluate a file
  :clear                Clear accumulated context
  :env                  Show all defined bindings
  :type <id>            Show type of an identifier
`);
    Deno.exit(0);
  }

  if (args[0] === "fmt") {
    // Format files
    await runFormatter(args.slice(1));
    Deno.exit(0);
  }

  if (args[0] === "compile") {
    try {
      const { entryPath, outDir } = parseCompileArgs(args.slice(1));
      await compileToDirectory(entryPath, outDir);
    } catch (error) {
      if (error instanceof WorkmanError) {
        console.error(error.format());
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      Deno.exit(1);
    }
    Deno.exit(0);
  }

  let filePath: string;
  let skipEvaluation = false;

  if (args[0] === "type") {
    if (args.length !== 2) {
      console.error("Usage: wm [fmt|type|compile] <file.wm> | wm <file.wm> | wm (REPL mode)");
      Deno.exit(1);
    }
    filePath = args[1];
    skipEvaluation = true;
  } else {
    if (args.length !== 1) {
      console.error("Usage: wm [fmt|type|compile] <file.wm> | wm <file.wm> | wm (REPL mode)");
      Deno.exit(1);
    }
    filePath = args[0];
  }

  if (!filePath.endsWith(".wm")) {
    console.error("Expected a .wm file");
    Deno.exit(1);
  }

  try {
    const compileResult = await compileWorkmanGraph(filePath, {
      loader: {
        stdRoots: [resolve("std")],
        preludeModule: "std/prelude",
        skipEvaluation: true, // Always compile (needed for JS interop)
      },
      lowering: {
        showAllErrors: skipEvaluation, // Only show all errors in type-check mode
      },
    });
    const entryKey = compileResult.coreGraph.entry;
    const artifact = compileResult.modules.get(entryKey);
    const coreModule = compileResult.coreGraph.modules.get(entryKey);
    if (!artifact || !coreModule) {
      throw new Error(`Failed to locate entry module artifacts for '${entryKey}'`);
    }

    const typeSummaries = artifact.analysis.layer1.summaries.map(({ name, scheme }) => ({
      name,
      type: formatScheme(scheme),
    }));

    if (skipEvaluation || debugMode) {
      if (typeSummaries.length > 0) {
        for (const { name, type } of typeSummaries) {
          console.log(`${name} : ${type}`);
        }
      } else {
        console.log("(no top-level let bindings)");
      }
    }

    if (!skipEvaluation) {
      const tempDir = await Deno.makeTempDir({ prefix: "workman-cli-" });
      try {
        const emitResult = await emitModuleGraph(compileResult.coreGraph, {
          outDir: tempDir,
        });
        const moduleUrl = toFileUrl(emitResult.entryPath).href;
        const moduleExports = await import(moduleUrl) as Record<string, unknown>;
        await invokeMainIfPresent(moduleExports);
        const forcedValueNames = coreModule.values.map((binding) => binding.name);
        const values = collectCompiledValues(moduleExports, coreModule, {
          forcedValueNames,
        });
        if (debugMode && values.length > 0) {
          console.log("");
          for (const { name, value } of values) {
            console.log(`${name} = ${value}`);
          }
        }
      } finally {
        try {
          await Deno.remove(tempDir, { recursive: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch (error) {
    if (error instanceof WorkmanError) {
      console.error(error.format());
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    Deno.exit(1);
  }
}
