import type {
  BlockExpr,
  Expr,
  Literal,
  MatchBundle,
  NodeId,
  Pattern,
  SourceSpan,
  TypeDeclaration,
  TypeExpr,
} from "../ast.ts";
import type {
  MExpr,
  MMarkFreeVar,
  MMarkInconsistent,
  MMarkInternal,
  MMarkNotFunction,
  MMarkOccursCheck,
  MMarkTypeDeclDuplicate,
  MMarkTypeDeclInvalidMember,
  MMarkTypeExprArity,
  MMarkTypeExprUnknown,
  MMarkTypeExprUnsupported,
  MMarkUnsupportedExpr,
  MProgram,
  MTopLevelMark,
  MTypeExpr,
  MTypeExprMark,
} from "../ast_marked.ts";
import type { MatchBranchesResult } from "./infermatch.ts";
import {
  applySubstitution,
  applySubstitutionScheme,
  cloneTypeInfo,
  cloneTypeScheme,
  composeSubstitution,
  generalize,
  instantiate,
  occursInType,
  Provenance,
  resetTypeVarCounter,
  Substitution,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
  typeToString,
  unknownType,
} from "../types.ts";
import { InferError } from "../error.ts";

export interface Context {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  subst: Substitution;
  source?: string;
  allBindings: Map<string, TypeScheme>;
  nonGeneralizable: Set<number>;
  marks: Map<Expr, MExpr>;
  typeExprMarks: Map<TypeExpr, MTypeExpr>;
  nodeTypes: Map<Expr, Type>;
  matchResults: Map<MatchBundle, MatchBranchesResult>;
  topLevelMarks: MTopLevelMark[];
  lastUnifyFailure: UnifyFailure | null;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
}

export interface InferOptions {
  initialEnv?: TypeEnv;
  initialAdtEnv?: TypeEnvADT;
  registerPrelude?: boolean;
  resetCounter?: boolean;
  source?: string;
}

export interface InferResult {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  summaries: { name: string; scheme: TypeScheme }[];
  allBindings: Map<string, TypeScheme>;
  markedProgram: MProgram;
  marks: Map<Expr, MExpr>;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
  marksVersion: number;
}

export function createContext(options: InferOptions = {}): Context {
  if (options.resetCounter !== false) {
    resetTypeVarCounter();
  }
  return {
    env: options.initialEnv ? cloneTypeEnv(options.initialEnv) : new Map(),
    adtEnv: options.initialAdtEnv
      ? cloneAdtEnv(options.initialAdtEnv)
      : new Map(),
    subst: new Map(),
    source: options.source,
    allBindings: new Map(),
    nonGeneralizable: new Set(),
    marks: new Map(),
    typeExprMarks: new Map(),
    nodeTypes: new Map(),
    matchResults: new Map(),
    topLevelMarks: [],
    lastUnifyFailure: null,
    holes: new Map(),
    constraintStubs: [],
  };
}

export type HoleId = NodeId;

export type HoleOriginKind = "expr" | "pattern" | "type_expr" | "top_level";

export interface HoleOrigin {
  kind: HoleOriginKind;
  nodeId: NodeId;
  span: SourceSpan;
}

export type UnknownCategory =
  | "free"
  | "local_conflict"
  | "incomplete"
  | "internal";

export interface UnknownInfo {
  id: HoleId;
  provenance: Provenance;
  category: UnknownCategory;
  relatedNodes: NodeId[];
  origin: HoleOrigin;
}

export type ConstraintStub =
  | {
      kind: "call";
      origin: NodeId;
      callee: NodeId;
      argument: NodeId;
      result: NodeId;
      index: number;
    }
  | {
      kind: "branch_join";
      origin: NodeId;
      scrutinee: NodeId | null;
      branches: NodeId[];
    }
  | {
      kind: "annotation";
      origin: NodeId;
      annotation: NodeId;
      value: NodeId;
      subject: NodeId | null;
    }
  | {
      kind: "numeric";
      origin: NodeId;
      operator: string;
      operands: NodeId[];
      result: NodeId;
    }
  | {
      kind: "boolean";
      origin: NodeId;
      operator: string;
      operands: NodeId[];
      result: NodeId;
    };

export function recordCallConstraint(
  ctx: Context,
  origin: Expr,
  callee: Expr,
  argument: Expr,
  result: Expr,
  index: number,
): void {
  ctx.constraintStubs.push({
    kind: "call",
    origin: origin.id,
    callee: callee.id,
    argument: argument.id,
    result: result.id,
    index,
  });
}

export function recordBranchJoinConstraint(
  ctx: Context,
  origin: Expr,
  branchBodies: Expr[],
  scrutinee?: Expr,
): void {
  ctx.constraintStubs.push({
    kind: "branch_join",
    origin: origin.id,
    scrutinee: scrutinee?.id ?? null,
    branches: branchBodies.map((body) => body.id),
  });
}

export function recordAnnotationConstraint(
  ctx: Context,
  origin: NodeId,
  annotation: TypeExpr,
  value: Expr,
  subject?: Expr | BlockExpr,
): void {
  ctx.constraintStubs.push({
    kind: "annotation",
    origin,
    annotation: annotation.id,
    value: value.id,
    subject: subject?.id ?? null,
  });
}

export function recordNumericConstraint(
  ctx: Context,
  origin: Expr,
  operands: Expr[],
  operator: string,
): void {
  if (operands.length === 0) {
    return;
  }
  ctx.constraintStubs.push({
    kind: "numeric",
    origin: origin.id,
    operator,
    operands: operands.map((operand) => operand.id),
    result: origin.id,
  });
}

export function recordBooleanConstraint(
  ctx: Context,
  origin: Expr,
  operands: Expr[],
  operator: string,
): void {
  ctx.constraintStubs.push({
    kind: "boolean",
    origin: origin.id,
    operator,
    operands: operands.map((operand) => operand.id),
    result: origin.id,
  });
}

export function holeOriginFromExpr(expr: Expr): HoleOrigin {
  return {
    kind: "expr",
    nodeId: expr.id,
    span: expr.span,
  };
}

export function holeOriginFromTypeExpr(typeExpr: TypeExpr): HoleOrigin {
  return {
    kind: "type_expr",
    nodeId: typeExpr.id,
    span: typeExpr.span,
  };
}

export function holeOriginFromPattern(pattern: Pattern): HoleOrigin {
  return {
    kind: "pattern",
    nodeId: pattern.id,
    span: pattern.span,
  };
}

function categoryFromProvenance(provenance: Provenance): UnknownCategory {
  switch (provenance.kind) {
    case "error_free_var":
      return "free";
    case "error_internal":
      return "internal";
    case "incomplete":
      return "incomplete";
    default:
      return "local_conflict";
  }
}

export function registerHoleForType(
  ctx: Context,
  origin: HoleOrigin,
  type: Type,
  category?: UnknownCategory,
  relatedNodes: NodeId[] = [],
): void {
  if (type.kind !== "unknown") {
    if (ctx.holes.has(origin.nodeId)) {
      ctx.holes.delete(origin.nodeId);
    }
    return;
  }

  const resolvedCategory = category ?? categoryFromProvenance(type.provenance);
  ctx.holes.set(origin.nodeId, {
    id: origin.nodeId,
    provenance: type.provenance,
    category: resolvedCategory,
    relatedNodes,
    origin,
  });
}

export function createUnknownAndRegister(
  ctx: Context,
  origin: HoleOrigin,
  provenance: Provenance,
  category?: UnknownCategory,
  relatedNodes: NodeId[] = [],
): Type {
  const type = unknownType(provenance);
  registerHoleForType(ctx, origin, type, category, relatedNodes);
  return type;
}

export function cloneTypeEnv(source: TypeEnv): TypeEnv {
  const clone: TypeEnv = new Map();
  for (const [name, scheme] of source.entries()) {
    clone.set(name, cloneTypeScheme(scheme));
  }
  return clone;
}

export function cloneAdtEnv(source: TypeEnvADT): TypeEnvADT {
  const clone: TypeEnvADT = new Map();
  for (const [name, info] of source.entries()) {
    clone.set(name, cloneTypeInfo(info));
  }
  return clone;
}

export function withScopedEnv<T>(ctx: Context, fn: () => T): T {
  const previous = ctx.env;
  ctx.env = new Map(ctx.env);
  try {
    return fn();
  } finally {
    ctx.env = previous;
  }
}

export function applyCurrentSubst(ctx: Context, type: Type): Type {
  return applySubstitution(type, ctx.subst);
}

export function instantiateAndApply(ctx: Context, scheme: TypeScheme): Type {
  const type = instantiate(scheme);
  return applyCurrentSubst(ctx, type);
}

export interface UnifyFailure {
  kind: "type_mismatch" | "arity_mismatch" | "occurs_check";
  left: Type;
  right: Type;
}

export type UnifyResult = { success: true; subst: Substitution } | {
  success: false;
  reason: UnifyFailure;
};

export function lookupEnv(ctx: Context, name: string): TypeScheme | null {
  const scheme = ctx.env.get(name);
  if (!scheme) {
    return null;
  }
  return scheme;
}

export function generalizeInContext(ctx: Context, type: Type): TypeScheme {
  const appliedType = applyCurrentSubst(ctx, type);
  const appliedEnv: TypeEnv = new Map();
  for (const [name, scheme] of ctx.env.entries()) {
    appliedEnv.set(name, applySubstitutionScheme(scheme, ctx.subst));
  }
  const scheme = generalize(appliedType, appliedEnv);
  if (ctx.nonGeneralizable.size === 0) {
    return scheme;
  }
  const filtered = scheme.quantifiers.filter((id) =>
    !ctx.nonGeneralizable.has(id)
  );
  ctx.nonGeneralizable.clear();
  if (filtered.length === scheme.quantifiers.length) {
    return scheme;
  }
  return {
    quantifiers: filtered,
    type: scheme.type,
  };
}

export type ExpectFunctionResult = { success: true; from: Type; to: Type } | {
  success: false;
  type: Type;
};

export function expectFunctionType(
  ctx: Context,
  type: Type,
  description: string,
): ExpectFunctionResult {
  const resolved = applyCurrentSubst(ctx, type);
  if (resolved.kind !== "func") {
    return { success: false, type: resolved };
  }
  return { success: true, from: resolved.from, to: resolved.to };
}

export function literalType(literal: Literal): Type {
  switch (literal.kind) {
    case "int":
      recordNumericLiteralConstraint(ctx, literal);
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "char":
      return { kind: "char" };
    case "unit":
      return { kind: "unit" };
    case "string":
      return { kind: "string" };
    default:
      return unknownType({ kind: "incomplete", reason: "literal.unsupported" });
  }
}

export function inferError(
  message: string,
  span?: SourceSpan,
  source?: string,
): InferError {
  return new InferError(message, span, source);
}

export function markFreeVariable(
  ctx: Context,
  expr: Expr,
  name: string,
): MMarkFreeVar {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkFreeVar = {
    kind: "mark_free_var",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_free_var",
      name,
    }, "free"),
    name,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markNotFunction(
  ctx: Context,
  expr: Expr,
  callee: MExpr,
  args: MExpr[],
  calleeType: Type,
): MMarkNotFunction {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkNotFunction = {
    kind: "mark_not_function",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_not_function",
      calleeType,
    }),
    callee,
    args,
    calleeType,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markOccursCheck(
  ctx: Context,
  expr: Expr,
  subject: MExpr,
  left: Type,
  right: Type,
): MMarkOccursCheck {
  const resolvedLeft = applyCurrentSubst(ctx, left);
  const resolvedRight = applyCurrentSubst(ctx, right);
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkOccursCheck = {
    kind: "mark_occurs_check",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_occurs_check",
      left: resolvedLeft,
      right: resolvedRight,
    }),
    subject,
    left: resolvedLeft,
    right: resolvedRight,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markInconsistent(
  ctx: Context,
  expr: Expr,
  subject: MExpr,
  expected: Type,
  actual: Type,
): MMarkInconsistent {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkInconsistent = {
    kind: "mark_inconsistent",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_inconsistent",
      expected,
      actual,
    }),
    subject,
    expected,
    actual,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markUnsupportedExpr(
  ctx: Context,
  expr: Expr,
  exprKind: string,
): MMarkUnsupportedExpr {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkUnsupportedExpr = {
    kind: "mark_unsupported_expr",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "incomplete",
      reason: "expr.unsupported",
    }, "incomplete"),
    exprKind,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markTypeDeclDuplicate(
  ctx: Context,
  decl: TypeDeclaration,
): MMarkTypeDeclDuplicate {
  const mark: MMarkTypeDeclDuplicate = {
    kind: "mark_type_decl_duplicate",
    span: decl.span,
    id: decl.id,
    declaration: decl,
    duplicate: decl,
  };
  // Note: Top-level marks don't use ctx.marks since they're not expressions
  return mark;
}

export function markTypeDeclInvalidMember(
  ctx: Context,
  decl: TypeDeclaration,
  member: TypeDeclaration["members"][0],
): MMarkTypeDeclInvalidMember {
  const mark: MMarkTypeDeclInvalidMember = {
    kind: "mark_type_decl_invalid_member",
    span: decl.span, // Use decl span for consistency
    id: decl.id, // Use decl id for provenance
    declaration: decl,
    member,
  };
  return mark;
}

export function markInternal(ctx: Context, reason: string): MMarkInternal {
  const mark: MMarkInternal = {
    kind: "mark_internal",
    span: { start: 0, end: 0 },
    id: -1,
    reason,
  };
  ctx.topLevelMarks.push(mark);
  return mark;
}

export function markTypeExprUnknown(
  ctx: Context,
  typeExpr: TypeExpr,
  reason: string,
): MMarkTypeExprUnknown {
  const origin = holeOriginFromTypeExpr(typeExpr);
  const mark: MMarkTypeExprUnknown = {
    kind: "mark_type_expr_unknown",
    span: typeExpr.span,
    id: typeExpr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_type_expr_unknown",
      name: reason,
    }),
    typeExpr,
    reason,
  };
  return mark;
}

export function markTypeExprArity(
  ctx: Context,
  typeExpr: TypeExpr,
  expected: number,
  actual: number,
): MMarkTypeExprArity {
  const origin = holeOriginFromTypeExpr(typeExpr);
  const mark: MMarkTypeExprArity = {
    kind: "mark_type_expr_arity",
    span: typeExpr.span,
    id: typeExpr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_type_expr_arity",
      expected,
      actual,
    }),
    typeExpr,
    expected,
    actual,
  };
  return mark;
}

export function markNonExhaustive(
  ctx: Context,
  expr: Expr,
  scrutineeSpan: SourceSpan,
  missingCases: string[],
): MMarkUnsupportedExpr {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkUnsupportedExpr = {
    kind: "mark_unsupported_expr",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "incomplete",
      reason: "match.non_exhaustive",
    }, "incomplete"),
    exprKind: "match_non_exhaustive",
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markTypeExprUnsupported(
  ctx: Context,
  typeExpr: TypeExpr,
): MMarkTypeExprUnsupported {
  const origin = holeOriginFromTypeExpr(typeExpr);
  const mark: MMarkTypeExprUnsupported = {
    kind: "mark_type_expr_unsupported",
    span: typeExpr.span,
    id: typeExpr.id,
    type: createUnknownAndRegister(ctx, origin, {
      kind: "error_type_expr_unsupported",
    }),
    typeExpr: typeExpr,
  };
  return mark;
}

function unifyTypes(a: Type, b: Type, subst: Substitution): UnifyResult {
  const left = applySubstitution(a, subst);
  const right = applySubstitution(b, subst);

  if (left.kind === "var") {
    return bindVar(left.id, right, subst);
  }
  if (right.kind === "var") {
    return bindVar(right.id, left, subst);
  }

  if (left.kind === "func" && right.kind === "func") {
    const subst1 = unifyTypes(left.from, right.from, subst);
    if (!subst1.success) return subst1;
    return unifyTypes(left.to, right.to, subst1.subst);
  }

  if (left.kind === "constructor" && right.kind === "constructor") {
    if (left.name !== right.name || left.args.length !== right.args.length) {
      return {
        success: false,
        reason: {
          kind: left.name !== right.name ? "type_mismatch" : "arity_mismatch",
          left,
          right,
        },
      };
    }
    let current = subst;
    for (let i = 0; i < left.args.length; i++) {
      const res = unifyTypes(left.args[i], right.args[i], current);
      if (!res.success) return res;
      current = res.subst;
    }
    return { success: true, subst: current };
  }

  if (left.kind === "tuple" && right.kind === "tuple") {
    if (left.elements.length !== right.elements.length) {
      return {
        success: false,
        reason: { kind: "arity_mismatch", left, right },
      };
    }
    let current = subst;
    for (let i = 0; i < left.elements.length; i++) {
      const res = unifyTypes(left.elements[i], right.elements[i], current);
      if (!res.success) return res;
      current = res.subst;
    }
    return { success: true, subst: current };
  }

  if (left.kind === right.kind) {
    return { success: true, subst };
  }

  return {
    success: false,
    reason: { kind: "type_mismatch", left, right },
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

export function unify(ctx: Context, a: Type, b: Type): boolean {
  const result = unifyTypes(a, b, ctx.subst);
  if (result.success) {
    ctx.subst = composeSubstitution(ctx.subst, result.subst);
    ctx.lastUnifyFailure = null;
    return true;
  }
  ctx.lastUnifyFailure = result.reason;
  return false;
}
