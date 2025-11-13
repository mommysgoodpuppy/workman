// Pure type definitions extracted to avoid Andromeda A→B→A import pattern
import type { NodeId, SourceSpan } from "@workman/ast.ts";

export type HoleOriginKind = "expr" | "pattern" | "type_expr" | "top_level";

export interface HoleOrigin {
  kind: HoleOriginKind;
  nodeId: NodeId;
  span: SourceSpan;
}

export type HoleId = NodeId;

export type UnknownCategory =
  | "free"
  | "local_conflict"
  | "incomplete"
  | "internal";
