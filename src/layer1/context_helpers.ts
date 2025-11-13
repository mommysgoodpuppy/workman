// Helper functions extracted from context.ts to avoid Andromeda circular import issues
import type { Expr, Literal, NodeId, Pattern } from "../ast.ts";
import { isHoleType, type Type, unknownType, getProvenance } from "../types.ts";
import type { HoleOrigin, UnknownCategory } from "./context_types.ts";

// Context interface is forward-declared here to avoid importing from context.ts
// Materialize.ts can import this type from here instead of from context.ts
export interface Context {
  holes: Map<NodeId, any>;
}

export function literalType(literal: Literal): Type {
  switch (literal.kind) {
    case "int":
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "char":
      return { kind: "char" };
    case "unit":
      return { kind: "unit" };
    case "string":
      return { kind: "string" };
    default:
      return unknownType({ kind: "incomplete", reason: "literal.unsupported" });
  }
}

export function holeOriginFromExpr(expr: Expr): HoleOrigin {
  return {
    kind: "expr",
    nodeId: expr.id,
    span: expr.span,
  };
}

export function holeOriginFromPattern(pattern: Pattern): HoleOrigin {
  return {
    kind: "pattern",
    nodeId: pattern.id,
    span: pattern.span,
  };
}

function categoryFromProvenance(provenance: any): UnknownCategory {
  switch (provenance.kind) {
    case "user_hole":
    case "expr_hole":
      return "incomplete";
    case "error_free_var":
    case "error_inconsistent":
    case "error_not_function":
    case "error_occurs_check":
    case "error_unify_conflict":
    case "error_unfillable_hole":
      return "local_conflict";
    case "error_type_expr_unknown":
    case "error_type_expr_arity":
    case "error_type_expr_unsupported":
    case "error_internal":
      return "internal";
    case "incomplete":
      return "incomplete";
    default:
      return "internal";
  }
}

export function registerHoleForType(
  ctx: Context,
  origin: HoleOrigin,
  type: Type,
  category?: UnknownCategory,
  relatedNodes: NodeId[] = [],
): void {
  if (!isHoleType(type)) {
    if (ctx.holes.has(origin.nodeId)) {
      ctx.holes.delete(origin.nodeId);
    }
    return;
  }

  const provenance = getProvenance(type);
  if (!provenance) return;

  if (
    provenance.kind === "incomplete" &&
    typeof (provenance as Record<string, unknown>).nodeId !== "number"
  ) {
    (provenance as Record<string, unknown>).nodeId = origin.nodeId;
  }

  const resolvedCategory = category ?? categoryFromProvenance(provenance);

  if (!ctx.holes.has(origin.nodeId)) {
    ctx.holes.set(origin.nodeId, {
      id: origin.nodeId,
      provenance,
      category: resolvedCategory,
      relatedNodes,
      origin,
    });
  }
}
