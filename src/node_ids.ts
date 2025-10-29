import type { NodeId } from "./ast.ts";

let nextId = 0;

export function resetNodeIds(start: number = 0): void {
  nextId = start;
}

export function nextNodeId(): NodeId {
  return nextId++;
}
