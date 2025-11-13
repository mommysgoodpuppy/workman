import type { NodeId } from "@workman/ast.ts";

let nextId = 0;

export function resetNodeIds(start: number = 0): void {
  nextId = start;
}

export function nextNodeId(): NodeId {
  return nextId++;
}
