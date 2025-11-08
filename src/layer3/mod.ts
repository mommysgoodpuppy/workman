import type { SourceSpan } from "../ast.ts";
import type { MProgram } from "../ast_marked.ts";
import {
  type ConstraintConflict,
  type ConstraintDiagnostic,
  type HoleSolution,
  type PartialType as Layer2PartialType,
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

export interface ConflictDiagnostic {
  kind: "unfillable_hole";
  holeId: NodeId;
  span?: SourceSpan;
  conflictingTypes: Type[];
  reason: string;
  message: string;
}

export interface FlowDiagnostic {
  kind: "not_implemented";
  message: string;
}

export interface TypeSummary {
  name: string;
  scheme: import("../types.ts").TypeScheme;
}

export interface Layer3Result {
  nodeViews: Map<NodeId, NodeView>;
  diagnostics: {
    solver: ConstraintDiagnosticWithSpan[];
    conflicts: ConflictDiagnostic[];
    flow: FlowDiagnostic[];
  };
  holeSolutions: Map<NodeId, HoleSolution>;
  spanIndex: Map<NodeId, SourceSpan>;
  summaries: TypeSummary[];
}

export function presentProgram(layer2: SolverResult): Layer3Result {
  const spanIndex = collectSpans(layer2.remarkedProgram);
  const nodeViews = buildNodeViews(layer2.resolvedNodeTypes, layer2.solutions, spanIndex);
  const solverDiagnostics = attachSpansToDiagnostics(
    layer2.diagnostics,
    spanIndex,
  );
  const conflictDiagnostics = buildConflictDiagnostics(
    layer2.conflicts,
    spanIndex,
  );

  return {
    nodeViews,
    diagnostics: {
      solver: solverDiagnostics,
      conflicts: conflictDiagnostics,
      flow: [],
    },
    holeSolutions: layer2.solutions,
    spanIndex,
    summaries: layer2.summaries,
  };
}

function buildNodeViews(
  resolved: Map<NodeId, Type>,
  solutions: Map<NodeId, HoleSolution>,
  spanIndex: Map<NodeId, SourceSpan>,
): Map<NodeId, NodeView> {
  const views = new Map<NodeId, NodeView>();
  for (const [nodeId, type] of resolved.entries()) {
    // First try to get solution for this node directly
    let solution = solutions.get(nodeId);
    
    // If not found and this is an unknown type, extract the underlying hole ID
    if (!solution && type.kind === "unknown") {
      const holeId = extractHoleIdFromType(type);
      if (holeId !== undefined && holeId !== nodeId) {
        solution = solutions.get(holeId);
      }
    }
    
    const view: NodeView = {
      nodeId,
      sourceSpan: spanIndex.get(nodeId),
      finalType: typeToPartial(type, solution),
    };
    views.set(nodeId, view);
  }
  return views;
}

/**
 * Extract the actual hole ID from an unknown type's provenance.
 * This handles error provenances that wrap the underlying hole.
 */
function extractHoleIdFromType(type: Type): NodeId | undefined {
  if (type.kind !== "unknown") {
    return undefined;
  }
  
  const prov = type.provenance;
  if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
    return (prov as any).id;
  } else if (prov.kind === "incomplete") {
    return (prov as any).nodeId;
  } else if (prov.kind === "error_not_function" || prov.kind === "error_inconsistent") {
    // Unwrap error provenance to get the underlying hole
    const innerType = (prov as any).calleeType || (prov as any).actual;
    if (innerType?.kind === "unknown") {
      return extractHoleIdFromType(innerType);
    }
  }
  
  return undefined;
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

function typeToPartial(type: Type, solution?: HoleSolution): PartialType {
  if (type.kind === "unknown") {
    // If the underlying hole is conflicted, replace the error provenance
    if (solution?.state === "conflicted") {
      const conflictedType: Type = {
        kind: "unknown",
        provenance: {
          kind: "error_unfillable_hole",
          holeId: solution.provenance.kind === "expr_hole" ? (solution.provenance as any).id : 0,
          conflicts: solution.conflicts || [],
        },
      };
      return { kind: "unknown", type: conflictedType };
    }
    
    // If we have a partial solution, use it
    if (solution?.state === "partial" && solution.partial?.known) {
      return { kind: "concrete", type: solution.partial.known };
    }
    
    return { kind: "unknown", type };
  }
  return { kind: "concrete", type };
}

function buildConflictDiagnostics(
  conflicts: ConstraintConflict[],
  spanIndex: Map<NodeId, SourceSpan>,
): ConflictDiagnostic[] {
  return conflicts.map((conflict) => {
    const typeNames = conflict.types.map((t) => typeToString(t)).join(" vs ");
    return {
      kind: "unfillable_hole",
      holeId: conflict.holeId,
      span: spanIndex.get(conflict.holeId),
      conflictingTypes: conflict.types,
      reason: conflict.reason,
      message: `Type hole has conflicting constraints: ${typeNames}`,
    };
  });
}

function typeToString(type: Type): string {
  switch (type.kind) {
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "string":
      return "String";
    case "char":
      return "Char";
    case "unit":
      return "Unit";
    case "var":
      return `'${type.id}`;
    case "func":
      return `(${typeToString(type.from)} -> ${typeToString(type.to)})`;
    case "constructor":
      if (type.args.length === 0) {
        return type.name;
      }
      return `${type.name}<${type.args.map(typeToString).join(", ")}>`;
    case "tuple":
      return `(${type.elements.map(typeToString).join(", ")})`;
    case "record": {
      const fields = Array.from(type.fields.entries())
        .map(([name, t]) => `${name}: ${typeToString(t)}`)
        .join(", ");
      return `{ ${fields} }`;
    }
    case "unknown":
      return "?";
    default:
      return "unknown";
  }
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
