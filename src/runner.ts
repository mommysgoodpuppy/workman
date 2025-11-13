import { lex } from "./lexer.ts";
import { ParseError, parseSurfaceProgram } from "./parser.ts";
import { InferError } from "./layer1/infer.ts";
import { formatScheme } from "./type_printer.ts";
import { evaluateProgram } from "./eval.ts";
import { formatRuntimeValue } from "./value_printer.ts";
import { analyzeProgram } from "./pipeline.ts";
import { IO } from "./io.ts";

export interface RunOptions {
  sourceName?: string;
  onPrint?: (text: string) => void;
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
    const tokens = lex(source);
    const program = parseSurfaceProgram(tokens);
    const analysis = analyzeProgram(program, {
      source,
      sourceName: options.sourceName,
    });
    const types = analysis.layer1.summaries.map((entry) => ({
      name: entry.name,
      type: formatScheme(entry.scheme),
    }));

    const runtimeLogs: string[] = [];
    const evaluation = evaluateProgram(program, {
      sourceName: options.sourceName,
      onPrint: (text) => {
        runtimeLogs.push(text);
        options.onPrint?.(text);
      },
    });
    const values = evaluation.summaries.map((summary) => ({
      name: summary.name,
      value: formatRuntimeValue(summary.value),
    }));

    return { types, values, runtimeLogs };
  } catch (error) {
    if (error instanceof ParseError || error instanceof InferError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new Error(`Unhandled error: ${error.message}`);
    }
    throw new Error(`Unknown error: ${String(error)}`);
  }
}

if (import.meta.main) {
  const path = IO.args[0];
  if (!path) {
    console.error("Usage: deno task run <file>");
    IO.exit(1);
  }
  const source = await IO.readTextFile(path);
  try {
    const result = runFile(source, { sourceName: path });

    if (result.types.length > 0) {
      for (const { name, type } of result.types) {
        console.log(`${name} : ${type}`);
      }
    } else {
      console.log("(no top-level let bindings)");
    }

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
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    IO.exit(1);
  }
}
