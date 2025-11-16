import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import {
  collectCompiledValues,
  invokeMainIfPresent,
} from "../src/runtime_display.ts";
import { formatScheme } from "../src/type_printer.ts";
import { cloneType } from "../src/types.ts";
import type { Type } from "../src/types.ts";
import { IO, resolve, toFileUrl } from "../src/io.ts";
import { WorkmanError } from "../src/error.ts";
import { substituteHoleSolutionsInType } from "./type_utils.ts";

const RUN_USAGE =
  "Usage: wm [fmt|type|err|compile] <file.wm> | wm <file.wm> | wm (REPL mode)";

export async function runProgramCommand(
  args: string[],
  debugMode: boolean,
): Promise<void> {
  let filePath: string;
  let skipEvaluation = false;
  let showErrorsOnly = false;

  if (args[0] === "type") {
    if (args.length !== 2) {
      console.error(RUN_USAGE);
      IO.exit(1);
    }
    filePath = args[1];
    skipEvaluation = true;
  } else if (args[0] === "err") {
    if (args.length !== 2) {
      console.error(RUN_USAGE);
      IO.exit(1);
    }
    filePath = args[1];
    showErrorsOnly = true;
    skipEvaluation = true;
  } else {
    if (args.length !== 1) {
      console.error(RUN_USAGE);
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
        skipEvaluation: true,
      },
      lowering: {
        showAllErrors: skipEvaluation,
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

    if ((skipEvaluation || debugMode) && !showErrorsOnly) {
      await displayExpressionSummaries({
        filePath,
        artifact,
      });
    }

    if (showErrorsOnly) {
      await reportErrorsOnly(filePath, artifact.analysis.layer3);
      IO.exit(0);
    }

    if (!skipEvaluation) {
      await executeModule(coreModule, compileResult.coreGraph, debugMode);
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

async function displayExpressionSummaries(
  options: {
    filePath: string;
    artifact: any;
  },
): Promise<void> {
  const { filePath, artifact } = options;
  const layer3 = artifact.analysis.layer3;
  const source = await IO.readTextFile(filePath);

  const nodeViewsWithSpans: Array<
    { nodeId: number; view: any; span: any }
  > = [];
  for (const [nodeId, view] of layer3.nodeViews.entries()) {
    if (view.sourceSpan) {
      nodeViewsWithSpans.push({ nodeId, view, span: view.sourceSpan });
    }
  }

  nodeViewsWithSpans.sort((left, right) => {
    if (left.span.start !== right.span.start) {
      return left.span.start - right.span.start;
    }
    return left.span.end - right.span.end;
  });

  const offsetToLineCol = (offset: number) => {
    let line = 0;
    let col = 0;
    for (let index = 0; index < offset && index < source.length; index++) {
      if (source[index] === "\n") {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    return { line, col };
  };

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

    const solution = layer3.holeSolutions.get(nodeId);
    let annotation = "";

    if (solution) {
      if (solution.state === "partial" && solution.partial?.known) {
        const partialType = formatScheme({
          quantifiers: [],
          type: solution.partial.known,
        });
        annotation = ` ?? partial: ${partialType}`;
      } else if (solution.state === "conflicted" && solution.conflicts) {
        annotation =
          ` ?? CONFLICT: ${solution.conflicts.length} incompatible constraints`;
      } else if (solution.state === "unsolved") {
        annotation = " ? unsolved";
      }
    }

    let infectionInfo: string | undefined;
    if (artifact.analysis.layer3.constraintFlow) {
      const flow = artifact.analysis.layer3.constraintFlow;
      const nodeLabels = flow.labels.get(nodeId);
      const incomingEdges = new Set<number>();

      for (const [fromId, toIds] of flow.edges.entries()) {
        if (toIds.has(nodeId)) {
          incomingEdges.add(fromId);
        }
      }

      if (nodeLabels || incomingEdges.size > 0) {
        const parts: string[] = [];

        if (incomingEdges.size > 0) {
          const incomingList = Array.from(incomingEdges).map((id) => {
            const span = artifact.analysis.layer3.spanIndex.get(id);
            return span ? `line ${span.start + 1}` : `node ${id}`;
          }).join(", ");
          parts.push(`infected from: ${incomingList}`);
        }

        if (nodeLabels) {
          for (const [domain, labelStr] of nodeLabels.entries()) {
            parts.push(`${domain}: ${labelStr}`);
          }
        }

        if (parts.length > 0) {
          infectionInfo = `?? ${parts.join("; ")}`;
        }
      }
    }

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
            `? discharges Err row ${rowStr}; constructors: ${handledLabel}`;
        } else {
          coverageInfo =
            `?? covers Err row ${rowStr} but infection continues (handled: ${handledLabel})`;
        }
      } else {
        const missingLabel = coverage.missingConstructors.join(", ");
        coverageInfo =
          `?? missing Err constructors ${missingLabel} for row ${rowStr} (handled: ${handledLabel})`;
      }
    }

    const lineNumber = startPos.line + 1;
    if (!expressionsByLine.has(lineNumber)) {
      expressionsByLine.set(lineNumber, []);
    }
    expressionsByLine.get(lineNumber)!.push({
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

  for (const [lineNumber, expressions] of expressionsByLine.entries()) {
    const lineText = source.split("\n")[lineNumber - 1] || "";
    console.log(`Line ${lineNumber}: ${lineText}`);

    expressions.sort((left, right) => left.startPos.col - right.startPos.col);

    for (const expression of expressions) {
      console.log(
        ` Col ${expression.startPos.col}: ${expression.excerpt}    //(nodeId:${expression.nodeId})`,
      );
      console.log(`  type: ${expression.typeStr}${expression.annotation}`);

      if (expression.infectionInfo) {
        console.log(`    ${expression.infectionInfo}`);
      }

      if (expression.coverageInfo) {
        console.log(`    ${expression.coverageInfo}`);
      }
    }
    console.log();
  }

  await displayTopLevelSummaries(artifact);
}

async function displayTopLevelSummaries(artifact: any): Promise<void> {
  console.log("=== Top-Level Bindings ===\n");
  const summaries = artifact.analysis.layer1.summaries;
  const adtEnv = artifact.analysis.layer1.adtEnv;
  if (summaries.length === 0) {
    console.log("(no top-level let bindings)");
    return;
  }

  type ErrorRow = {
    kind: "error_row";
    cases: Map<string, Type | null>;
    tail?: Type | null;
  };

  const formatErrorSummary = (type: Type): string | null => {
    if (
      type.kind !== "constructor" || type.name !== "Result" ||
      type.args.length !== 2
    ) return null;
    const errArg = type.args[1];
    const ensureRow = (input: Type): ErrorRow => {
      const rowLike = input as unknown as Partial<ErrorRow>;
      if (rowLike.kind === "error_row") {
        return rowLike as ErrorRow;
      }
      return {
        kind: "error_row",
        cases: new Map(),
        tail: input,
      };
    };
    const row = ensureRow(errArg);
    const caseLabels = new Set<string>(Array.from(row.cases.keys()));
    const fullAdts = new Set<string>();
    if (row.tail && row.tail.kind === "constructor") {
      fullAdts.add(row.tail.name);
    }
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
        for (const ctor of info.constructors) {
          caseLabels.delete(ctor.name);
        }
      }
    }
    const parts: string[] = [];
    for (const adt of fullAdts) parts.push(adt);
    for (const label of caseLabels) parts.push(label);
    if (parts.length === 0) return null;
    return parts.join(" | ");
  };

  const layer3 = artifact.analysis.layer3;
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
}

async function reportErrorsOnly(
  filePath: string,
  layer3: any,
): Promise<void> {
  const source = await IO.readTextFile(filePath);
  const hasDiagnostics = layer3.diagnostics.solver.length > 0 ||
    layer3.diagnostics.conflicts.length > 0;

  if (hasDiagnostics) {
    let errorMessage = "";

    for (const diag of layer3.diagnostics.solver) {
      if (diag.span && source) {
        const lines = source.split("\n");
        const line = lines[diag.span.start] || "";
        let message = `Type Error: ${diag.reason}`;

        if (diag.details && typeof diag.details === "object") {
          const details = diag.details as Record<string, unknown>;
          if (
            diag.reason === "type_mismatch" && details.left && details.right
          ) {
            const leftType = formatScheme({
              quantifiers: [],
              type: details.left as Type,
            });
            const rightType = formatScheme({
              quantifiers: [],
              type: details.right as Type,
            });
            message += `\n    Expected: ${rightType}\n    Found: ${leftType}`;
          }
        }

        errorMessage += `\n${message}\n`;
        errorMessage += `  ${line}\n`;
      } else {
        errorMessage += `\nType Error: ${diag.reason}\n`;
      }
    }

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
}

async function executeModule(
  coreModule: any,
  coreGraph: any,
  debugMode: boolean,
): Promise<void> {
  const tempDir = await IO.makeTempDir({ prefix: "workman-cli-" });
  try {
    const emitResult = await emitModuleGraph(coreGraph, {
      outDir: tempDir,
    });
    const moduleUrl = toFileUrl(emitResult.entryPath).href;
    const moduleExports = await import(moduleUrl) as Record<string, unknown>;
    await invokeMainIfPresent(moduleExports);
    const forcedValueNames = coreModule.values.map((binding: any) =>
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
