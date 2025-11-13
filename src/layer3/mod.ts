import type { SourceSpan } from "../ast.ts";
import type {
  MBlockExpr,
  MBlockStatement,
  MExpr,
  MMatchBundle,
  MPattern,
  MProgram,
} from "../ast_marked.ts";
import type {
  ConstraintConflict,
  ConstraintDiagnostic,
  HoleSolution,
  PartialType as Layer2PartialType,
  SolverResult,
} from "../layer2/mod.ts";
import { formatLabel } from "../types.ts";
import type { NodeId } from "../ast.ts";
import type { Type } from "../types.ts";
import { cloneType, getProvenance, isHoleType, unknownType } from "../types.ts";

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

export type FlowDiagnostic =
  | {
    kind: "not_implemented";
    message: string;
  }
  | {
    kind: "match_error_row_partial";
    nodeId: NodeId;
    span?: SourceSpan;
    missingConstructors: string[];
    message: string;
  };

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
  matchCoverages: Map<NodeId, MatchCoverageView>;
  summaries: TypeSummary[];
  constraintFlow?: ConstraintFlowView;
}

export interface MatchCoverageView {
  row: Type;
  coveredConstructors: string[];
  coversTail: boolean;
  missingConstructors: string[];
  dischargesResult: boolean;
}

export interface ConstraintFlowView {
  labels: Map<NodeId, Map<string, string>>; // domain -> formatted label
  edges: Map<NodeId, Set<NodeId>>; // from -> to
  sources: Map<NodeId, string[]>; // node -> list of source descriptions
}

export function presentProgram(layer2: SolverResult): Layer3Result {
  const spanIndex = collectSpans(layer2.remarkedProgram);
  const coverageInfo = collectMatchCoverages(layer2.remarkedProgram);
  const nodeViews = buildNodeViews(
    layer2.resolvedNodeTypes,
    layer2.solutions,
    spanIndex,
  );
  const solverDiagnostics = attachSpansToDiagnostics(
    layer2.diagnostics,
    spanIndex,
  );
  const conflictDiagnostics = buildConflictDiagnostics(
    layer2.conflicts,
    spanIndex,
  );
  const flowDiagnostics = buildCoverageDiagnostics(
    coverageInfo.partials,
    spanIndex,
  );

  const constraintFlowView = layer2.constraintFlow
    ? buildConstraintFlowView(layer2.constraintFlow)
    : undefined;

  return {
    nodeViews,
    diagnostics: {
      solver: solverDiagnostics,
      conflicts: conflictDiagnostics,
      flow: flowDiagnostics,
    },
    holeSolutions: layer2.solutions,
    spanIndex,
    matchCoverages: coverageInfo.coverages,
    summaries: layer2.summaries,
    constraintFlow: constraintFlowView,
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

    // If not found and this is a hole type, extract the underlying hole ID
    if (!solution && isHoleType(type)) {
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
 * Extract the actual hole ID from a hole type's provenance.
 * This handles error provenances that wrap the underlying hole.
 */
function extractHoleIdFromType(type: Type): NodeId | undefined {
  if (!isHoleType(type)) {
    return undefined;
  }

  const prov = getProvenance(type);
  if (!prov) return undefined;

  if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
    return (prov as Record<string, unknown>).id as NodeId;
  } else if (prov.kind === "incomplete") {
    return (prov as Record<string, unknown>).nodeId as NodeId;
  } else if (
    prov.kind === "error_not_function" || prov.kind === "error_inconsistent"
  ) {
    // Unwrap error provenance to get the underlying hole
    const innerType = (prov as Record<string, unknown>).calleeType ||
      (prov as Record<string, unknown>).actual;
    if (innerType && isHoleType(innerType as Type)) {
      return extractHoleIdFromType(innerType as Type);
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
  if (isHoleType(type)) {
    // If the underlying hole is conflicted, replace the error provenance
    if (solution?.state === "conflicted") {
      const prov = solution.provenance.provenance;
      const holeId = prov.kind === "expr_hole"
        ? (prov as Record<string, unknown>).id as number
        : 0;
      const conflictedType = unknownType({
        kind: "error_unfillable_hole",
        holeId,
        conflicts: solution.conflicts || [],
      });
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
    case "error_row": {
      // Ergonomic printing: tail-only rows render as the tail type directly
      if (type.cases.size === 0 && type.tail) {
        return typeToString(type.tail);
      }
      const entries = Array.from(type.cases.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const parts = entries.map(([label, payload]) =>
        payload ? `${label}(${typeToString(payload)})` : label
      );

      // Simplify display: if one concrete case with an open tail variable, hide the tail
      if (parts.length === 1 && type.tail?.kind === "var") {
        return `<${parts[0]}>`;
      }

      // Otherwise show full notation with tail
      if (type.tail) {
        const tailStr = typeToString(type.tail);
        // Tail represents "all other potential errors" - prefix with _
        parts.push(`_${tailStr}`);
      } else if (parts.length === 0) {
        // Empty error row
        parts.push("_");
      }
      return `<${parts.join(" | ")}>`;
    }
    default:
      return "unknown";
  }
}

function buildCoverageDiagnostics(
  partials: CoveragePartialInfo[],
  spanIndex: Map<NodeId, SourceSpan>,
): FlowDiagnostic[] {
  return partials.map((entry) => {
    const missing = entry.coverage.missingConstructors.join(", ");
    return {
      kind: "match_error_row_partial",
      nodeId: entry.nodeId,
      span: spanIndex.get(entry.nodeId),
      missingConstructors: entry.coverage.missingConstructors,
      message: `Match does not cover Err constructors: ${missing}`,
    };
  });
}

function collectSpans(program: MProgram): Map<NodeId, SourceSpan> {
  const spans = new Map<NodeId, SourceSpan>();
  traverse(program, spans, new Set());
  return spans;
}

interface CoveragePartialInfo {
  nodeId: NodeId;
  coverage: MatchCoverageView;
}

function collectMatchCoverages(program: MProgram): {
  coverages: Map<NodeId, MatchCoverageView>;
  partials: CoveragePartialInfo[];
} {
  const coverages = new Map<NodeId, MatchCoverageView>();
  const partials: CoveragePartialInfo[] = [];
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      collectCoverageFromBlock(decl.body, coverages, partials);
      if (decl.mutualBindings) {
        for (const binding of decl.mutualBindings) {
          collectCoverageFromBlock(binding.body, coverages, partials);
        }
      }
    }
  }
  return { coverages, partials };
}

function collectCoverageFromBlock(
  block: MBlockExpr,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  for (const stmt of block.statements) {
    collectCoverageFromStatement(stmt, coverages, partials);
  }
  if (block.result) {
    collectCoverageFromExpr(block.result, coverages, partials);
  }
}

function collectCoverageFromStatement(
  statement: MBlockStatement,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  if (statement.kind === "let_statement") {
    collectCoverageFromBlock(statement.declaration.body, coverages, partials);
    if (statement.declaration.mutualBindings) {
      for (const binding of statement.declaration.mutualBindings) {
        collectCoverageFromBlock(binding.body, coverages, partials);
      }
    }
  } else if (statement.kind === "expr_statement") {
    collectCoverageFromExpr(statement.expression, coverages, partials);
  }
}

function collectCoverageFromExpr(
  expr: MExpr,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  switch (expr.kind) {
    case "identifier":
    case "literal":
    case "hole":
    case "mark_free_var":
    case "mark_not_function":
    case "mark_occurs_check":
    case "mark_inconsistent":
    case "mark_unsupported_expr":
    case "mark_type_expr_unknown":
    case "mark_type_expr_arity":
    case "mark_type_expr_unsupported":
      return;
    case "constructor":
      expr.args.forEach((arg) =>
        collectCoverageFromExpr(arg, coverages, partials)
      );
      return;
    case "tuple":
      expr.elements.forEach((el) =>
        collectCoverageFromExpr(el, coverages, partials)
      );
      return;
    case "record_literal":
      expr.fields.forEach((field) =>
        collectCoverageFromExpr(field.value, coverages, partials)
      );
      return;
    case "call":
      collectCoverageFromExpr(expr.callee, coverages, partials);
      expr.arguments.forEach((arg) =>
        collectCoverageFromExpr(arg, coverages, partials)
      );
      return;
    case "record_projection":
      collectCoverageFromExpr(expr.target, coverages, partials);
      return;
    case "binary":
      collectCoverageFromExpr(expr.left, coverages, partials);
      collectCoverageFromExpr(expr.right, coverages, partials);
      return;
    case "unary":
      collectCoverageFromExpr(expr.operand, coverages, partials);
      return;
    case "arrow":
      expr.parameters.forEach((param) =>
        collectCoverageFromPattern(param.pattern, coverages, partials)
      );
      collectCoverageFromBlock(expr.body, coverages, partials);
      return;
    case "block":
      collectCoverageFromBlock(expr, coverages, partials);
      return;
    case "match":
      recordCoverageForBundle(expr.id, expr.bundle, coverages, partials);
      collectCoverageFromExpr(expr.scrutinee, coverages, partials);
      collectCoverageFromMatchBundle(expr.bundle, coverages, partials);
      return;
    case "match_fn":
      expr.parameters.forEach((param) =>
        collectCoverageFromExpr(param, coverages, partials)
      );
      recordCoverageForBundle(expr.id, expr.bundle, coverages, partials);
      collectCoverageFromMatchBundle(expr.bundle, coverages, partials);
      return;
    case "match_bundle_literal":
      recordCoverageForBundle(expr.id, expr.bundle, coverages, partials);
      collectCoverageFromMatchBundle(expr.bundle, coverages, partials);
      return;
    default:
      return;
  }
}

function collectCoverageFromPattern(
  pattern: MPattern,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  switch (pattern.kind) {
    case "literal":
    case "wildcard":
    case "variable":
    case "all_errors":
    case "mark_pattern":
      return;
    case "constructor":
      pattern.args.forEach((arg) =>
        collectCoverageFromPattern(arg, coverages, partials)
      );
      return;
    case "tuple":
      pattern.elements.forEach((el) =>
        collectCoverageFromPattern(el, coverages, partials)
      );
      return;
  }
}

function collectCoverageFromMatchBundle(
  bundle: MMatchBundle,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  bundle.arms.forEach((arm) => {
    if (arm.kind === "match_pattern") {
      collectCoverageFromPattern(arm.pattern, coverages, partials);
      collectCoverageFromExpr(arm.body, coverages, partials);
    }
  });
}

function recordCoverageForBundle(
  ownerId: NodeId,
  bundle: MMatchBundle,
  coverages: Map<NodeId, MatchCoverageView>,
  partials: CoveragePartialInfo[],
): void {
  if (!bundle.errorRowCoverage) {
    return;
  }
  const cloned = cloneMatchCoverage(
    bundle.errorRowCoverage,
    bundle.dischargesResult ?? false,
  );
  coverages.set(ownerId, cloned);
  if (cloned.missingConstructors.length > 0) {
    partials.push({ nodeId: ownerId, coverage: cloned });
  }
}

function cloneMatchCoverage(
  coverage: {
    row: Type;
    coveredConstructors: string[];
    coversTail: boolean;
    missingConstructors: string[];
  },
  dischargesResult: boolean,
): MatchCoverageView {
  return {
    row: cloneType(coverage.row),
    coveredConstructors: [...coverage.coveredConstructors],
    coversTail: coverage.coversTail,
    missingConstructors: [...coverage.missingConstructors],
    dischargesResult,
  };
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

function buildConstraintFlowView(flow: any): ConstraintFlowView {
  const labels = new Map<NodeId, Map<string, string>>();
  const sources = new Map<NodeId, string[]>();

  // Convert labels to display format
  for (const [nodeId, domainMap] of flow.labels.entries()) {
    const displayMap = new Map<string, string>();
    for (const [domain, label] of domainMap.entries()) {
      displayMap.set(domain, formatLabel(label));
    }
    labels.set(nodeId, displayMap);

    // Build source descriptions
    const sourceDescs: string[] = [];
    for (const [domain, label] of domainMap.entries()) {
      sourceDescs.push(`${domain}: ${formatLabel(label)}`);
    }
    if (sourceDescs.length > 0) {
      sources.set(nodeId, sourceDescs);
    }
  }

  return {
    labels,
    edges: flow.edges,
    sources,
  };
}
