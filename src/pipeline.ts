import type { Program } from "./ast.ts";
import { inferProgram } from "./layer1/infer.ts";
import type { InferOptions, InferResult } from "./layer1/context.ts";
import {
  solveConstraints,
  type SolveInput,
  type SolverResult,
} from "./layer2/mod.ts";
import { type Layer3Result, presentProgram } from "./layer3/mod.ts";

export interface AnalysisResult {
  layer1: InferResult;
  layer2: SolverResult;
}

export interface AnalysisOptions extends InferOptions {
}

export function analyzeProgram(
  program: Program,
  options: AnalysisOptions = {},
): AnalysisResult {
  const layer1 = inferProgram(program, options);
  const solveInput: SolveInput = {
    markedProgram: layer1.markedProgram,
    constraintStubs: layer1.constraintStubs,
    holes: layer1.holes,
    nodeTypeById: layer1.nodeTypeById,
    layer1Diagnostics: layer1.layer1Diagnostics,
    summaries: layer1.summaries,
  };

  const layer2 = solveConstraints(solveInput);
  return { layer1, layer2 };
}

export interface PresentationResult extends AnalysisResult {
  layer3: Layer3Result;
}

export function analyzeAndPresent(
  program: Program,
  options: AnalysisOptions = {},
): PresentationResult {
  const analysis = analyzeProgram(program, options);
  const layer3 = presentProgram(analysis.layer2);
  return { ...analysis, layer3 };
}
