export type { ConstraintDiagnostic, ConstraintDiagnosticReason } from "../diagnostics.ts";

import {
  type MProgram,
  MBlockExpr,
  type MBlockStatement,
  MExpr,
  MParameter,
  MPattern,
  type MMatchArm,
  MMatchBundle,
  MLetDeclaration,
} from "../ast_marked.ts";
import type { ConstraintStub, HoleId, UnknownInfo } from "../layer1/context.ts";
import {
  type Type,
  applySubstitution,
  cloneType,
  occursInType,
  type Substitution,
  unknownType,
} from "../types.ts";
import type { ConstraintDiagnostic, ConstraintDiagnosticReason } from "../diagnostics.ts";
import type { NodeId } from "../ast.ts";

export interface HoleSolution {
  state: "solved" | "unsolved";
  type?: Type;
  provenance: UnknownInfo;
}

export interface SolveInput {
  markedProgram: MProgram;
  constraintStubs: ConstraintStub[];
  holes: Map<HoleId, UnknownInfo>;
  nodeTypeById: Map<NodeId, Type>;
  layer1Diagnostics: ConstraintDiagnostic[];
}

export interface SolverResult {
  solutions: Map<HoleId, HoleSolution>;
  diagnostics: ConstraintDiagnostic[];
  substitution: Substitution;
  resolvedNodeTypes: Map<NodeId, Type>;
  remarkedProgram: MProgram;
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

  for (const stub of input.constraintStubs) {
    switch (stub.kind) {
      case "call":
        solveCallConstraint(state, stub);
        break;
      case "has_field":
        solveHasFieldConstraint(state, stub);
        break;
      case "annotation":
        solveAnnotationConstraint(state, stub);
        break;
      case "numeric":
        solveNumericConstraint(state, stub);
        break;
      case "boolean":
        solveBooleanConstraint(state, stub);
        break;
      case "branch_join":
        solveBranchJoinConstraint(state, stub);
        break;
    }
  }

  const resolvedNodeTypes = new Map<NodeId, Type>();
  for (const [nodeId, type] of input.nodeTypeById.entries()) {
    const resolved = applySubstitution(type, state.substitution);
    resolvedNodeTypes.set(nodeId, cloneType(resolved));
  }

  const solutions: Map<HoleId, HoleSolution> = new Map();
  for (const [holeId, info] of input.holes.entries()) {
    const nodeType = resolvedNodeTypes.get(holeId);
    if (!nodeType || nodeType.kind === "unknown") {
      solutions.set(holeId, { state: "unsolved", provenance: info });
    } else {
      solutions.set(holeId, { state: "solved", type: nodeType, provenance: info });
    }
  }

  remarkProgram(input.markedProgram, resolvedNodeTypes);

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
  };
}

interface SolverState {
  substitution: Substitution;
  diagnostics: ConstraintDiagnostic[];
  nodeTypeById: Map<NodeId, Type>;
}

function solveCallConstraint(state: SolverState, stub: ConstraintStub & { kind: "call" }): void {
  const callee = getTypeForNode(state, stub.callee);
  const stageCallee = peelFunctionType(callee, stub.index);
  const argument = getTypeForNode(state, stub.argument);
  const result = applySubstitution(stub.resultType, state.substitution);
  const target: Type = { kind: "func", from: argument, to: result };
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

  registerUnifyFailure(state, stub.origin, unified.reason);
}

function solveHasFieldConstraint(state: SolverState, stub: ConstraintStub & { kind: "has_field" }): void {
  const target = getTypeForNode(state, stub.target);
  const result = getTypeForNode(state, stub.result);
  const resolvedTarget = applySubstitution(target, state.substitution);

  if (resolvedTarget.kind === "record") {
    const fieldType = resolvedTarget.fields.get(stub.field);
    if (!fieldType) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "missing_field",
        details: { field: stub.field },
      });
      return;
    }
    const unified = unifyTypes(fieldType, result, state.substitution);
    if (unified.success) {
      state.substitution = unified.subst;
    } else {
      registerUnifyFailure(state, stub.origin, unified.reason);
    }
    return;
  }

  if (resolvedTarget.kind === "var" || resolvedTarget.kind === "unknown") {
    const fields = new Map<string, Type>();
    fields.set(stub.field, result);
    const unified = unifyTypes(resolvedTarget, { kind: "record", fields }, state.substitution);
    if (unified.success) {
      state.substitution = unified.subst;
      return;
    }
    registerUnifyFailure(state, stub.origin, unified.reason);
    return;
  }

  state.diagnostics.push({
    origin: stub.origin,
    reason: "not_record",
    details: { actual: resolvedTarget.kind },
  });
}

function solveAnnotationConstraint(state: SolverState, stub: ConstraintStub & { kind: "annotation" }): void {
  const annotation = getTypeForNode(state, stub.annotation);
  const value = getTypeForNode(state, stub.value);
  const unified = unifyTypes(annotation, value, state.substitution);
  if (unified.success) {
    state.substitution = unified.subst;
  } else {
    registerUnifyFailure(state, stub.origin, unified.reason);
  }
}

function solveNumericConstraint(state: SolverState, stub: ConstraintStub & { kind: "numeric" }): void {
  const intType: Type = { kind: "int" };
  let currentSubst = state.substitution;

  for (const operand of stub.operands) {
    const operandType = getTypeForNode(state, operand);
    const unified = unifyTypes(operandType, intType, currentSubst);
    if (!unified.success) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "not_numeric",
        details: { operand },
      });
      return;
    }
    currentSubst = unified.subst;
  }

  const resultType = getTypeForNode(state, stub.result);
  const unifiedResult = unifyTypes(resultType, intType, currentSubst);
  if (!unifiedResult.success) {
    state.diagnostics.push({
      origin: stub.origin,
      reason: "not_numeric",
      details: { operand: stub.result },
    });
    return;
  }

  state.substitution = unifiedResult.subst;
}

function solveBooleanConstraint(state: SolverState, stub: ConstraintStub & { kind: "boolean" }): void {
  const boolType: Type = { kind: "bool" };
  let currentSubst = state.substitution;

  for (const operand of stub.operands) {
    const operandType = getTypeForNode(state, operand);
    const unified = unifyTypes(operandType, boolType, currentSubst);
    if (!unified.success) {
      state.diagnostics.push({
        origin: stub.origin,
        reason: "not_boolean",
        details: { operand },
      });
      return;
    }
    currentSubst = unified.subst;
  }

  const resultType = getTypeForNode(state, stub.result);
  const unifiedResult = unifyTypes(resultType, boolType, currentSubst);
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

function solveBranchJoinConstraint(state: SolverState, stub: ConstraintStub & { kind: "branch_join" }): void {
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
        details: { branchIndex: index },
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

function registerUnifyFailure(state: SolverState, origin: NodeId, failure: UnifyFailure): void {
  const reason: ConstraintDiagnosticReason =
    failure.kind === "occurs_check"
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

  if (resolvedLeft.kind === "constructor" && resolvedRight.kind === "constructor") {
    if (resolvedLeft.name !== resolvedRight.name || resolvedLeft.args.length !== resolvedRight.args.length) {
      return {
        success: false,
        reason: {
          kind: resolvedLeft.name !== resolvedRight.name ? "type_mismatch" : "arity_mismatch",
          left: resolvedLeft,
          right: resolvedRight,
        },
      };
    }
    let current = subst;
    for (let index = 0; index < resolvedLeft.args.length; index += 1) {
      const result = unifyTypes(resolvedLeft.args[index], resolvedRight.args[index], current);
      if (!result.success) return result;
      current = result.subst;
    }
    return { success: true, subst: current };
  }

  if (resolvedLeft.kind === "tuple" && resolvedRight.kind === "tuple") {
    if (resolvedLeft.elements.length !== resolvedRight.elements.length) {
      return {
        success: false,
        reason: { kind: "arity_mismatch", left: resolvedLeft, right: resolvedRight },
      };
    }
    let current = subst;
    for (let index = 0; index < resolvedLeft.elements.length; index += 1) {
      const result = unifyTypes(resolvedLeft.elements[index], resolvedRight.elements[index], current);
      if (!result.success) return result;
      current = result.subst;
    }
    return { success: true, subst: current };
  }

  if (resolvedLeft.kind === "record" && resolvedRight.kind === "record") {
    if (resolvedLeft.fields.size !== resolvedRight.fields.size) {
      return {
        success: false,
        reason: { kind: "arity_mismatch", left: resolvedLeft, right: resolvedRight },
      };
    }
    let current = subst;
    for (const [field, leftType] of resolvedLeft.fields.entries()) {
      const rightType = resolvedRight.fields.get(field);
      if (!rightType) {
        return {
          success: false,
          reason: { kind: "type_mismatch", left: resolvedLeft, right: resolvedRight },
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
      if (b.kind !== "constructor" || a.name !== b.name || a.args.length !== b.args.length) {
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
    case "unknown":
      return b.kind === "unknown" && a.provenance === b.provenance;
    default:
      return true;
  }
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

function remarkLetDeclaration(decl: MLetDeclaration, resolved: Map<NodeId, Type>): void {
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

function remarkParameter(parameter: MParameter, resolved: Map<NodeId, Type>): void {
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

function remarkBlockStatement(statement: MBlockStatement, resolved: Map<NodeId, Type>): void {
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

function remarkMatchBundle(bundle: MMatchBundle, resolved: Map<NodeId, Type>): void {
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

function remarkType(node: { id: NodeId; type: Type }, resolved: Map<NodeId, Type>): void {
  const replacement = resolved.get(node.id);
  if (!replacement) {
    return;
  }
  if (node.type.kind === "unknown" && replacement.kind !== "unknown") {
    node.type = replacement;
  }
}
