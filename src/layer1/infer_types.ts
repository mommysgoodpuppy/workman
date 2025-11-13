// Shared types for inference system to avoid circular dependencies
// between infer.ts and context.ts

import type { MPattern } from "../ast_marked.ts";
import type { ErrorRowType, Type } from "../types.ts";

export interface ErrorRowCoverage {
  constructors: Set<string>;
  coversTail: boolean;
}

export type PatternCoverage =
  | { kind: "wildcard" }
  | {
    kind: "constructor";
    typeName: string;
    ctor: string;
    errorRow?: ErrorRowCoverage;
  }
  | { kind: "bool"; value: boolean }
  | { kind: "none" }
  | { kind: "all_errors" };

export interface PatternInfo {
  type: Type;
  bindings: Map<string, Type>;
  coverage: PatternCoverage;
  marked: MPattern;
}

export interface MatchErrorRowCoverage {
  errorRow: Type; // Can be error_row or type variable during inference
  coveredConstructors: Set<string>;
  coversTail: boolean;
  missingConstructors: string[];
}

export interface MatchBranchesResult {
  type: Type;
  patternInfos: PatternInfo[];
  bodyTypes: Type[];
  errorRowCoverage?: MatchErrorRowCoverage;
  dischargesResult?: boolean;
}
