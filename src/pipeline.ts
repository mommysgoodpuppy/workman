import type { Program } from "./ast.ts";
import { inferProgram, type InferOptions, type InferResult } from "./layer1/infer.ts";
import {
  solveConstraints,
  type SolveInput,
  type SolverResult,
} from "./layer2/mod.ts";

export interface AnalysisResult {
  layer1: InferResult;
  layer2: SolverResult;
}

export interface AnalysisOptions extends InferOptions {
}

export function analyzeProgram(program: Program, options: AnalysisOptions = {}): AnalysisResult {
  const layer1 = inferProgram(program, options);
  const solveInput: SolveInput = {
    markedProgram: layer1.markedProgram,
    constraintStubs: layer1.constraintStubs,
    holes: layer1.holes,
    nodeTypeById: layer1.nodeTypeById,
  };

  const layer2 = solveConstraints(solveInput);
  return { layer1, layer2 };
}
