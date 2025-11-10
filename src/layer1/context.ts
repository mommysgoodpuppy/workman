import type {
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
import type {
  MatchBranchesResult,
  MatchErrorRowCoverage,
} from "./infermatch.ts";
import {
  applySubstitution,
  applySubstitutionScheme,
  cloneType,
  cloneTypeInfo,
  cloneTypeScheme,
  composeSubstitution,
  ErrorRowType,
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
import type { ConstraintDiagnostic, ConstraintDiagnosticReason } from "../diagnostics.ts";

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
  annotationTypes: Map<NodeId, Type>;
  matchResults: Map<MatchBundle, MatchBranchesResult>;
  topLevelMarks: MTopLevelMark[];
  lastUnifyFailure: UnifyFailure | null;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
  layer1Diagnostics: ConstraintDiagnostic[];
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
  typeExprMarks: Map<NodeId, MTypeExpr>;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
  nodeTypeById: Map<NodeId, Type>;
  marksVersion: number;
  layer1Diagnostics: ConstraintDiagnostic[];
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
    annotationTypes: new Map(),
    matchResults: new Map(),
    topLevelMarks: [],
    lastUnifyFailure: null,
    holes: new Map(),
    constraintStubs: [],
    layer1Diagnostics: [],
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

export interface ErrorRowCoverageStub {
  row: ErrorRowType;
  coveredConstructors: string[];
  coversTail: boolean;
  missingConstructors: string[];
}

export type ConstraintStub =
  | {
      kind: "call";
      origin: NodeId;
      callee: NodeId;
      argument: NodeId;
      result: NodeId;
      resultType: Type;
      index: number;
      argumentValueType?: Type;
      argumentErrorRow?: ErrorRowType;
    }
  | {
      kind: "branch_join";
      origin: NodeId;
      scrutinee: NodeId | null;
      branches: NodeId[];
      dischargesResult?: boolean;
      errorRowCoverage?: ErrorRowCoverageStub;
    }
  | {
      kind: "annotation";
      origin: NodeId;
      annotation: NodeId;
      annotationType?: Type;
      value: NodeId;
      subject: NodeId | null;
    }
  | {
      kind: "has_field";
      origin: NodeId;
      target: NodeId;
      field: string;
      result: NodeId;
      projectedValueType?: Type;
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
  resultType: Type,
  index: number,
  argumentValueType: Type,
  argumentErrorRow?: ErrorRowType,
): void {
  ctx.constraintStubs.push({
    kind: "call",
    origin: origin.id,
    callee: callee.id,
    argument: argument.id,
    result: result.id,
    resultType,
    index,
    argumentValueType: cloneType(argumentValueType),
    argumentErrorRow: argumentErrorRow ? cloneType(argumentErrorRow) as ErrorRowType : undefined,
  });
}

export function recordBranchJoinConstraint(
  ctx: Context,
  origin: Expr,
  branchBodies: Expr[],
  scrutinee?: Expr,
  metadata?: {
    dischargesResult?: boolean;
    errorRowCoverage?: MatchErrorRowCoverage;
  },
): void {
  const coverage = metadata?.errorRowCoverage
    ? {
      row: metadata.errorRowCoverage.errorRow,
      coveredConstructors: Array.from(
        metadata.errorRowCoverage.coveredConstructors,
      ),
      coversTail: metadata.errorRowCoverage.coversTail,
      missingConstructors: metadata.errorRowCoverage.missingConstructors,
    }
    : undefined;
  ctx.constraintStubs.push({
    kind: "branch_join",
    origin: origin.id,
    scrutinee: scrutinee?.id ?? null,
    branches: branchBodies.map((body) => body.id),
    dischargesResult: metadata?.dischargesResult ?? false,
    errorRowCoverage: coverage,
  });
}

export function recordAnnotationConstraint(
  ctx: Context,
  origin: NodeId,
  annotation: TypeExpr,
  value: Expr,
  subject?: Expr,
): void {
  const resolvedAnnotationType = ctx.annotationTypes.get(annotation.id);
  ctx.constraintStubs.push({
    kind: "annotation",
    origin,
    annotation: annotation.id,
    annotationType: resolvedAnnotationType
      ? cloneType(resolvedAnnotationType)
      : undefined,
    value: value.id,
    subject: subject?.id ?? null,
  });
}

export function recordHasFieldConstraint(
  ctx: Context,
  origin: Expr,
  target: Expr,
  field: string,
  result: Expr,
  projectedValueType?: Type,
): void {
  ctx.constraintStubs.push({
    kind: "has_field",
    origin: origin.id,
    target: target.id,
    field,
    result: result.id,
    projectedValueType: projectedValueType
      ? cloneType(projectedValueType)
      : undefined,
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
    case "expr_hole":
    case "user_hole":
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

  if (
    type.provenance.kind === "incomplete" &&
    typeof (type.provenance as any).nodeId !== "number"
  ) {
    (type.provenance as any).nodeId = origin.nodeId;
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
  
  // Gradual typing: unknown types can be functions
  // Create fresh unknowns for parameter and return types
  if (resolved.kind === "unknown") {
    const fromType = createFreshUnknown(ctx);
    const toType = createFreshUnknown(ctx);
    return { success: true, from: fromType, to: toType };
  }
  
  if (resolved.kind !== "func") {
    return { success: false, type: resolved };
  }
  return { success: true, from: resolved.from, to: resolved.to };
}

export function literalType(literal: Literal): Type {
  switch (literal.kind) {
    case "int":
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

function recordLayer1Diagnostic(
  ctx: Context,
  origin: NodeId,
  reason: ConstraintDiagnosticReason,
  details?: Record<string, unknown>,
): void {
  ctx.layer1Diagnostics.push({ origin, reason, details });
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
  recordLayer1Diagnostic(ctx, expr.id, "free_variable", { name });
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
  
  // If the callee is already an incomplete unknown (e.g., JS import),
  // preserve that provenance instead of wrapping it in error_not_function
  let resultType: Type;
  if (calleeType.kind === "unknown" && calleeType.provenance.kind === "incomplete") {
    const provenance = { ...calleeType.provenance } as Record<string, unknown>;
    delete provenance.nodeId;
    resultType = createUnknownAndRegister(
      ctx,
      origin,
      provenance as Provenance,
      "incomplete",
      [callee.id],
    );
  } else {
    resultType = createUnknownAndRegister(ctx, origin, {
      kind: "error_not_function",
      calleeType,
    });
  }
  
  const mark: MMarkNotFunction = {
    kind: "mark_not_function",
    span: expr.span,
    id: expr.id,
    type: resultType,
    callee,
    args,
    calleeType,
  };
  ctx.marks.set(expr, mark);
  
  // Only record a diagnostic if it's actually an error (not just incomplete type info)
  // For unknowns (JS imports, explicit holes), this is expected gradual typing behavior
  if (!(calleeType.kind === "unknown" && 
        (calleeType.provenance.kind === "incomplete" || 
         calleeType.provenance.kind === "expr_hole" ||
         calleeType.provenance.kind === "user_hole"))) {
    recordLayer1Diagnostic(ctx, expr.id, "not_function", { calleeType });
  }
  
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
  recordLayer1Diagnostic(ctx, expr.id, "occurs_cycle", { left: resolvedLeft, right: resolvedRight });
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
  
  // Only record diagnostic if this is a real type error, not gradual typing
  // Unknowns (holes, JS imports) are allowed to mismatch - Layer 2 will handle conflicts
  const isGradualTyping = 
    (expected.kind === "unknown" && 
     (expected.provenance.kind === "incomplete" || 
      expected.provenance.kind === "expr_hole" ||
      expected.provenance.kind === "user_hole")) ||
    (actual.kind === "unknown" && 
     (actual.provenance.kind === "incomplete" || 
      actual.provenance.kind === "expr_hole" ||
      actual.provenance.kind === "user_hole"));
  
  if (!isGradualTyping) {
    recordLayer1Diagnostic(ctx, expr.id, "type_mismatch", { expected, actual });
  }
  
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
  recordLayer1Diagnostic(ctx, expr.id, "unsupported_expr", { exprKind });
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
  recordLayer1Diagnostic(ctx, decl.id, "type_decl_duplicate", {
    name: decl.name,
  });
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
  const details: Record<string, unknown> = { memberKind: member.kind };
  if ("name" in member) {
    details.memberName = (member as { name: string }).name;
  }
  recordLayer1Diagnostic(ctx, decl.id, "type_decl_invalid_member", details);
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
  recordLayer1Diagnostic(ctx, mark.id, "internal_error", { reason });
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
  recordLayer1Diagnostic(ctx, typeExpr.id, "type_expr_unknown", { reason });
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
  recordLayer1Diagnostic(ctx, typeExpr.id, "type_expr_arity", {
    expected,
    actual,
    typeExprKind: typeExpr.kind,
  });
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
  recordLayer1Diagnostic(ctx, expr.id, "non_exhaustive_match", {
    missingCases,
    scrutineeSpan,
  });
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
  recordLayer1Diagnostic(ctx, typeExpr.id, "type_expr_unsupported", {
    typeExprKind: typeExpr.kind,
  });
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

  if (left.kind === "error_row" && right.kind === "error_row") {
    return unifyErrorRowTypes(left, right, subst);
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

function unifyErrorRowTypes(
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
