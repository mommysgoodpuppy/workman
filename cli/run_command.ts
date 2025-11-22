import {
  compileWorkmanGraph,
  type WorkmanModuleArtifacts,
} from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import {
  collectCompiledValues,
  invokeMainIfPresent,
} from "../src/runtime_display.ts";
import { formatScheme } from "../src/type_printer.ts";
import { cloneType } from "../src/types.ts";
import type { Type } from "../src/types.ts";
import { IO, relative, resolve, toFileUrl } from "../src/io.ts";
import {
  RuntimeError as WorkmanRuntimeError,
  WorkmanError,
} from "../src/error.ts";
import { substituteHoleSolutionsInType } from "./type_utils.ts";
import type { SourceSpan } from "../src/ast.ts";

const RUN_USAGE =
  "Usage: wm [fmt|type [--line <line>] |err|compile] <file.wm> | wm <file.wm> | wm (REPL mode)";

interface NodeLocationEntry {
  path: string;
  source: string;
  span: SourceSpan;
}

interface NonExhaustiveMatchMetadata {
  kind: "non_exhaustive_match";
  nodeId: number | null;
  span: SourceSpan | null;
  patterns: string[];
  valueDescription?: string;
  modulePath?: string | null;
}

export async function runProgramCommand(
  args: string[],
  debugMode: boolean,
): Promise<void> {
  let filePath: string;
  let lineNumber: number | undefined = undefined;
  let skipEvaluation = false;
  let showErrorsOnly = false;

  if (args[0] === "type") {
    let index = 1;
    if (args[index] === "--line") {
      if (args.length < 4) {
        console.error(RUN_USAGE);
        IO.exit(1);
      }
      const lineStr = args[index + 1];
      const parsed = parseInt(lineStr, 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error("Invalid line number, must be a positive integer");
        IO.exit(1);
      }
      lineNumber = parsed;
      index += 2;
    }
    if (args.length !== index + 1) {
      console.error(RUN_USAGE);
      IO.exit(1);
    }
    filePath = args[index];
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
        lineFilter: lineNumber,
      });
    }

    if (showErrorsOnly) {
      await reportErrorsOnly(filePath, artifact.analysis.layer3);
      IO.exit(0);
    }

    if (!skipEvaluation) {
      const nodeLocations = buildNodeLocationIndex(compileResult.modules);
      await executeModule(
        coreModule,
        compileResult.coreGraph,
        debugMode,
        nodeLocations,
      );
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
    lineFilter?: number;
  },
): Promise<void> {
  const { filePath, artifact, lineFilter } = options;
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
    let resolvedType = view.finalType.kind === "concrete" && view.finalType.type
      ? view.finalType.type
      : (view.finalType.kind === "unknown" && view.finalType.type)
      ? substituteHoleSolutionsInType(view.finalType.type, layer3)
      : undefined;
    if (resolvedType) {
      typeStr = formatScheme({
        quantifiers: [],
        type: resolvedType,
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

  for (const [lineNum, expressions] of expressionsByLine.entries()) {
    if (lineFilter !== undefined && lineNum !== lineFilter) continue;

    const lineText = source.split("\n")[lineNum - 1] || "";
    console.log(`Line ${lineNum}: ${lineText}`);

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

  if (lineFilter === undefined) {
    await displayTopLevelSummaries(artifact);
  }
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
    kind: "effect_row";
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
      if (rowLike.kind === "effect_row") {
        return rowLike as ErrorRow;
      }
      return {
        kind: "effect_row",
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
        let message = `Type Error: `;

        if (diag.reason === "pattern_binding_required" && diag.details) {
          const details = diag.details as Record<string, unknown>;
          const name = typeof details.name === "string"
            ? details.name
            : "value";
          message +=
            `Pattern '${name}' would bind a new name. Use Var(${name}) to bind or ^${name} to pin an existing value.`;
        } else if (diag.reason === "non_exhaustive_match" && diag.details) {
          const details = diag.details as Record<string, unknown>;
          message += "Match expression is not exhaustive";
          const missing = Array.isArray(details.missingCases)
            ? (details.missingCases as string[]).join(", ")
            : null;
          if (missing) {
            message += ` - missing cases: ${missing}`;
          }
          const hint = typeof details.hint === "string" ? details.hint : null;
          if (hint) {
            message += `\n    Hint: ${hint}`;
          }
        } else if (diag.details && typeof diag.details === "object") {
          const details = diag.details as Record<string, unknown>;
          if (details.expected && details.actual) {
            const foundResolved = substituteHoleSolutionsInType(
              cloneType(details.actual as Type),
              layer3,
            );
            const expectedResolved = substituteHoleSolutionsInType(
              cloneType(details.expected as Type),
              layer3,
            );
            const foundType = formatScheme({
              quantifiers: [],
              type: foundResolved,
            });
            const expectedType = formatScheme({
              quantifiers: [],
              type: expectedResolved,
            });
            message += "Type mismatch";
            message +=
              `\n    Expected: ${expectedType}\n    Found: ${foundType}`;
          } else {
            message += `${diag.reason}`;
          }
        } else {
          message += `${diag.reason}`;
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

function buildNodeLocationIndex(
  modules: ReadonlyMap<string, WorkmanModuleArtifacts>,
): Map<string, Map<number, NodeLocationEntry>> {
  const index = new Map<string, Map<number, NodeLocationEntry>>();
  for (const artifact of modules.values()) {
    const { path, source } = artifact.node;
    const spans = artifact.analysis.layer3.spanIndex;
    let moduleMap = index.get(path);
    if (!moduleMap) {
      moduleMap = new Map<number, NodeLocationEntry>();
      index.set(path, moduleMap);
    }
    for (const [nodeId, span] of spans.entries()) {
      if (!span) continue;
      moduleMap.set(nodeId, { path, source, span });
    }
  }
  return index;
}

async function executeModule(
  coreModule: any,
  coreGraph: any,
  debugMode: boolean,
  nodeLocations: Map<string, Map<number, NodeLocationEntry>>,
): Promise<void> {
  const tempDir = await IO.makeTempDir({ prefix: "workman-cli-" });
  try {
    const emitResult = await emitModuleGraph(coreGraph, {
      outDir: tempDir,
    });
    const moduleUrl = toFileUrl(emitResult.entryPath).href;
    try {
      const moduleExports = await import(moduleUrl) as Record<string, unknown>;
      //await invokeMainIfPresent(moduleExports);
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
    } catch (runtimeError) {
      throw enhanceRuntimeError(runtimeError, nodeLocations);
    }
  } finally {
    try {
      await IO.remove(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function enhanceRuntimeError(
  error: unknown,
  nodeLocations: Map<string, Map<number, NodeLocationEntry>>,
): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const metadata = (error as { workmanMetadata?: NonExhaustiveMatchMetadata })
    .workmanMetadata;
  if (!metadata || metadata.kind !== "non_exhaustive_match") {
    return error;
  }
  const patterns = metadata.patterns.length > 0
    ? metadata.patterns.join(", ")
    : "unknown patterns";
  const valueDesc = metadata.valueDescription ?? "value";

  const locationCandidates = [metadata.callSite, metadata].filter(Boolean) as
    Array<{
      nodeId: number | null | undefined;
      modulePath?: string | null;
      span?: SourceSpan | null;
    }>;

  let location: NodeLocationEntry | undefined;
  let resolvedNodeId: number | null = null;
  for (const candidate of locationCandidates) {
    const nodeId = typeof candidate.nodeId === "number" ? candidate.nodeId : null;
    if (nodeId !== null) {
      location = findNodeLocation(nodeId, candidate.modulePath, nodeLocations);
      if (location) {
        resolvedNodeId = nodeId;
        break;
      }
    }
  }

  const locationLabel = location
    ? `at node ${resolvedNodeId}`
    : "at unknown location";
  const message =
    `Non-exhaustive match ${locationLabel}. Value ${valueDesc} is not handled. Patterns: ${patterns}.`;
  if (location) {
    const runtimeError = new WorkmanRuntimeError(
      message,
      location.span,
      location.source,
    );
    (runtimeError as { cause?: Error }).cause = error;
    return runtimeError;
  }
  const runtimeError = new WorkmanRuntimeError(message);
  (runtimeError as { cause?: Error }).cause = error;
  return runtimeError;
}

function findNodeLocation(
  nodeId: number,
  modulePath: string | null | undefined,
  nodeLocations: Map<string, Map<number, NodeLocationEntry>>,
): NodeLocationEntry | undefined {
  if (modulePath && nodeLocations.has(modulePath)) {
    const exact = nodeLocations.get(modulePath)!.get(nodeId);
    if (exact) {
      return exact;
    }
  }
  for (const moduleMap of nodeLocations.values()) {
    const candidate = moduleMap.get(nodeId);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}
