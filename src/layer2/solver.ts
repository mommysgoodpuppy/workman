export type {
  ConstraintDiagnostic,
  ConstraintDiagnosticReason,
} from "../diagnostics.ts";

import type {
  MBlockExpr,
  MBlockStatement,
  MExpr,
  MLetDeclaration,
  MMatchArm,
  MMatchBundle,
  MParameter,
  MPattern,
  MProgram,
} from "../ast_marked.ts";
import type {
  ConstraintStub,
  ErrorRowCoverageStub,
  UnknownInfo,
} from "../layer1/context.ts";
import type { HoleId } from "../layer1/context_types.ts";
import {
  applySubstitution,
  cloneType,
  type ConstraintLabel,
  errorLabel,
  type ErrorRowType,
  errorRowUnion,
  findCarrierDomain,
  flattenResultType,
  type flattenTaintedType,
  formatLabel,
  type GenericCarrierInfo,
  getProvenance,
  type Identity,
  isHoleType,
  joinCarrier,
  makeResultType,
  type makeTaintedType,
  occursInType,
  type sameIdentity,
  splitCarrier,
  type Substitution,
  taintLabel,
  type TaintRowType,
  taintRowUnion,
  type Type,
  unknownType,
} from "../types.ts";
import type {
  ConstraintDiagnostic,
  ConstraintDiagnosticReason,
} from "../diagnostics.ts";
import type { NodeId } from "../ast.ts";
import { areIncompatible, conflictMessage } from "./conflict_rules.ts";
import { BOUNDARY_RULES } from "./boundary_rules.ts";

export interface ConstraintConflict {
  holeId: HoleId;
  provenance: UnknownInfo;
  conflictingConstraints: ConstraintStub[];
  reason: "type_mismatch" | "arity_conflict" | "shape_conflict";
  types: Type[];
}

export interface PartialType {
  kind: "partial";
  known: Type | null;
  constraints: ConstraintStub[];
  possibilities: Type[];
}

export interface HoleSolution {
  state: "solved" | "partial" | "unsolved" | "conflicted";
  type?: Type;
  partial?: PartialType;
  conflicts?: ConstraintConflict[];
  provenance: UnknownInfo;
}

export interface SolveInput {
  markedProgram: MProgram;
  constraintStubs: ConstraintStub[];
  holes: Map<HoleId, UnknownInfo>;
  nodeTypeById: Map<NodeId, Type>;
  layer1Diagnostics: ConstraintDiagnostic[];
  summaries: { name: string; scheme: import("../types.ts").TypeScheme }[];
}

export interface SolverResult {
  solutions: Map<HoleId, HoleSolution>;
  diagnostics: ConstraintDiagnostic[];
  substitution: Substitution;
  resolvedNodeTypes: Map<NodeId, Type>;
  remarkedProgram: MProgram;
  conflicts: ConstraintConflict[];
  summaries: { name: string; scheme: import("../types.ts").TypeScheme }[];
  constraintFlow?: ConstraintFlow;
}

interface UnifyFailure {
  kind: "type_mismatch" | "arity_mismatch" | "occurs_check";
  left: Type;
  right: Type;
}

interface UnifyResultSuccess {
  success: true;
  subst: Substitution;
}

interface UnifyResultFailure {
  success: false;
  reason: UnifyFailure;
}

type UnifyResult = UnifyResultSuccess | UnifyResultFailure;

export function solveConstraints(input: SolveInput): SolverResult {
  const state: SolverState = {
    substitution: new Map(),
    diagnostics: [],
    nodeTypeById: input.nodeTypeById,
  };

  // Solve constraints in phases to establish type information before
  // checking numeric/boolean constraints that depend on it:
  // 1. Annotations - explicit type information
  // 2. Calls & field access - propagate types from function signatures
  // 3. Numeric/boolean - check that operands are the right type
  // 4. Branch joins - ensure branch consistency
  const annotationStubs = input.constraintStubs.filter((s) =>
    s.kind === "annotation"
  );
  const callAndFieldStubs = input.constraintStubs.filter((s) =>
    s.kind === "call" || s.kind === "has_field"
  );
  const numericBooleanStubs = input.constraintStubs.filter((s) =>
    s.kind === "numeric" || s.kind === "boolean"
  );
  const branchStubs = input.constraintStubs.filter((s) =>
    s.kind === "branch_join"
  );

  // Phase 1: Annotations
  for (const stub of annotationStubs) {
    solveAnnotationConstraint(state, stub);
  }

  // Phase 2: Calls and field access
  for (const stub of callAndFieldStubs) {
    if (stub.kind === "call") {
      solveCallConstraint(state, stub);
    } else {
      solveHasFieldConstraint(state, stub);
    }
  }

  // Phase 3: Numeric and boolean constraints
  for (const stub of numericBooleanStubs) {
    if (stub.kind === "numeric") {
      solveNumericConstraint(state, stub);
    } else {
      solveBooleanConstraint(state, stub);
    }
  }

  // Phase 4: Branch joins
  for (const stub of branchStubs) {
    solveBranchJoinConstraint(state, stub);
  }

  const resolvedNodeTypes = new Map<NodeId, Type>();
  // Use state.nodeTypeById which may have been updated during solving (e.g., branch joins with unions)
  for (const [nodeId, type] of state.nodeTypeById.entries()) {
    const resolved = applySubstitution(type, state.substitution);
    resolvedNodeTypes.set(nodeId, cloneType(resolved));
  }

  // PHASE 5: NEW Constraint Propagation System (parallel to existing)
  // Build constraint flow graph
  const constraintFlow = buildConstraintFlow(input.constraintStubs);

  // Propagate constraints using single-pass algorithm
  propagateConstraints(constraintFlow, input.constraintStubs);

  // Detect conflicts (multi-domain)
  detectConstraintConflicts(constraintFlow, state.diagnostics);

  // Check return boundaries
  checkReturnBoundaries(
    constraintFlow,
    resolvedNodeTypes,
    input.markedProgram,
    state.diagnostics,
  );

  // Additional checking for annotations and matches (backward compatibility with test expectations)
  checkInfectiousAnnotations(
    input.constraintStubs,
    constraintFlow,
    resolvedNodeTypes,
    input.nodeTypeById,
    state.diagnostics,
  );

  // Phase 8: Old system removed - new constraint system fully handles infectious types

  // Detect conflicts in unknown types
  const conflicts = detectConflicts(
    input.holes,
    input.constraintStubs,
    state.substitution,
    resolvedNodeTypes,
  );

  // Add diagnostics for conflicts
  for (const conflict of conflicts) {
    state.diagnostics.push({
      origin: conflict.holeId,
      reason: "unfillable_hole",
      details: {
        conflictingTypes: conflict.types,
        reason: conflict.reason,
      },
    });
  }

  const solutions: Map<HoleId, HoleSolution> = new Map();
  for (const [holeId, info] of input.holes.entries()) {
    const nodeType = resolvedNodeTypes.get(holeId);
    const holeConflicts = conflicts.filter((c) => c.holeId === holeId);

    if (holeConflicts.length > 0) {
      solutions.set(holeId, {
        state: "conflicted",
        conflicts: holeConflicts,
        provenance: info,
      });
    } else if (!nodeType || isHoleType(nodeType)) {
      // Try to build partial solution
      const partial = buildPartialSolution(
        holeId,
        input.constraintStubs,
        state.substitution,
        resolvedNodeTypes,
      );
      if (partial) {
        solutions.set(holeId, { state: "partial", partial, provenance: info });
      } else {
        solutions.set(holeId, { state: "unsolved", provenance: info });
      }
    } else {
      solutions.set(holeId, {
        state: "solved",
        type: nodeType,
        provenance: info,
      });
    }
  }

  remarkProgram(input.markedProgram, resolvedNodeTypes);

  // Transform summaries with resolved types and conflict information
  const transformedSummaries = input.summaries.map(({ name, scheme }) => {
    // Apply substitution to get the most up-to-date type
    let transformedType = applySubstitution(scheme.type, state.substitution);
    // Then apply hole solutions
    transformedType = transformTypeWithSolutions(transformedType, solutions);
    // Flatten any nested error_rows that may have been created
    transformedType = flattenNestedErrorRows(transformedType);
    return {
      name,
      scheme: {
        quantifiers: scheme.quantifiers,
        type: transformedType,
      },
    };
  });

  const combinedDiagnostics = [
    ...input.layer1Diagnostics,
    ...state.diagnostics,
  ];

  return {
    solutions,
    diagnostics: combinedDiagnostics,
    substitution: state.substitution,
    resolvedNodeTypes,
    remarkedProgram: input.markedProgram,
    conflicts,
    summaries: transformedSummaries,
    constraintFlow,
  };
}

/**
 * Recursively transform a type, replacing error provenances with conflict markers
 * when the underlying hole is conflicted.
 */
function transformTypeWithSolutions(
  type: Type,
  solutions: Map<HoleId, HoleSolution>,
): Type {
  if (isHoleType(type)) {
    const holeId = extractHoleIdFromType(type);
    if (holeId !== undefined) {
      const solution = solutions.get(holeId);
      if (solution?.state === "conflicted") {
        // Replace with unfillable_hole marker (constraint conflict)
        return unknownType({
          kind: "error_unfillable_hole",
          holeId,
          conflicts: solution.conflicts || [],
        });
      } else if (solution?.state === "partial" && solution.partial?.known) {
        // Use the partial type
        return solution.partial.known;
      }
    }
    return type;
  }

  // Recursively transform nested types
  switch (type.kind) {
    case "func":
      return {
        kind: "func",
        from: transformTypeWithSolutions(type.from, solutions),
        to: transformTypeWithSolutions(type.to, solutions),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((el) =>
          transformTypeWithSolutions(el, solutions)
        ),
      };
    case "record": {
      const fields = new Map<string, Type>();
      for (const [name, fieldType] of type.fields.entries()) {
        fields.set(name, transformTypeWithSolutions(fieldType, solutions));
      }
      return { kind: "record", fields };
    }
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map((arg) =>
          transformTypeWithSolutions(arg, solutions)
        ),
      };
    default:
      return type;
  }
}

interface SolverState {
  substitution: Substitution;
  diagnostics: ConstraintDiagnostic[];
  nodeTypeById: Map<NodeId, Type>;
}

function solveCallConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "call" },
): void {
  const callee = getTypeForNode(state, stub.callee);
  const stageCallee = peelFunctionType(callee, stub.index);
  const argumentValue = stub.argumentValueType
    ? applySubstitution(stub.argumentValueType, state.substitution)
    : getTypeForNode(state, stub.argument);
  const result = applySubstitution(stub.resultType, state.substitution);
  const target: Type = { kind: "func", from: argumentValue, to: result };
  const unified = unifyTypes(stageCallee, target, state.substitution);
  if (unified.success) {
    state.substitution = unified.subst;
    return;
  }

  const resolvedStage = applySubstitution(stageCallee, state.substitution);
  if (resolvedStage.kind !== "func") {
    state.diagnostics.push({
      origin: stub.origin,
      reason: "not_function",
      details: { calleeKind: resolvedStage.kind },
    });
    return;
  }

  const extraDetails = {
    argumentIndex: stub.index,
  };
  registerUnifyFailure(state, stub.origin, unified.reason, extraDetails);
}

function solveHasFieldConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "has_field" },
): void {
  const target = getTypeForNode(state, stub.target);
  const result = getTypeForNode(state, stub.result);
  const resolvedTarget = applySubstitution(target, state.substitution);

  // Use generic carrier splitting instead of Result-specific flattening
  const targetCarrierInfo = splitCarrier(resolvedTarget);
  const targetValue = targetCarrierInfo
    ? applySubstitution(targetCarrierInfo.value, state.substitution)
    : resolvedTarget;
  const projectedValue = stub.projectedValueType
    ? applySubstitution(stub.projectedValueType, state.substitution)
    : null;

  if (targetValue.kind === "record") {
    projectFieldFromRecord(
      state,
      stub,
      targetValue,
      result,
      targetCarrierInfo,
      projectedValue,
    );
    return;
  }

  if (targetValue.kind === "var" || isHoleType(targetValue)) {
    const fields = new Map<string, Type>();
    fields.set(stub.field, projectedValue ?? result);
    const recordType: Type = { kind: "record", fields };
    const unified = unifyTypes(
      targetValue,
      recordType,
      state.substitution,
    );
    if (unified.success) {
      state.substitution = unified.subst;
      projectFieldFromRecord(
        state,
        stub,
        recordType,
        result,
        targetCarrierInfo,
        projectedValue,
      );
      return;
    }
    registerUnifyFailure(state, stub.origin, unified.reason);
    return;
  }

  state.diagnostics.push({
    origin: stub.origin,
    reason: "not_record",
    details: { actual: targetValue.kind },
  });
}

function projectFieldFromRecord(
  state: SolverState,
  stub: ConstraintStub & { kind: "has_field" },
  recordType: Extract<Type, { kind: "record" }>,
  result: Type,
  targetCarrierInfo: GenericCarrierInfo | null,
  projectedValue?: Type | null,
): void {
  const fieldType = recordType.fields.get(stub.field);
  if (!fieldType) {
    state.diagnostics.push({
      origin: stub.origin,
      reason: "missing_field",
      details: { field: stub.field },
    });
    return;
  }
  const resolvedFieldType = applySubstitution(fieldType, state.substitution);

  // Use generic carrier splitting for the field type
  const fieldCarrierInfo = splitCarrier(resolvedFieldType);
  const projectedValueType = fieldCarrierInfo
    ? applySubstitution(fieldCarrierInfo.value, state.substitution)
    : resolvedFieldType;
  const valueTarget = projectedValue ?? projectedValueType;
  if (projectedValue) {
    const unifyValue = unifyTypes(
      projectedValueType,
      valueTarget,
      state.substitution,
    );
    if (!unifyValue.success) {
      registerUnifyFailure(state, stub.origin, unifyValue.reason);
      return;
    }
    state.substitution = unifyValue.subst;
  }

  // Combine carrier states if both target and field have carriers
  let finalType: Type;
  const finalValue = applySubstitution(valueTarget, state.substitution);

  if (targetCarrierInfo && fieldCarrierInfo) {
    // Both have carriers - need to combine states
    // For now, use the target's carrier domain and combine states
    // TODO: Handle cross-domain carrier combinations properly
    if (targetCarrierInfo.domain === fieldCarrierInfo.domain) {
      // Same domain - combine states based on domain type
      if (targetCarrierInfo.domain === "error") {
        // Error domain: union the error rows
        const targetError = targetCarrierInfo.state as ErrorRowType;
        const fieldError = fieldCarrierInfo.state as ErrorRowType;
        const combinedError = errorRowUnion(targetError, fieldError);
        finalType = makeResultType(cloneType(finalValue), combinedError);
      } else if (targetCarrierInfo.domain === "taint") {
        // Taint domain: union the taint rows
        const targetTaint = targetCarrierInfo.state as TaintRowType;
        const fieldTaint = fieldCarrierInfo.state as TaintRowType;
        const combinedTaint = taintRowUnion(targetTaint, fieldTaint);
        const joined = joinCarrier(
          targetCarrierInfo.domain,
          finalValue,
          combinedTaint,
        );
        finalType = joined ?? finalValue;
      } else {
        // Unknown domain: just use target's carrier
        const joined = joinCarrier(
          targetCarrierInfo.domain,
          finalValue,
          targetCarrierInfo.state,
        );
        finalType = joined ?? finalValue;
      }
    } else {
      // Different domains - use target's carrier
      const joined = joinCarrier(
        targetCarrierInfo.domain,
        finalValue,
        targetCarrierInfo.state,
      );
      finalType = joined ?? finalValue;
    }
  } else if (targetCarrierInfo) {
    // Only target has carrier - propagate it
    const joined = joinCarrier(
      targetCarrierInfo.domain,
      finalValue,
      targetCarrierInfo.state,
    );
    finalType = joined ?? finalValue;
  } else if (fieldCarrierInfo) {
    // Only field has carrier - propagate it
    const joined = joinCarrier(
      fieldCarrierInfo.domain,
      finalValue,
      fieldCarrierInfo.state,
    );
    finalType = joined ?? finalValue;
  } else {
    // No carriers
    finalType = finalValue;
  }

  const unified = unifyTypes(finalType, result, state.substitution);
  if (unified.success) {
    state.substitution = unified.subst;
  } else {
    registerUnifyFailure(state, stub.origin, unified.reason);
  }
}

function solveAnnotationConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "annotation" },
): void {
  const annotation = stub.annotationType ??
    getTypeForNode(state, stub.annotation);
  const value = getTypeForNode(state, stub.value);
  const unified = unifyTypes(annotation, value, state.substitution);
  if (unified.success) {
    state.substitution = unified.subst;
  } else {
    registerUnifyFailure(state, stub.origin, unified.reason);
  }
}

function solveNumericConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "numeric" },
): void {
  const intType: Type = { kind: "int" };
  let currentSubst = state.substitution;

  // Track accumulated carriers per domain
  const accumulatedCarriers = new Map<
    string,
    { domain: string; state: Type }
  >();

  for (const operand of stub.operands) {
    const operandType = applySubstitution(
      getTypeForNode(state, operand),
      currentSubst,
    );

    // Use generic carrier splitting
    const operandCarrierInfo = splitCarrier(operandType);
    const operandValue = operandCarrierInfo
      ? operandCarrierInfo.value
      : operandType;

    // Skip hole types - they'll be constrained elsewhere or represent holes
    if (isHoleType(operandValue)) {
      continue;
    }

    const unified = unifyTypes(operandValue, intType, currentSubst);
    if (!unified.success) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "not_numeric",
        details: { operand },
      });
      return;
    }
    currentSubst = unified.subst;

    // Accumulate carrier states by domain
    if (operandCarrierInfo) {
      const existing = accumulatedCarriers.get(operandCarrierInfo.domain);
      if (existing) {
        // Combine states for the same domain
        if (operandCarrierInfo.domain === "error") {
          const combinedError = errorRowUnion(
            existing.state as ErrorRowType,
            operandCarrierInfo.state as ErrorRowType,
          );
          accumulatedCarriers.set(operandCarrierInfo.domain, {
            domain: operandCarrierInfo.domain,
            state: combinedError,
          });
        } else if (operandCarrierInfo.domain === "taint") {
          const combinedTaint = taintRowUnion(
            existing.state as TaintRowType,
            operandCarrierInfo.state as TaintRowType,
          );
          accumulatedCarriers.set(operandCarrierInfo.domain, {
            domain: operandCarrierInfo.domain,
            state: combinedTaint,
          });
        }
        // For other domains, keep the first one (or implement domain-specific logic)
      } else {
        accumulatedCarriers.set(operandCarrierInfo.domain, {
          domain: operandCarrierInfo.domain,
          state: operandCarrierInfo.state,
        });
      }
    }
  }

  // For comparison operators (>, <, >=, <=), the result is Bool, not Int
  // Only check result type for arithmetic operators (+, -, *, /)
  const comparisonOperators = new Set([">", "<", ">=", "<=", "==", "!="]);
  const isComparison = comparisonOperators.has(stub.operator);

  if (!isComparison) {
    const resultType = getTypeForNode(state, stub.result);
    const resolvedResultType = applySubstitution(resultType, currentSubst);
    const resultCarrierInfo = splitCarrier(resolvedResultType);

    // Merge result's carriers with accumulated carriers
    if (resultCarrierInfo) {
      const existing = accumulatedCarriers.get(resultCarrierInfo.domain);
      if (existing) {
        if (resultCarrierInfo.domain === "error") {
          const combinedError = errorRowUnion(
            existing.state as ErrorRowType,
            resultCarrierInfo.state as ErrorRowType,
          );
          accumulatedCarriers.set(resultCarrierInfo.domain, {
            domain: resultCarrierInfo.domain,
            state: combinedError,
          });
        } else if (resultCarrierInfo.domain === "taint") {
          const combinedTaint = taintRowUnion(
            existing.state as TaintRowType,
            resultCarrierInfo.state as TaintRowType,
          );
          accumulatedCarriers.set(resultCarrierInfo.domain, {
            domain: resultCarrierInfo.domain,
            state: combinedTaint,
          });
        }
      } else {
        accumulatedCarriers.set(resultCarrierInfo.domain, {
          domain: resultCarrierInfo.domain,
          state: resultCarrierInfo.state,
        });
      }
    }

    // Build expected result type with all accumulated carriers
    let expectedResultType: Type = intType;
    for (const [_domain, carrier] of accumulatedCarriers.entries()) {
      const joined = joinCarrier(
        carrier.domain,
        expectedResultType,
        carrier.state,
      );
      if (joined) {
        expectedResultType = joined;
      }
    }

    const unifiedResult = unifyTypes(
      resultType,
      expectedResultType,
      currentSubst,
    );
    if (!unifiedResult.success) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "not_numeric",
        details: { operand: stub.result },
      });
      return;
    }
    currentSubst = unifiedResult.subst;
  }

  state.substitution = currentSubst;
}

function solveBooleanConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "boolean" },
): void {
  const boolType: Type = { kind: "bool" };
  let currentSubst = state.substitution;

  // Track accumulated carriers per domain
  const accumulatedCarriers = new Map<
    string,
    { domain: string; state: Type }
  >();

  for (const operand of stub.operands) {
    const operandType = applySubstitution(
      getTypeForNode(state, operand),
      currentSubst,
    );

    // Use generic carrier splitting
    const operandCarrierInfo = splitCarrier(operandType);
    const operandValue = operandCarrierInfo
      ? operandCarrierInfo.value
      : operandType;

    const unified = unifyTypes(operandValue, boolType, currentSubst);
    if (!unified.success) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "not_boolean",
        details: { operand },
      });
      return;
    }
    currentSubst = unified.subst;

    // Accumulate carrier states by domain
    if (operandCarrierInfo) {
      const existing = accumulatedCarriers.get(operandCarrierInfo.domain);
      if (existing) {
        // Combine states for the same domain
        if (operandCarrierInfo.domain === "error") {
          const combinedError = errorRowUnion(
            existing.state as ErrorRowType,
            operandCarrierInfo.state as ErrorRowType,
          );
          accumulatedCarriers.set(operandCarrierInfo.domain, {
            domain: operandCarrierInfo.domain,
            state: combinedError,
          });
        } else if (operandCarrierInfo.domain === "taint") {
          const combinedTaint = taintRowUnion(
            existing.state as TaintRowType,
            operandCarrierInfo.state as TaintRowType,
          );
          accumulatedCarriers.set(operandCarrierInfo.domain, {
            domain: operandCarrierInfo.domain,
            state: combinedTaint,
          });
        }
        // For other domains, keep the first one (or implement domain-specific logic)
      } else {
        accumulatedCarriers.set(operandCarrierInfo.domain, {
          domain: operandCarrierInfo.domain,
          state: operandCarrierInfo.state,
        });
      }
    }
  }

  const resultType = getTypeForNode(state, stub.result);
  const resolvedResultType = applySubstitution(resultType, currentSubst);
  const resultCarrierInfo = splitCarrier(resolvedResultType);

  // Merge result's carriers with accumulated carriers
  if (resultCarrierInfo) {
    const existing = accumulatedCarriers.get(resultCarrierInfo.domain);
    if (existing) {
      if (resultCarrierInfo.domain === "error") {
        const combinedError = errorRowUnion(
          existing.state as ErrorRowType,
          resultCarrierInfo.state as ErrorRowType,
        );
        accumulatedCarriers.set(resultCarrierInfo.domain, {
          domain: resultCarrierInfo.domain,
          state: combinedError,
        });
      } else if (resultCarrierInfo.domain === "taint") {
        const combinedTaint = taintRowUnion(
          existing.state as TaintRowType,
          resultCarrierInfo.state as TaintRowType,
        );
        accumulatedCarriers.set(resultCarrierInfo.domain, {
          domain: resultCarrierInfo.domain,
          state: combinedTaint,
        });
      }
    } else {
      accumulatedCarriers.set(resultCarrierInfo.domain, {
        domain: resultCarrierInfo.domain,
        state: resultCarrierInfo.state,
      });
    }
  }

  // Build expected result type with all accumulated carriers
  let expectedResultType: Type = boolType;
  for (const [_domain, carrier] of accumulatedCarriers.entries()) {
    const joined = joinCarrier(
      carrier.domain,
      expectedResultType,
      carrier.state,
    );
    if (joined) {
      expectedResultType = joined;
    }
  }

  const unifiedResult = unifyTypes(
    resultType,
    expectedResultType,
    currentSubst,
  );
  if (!unifiedResult.success) {
    state.diagnostics.push({
      origin: stub.origin,
      reason: "not_boolean",
      details: { operand: stub.result },
    });
    return;
  }

  state.substitution = unifiedResult.subst;
}

function solveBranchJoinConstraint(
  state: SolverState,
  stub: ConstraintStub & { kind: "branch_join" },
): void {
  if (stub.branches.length === 0) {
    return;
  }

  let mergedType = getTypeForNode(state, stub.branches[0]);
  let currentSubst = state.substitution;

  for (let index = 1; index < stub.branches.length; index += 1) {
    const branchType = getTypeForNode(state, stub.branches[index]);

    // Check if both types are carriers in the same domain
    const leftCarrier = splitCarrier(mergedType);
    const rightCarrier = splitCarrier(branchType);

    if (
      leftCarrier && rightCarrier && leftCarrier.domain === rightCarrier.domain
    ) {
      // Both are carriers in the same domain - merge their states using union
      const valueUnify = unifyTypes(
        leftCarrier.value,
        rightCarrier.value,
        currentSubst,
      );
      if (!valueUnify.success) {
        state.diagnostics.push({
          origin: stub.origin,
          reason: "branch_mismatch",
          details: {
            branchIndex: index,
            dischargesResult: stub.dischargesResult ?? false,
            errorRow: stub.errorRowCoverage?.row,
            missingConstructors: stub.errorRowCoverage?.missingConstructors,
          },
        });
        return;
      }
      currentSubst = valueUnify.subst;

      // For error domain, union the error rows
      if (
        leftCarrier.domain === "error" &&
        leftCarrier.state.kind === "error_row" &&
        rightCarrier.state.kind === "error_row"
      ) {
        const unionState = errorRowUnion(leftCarrier.state, rightCarrier.state);
        mergedType =
          joinCarrier(leftCarrier.domain, leftCarrier.value, unionState) ??
            mergedType;
      }
    } else {
      // Normal unification
      const unified = unifyTypes(mergedType, branchType, currentSubst);
      if (!unified.success) {
        state.diagnostics.push({
          origin: stub.origin,
          reason: "branch_mismatch",
          details: {
            branchIndex: index,
            dischargesResult: stub.dischargesResult ?? false,
            errorRow: stub.errorRowCoverage?.row,
            missingConstructors: stub.errorRowCoverage?.missingConstructors,
          },
        });
        return;
      }
      currentSubst = unified.subst;
    }
  }

  // Store the merged type (with unions) directly
  // Don't unify with the old result type - just replace it
  // This ensures the union is visible in the final type display
  state.nodeTypeById.set(stub.origin, mergedType);
  state.substitution = currentSubst;
}

function getTypeForNode(state: SolverState, nodeId: NodeId): Type {
  const type = state.nodeTypeById.get(nodeId);
  if (type) {
    return cloneType(applySubstitution(type, state.substitution));
  }
  return unknownType({ kind: "incomplete", reason: "solver.missing_node" });
}

function flattenNestedErrorRows(type: Type): Type {
  switch (type.kind) {
    case "error_row": {
      // Flatten nested error_rows
      if (type.tail?.kind === "error_row") {
        const tailRow = type.tail;
        const mergedCases = new Map(type.cases);
        for (const [label, payload] of tailRow.cases) {
          if (!mergedCases.has(label)) {
            mergedCases.set(
              label,
              payload ? flattenNestedErrorRows(payload) : null,
            );
          }
        }
        return flattenNestedErrorRows({
          kind: "error_row",
          cases: mergedCases,
          tail: tailRow.tail,
        });
      }
      // Flatten payloads
      const flattenedCases = new Map();
      for (const [label, payload] of type.cases) {
        flattenedCases.set(
          label,
          payload ? flattenNestedErrorRows(payload) : null,
        );
      }
      return {
        kind: "error_row",
        cases: flattenedCases,
        tail: type.tail ? flattenNestedErrorRows(type.tail) : type.tail,
      };
    }
    case "func":
      return {
        kind: "func",
        from: flattenNestedErrorRows(type.from),
        to: flattenNestedErrorRows(type.to),
      };
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map(flattenNestedErrorRows),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map(flattenNestedErrorRows),
      };
    case "record":
      const flattenedFields = new Map();
      for (const [name, fieldType] of type.fields) {
        flattenedFields.set(name, flattenNestedErrorRows(fieldType));
      }
      return {
        kind: "record",
        fields: flattenedFields,
      };
    default:
      return type;
  }
}

function registerUnifyFailure(
  state: SolverState,
  origin: NodeId,
  failure: UnifyFailure,
  extraDetails?: Record<string, unknown>,
): void {
  const reason: ConstraintDiagnosticReason = failure.kind === "occurs_check"
    ? "occurs_cycle"
    : failure.kind === "arity_mismatch"
    ? "arity_mismatch"
    : "type_mismatch";
  state.diagnostics.push({
    origin,
    reason,
    details: {
      left: failure.left,
      right: failure.right,
      ...(extraDetails ?? {}),
    },
  });
}

function peelFunctionType(type: Type, depth: number): Type {
  let current: Type = type;
  for (let index = 0; index < depth; index += 1) {
    if (current.kind !== "func") {
      return cloneType(current);
    }
    current = current.to;
  }
  return cloneType(current);
}

function unifyTypes(left: Type, right: Type, subst: Substitution): UnifyResult {
  const resolvedLeft = applySubstitution(left, subst);
  const resolvedRight = applySubstitution(right, subst);

  if (typesEqual(resolvedLeft, resolvedRight)) {
    return { success: true, subst };
  }

  if (isHoleType(resolvedLeft)) {
    return { success: true, subst };
  }
  if (isHoleType(resolvedRight)) {
    return { success: true, subst };
  }

  if (resolvedLeft.kind === "var") {
    return bindVar(resolvedLeft.id, resolvedRight, subst);
  }
  if (resolvedRight.kind === "var") {
    return bindVar(resolvedRight.id, resolvedLeft, subst);
  }

  if (resolvedLeft.kind === "func" && resolvedRight.kind === "func") {
    const first = unifyTypes(resolvedLeft.from, resolvedRight.from, subst);
    if (!first.success) return first;
    return unifyTypes(resolvedLeft.to, resolvedRight.to, first.subst);
  }

  if (
    resolvedLeft.kind === "constructor" && resolvedRight.kind === "constructor"
  ) {
    if (
      resolvedLeft.name !== resolvedRight.name ||
      resolvedLeft.args.length !== resolvedRight.args.length
    ) {
      return {
        success: false,
        reason: {
          kind: resolvedLeft.name !== resolvedRight.name
            ? "type_mismatch"
            : "arity_mismatch",
          left: resolvedLeft,
          right: resolvedRight,
        },
      };
    }
    let current = subst;
    for (let index = 0; index < resolvedLeft.args.length; index += 1) {
      const result = unifyTypes(
        resolvedLeft.args[index],
        resolvedRight.args[index],
        current,
      );
      if (!result.success) return result;
      current = result.subst;
    }
    return { success: true, subst: current };
  }

  if (resolvedLeft.kind === "tuple" && resolvedRight.kind === "tuple") {
    if (resolvedLeft.elements.length !== resolvedRight.elements.length) {
      return {
        success: false,
        reason: {
          kind: "arity_mismatch",
          left: resolvedLeft,
          right: resolvedRight,
        },
      };
    }
    let current = subst;
    for (let index = 0; index < resolvedLeft.elements.length; index += 1) {
      const result = unifyTypes(
        resolvedLeft.elements[index],
        resolvedRight.elements[index],
        current,
      );
      if (!result.success) return result;
      current = result.subst;
    }
    return { success: true, subst: current };
  }

  if (resolvedLeft.kind === "record" && resolvedRight.kind === "record") {
    if (resolvedLeft.fields.size !== resolvedRight.fields.size) {
      return {
        success: false,
        reason: {
          kind: "arity_mismatch",
          left: resolvedLeft,
          right: resolvedRight,
        },
      };
    }
    let current = subst;
    for (const [field, leftType] of resolvedLeft.fields.entries()) {
      const rightType = resolvedRight.fields.get(field);
      if (!rightType) {
        return {
          success: false,
          reason: {
            kind: "type_mismatch",
            left: resolvedLeft,
            right: resolvedRight,
          },
        };
      }
      const result = unifyTypes(leftType, rightType, current);
      if (!result.success) {
        return result;
      }
      current = result.subst;
    }
    return { success: true, subst: current };
  }

  if (resolvedLeft.kind === "error_row" && resolvedRight.kind === "error_row") {
    return unifyErrorRows(resolvedLeft, resolvedRight, subst);
  }

  if (resolvedLeft.kind === resolvedRight.kind) {
    return { success: true, subst };
  }

  return {
    success: false,
    reason: { kind: "type_mismatch", left: resolvedLeft, right: resolvedRight },
  };
}

function bindVar(id: number, type: Type, subst: Substitution): UnifyResult {
  const resolved = applySubstitution(type, subst);
  if (resolved.kind === "var" && resolved.id === id) {
    return { success: true, subst };
  }
  if (occursInType(id, resolved)) {
    return {
      success: false,
      reason: {
        kind: "occurs_check",
        left: { kind: "var", id },
        right: resolved,
      },
    };
  }
  const next = new Map(subst);
  next.set(id, resolved);
  return { success: true, subst: next };
}

function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "var":
      return b.kind === "var" && a.id === b.id;
    case "func":
      return typesEqual(a.from, (b as Type & { kind: "func" }).from) &&
        typesEqual(a.to, (b as Type & { kind: "func" }).to);
    case "constructor": {
      if (
        b.kind !== "constructor" || a.name !== b.name ||
        a.args.length !== b.args.length
      ) {
        return false;
      }
      for (let i = 0; i < a.args.length; i++) {
        if (!typesEqual(a.args[i], b.args[i])) return false;
      }
      return true;
    }
    case "tuple": {
      if (b.kind !== "tuple" || a.elements.length !== b.elements.length) {
        return false;
      }
      for (let i = 0; i < a.elements.length; i++) {
        if (!typesEqual(a.elements[i], b.elements[i])) return false;
      }
      return true;
    }
    case "record": {
      if (b.kind !== "record" || a.fields.size !== b.fields.size) {
        return false;
      }
      for (const [field, typeA] of a.fields.entries()) {
        const typeB = b.fields.get(field);
        if (!typeB || !typesEqual(typeA, typeB)) return false;
      }
      return true;
    }
    case "error_row": {
      if (b.kind !== "error_row" || a.cases.size !== b.cases.size) {
        return false;
      }
      for (const [label, payloadA] of a.cases.entries()) {
        if (!b.cases.has(label)) {
          return false;
        }
        const payloadB = b.cases.get(label) ?? null;
        if (Boolean(payloadA) !== Boolean(payloadB)) {
          return false;
        }
        if (payloadA && payloadB && !typesEqual(payloadA, payloadB)) {
          return false;
        }
      }
      if (!a.tail && !b.tail) {
        return true;
      }
      if (!a.tail || !b.tail) {
        return false;
      }
      return typesEqual(a.tail, b.tail);
    }
    default:
      return true;
  }
}

function unifyErrorRows(
  left: ErrorRowType,
  right: ErrorRowType,
  subst: Substitution,
): UnifyResult {
  if (left.cases.size !== right.cases.size) {
    return {
      success: false,
      reason: { kind: "type_mismatch", left, right },
    };
  }
  let current = subst;
  for (const [label, leftPayload] of left.cases.entries()) {
    if (!right.cases.has(label)) {
      return {
        success: false,
        reason: { kind: "type_mismatch", left, right },
      };
    }
    const rightPayload = right.cases.get(label) ?? null;
    if (leftPayload && rightPayload) {
      const merged = unifyTypes(leftPayload, rightPayload, current);
      if (!merged.success) {
        return merged;
      }
      current = merged.subst;
    } else if (leftPayload || rightPayload) {
      return {
        success: false,
        reason: { kind: "type_mismatch", left, right },
      };
    }
  }
  if (left.tail && right.tail) {
    return unifyTypes(left.tail, right.tail, current);
  }
  if (left.tail || right.tail) {
    return {
      success: false,
      reason: { kind: "type_mismatch", left, right },
    };
  }
  return { success: true, subst: current };
}

function remarkProgram(program: MProgram, resolved: Map<NodeId, Type>): void {
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      remarkLetDeclaration(decl, resolved);
    } else if (decl.kind === "type") {
      continue;
    } else if (decl.kind === "prefix" || decl.kind === "infix") {
      continue;
    }
  }
}

function remarkLetDeclaration(
  decl: MLetDeclaration,
  resolved: Map<NodeId, Type>,
): void {
  remarkType(decl, resolved);
  for (const param of decl.parameters) {
    remarkParameter(param, resolved);
  }
  remarkBlockExpr(decl.body, resolved);
  if (decl.mutualBindings) {
    for (const binding of decl.mutualBindings) {
      remarkLetDeclaration(binding, resolved);
    }
  }
}

function remarkParameter(
  parameter: MParameter,
  resolved: Map<NodeId, Type>,
): void {
  remarkType(parameter, resolved);
  remarkPattern(parameter.pattern, resolved);
  if (parameter.annotation) {
    // Type expressions remain unchanged for now.
  }
}

function remarkBlockExpr(block: MBlockExpr, resolved: Map<NodeId, Type>): void {
  remarkType(block, resolved);
  for (const statement of block.statements) {
    remarkBlockStatement(statement, resolved);
  }
  if (block.result) {
    remarkExpr(block.result, resolved);
  }
}

function remarkBlockStatement(
  statement: MBlockStatement,
  resolved: Map<NodeId, Type>,
): void {
  if (statement.kind === "let_statement") {
    remarkLetDeclaration(statement.declaration, resolved);
  } else if (statement.kind === "expr_statement") {
    remarkExpr(statement.expression, resolved);
  }
}

function remarkExpr(expr: MExpr, resolved: Map<NodeId, Type>): void {
  remarkType(expr, resolved);
  switch (expr.kind) {
    case "identifier":
    case "literal":
      return;
    case "constructor":
      expr.args.forEach((arg) => remarkExpr(arg, resolved));
      return;
    case "tuple":
      expr.elements.forEach((el) => remarkExpr(el, resolved));
      return;
    case "record_literal":
      expr.fields.forEach((field) => remarkExpr(field.value, resolved));
      return;
    case "call":
      remarkExpr(expr.callee, resolved);
      expr.arguments.forEach((arg) => remarkExpr(arg, resolved));
      return;
    case "record_projection":
      remarkExpr(expr.target, resolved);
      return;
    case "binary":
      remarkExpr(expr.left, resolved);
      remarkExpr(expr.right, resolved);
      return;
    case "unary":
      remarkExpr(expr.operand, resolved);
      return;
    case "arrow":
      expr.parameters.forEach((param) => remarkParameter(param, resolved));
      remarkBlockExpr(expr.body, resolved);
      return;
    case "block":
      remarkBlockExpr(expr, resolved);
      return;
    case "match":
      remarkExpr(expr.scrutinee, resolved);
      remarkMatchBundle(expr.bundle, resolved);
      return;
    case "match_fn":
      expr.parameters.forEach((param) => remarkExpr(param, resolved));
      remarkMatchBundle(expr.bundle, resolved);
      return;
    case "match_bundle_literal":
      remarkMatchBundle(expr.bundle, resolved);
      return;
    case "mark_free_var":
    case "mark_not_function":
    case "mark_occurs_check":
    case "mark_inconsistent":
    case "mark_unsupported_expr":
    case "mark_unfillable_hole":
      return;
    case "mark_type_expr_unknown":
    case "mark_type_expr_arity":
    case "mark_type_expr_unsupported":
      return;
    default:
      return;
  }
}

function remarkPattern(pattern: MPattern, resolved: Map<NodeId, Type>): void {
  remarkType(pattern, resolved);
  switch (pattern.kind) {
    case "literal":
      return;
    case "wildcard":
    case "variable":
      return;
    case "constructor":
      pattern.args.forEach((arg) => remarkPattern(arg, resolved));
      return;
    case "tuple":
      pattern.elements.forEach((el) => remarkPattern(el, resolved));
      return;
    case "mark_pattern":
      return;
  }
}

function remarkMatchBundle(
  bundle: MMatchBundle,
  resolved: Map<NodeId, Type>,
): void {
  remarkType(bundle, resolved);
  bundle.arms.forEach((arm) => remarkMatchArm(arm, resolved));
}

function remarkMatchArm(arm: MMatchArm, resolved: Map<NodeId, Type>): void {
  if (arm.kind !== "match_pattern") {
    return;
  }
  remarkType(arm, resolved);
  remarkPattern(arm.pattern, resolved);
  remarkExpr(arm.body, resolved);
}

function remarkType(
  node: { id: NodeId; type: Type },
  resolved: Map<NodeId, Type>,
): void {
  const replacement = resolved.get(node.id);
  if (!replacement) {
    return;
  }
  if (isHoleType(node.type) && !isHoleType(replacement)) {
    node.type = replacement;
  }
}

// ============================================================================
// Phase 3: Constraint Flow Graph (Unified Constraint Model)
// ============================================================================

// Constraint flow graph representation
interface ConstraintFlow {
  // Which labels are on which nodes
  // IMPORTANT: Per-domain singleton - each node has at most one label per domain
  labels: Map<NodeId, Map<string, ConstraintLabel>>; // domain → label

  // Flow edges (from → to)
  edges: Map<NodeId, Set<NodeId>>;

  // Rewrites to apply at each node
  rewrites: Map<NodeId, { remove: ConstraintLabel[]; add: ConstraintLabel[] }>;

  // Alias equivalence classes (union-find) - future use for memory domain
  aliases: Map<number, number>; // Simple parent-pointer structure
}

function buildConstraintFlow(stubs: ConstraintStub[]): ConstraintFlow {
  const flow: ConstraintFlow = {
    labels: new Map(),
    edges: new Map(),
    rewrites: new Map(),
    aliases: new Map(),
  };

  // Phase 1: Collect sources
  for (const stub of stubs) {
    if (stub.kind === "constraint_source") {
      const domainMap = flow.labels.get(stub.node) ?? new Map();

      // Per-domain singleton: merge if already exists
      const existing = domainMap.get(stub.label.domain);
      if (existing && stub.label.domain === "error") {
        // Error domain: union rows
        const merged = errorRowUnion(existing.row, stub.label.row);
        domainMap.set("error", errorLabel(merged));
      } else if (existing && stub.label.domain === "taint") {
        // Taint domain: union rows (same as error)
        const merged = taintRowUnion(existing.row, stub.label.row);
        domainMap.set("taint", taintLabel(merged));
      } else {
        domainMap.set(stub.label.domain, stub.label);
      }

      flow.labels.set(stub.node, domainMap);
    }
  }

  // Phase 2: Collect flow edges
  for (const stub of stubs) {
    if (stub.kind === "constraint_flow") {
      const existing = flow.edges.get(stub.from) ?? new Set();
      existing.add(stub.to);
      flow.edges.set(stub.from, existing);
    }
  }

  // Phase 3: Collect rewrites
  for (const stub of stubs) {
    if (stub.kind === "constraint_rewrite") {
      flow.rewrites.set(stub.node, {
        remove: stub.remove,
        add: stub.add,
      });
    }
  }

  // Phase 4: Build alias map (simple union-find) - future use
  for (const stub of stubs) {
    if (stub.kind === "constraint_alias") {
      // Simple implementation: just record pairs
      // More sophisticated union-find would be needed for complex cases
      const id1 = identityToNumber(stub.id1);
      const id2 = identityToNumber(stub.id2);
      flow.aliases.set(id1, id2);
    }
  }

  return flow;
}

// Helper: convert Identity to a comparable number
function identityToNumber(id: Identity): number {
  switch (id.kind) {
    case "resource":
      return id.id;
    case "borrow":
      return 1000000 + id.id; // Offset to avoid collision
    case "hole":
      return 2000000 + id.id; // Offset to avoid collision
  }
}

function propagateConstraints(
  flow: ConstraintFlow,
  stubs: ConstraintStub[],
): void {
  // CRITICAL: Process stubs in creation order (follows inference traversal)
  // This gives parent-before-child ordering for nested matches

  for (const stub of stubs) {
    if (stub.kind === "constraint_source") {
      // Labels already added during buildConstraintFlow
      // Nothing to do here
    } else if (stub.kind === "constraint_flow") {
      // Propagate from source to target
      const fromLabels = flow.labels.get(stub.from);
      if (!fromLabels) continue;

      const toLabels = flow.labels.get(stub.to) ?? new Map();

      for (const [domain, label] of fromLabels.entries()) {
        const existing = toLabels.get(domain);
        if (existing && domain === "error") {
          // Error domain: union rows
          if (existing.domain === "error" && label.domain === "error") {
            const merged = errorRowUnion(existing.row, label.row);
            toLabels.set("error", errorLabel(merged));
          }
        } else if (existing && domain === "taint") {
          // Taint domain: union rows (same as error)
          if (existing.domain === "taint" && label.domain === "taint") {
            const merged = taintRowUnion(existing.row, label.row);
            toLabels.set("taint", taintLabel(merged));
          }
        } else if (!existing) {
          toLabels.set(domain, label);
        }
        // Other domains: handle in their conflict rules
      }
      flow.labels.set(stub.to, toLabels);
    } else if (stub.kind === "constraint_rewrite") {
      // Apply rewrite DURING propagation (critical for nested matches)
      const labels = flow.labels.get(stub.node);
      if (!labels) continue;

      for (const removeLabel of stub.remove) {
        labels.delete(removeLabel.domain); // Remove by domain
      }
      for (const addLabel of stub.add) {
        labels.set(addLabel.domain, addLabel);
      }
    } else if (stub.kind === "branch_join") {
      // Union labels from all branches
      const merged = new Map<string, ConstraintLabel>();

      for (const branchId of stub.branches) {
        const branchLabels = flow.labels.get(branchId);
        if (!branchLabels) continue;

        for (const [domain, label] of branchLabels.entries()) {
          const existing = merged.get(domain);
          if (existing && domain === "error") {
            // Error domain: union rows
            if (existing.domain === "error" && label.domain === "error") {
              const unionRow = errorRowUnion(existing.row, label.row);
              merged.set("error", errorLabel(unionRow));
            }
          } else if (existing && domain === "taint") {
            // Taint domain: union rows (same as error)
            if (existing.domain === "taint" && label.domain === "taint") {
              const unionRow = taintRowUnion(existing.row, label.row);
              merged.set("taint", taintLabel(unionRow));
            }
          } else if (!existing) {
            merged.set(domain, label);
          }
          // Other domains: conflict checking happens later
        }
      }
      flow.labels.set(stub.origin, merged);
    }
  }
}

function detectConstraintConflicts(
  flow: ConstraintFlow,
  diagnostics: ConstraintDiagnostic[],
): void {
  // Check conflicts at every node
  for (const [node, domainLabels] of flow.labels.entries()) {
    // Convert Map<string, ConstraintLabel> to array for pairwise checking
    const labelArray = Array.from(domainLabels.values());

    // Check pairs within each node
    for (let i = 0; i < labelArray.length; i++) {
      for (let j = i + 1; j < labelArray.length; j++) {
        const label1 = labelArray[i];
        const label2 = labelArray[j];

        if (areIncompatible(label1, label2)) {
          diagnostics.push({
            origin: node,
            reason: "incompatible_constraints" as ConstraintDiagnosticReason,
            details: {
              label1: formatLabel(label1),
              label2: formatLabel(label2),
              message: conflictMessage(label1, label2),
            },
          });
        }
      }
    }
  }
}

function checkReturnBoundaries(
  flow: ConstraintFlow,
  resolved: Map<NodeId, Type>,
  program: MProgram,
  diagnostics: ConstraintDiagnostic[],
): void {
  // Walk all function declarations (top-level and nested)
  function checkFunction(decl: MLetDeclaration) {
    // Return position is body.result or body itself
    const returnNodeId = decl.body.result?.id ?? decl.body.id;
    const labels = flow.labels.get(returnNodeId);
    const returnType = resolved.get(returnNodeId);

    if (!labels || !returnType) return;

    // Check each domain's boundary rules
    for (const [_domain, rule] of BOUNDARY_RULES.entries()) {
      // Convert Map<string, ConstraintLabel> to Set<ConstraintLabel> for rules
      const labelSet = new Set(labels.values());
      const error = rule.check(labelSet, returnType);
      if (error) {
        diagnostics.push({
          origin: returnNodeId,
          reason: "boundary_violation" as ConstraintDiagnosticReason,
          details: {
            domain: _domain,
            message: error,
            functionName: decl.name, // Include function name in error
          },
        });
      }
    }

    // Recursively check nested functions
    if (decl.body.kind === "block") {
      for (const stmt of decl.body.statements) {
        if (stmt.kind === "let_statement") {
          checkFunction(stmt.declaration);
        }
      }
    }
  }

  // Check all top-level declarations
  for (const topLevel of program.declarations) {
    if (topLevel.kind === "let") {
      checkFunction(topLevel);
    }
  }
}

// ============================================================================
// Infectious Annotation Checking (Backward Compatibility)
// ============================================================================
// This function provides the same error messages as the old enforceInfectiousMetadata
// for annotation and match mismatches, ensuring backward compatibility with tests.

function checkInfectiousAnnotations(
  stubs: ConstraintStub[],
  flow: ConstraintFlow,
  resolved: Map<NodeId, Type>,
  original: Map<NodeId, Type>,
  diagnostics: ConstraintDiagnostic[],
): void {
  const getNodeType = (nodeId: NodeId): Type | undefined => {
    return resolved.get(nodeId) ?? original.get(nodeId);
  };

  const flaggedCalls = new Set<NodeId>();
  const flaggedMatches = new Set<NodeId>();

  const reportInfectiousCall = (nodeId: NodeId) => {
    if (flaggedCalls.has(nodeId)) {
      return;
    }
    flaggedCalls.add(nodeId);

    // Get error row from constraint labels
    const labels = flow.labels.get(nodeId);
    let row: ErrorRowType | undefined;
    if (labels) {
      const errorLabel = labels.get("error");
      if (errorLabel && errorLabel.domain === "error") {
        row = errorLabel.row;
      }
    }

    diagnostics.push({
      origin: nodeId,
      reason: "infectious_call_result_mismatch",
      details: row ? { errorRow: row } : undefined,
    });
  };

  const reportInfectiousMatch = (
    nodeId: NodeId,
    coverage?: ErrorRowCoverageStub,
  ) => {
    if (flaggedMatches.has(nodeId)) {
      return;
    }
    flaggedMatches.add(nodeId);
    diagnostics.push({
      origin: nodeId,
      reason: "infectious_match_result_mismatch",
      details: {
        errorRow: coverage?.row,
        missingConstructors: coverage?.missingConstructors,
      },
    });
  };

  // Build map of discharged matches
  const dischargedMatches = new Map<NodeId, ErrorRowCoverageStub | undefined>();

  for (const stub of stubs) {
    // Track matches that claim to discharge
    if (stub.kind === "branch_join" && stub.dischargesResult) {
      dischargedMatches.set(stub.origin, stub.errorRowCoverage);
    }
  }

  // Check annotations
  for (const stub of stubs) {
    if (stub.kind === "annotation") {
      const annotationType = stub.annotationType ??
        getNodeType(stub.annotation) ??
        getNodeType(stub.origin);
      if (!annotationType) {
        continue;
      }

      const annotationResultInfo = flattenResultType(annotationType);
      if (!annotationResultInfo) {
        // Annotation expects non-Result type
        // Check if value has error constraints
        const valueLabels = flow.labels.get(stub.value);
        if (valueLabels?.has("error")) {
          reportInfectiousCall(stub.value);
        }

        // Check if it's a discharged match
        if (dischargedMatches.has(stub.value)) {
          reportInfectiousMatch(stub.value, dischargedMatches.get(stub.value));
        }
      } else {
        // Annotation expects Result type
        // Check if value is a discharged match (shouldn't be Result anymore)
        if (dischargedMatches.has(stub.value)) {
          const valueType = getNodeType(stub.value);
          // If the value type is NOT a Result but annotation expects Result,
          // then the match discharged when it shouldn't have
          if (valueType && !flattenResultType(valueType)) {
            reportInfectiousMatch(
              stub.value,
              dischargedMatches.get(stub.value),
            );
          }
        }
      }
    }
  }
}

// ============================================================================
// End of Constraint Flow Graph
// ============================================================================
// Old System Removed - Replaced by Unified Constraint System
// The old enforceInfectiousMetadata function has been removed.
// All infectious type checking is now handled by:
// - buildConstraintFlow()
// - propagateConstraints()
// - detectConstraintConflicts()
// - checkReturnBoundaries()
// ============================================================================

function detectConflicts(
  holes: Map<HoleId, UnknownInfo>,
  constraints: ConstraintStub[],
  substitution: Substitution,
  resolvedTypes: Map<NodeId, Type>,
): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];

  // Group constraints by the holes they reference
  const constraintsByHole = new Map<HoleId, ConstraintStub[]>();

  for (const constraint of constraints) {
    const referencedHoles = getReferencedHoles(constraint, resolvedTypes);
    for (const holeId of referencedHoles) {
      if (!constraintsByHole.has(holeId)) {
        constraintsByHole.set(holeId, []);
      }
      constraintsByHole.get(holeId)!.push(constraint);
    }
  }

  // For each hole, check if its constraints are compatible
  for (const [holeId, holeConstraints] of constraintsByHole.entries()) {
    const info = holes.get(holeId);
    if (!info) continue;

    // Extract the types that the hole is constrained to be
    const constrainedTypes: Type[] = [];

    for (const constraint of holeConstraints) {
      const types = extractConstrainedTypes(constraint, holeId, resolvedTypes);
      constrainedTypes.push(...types);
    }

    // Try to unify all constrained types
    if (constrainedTypes.length > 1) {
      let testSubst = new Map(substitution);
      let firstType = constrainedTypes[0];
      let hasConflict = false;
      const conflictingTypes: Type[] = [firstType];

      for (let i = 1; i < constrainedTypes.length; i++) {
        const result = unifyTypes(firstType, constrainedTypes[i], testSubst);
        if (!result.success) {
          hasConflict = true;
          conflictingTypes.push(constrainedTypes[i]);
        } else {
          testSubst = result.subst;
          firstType = applySubstitution(firstType, testSubst);
        }
      }

      if (hasConflict) {
        conflicts.push({
          holeId,
          provenance: info,
          conflictingConstraints: holeConstraints,
          reason: "type_mismatch",
          types: conflictingTypes,
        });
      }
    }
  }

  return conflicts;
}

function getReferencedHoles(
  constraint: ConstraintStub,
  resolvedTypes: Map<NodeId, Type>,
): HoleId[] {
  const holes: HoleId[] = [];
  const seen = new Set<HoleId>();

  const checkType = (nodeId: NodeId) => {
    const type = resolvedTypes.get(nodeId);
    if (type && isHoleType(type)) {
      // Extract the actual hole ID from the provenance
      const holeId = extractHoleIdFromType(type);
      if (holeId !== undefined && !seen.has(holeId)) {
        holes.push(holeId);
        seen.add(holeId);
      }
    }
  };

  switch (constraint.kind) {
    case "call":
      checkType(constraint.callee);
      checkType(constraint.argument);
      checkType(constraint.result);
      break;
    case "has_field":
      checkType(constraint.target);
      checkType(constraint.result);
      break;
    case "annotation":
      checkType(constraint.annotation);
      checkType(constraint.value);
      break;
    case "numeric":
      constraint.operands.forEach(checkType);
      checkType(constraint.result);
      break;
    case "boolean":
      constraint.operands.forEach(checkType);
      checkType(constraint.result);
      break;
    case "branch_join":
      constraint.branches.forEach(checkType);
      break;
  }

  return holes;
}

/**
 * Extract the actual hole ID from an unknown type's provenance.
 * This handles error provenances that wrap the underlying hole.
 */
function extractHoleIdFromType(type: Type): HoleId | undefined {
  if (!isHoleType(type)) {
    return undefined;
  }

  const prov = getProvenance(type);
  if (!prov) return undefined;

  if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
    return (prov as Record<string, unknown>).id as HoleId;
  } else if (prov.kind === "incomplete") {
    return (prov as Record<string, unknown>).nodeId as HoleId;
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

function extractConstrainedTypes(
  constraint: ConstraintStub,
  holeId: HoleId,
  resolvedTypes: Map<NodeId, Type>,
): Type[] {
  const types: Type[] = [];

  const nodeContainsHole = (nodeId: NodeId): boolean => {
    const type = resolvedTypes.get(nodeId);
    if (type && isHoleType(type)) {
      return extractHoleIdFromType(type) === holeId;
    }
    return false;
  };

  switch (constraint.kind) {
    case "call": {
      // If the callee contains the hole, we know it must be a function
      if (nodeContainsHole(constraint.callee)) {
        const argType = resolvedTypes.get(constraint.argument);
        const resType = constraint.resultType;
        if (argType) {
          // Build function type: (argType -> resType)
          types.push({ kind: "func", from: argType, to: resType });
        }
      }
      break;
    }
    case "annotation": {
      if (nodeContainsHole(constraint.value)) {
        const annotationType = constraint.annotationType ??
          resolvedTypes.get(constraint.annotation);
        if (annotationType && !isHoleType(annotationType)) {
          types.push(annotationType);
        }
      }
      break;
    }
    case "numeric": {
      const hasHole = constraint.operands.some(nodeContainsHole) ||
        nodeContainsHole(constraint.result);
      if (hasHole) {
        types.push({ kind: "int" });
      }
      break;
    }
    case "boolean": {
      const hasHole = constraint.operands.some(nodeContainsHole) ||
        nodeContainsHole(constraint.result);
      if (hasHole) {
        types.push({ kind: "bool" });
      }
      break;
    }
    case "has_field": {
      if (nodeContainsHole(constraint.target)) {
        const resultType = resolvedTypes.get(constraint.result);
        if (resultType) {
          const fields = new Map<string, Type>();
          fields.set(constraint.field, resultType);
          types.push({ kind: "record", fields });
        }
      }
      break;
    }
  }

  return types;
}

function buildPartialSolution(
  holeId: HoleId,
  constraints: ConstraintStub[],
  substitution: Substitution,
  resolvedTypes: Map<NodeId, Type>,
): PartialType | null {
  const relevantConstraints = constraints.filter((c) => {
    const referenced = getReferencedHoles(c, resolvedTypes);
    return referenced.includes(holeId);
  });

  if (relevantConstraints.length === 0) {
    return null;
  }

  // Try to extract what we know about this hole
  const possibilities: Type[] = [];

  for (const constraint of relevantConstraints) {
    const types = extractConstrainedTypes(constraint, holeId, resolvedTypes);
    possibilities.push(...types);
  }

  if (possibilities.length === 0) {
    return null;
  }

  // Try to find a common type
  let known: Type | null = null;
  if (possibilities.length === 1) {
    known = possibilities[0];
  } else {
    // Try to unify all possibilities
    let testSubst = new Map(substitution);
    let unified = possibilities[0];
    let canUnify = true;

    for (let i = 1; i < possibilities.length; i++) {
      const result = unifyTypes(unified, possibilities[i], testSubst);
      if (!result.success) {
        canUnify = false;
        break;
      }
      testSubst = result.subst;
      unified = applySubstitution(unified, testSubst);
    }

    if (canUnify) {
      known = unified;
    }
  }

  return {
    kind: "partial",
    known,
    constraints: relevantConstraints,
    possibilities,
  };
}
