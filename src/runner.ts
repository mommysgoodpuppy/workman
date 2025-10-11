import { lex } from "./lexer.ts";
import { parseSurfaceProgram, ParseError } from "./parser.ts";
import { inferProgram, InferError } from "./infer.ts";
import { formatScheme } from "./type_printer.ts";
import { evaluateProgram } from "./eval.ts";
import { formatRuntimeValue } from "./value_printer.ts";

export interface RunOptions {
  sourceName?: string;
}

export interface TypeSummary {
  name: string;
  type: string;
}

export interface RunResult {
  types: TypeSummary[];
  values: ValueSummary[];
}

export interface ValueSummary {
  name: string;
  value: string;
}

export function runFile(source: string, _options: RunOptions = {}): RunResult {
  try {
    const tokens = lex(source);
    const program = parseSurfaceProgram(tokens);
    const inference = inferProgram(program);
    const types = inference.summaries.map((entry) => ({
      name: entry.name,
      type: formatScheme(entry.scheme),
    }));

    const evaluation = evaluateProgram(program);
    const values = evaluation.summaries.map((summary) => ({
      name: summary.name,
      value: formatRuntimeValue(summary.value),
    }));

    return { types, values };
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
  const path = Deno.args[0];
  if (!path) {
    console.error("Usage: deno task run <file>");
    Deno.exit(1);
  }
  const source = await Deno.readTextFile(path);
  try {
    const result = runFile(source, { sourceName: path });
    if (result.types.length === 0) {
      console.log("No value bindings inferred.");
    } else {
      for (const { name, type } of result.types) {
        console.log(`${name} : ${type}`);
      }
    }

    if (result.values.length > 0) {
      console.log("");
      for (const { name, value } of result.values) {
        console.log(`${name} = ${value}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
