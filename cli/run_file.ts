import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { formatScheme } from "../src/type_printer.ts";
import { formatRuntimeValue } from "../src/value_printer.ts";
import { analyzeAndPresent } from "../src/pipeline.ts";
import { LexError, ParseError } from "../src/error.ts";
import type { RuntimeValue } from "../src/value.ts";
import type { TypeScheme } from "../src/types.ts";
import { isHoleType } from "../src/types.ts";
import { holeIdFromUnknown } from "./type_utils.ts";

export interface RunOptions {
  sourceName?: string;
  onPrint?: (text: string) => void;
  skipEvaluation?: boolean;
}

export interface TypeSummary {
  name: string;
  type: string;
}

export interface ValueSummary {
  name: string;
  value: string;
}

export interface RunResult {
  types: TypeSummary[];
  values: ValueSummary[];
  runtimeLogs: string[];
}

export function runFile(source: string, options: RunOptions = {}): RunResult {
  try {
    const tokens = lex(source, options.sourceName);
    const program = parseSurfaceProgram(tokens, source);

    const analysis = analyzeAndPresent(program, {
      source,
    });

    const types = analysis.layer1.summaries.map((
      entry: { name: string; scheme: TypeScheme },
    ) => {
      let typeStr = formatScheme(entry.scheme);
      let holeId: number | undefined;
      if (isHoleType(entry.scheme.type)) {
        holeId = holeIdFromUnknown(entry.scheme.type);
      }

      if (holeId !== undefined) {
        const solution = analysis.layer3.holeSolutions.get(holeId);
        if (solution?.state === "partial" && solution.partial?.known) {
          typeStr = `${
            formatScheme({
              quantifiers: entry.scheme.quantifiers,
              type: solution.partial.known,
            })
          } (partial)`;
        } else if (solution?.state === "conflicted" && solution.conflicts) {
          typeStr = `? (conflicted: ${solution.conflicts.length} conflicts)`;
        }
      }

      return {
        name: entry.name,
        type: typeStr,
      };
    });

    const hasDiagnostics = analysis.layer3.diagnostics.solver.length > 0 ||
      analysis.layer3.diagnostics.conflicts.length > 0;

    if (hasDiagnostics) {
      let errorMessage = "";

      for (const diag of analysis.layer3.diagnostics.solver) {
        if (diag.span && source) {
          const lines = source.split("\n");
          const line = lines[diag.span.start] || "";
          errorMessage += `\nType Error: ${diag.reason}\n`;
          errorMessage += `  ${line}\n`;
        } else {
          errorMessage += `\nType Error: ${diag.reason}\n`;
        }
      }

      for (const conflict of analysis.layer3.diagnostics.conflicts) {
        errorMessage += `\n${conflict.message}\n`;
        if (conflict.span && source) {
          const lines = source.split("\n");
          const line = lines[conflict.span.start] || "";
          errorMessage += `  ${line}\n`;
        }
      }

      if (errorMessage) {
        throw new Error(errorMessage);
      }
    }

    let values: ValueSummary[] = [];
    const runtimeLogs: string[] = [];

    if (!options.skipEvaluation) {
      /* const evaluation = evaluateProgram(program, {
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
      })); */
    }

    return { types, values, runtimeLogs };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      const formatted = error.format();
      throw new Error(formatted);
    }
    throw error;
  }
}
