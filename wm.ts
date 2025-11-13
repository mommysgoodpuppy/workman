import { lex } from "./src/lexer.ts";
import { parseSurfaceProgram } from "./src/parser.ts";
import {
  type InferError,
  LexError,
  ParseError,
  WorkmanError,
} from "./src/error.ts";
import { formatScheme } from "./src/type_printer.ts";
import { evaluateProgram } from "./src/eval.ts";
import { formatRuntimeValue } from "./src/value_printer.ts";
import { cloneType, getProvenance, isHoleType } from "./src/types.ts";
import type { Type, TypeScheme } from "./src/types.ts";
import type { RuntimeValue } from "./src/value.ts";
import { startRepl } from "./tools/repl.ts";
import { runFormatter } from "./tools/fmt.ts";
import { IO, relative, resolve, toFileUrl } from "./src/io.ts";
import { compileWorkmanGraph } from "./backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "./backends/compiler/js/graph_emitter.ts";
import {
  collectCompiledValues,
  invokeMainIfPresent,
} from "./src/runtime_display.ts";
import { analyzeAndPresent } from "./src/pipeline.ts";
import type { Layer3Result } from "./src/layer3/mod.ts";

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

function holeIdFromUnknown(type: Type): number | undefined {
  const prov = getProvenance(type);
  if (!prov) return undefined;
  if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
    return (prov as Record<string, unknown>).id as number;
  }
  if (prov.kind === "incomplete") {
    return (prov as Record<string, unknown>).nodeId as number;
  }
  if (
    prov.kind === "error_not_function" || prov.kind === "error_inconsistent"
  ) {
    const inner = (prov as Record<string, unknown>).calleeType ??
      (prov as Record<string, unknown>).actual;
    if (inner && isHoleType(inner as Type)) {
      return holeIdFromUnknown(inner as Type);
    }
  }
  return undefined;
}

function substituteHoleSolutionsInType(
  type: Type,
  layer3: Layer3Result,
): Type {
  switch (type.kind) {
    case "func":
      return {
        kind: "func",
        from: substituteHoleSolutionsInType(type.from, layer3),
        to: substituteHoleSolutionsInType(type.to, layer3),
      };
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map((arg) =>
          substituteHoleSolutionsInType(arg, layer3)
        ),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((el) =>
          substituteHoleSolutionsInType(el, layer3)
        ),
      };
    case "record": {
      const updated = new Map<string, Type>();
      for (const [field, fieldType] of type.fields.entries()) {
        updated.set(field, substituteHoleSolutionsInType(fieldType, layer3));
      }
      return { kind: "record", fields: updated };
    }
    default:
      // Handle holes via carrier check (no longer a separate kind)
      if (isHoleType(type)) {
        const holeId = holeIdFromUnknown(type);
        if (holeId !== undefined) {
          const solution = layer3.holeSolutions.get(holeId);
          if (solution?.state === "partial" && solution.partial?.known) {
            return substituteHoleSolutionsInType(
              solution.partial.known,
              layer3,
            );
          }
          if (solution?.state === "conflicted" && solution.conflicts?.length) {
            return type;
          }
        }
        const prov = getProvenance(type);
        if (prov?.kind === "error_inconsistent") {
          const expected = (prov as Record<string, unknown>).expected as
            | Type
            | undefined;
          if (expected) {
            return substituteHoleSolutionsInType(expected, layer3);
          }
        }
        return type;
      }
      return type;
  }
}

export function runFile(source: string, options: RunOptions = {}): RunResult {
  try {
    const tokens = lex(source, options.sourceName);
    const program = parseSurfaceProgram(tokens, source);

    // Use full pipeline: Layer 1 → Layer 2 → Layer 3
    const analysis = analyzeAndPresent(program, {
      source,
      sourceName: options.sourceName,
    });

    // Get types from Layer 3 (which includes partial types from Layer 2)
    // For each binding, check if it has a partial type solution
    const types = analysis.layer1.summaries.map((
      entry: { name: string; scheme: TypeScheme },
    ) => {
      let typeStr = formatScheme(entry.scheme);

      // Check if this binding has partial type information from Layer 2
      // Extract the actual hole ID, which might be wrapped in error provenances
      let holeId: number | undefined;
      if (isHoleType(entry.scheme.type)) {
        holeId = holeIdFromUnknown(entry.scheme.type);
      }

      if (holeId !== undefined) {
        const solution = analysis.layer3.holeSolutions.get(holeId);
        if (solution?.state === "partial" && solution.partial?.known) {
          // Show the partial type instead of just "?"
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

    // Check for Layer 2/3 diagnostics (these are the real errors)
    // Layer 1 errors are internal and shouldn't be surfaced
    const hasDiagnostics = analysis.layer3.diagnostics.solver.length > 0 ||
      analysis.layer3.diagnostics.conflicts.length > 0;

    if (hasDiagnostics) {
      // Format diagnostics for display
      let errorMessage = "";

      // Show solver diagnostics
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

      // Show conflict diagnostics (unfillable holes)
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
    // Only catch parse/lex errors, not Layer 1 inference errors
    if (error instanceof ParseError || error instanceof LexError) {
      const formatted = error.format();
      throw new Error(formatted);
    }
    // Re-throw other errors as-is
    throw error;
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

async function compileToDirectory(
  entryPath: string,
  outDir?: string,
): Promise<void> {
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

  console.log(
    `Emitted ${emitResult.moduleFiles.size} module(s) to ${resolvedOutDir}`,
  );
  const entryRelative = relative(IO.cwd(), emitResult.entryPath);
  const runtimeRelative = relative(IO.cwd(), emitResult.runtimePath);
  console.log(`Entry module: ${entryRelative}`);
  console.log(`Runtime module: ${runtimeRelative}`);
}

if (import.meta.main) {
  let debugMode = false;
  const args: string[] = [];
  for (const arg of IO.args) {
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
    IO.exit(0);
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
🗿 Workman - A functional programming language

Usage:
  wm                    Start interactive REPL
  wm <file.wm>          Run a Workman file
  wm --debug <file.wm>  Run a file and print types/values
  wm type <file.wm>     Type-check a file (skip evaluation)
  wm err <file.wm>      Check for type errors only
  wm compile <file.wm> [--out-dir <dir>]
                        Emit JavaScript modules for the given entry
  wm fmt <files...>     Format Workman files
  wm --help             Show this help message

Examples:
  wm                    # Start REPL for interactive development
  wm main.wm            # Run main.wm without extra debug output
  wm --debug main.wm    # Run main.wm and show types + values
  wm type main.wm       # Only type-check main.wm
  wm err main.wm        # Check main.wm for type errors only
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
    IO.exit(0);
  }

  if (args[0] === "fmt") {
    // Format files
    await runFormatter(args.slice(1));
    IO.exit(0);
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
      IO.exit(1);
    }
    IO.exit(0);
  }

  let filePath: string;
  let skipEvaluation = false;
  let showErrorsOnly = false;

  if (args[0] === "type") {
    if (args.length !== 2) {
      console.error(
        "Usage: wm [fmt|type|err|compile] <file.wm> | wm <file.wm> | wm (REPL mode)",
      );
      IO.exit(1);
    }
    filePath = args[1];
    skipEvaluation = true;
  } else if (args[0] === "err") {
    if (args.length !== 2) {
      console.error(
        "Usage: wm [fmt|type|err|compile] <file.wm> | wm <file.wm> | wm (REPL mode)",
      );
      IO.exit(1);
    }
    filePath = args[1];
    showErrorsOnly = true;
    skipEvaluation = true;
  } else {
    if (args.length !== 1) {
      console.error(
        "Usage: wm [fmt|type|err|compile] <file.wm> | wm <file.wm> | wm (REPL mode)",
      );
      IO.exit(1);
    }
    filePath = args[0];
  }

  if (!filePath.endsWith(".wm")) {
    console.error("Expected a .wm file");
    IO.exit(1);
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
      throw new Error(
        `Failed to locate entry module artifacts for '${entryKey}'`,
      );
    }

    // Show all expression types from Layer 3 (like the LSP does)
    if ((skipEvaluation || debugMode) && !showErrorsOnly) {
      const layer3 = artifact.analysis.layer3;
      const source = await IO.readTextFile(filePath);
      const _lines = source.split("\n");

      // Collect all node views with their spans
      const nodeViewsWithSpans: Array<
        { nodeId: number; view: any; span: any }
      > = [];
      for (const [nodeId, view] of layer3.nodeViews.entries()) {
        if (view.sourceSpan) {
          nodeViewsWithSpans.push({ nodeId, view, span: view.sourceSpan });
        }
      }

      // Sort by line and column
      nodeViewsWithSpans.sort((a, b) => {
        if (a.span.start !== b.span.start) return a.span.start - b.span.start;
        return a.span.end - b.span.end;
      });

      // Helper to convert offset to line/col
      const offsetToLineCol = (offset: number) => {
        let line = 0;
        let col = 0;
        for (let i = 0; i < offset && i < source.length; i++) {
          if (source[i] === "\n") {
            line++;
            col = 0;
          } else {
            col++;
          }
        }
        return { line, col };
      };

      // Group expressions by line
      const expressionsByLine = new Map<
        number,
        Array<
          {
            nodeId: number;
            view: any;
            span: any;
            startPos: { line: number; col: number };
            excerpt: string;
            typeStr: string;
            annotation: string;
            infectionInfo?: string;
            coverageInfo?: string;
          }
        >
      >();

      for (const { nodeId, view, span } of nodeViewsWithSpans) {
        const startPos = offsetToLineCol(span.start);
        const excerpt = source.substring(span.start, span.end);

        // finalType is a PartialType: { kind: "unknown" | "concrete", type?: Type }
        let typeStr = "?";
        if (view.finalType.kind === "concrete" && view.finalType.type) {
          typeStr = formatScheme({
            quantifiers: [],
            type: view.finalType.type,
          });
        } else if (view.finalType.kind === "unknown" && view.finalType.type) {
          typeStr = formatScheme({
            quantifiers: [],
            type: view.finalType.type,
          });
        }

        // Check for hole solutions
        const solution = layer3.holeSolutions.get(nodeId);
        let annotation = "";

        if (solution) {
          if (solution.state === "partial" && solution.partial?.known) {
            const partialType = formatScheme({
              quantifiers: [],
              type: solution.partial.known,
            });
            annotation = ` 🔍 partial: ${partialType}`;
          } else if (solution.state === "conflicted" && solution.conflicts) {
            annotation =
              ` ⚠️ CONFLICT: ${solution.conflicts.length} incompatible constraints`;
          } else if (solution.state === "unsolved") {
            annotation = " ❓ unsolved";
          }
        }

        // Collect infection information
        let infectionInfo: string | undefined;
        if (artifact.analysis.layer3.constraintFlow) {
          const flow = artifact.analysis.layer3.constraintFlow;
          const nodeLabels = flow.labels.get(nodeId);
          const incomingEdges = new Set<number>();

          // Find incoming edges
          for (const [fromId, toIds] of flow.edges.entries()) {
            if (toIds.has(nodeId)) {
              incomingEdges.add(fromId);
            }
          }

          if (nodeLabels || incomingEdges.size > 0) {
            const infectionParts: string[] = [];

            // Show incoming flow
            if (incomingEdges.size > 0) {
              const incomingList = Array.from(incomingEdges).map((id) => {
                const span = artifact.analysis.layer3.spanIndex.get(id);
                return span ? `line ${span.start + 1}` : `node ${id}`;
              }).join(", ");
              infectionParts.push(`infected from: ${incomingList}`);
            }

            // Show labels on this node
            if (nodeLabels) {
              for (const [domain, labelStr] of nodeLabels.entries()) {
                infectionParts.push(`${domain}: ${labelStr}`);
              }
            }

            if (infectionParts.length > 0) {
              infectionInfo = `🦠 ${infectionParts.join("; ")}`;
            }
          }
        }

        // Collect coverage information
        let coverageInfo: string | undefined;
        const coverage = layer3.matchCoverages.get(nodeId);
        if (coverage) {
          const rowStr = formatScheme({ quantifiers: [], type: coverage.row });
          const handledConstructors = [...coverage.coveredConstructors];
          if (coverage.coversTail) {
            handledConstructors.push("_");
          }
          const handledLabel = handledConstructors.length > 0
            ? handledConstructors.join(", ")
            : "(none)";
          if (coverage.missingConstructors.length === 0) {
            if (coverage.dischargesResult) {
              coverageInfo =
                `⚡ discharges Err row ${rowStr}; constructors: ${handledLabel}`;
            } else {
              coverageInfo =
                `⚠️ covers Err row ${rowStr} but infection continues (handled: ${handledLabel})`;
            }
          } else {
            const missingLabel = coverage.missingConstructors.join(", ");
            coverageInfo =
              `⚠️ missing Err constructors ${missingLabel} for row ${rowStr} (handled: ${handledLabel})`;
          }
        }

        const lineNum = startPos.line + 1;
        if (!expressionsByLine.has(lineNum)) {
          expressionsByLine.set(lineNum, []);
        }
        expressionsByLine.get(lineNum)!.push({
          nodeId,
          view,
          span,
          startPos,
          excerpt,
          typeStr,
          annotation,
          infectionInfo,
          coverageInfo,
        });
      }

      // Now display grouped by line
      for (const [lineNum, expressions] of expressionsByLine.entries()) {
        // Get the full line text
        const lineText = source.split("\n")[lineNum - 1] || "";
        console.log(`Line ${lineNum}: ${lineText}`);

        // Sort expressions by column within the line
        expressions.sort((a, b) => a.startPos.col - b.startPos.col);

        for (const expr of expressions) {
          console.log(`  ${expr.startPos.col}: ${expr.excerpt}`);
          console.log(`    → ${expr.typeStr}${expr.annotation}`);

          if (expr.infectionInfo) {
            console.log(`    ${expr.infectionInfo}`);
          }

          if (expr.coverageInfo) {
            console.log(`    ${expr.coverageInfo}`);
          }
        }
        console.log();
      } // Also show top-level bindings summary with Layer 3 types
      console.log("=== Top-Level Bindings ===\n");
      const summaries = artifact.analysis.layer1.summaries;
      const adtEnv = artifact.analysis.layer1.adtEnv;
      if (summaries.length > 0) {
        // Precompute constructor->ADT index
        const ctorToAdt = new Map<string, string>();
        for (const [adtName, info] of adtEnv.entries()) {
          for (const ctor of info.constructors) {
            ctorToAdt.set(ctor.name, adtName);
          }
        }
        const formatErrorSummary = (
          type: import("./src/types.ts").Type,
        ): string | null => {
          if (
            type.kind !== "constructor" || type.name !== "Result" ||
            type.args.length !== 2
          ) return null;
          const errArg = type.args[1];
          const ensureRow = (
            t: import("./src/types.ts").Type,
          ): import("./src/types.ts").ErrorRowType => {
            return (t.kind === "error_row")
              ? t
              : { kind: "error_row", cases: new Map(), tail: t };
          };
          const row = ensureRow(errArg);
          const caseLabels = new Set<string>(Array.from(row.cases.keys()));
          const fullAdts = new Set<string>();
          // Tail is an ADT type -> add that ADT
          if (row.tail && row.tail.kind === "constructor") {
            fullAdts.add(row.tail.name);
          }
          // Add ADTs that are fully covered by explicit constructors
          for (const [adtName, info] of adtEnv.entries()) {
            let allCovered = true;
            for (const ctor of info.constructors) {
              if (!caseLabels.has(ctor.name)) {
                allCovered = false;
                break;
              }
            }
            if (allCovered) {
              fullAdts.add(adtName);
              // remove consumed labels so we don't also list them as partials
              for (const ctor of info.constructors) {
                caseLabels.delete(ctor.name);
              }
            }
          }
          const parts: string[] = [];
          for (const adt of fullAdts) parts.push(adt);
          // Remaining labels that couldn't be grouped – show as ctor names
          for (const lbl of caseLabels) parts.push(lbl);
          if (parts.length === 0) return null;
          return parts.join(" | ");
        };
        for (const { name, scheme } of summaries) {
          const resolvedType = substituteHoleSolutionsInType(
            cloneType(scheme.type),
            layer3,
          );
          const typeStr = formatScheme({
            quantifiers: scheme.quantifiers,
            type: resolvedType,
          });
          const errorSummary = formatErrorSummary(resolvedType);
          if (errorSummary) {
            console.log(`${name} : ${typeStr}`);
            console.log(`  errors: ${errorSummary}`);
          } else {
            console.log(`${name} : ${typeStr}`);
          }
        }
      } else {
        console.log("(no top-level let bindings)");
      }
    }

    // Check for errors in err mode
    if (showErrorsOnly) {
      const layer3 = artifact.analysis.layer3;
      const source = await IO.readTextFile(filePath);
      const hasDiagnostics = layer3.diagnostics.solver.length > 0 ||
        layer3.diagnostics.conflicts.length > 0;

      if (hasDiagnostics) {
        // Format diagnostics for display
        let errorMessage = "";

        // Show solver diagnostics
        for (const diag of layer3.diagnostics.solver) {
          if (diag.span && source) {
            const lines = source.split("\n");
            const line = lines[diag.span.start] || "";
            errorMessage += `\nType Error: ${diag.reason}\n`;
            errorMessage += `  ${line}\n`;
          } else {
            errorMessage += `\nType Error: ${diag.reason}\n`;
          }
        }

        // Show conflict diagnostics (unfillable holes)
        for (const conflict of layer3.diagnostics.conflicts) {
          errorMessage += `\n${conflict.message}\n`;
          if (conflict.span && source) {
            const lines = source.split("\n");
            const line = lines[conflict.span.start] || "";
            errorMessage += `  ${line}\n`;
          }
        }

        if (errorMessage) {
          console.error(errorMessage.trim());
          IO.exit(1);
        }
      }
      // If no errors, exit successfully with no output
      IO.exit(0);
    }

    if (!skipEvaluation) {
      const tempDir = await IO.makeTempDir({ prefix: "workman-cli-" });
      try {
        const emitResult = await emitModuleGraph(compileResult.coreGraph, {
          outDir: tempDir,
        });
        const moduleUrl = toFileUrl(emitResult.entryPath).href;
        const moduleExports = await import(moduleUrl) as Record<
          string,
          unknown
        >;
        await invokeMainIfPresent(moduleExports);
        const forcedValueNames = coreModule.values.map((binding) =>
          binding.name
        );
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
          await IO.remove(tempDir, { recursive: true });
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
    IO.exit(1);
  }
}
