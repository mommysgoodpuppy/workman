/**
 * Utility functions for infer module
 * Separated to avoid circular dependencies
 */

import type { Expr } from "../ast.ts";
import type { Type } from "../types.ts";
import { unknownType } from "../types.ts";
import type { Context } from "./context.ts";

export function getExprTypeOrUnknown(
  ctx: Context,
  expr: Expr,
  reason: string,
): Type {
  return ctx.nodeTypes.get(expr.id) ?? unknownFromReason(reason);
}

export function unknownFromReason(reason: string): Type {
  return unknownType({ kind: "incomplete", reason });
}
