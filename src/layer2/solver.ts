export type {
  ConstraintDiagnostic,
  ConstraintDiagnosticReason,
} from "../diagnostics.ts";

import {
  MBlockExpr,
  type MBlockStatement,
  MExpr,
  MLetDeclaration,
  type MMatchArm,
  MMatchBundle,
  MParameter,
  MPattern,
  type MProgram,
} from "../ast_marked.ts";
import type {
  ConstraintStub,
  ErrorRowCoverageStub,
  HoleId,
  UnknownInfo,
} from "../layer1/context.ts";
import {
  applySubstitution,
  cloneType,
  type ErrorRowType,
  errorRowUnion,
  flattenResultType,
  makeResultType,
  occursInType,
  type Substitution,
  type Type,
  unknownType,
} from "../types.ts";
import type {
  ConstraintDiagnostic,
  ConstraintDiagnosticReason,
} from "../diagnostics.ts";
import type { NodeId } from "../ast.ts";

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
  for (const [nodeId, type] of input.nodeTypeById.entries()) {
    const resolved = applySubstitution(type, state.substitution);
    resolvedNodeTypes.set(nodeId, cloneType(resolved));
  }

  enforceInfectiousMetadata(
    input.constraintStubs,
    resolvedNodeTypes,
    input.nodeTypeById,
    state.diagnostics,
  );

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
    } else if (!nodeType || nodeType.kind === "unknown") {
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
    const transformedType = transformTypeWithSolutions(scheme.type, solutions);
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
  if (type.kind === "unknown") {
    const holeId = extractHoleIdFromType(type);
    if (holeId !== undefined) {
      const solution = solutions.get(holeId);
      if (solution?.state === "conflicted") {
        // Replace with unfillable_hole marker (constraint conflict)
        return {
          kind: "unknown",
          provenance: {
            kind: "error_unfillable_hole",
            holeId,
            conflicts: solution.conflicts || [],
          },
        };
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
    argumentErrorRow: stub.argumentErrorRow,
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
  const targetResultInfo = flattenResultType(resolvedTarget);
  const targetValue = targetResultInfo
    ? applySubstitution(targetResultInfo.value, state.substitution)
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
      targetResultInfo?.error ?? null,
      projectedValue,
    );
    return;
  }

  if (targetValue.kind === "var" || targetValue.kind === "unknown") {
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
        targetResultInfo?.error ?? null,
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
  carriedError: ErrorRowType | null,
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
  const fieldResultInfo = flattenResultType(resolvedFieldType);
  const projectedValueType = fieldResultInfo
    ? applySubstitution(fieldResultInfo.value, state.substitution)
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
  let combinedError = carriedError;
  if (fieldResultInfo) {
    combinedError = combinedError
      ? errorRowUnion(combinedError, fieldResultInfo.error)
      : fieldResultInfo.error;
  }
  const finalValue = applySubstitution(valueTarget, state.substitution);
  const finalType = combinedError
    ? makeResultType(cloneType(finalValue), combinedError)
    : finalValue;
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
  let accumulatedErrors: ErrorRowType | null = null;

  for (const operand of stub.operands) {
    const operandType = applySubstitution(
      getTypeForNode(state, operand),
      currentSubst,
    );
    const operandInfo = flattenResultType(operandType);
    const operandValue = operandInfo ? operandInfo.value : operandType;

    // Skip unknown types - they'll be constrained elsewhere or represent holes
    if (operandValue.kind === "unknown") {
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
    if (operandInfo) {
      accumulatedErrors = accumulatedErrors
        ? errorRowUnion(accumulatedErrors, operandInfo.error)
        : operandInfo.error;
    }
  }

  // For comparison operators (>, <, >=, <=), the result is Bool, not Int
  // Only check result type for arithmetic operators (+, -, *, /)
  const comparisonOperators = new Set([">", "<", ">=", "<=", "==", "!="]);
  const isComparison = comparisonOperators.has(stub.operator);

  if (!isComparison) {
    const resultType = getTypeForNode(state, stub.result);
    const resultInfo = flattenResultType(
      applySubstitution(resultType, currentSubst),
    );
    let combinedErrors = accumulatedErrors;
    if (resultInfo && resultInfo.error) {
      combinedErrors = combinedErrors
        ? errorRowUnion(combinedErrors, resultInfo.error)
        : resultInfo.error;
    }
    const expectedResultType = combinedErrors
      ? makeResultType(intType, combinedErrors)
      : intType;
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
  let accumulatedErrors: ErrorRowType | null = null;

  for (const operand of stub.operands) {
    const operandType = applySubstitution(
      getTypeForNode(state, operand),
      currentSubst,
    );
    const operandInfo = flattenResultType(operandType);
    const operandValue = operandInfo ? operandInfo.value : operandType;
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
    if (operandInfo) {
      accumulatedErrors = accumulatedErrors
        ? errorRowUnion(accumulatedErrors, operandInfo.error)
        : operandInfo.error;
    }
  }

  const resultType = getTypeForNode(state, stub.result);
  const resultInfo = flattenResultType(
    applySubstitution(resultType, currentSubst),
  );
  let combinedErrors = accumulatedErrors;
  if (resultInfo && resultInfo.error) {
    combinedErrors = combinedErrors
      ? errorRowUnion(combinedErrors, resultInfo.error)
      : resultInfo.error;
  }
  const expectedResultType = combinedErrors
    ? makeResultType(boolType, combinedErrors)
    : boolType;
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

  const referenceType = getTypeForNode(state, stub.branches[0]);
  let currentSubst = state.substitution;

  for (let index = 1; index < stub.branches.length; index += 1) {
    const branchType = getTypeForNode(state, stub.branches[index]);
    const unified = unifyTypes(referenceType, branchType, currentSubst);
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

  const resultType = getTypeForNode(state, stub.origin);
  const unifiedResult = unifyTypes(referenceType, resultType, currentSubst);
  if (!unifiedResult.success) {
    state.diagnostics.push({
      origin: stub.origin,
      reason: "branch_mismatch",
      details: {
        branchIndex: "result",
        dischargesResult: stub.dischargesResult ?? false,
        errorRow: stub.errorRowCoverage?.row,
        missingConstructors: stub.errorRowCoverage?.missingConstructors,
      },
    });
    return;
  }

  state.substitution = unifiedResult.subst;
}

function getTypeForNode(state: SolverState, nodeId: NodeId): Type {
  const type = state.nodeTypeById.get(nodeId);
  if (type) {
    return cloneType(applySubstitution(type, state.substitution));
  }
  return unknownType({ kind: "incomplete", reason: "solver.missing_node" });
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

  if (resolvedLeft.kind === "unknown") {
    return { success: true, subst };
  }
  if (resolvedRight.kind === "unknown") {
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
    case "unknown":
      return b.kind === "unknown" && a.provenance === b.provenance;
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
  if (node.type.kind === "unknown" && replacement.kind !== "unknown") {
    node.type = replacement;
  }
}

function enforceInfectiousMetadata(
  stubs: ConstraintStub[],
  resolved: Map<NodeId, Type>,
  original: Map<NodeId, Type>,
  diagnostics: ConstraintDiagnostic[],
): void {
  const infectiousCalls = new Map<NodeId, ErrorRowType>();
  const dischargedMatches = new Map<NodeId, ErrorRowCoverageStub | undefined>();

  for (const stub of stubs) {
    if (stub.kind === "call" && stub.argumentErrorRow) {
      const existing = infectiousCalls.get(stub.result);
      if (existing) {
        infectiousCalls.set(
          stub.result,
          errorRowUnion(existing, stub.argumentErrorRow),
        );
      } else {
        infectiousCalls.set(
          stub.result,
          cloneType(stub.argumentErrorRow) as ErrorRowType,
        );
      }
    } else if (stub.kind === "branch_join" && stub.dischargesResult) {
      dischargedMatches.set(stub.origin, stub.errorRowCoverage);
    }
  }

  const getNodeType = (nodeId: NodeId): Type | undefined => {
    return resolved.get(nodeId) ?? original.get(nodeId);
  };

  const flaggedCalls = new Set<NodeId>();
  const flaggedMatches = new Set<NodeId>();

  const reportInfectiousValue = (
    nodeId: NodeId,
    row?: ErrorRowType,
  ) => {
    if (flaggedCalls.has(nodeId)) {
      return;
    }
    flaggedCalls.add(nodeId);
    diagnostics.push({
      origin: nodeId,
      reason: "infectious_call_result_mismatch",
      details: row ? { errorRow: row } : undefined,
    });
  };

  const flagCallNode = (nodeId: NodeId, force = false) => {
    const nodeType = getNodeType(nodeId);
    if (!force) {
      if (!nodeType) {
        return;
      }
      if (flattenResultType(nodeType)) {
        return;
      }
    }
    const row = infectiousCalls.get(nodeId) ??
      (nodeType ? flattenResultType(nodeType)?.error : undefined);
    if (!row) {
      return;
    }
    reportInfectiousValue(nodeId, row);
  };

  const flagMatchNode = (nodeId: NodeId, force = false) => {
    const coverage = dischargedMatches.get(nodeId);
    if (!coverage || flaggedMatches.has(nodeId)) {
      return;
    }
    if (!force) {
      const nodeType = getNodeType(nodeId);
      if (!nodeType) {
        return;
      }
      if (!flattenResultType(nodeType)) {
        return;
      }
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

  for (const nodeId of infectiousCalls.keys()) {
    flagCallNode(nodeId);
  }
  for (const nodeId of dischargedMatches.keys()) {
    flagMatchNode(nodeId);
  }

  for (const stub of stubs) {
    switch (stub.kind) {
      case "annotation": {
        const annotationType = stub.annotationType ??
          getNodeType(stub.annotation) ??
          getNodeType(stub.origin);
        if (!annotationType) {
          break;
        }
        const annotationResultInfo = flattenResultType(annotationType);
        if (!annotationResultInfo) {
          const valueType = getNodeType(stub.value);
          const valueResultInfo = valueType
            ? flattenResultType(valueType)
            : undefined;
          const originalValueType = original.get(stub.value);
          const originalValueInfo = originalValueType
            ? flattenResultType(originalValueType)
            : undefined;
          if (valueResultInfo) {
            reportInfectiousValue(stub.value, valueResultInfo.error);
          } else if (originalValueInfo) {
            reportInfectiousValue(stub.value, originalValueInfo.error);
          } else {
            flagCallNode(stub.value, true);
          }
        } else if (dischargedMatches.has(stub.value)) {
          flagMatchNode(stub.value, true);
        }
        break;
      }
      case "has_field": {
        flagCallNode(stub.target);
        break;
      }
      default:
        break;
    }
  }
}

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
    if (type?.kind === "unknown") {
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
  if (type.kind !== "unknown") {
    return undefined;
  }

  const prov = type.provenance;
  if (prov.kind === "expr_hole" || prov.kind === "user_hole") {
    return (prov as any).id;
  } else if (prov.kind === "incomplete") {
    return (prov as any).nodeId;
  } else if (
    prov.kind === "error_not_function" || prov.kind === "error_inconsistent"
  ) {
    // Unwrap error provenance to get the underlying hole
    const innerType = (prov as any).calleeType || (prov as any).actual;
    if (innerType?.kind === "unknown") {
      return extractHoleIdFromType(innerType);
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
    if (type?.kind === "unknown") {
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
        if (annotationType && annotationType.kind !== "unknown") {
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
