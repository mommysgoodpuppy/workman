import { lex } from "./src/lexer.ts";
import { ParseError, parseSurfaceProgram } from "./src/parser.ts";
import { InferError, inferProgram } from "./src/infer.ts";
import { LexError, WorkmanError } from "./src/error.ts";
import { formatScheme } from "./src/type_printer.ts";
import { evaluateProgram } from "./src/eval.ts";
import { formatRuntimeValue } from "./src/value_printer.ts";
import type { TypeScheme } from "./src/types.ts";
import type { RuntimeValue } from "./src/value.ts";
import { startRepl } from "./tools/repl.ts";
import { runFormatter } from "./tools/fmt.ts";
import { runEntryPath } from "./src/module_loader.ts";
import { resolve } from "std/path/mod.ts";

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
    const inference = inferProgram(program);
    const types = inference.summaries.map((
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
        source: source,
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

if (import.meta.main) {
  const args = Deno.args;
  
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
  wm type <file.wm>     Type-check a file (skip evaluation)
  wm fmt <files...>     Format Workman files
  wm --help             Show this help message

Examples:
  wm                    # Start REPL for interactive development
  wm main.wm            # Run main.wm and show types + values
  wm type main.wm       # Only type-check main.wm
  wm fmt .              # Format all .wm files recursively

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

  let filePath: string;
  let skipEvaluation = false;

  if (args[0] === "type") {
    if (args.length !== 2) {
      console.error("Usage: wm [fmt|type] <file.wm> | wm <file.wm> | wm (REPL mode)");
      Deno.exit(1);
    }
    filePath = args[1];
    skipEvaluation = true;
  } else {
    if (args.length !== 1) {
      console.error("Usage: wm [fmt|type] <file.wm> | wm <file.wm> | wm (REPL mode)");
      Deno.exit(1);
    }
    filePath = args[0];
  }

  if (!filePath.endsWith(".wm")) {
    console.error("Expected a .wm file");
    Deno.exit(1);
  }

  try {
    // Use module loader to properly load prelude
    const result = await runEntryPath(filePath, {
      stdRoots: [resolve("std")],
      preludeModule: "std/prelude",
    });

    if (result.types.length > 0) {
      for (const { name, type } of result.types) {
        console.log(`${name} : ${type}`);
      }
    } else {
      console.log("(no top-level let bindings)");
    }

    if (!skipEvaluation) {
      const hasRuntimeInfo = result.runtimeLogs.length > 0 ||
        result.values.length > 0;
      if (hasRuntimeInfo) {
        console.log("");
        for (const entry of result.runtimeLogs) {
          console.log(entry);
        }
        if (result.runtimeLogs.length > 0 && result.values.length > 0) {
          console.log("");
        }
        for (const { name, value } of result.values) {
          console.log(`${name} = ${value}`);
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
