import type { SourceSpan } from "../ast.ts";
import type { MProgram } from "../ast_marked.ts";
import type { InferResult } from "../layer1/infer.ts";
import {
  type ConstraintDiagnostic,
  type SolverResult,
} from "../layer2/mod.ts";
import type { NodeId } from "../ast.ts";
import type { Type } from "../types.ts";

export interface PartialType {
  kind: "unknown" | "concrete";
  type?: Type;
}

export interface NodeView {
  nodeId: NodeId;
  sourceSpan?: SourceSpan;
  finalType: PartialType;
  observed?: PartialType;
  expected?: PartialType;
}

export interface ConstraintDiagnosticWithSpan extends ConstraintDiagnostic {
  span?: SourceSpan;
}

export interface FlowDiagnostic {
  kind: "not_implemented";
  message: string;
}

export interface Layer3Result {
  nodeViews: Map<NodeId, NodeView>;
  diagnostics: {
    solver: ConstraintDiagnosticWithSpan[];
    flow: FlowDiagnostic[];
  };
  spanIndex: Map<NodeId, SourceSpan>;
}

export interface PresentProgramInput {
  layer1: InferResult;
  layer2: SolverResult;
}

export function presentProgram(input: PresentProgramInput): Layer3Result {
  const spanIndex = collectSpans(input.layer1.markedProgram);
  const nodeViews = buildNodeViews(input.layer2.resolvedNodeTypes, spanIndex);
  const solverDiagnostics = attachSpansToDiagnostics(
    input.layer2.diagnostics,
    spanIndex,
  );

  return {
    nodeViews,
    diagnostics: {
      solver: solverDiagnostics,
      flow: [],
    },
    spanIndex,
  };
}

function buildNodeViews(
  resolved: Map<NodeId, Type>,
  spanIndex: Map<NodeId, SourceSpan>,
): Map<NodeId, NodeView> {
  const views = new Map<NodeId, NodeView>();
  for (const [nodeId, type] of resolved.entries()) {
    const view: NodeView = {
      nodeId,
      sourceSpan: spanIndex.get(nodeId),
      finalType: typeToPartial(type),
    };
    views.set(nodeId, view);
  }
  return views;
}

function attachSpansToDiagnostics(
  diagnostics: ConstraintDiagnostic[],
  spanIndex: Map<NodeId, SourceSpan>,
): ConstraintDiagnosticWithSpan[] {
  return diagnostics.map((diag) => ({
    ...diag,
    span: spanIndex.get(diag.origin),
  }));
}

function typeToPartial(type: Type): PartialType {
  if (type.kind === "unknown") {
    return { kind: "unknown" };
  }
  return { kind: "concrete", type };
}

function collectSpans(program: MProgram): Map<NodeId, SourceSpan> {
  const spans = new Map<NodeId, SourceSpan>();
  traverse(program, spans, new Set());
  return spans;
}

export function findNodeAtOffset(
  spanIndex: Map<NodeId, SourceSpan>,
  offset: number,
): NodeId | undefined {
  let best: { nodeId: NodeId; span: SourceSpan } | undefined = undefined;
  for (const [nodeId, span] of spanIndex.entries()) {
    if (span.start <= offset && offset < span.end) {
      if (
        !best ||
        (span.end - span.start) < (best.span.end - best.span.start)
      ) {
        best = { nodeId, span };
      }
    }
  }
  return best?.nodeId;
}

function traverse(
  node: unknown,
  spans: Map<NodeId, SourceSpan>,
  seen: Set<unknown>,
): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (seen.has(node)) {
    return;
  }
  seen.add(node);

  const maybeId = (node as { id?: NodeId }).id;
  const maybeSpan = (node as { span?: SourceSpan }).span;
  if (maybeId !== undefined && maybeSpan !== undefined) {
    spans.set(maybeId, maybeSpan);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      traverse(item, spans, seen);
    }
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      traverse(value, spans, seen);
    }
  }
}
