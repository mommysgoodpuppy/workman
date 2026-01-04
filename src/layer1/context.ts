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
import { InfectionRegistry } from "../infection_registry.ts";
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
  MTypeEffectRowExpr,
  MTypeExpr,
} from "../ast_marked.ts";
import {
  applySubstitution,
  applySubstitutionScheme,
  cloneType,
  cloneTypeInfo,
  cloneTypeScheme,
  composeSubstitution,
  type ConstraintLabel,
  type EffectRowType,
  effectRowUnion,
  ensureRow,
  generalize,
  getProvenance,
  type Identity,
  instantiate,
  isHoleType,
  occursInType,
  type Provenance,
  resetTypeVarCounter,
  splitCarrier,
  type Substitution,
  type Type,
  type TypeEnv,
  type TypeEnvADT,
  type TypeScheme,
  type typeToString,
  unknownType,
} from "../types.ts";
import { InferError } from "../error.ts";
import type {
  ConstraintDiagnostic,
  ConstraintDiagnosticReason,
} from "../diagnostics.ts";
import type {
  MatchBranchesResult,
  MatchEffectRowCoverage,
} from "./infer_types.ts";
import type {
  HoleId,
  HoleOrigin,
  HoleOriginKind,
  UnknownCategory,
} from "./context_types.ts";
/* export type { HoleId, HoleOrigin, HoleOriginKind, UnknownCategory }; */

export interface Context {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  subst: Substitution;
  source?: string;
  rawMode?: boolean;
  allBindings: Map<string, TypeScheme>;
  nonGeneralizable: Set<number>;
  marks: Map<Expr, MExpr>;
  typeExprMarks: Map<TypeExpr, MTypeExpr>;
  nodeTypes: Map<NodeId, Type>;
  annotationTypes: Map<NodeId, Type>;
  matchResults: Map<MatchBundle, MatchBranchesResult>;
  topLevelMarks: MTopLevelMark[];
  lastUnifyFailure: UnifyFailure | null;
  holes: Map<HoleId, UnknownInfo>;
  constraintStubs: ConstraintStub[];
  layer1Diagnostics: ConstraintDiagnostic[];
  infectionRegistry: InfectionRegistry;
  identityBindings: Map<string, Map<string, Set<number>>>;
  identityStates: Map<number, Map<string, Map<string, number>>>;
  exprIdentities: Map<NodeId, Map<string, Set<number>>>;
  identityUsage: Map<
    number,
    Map<string, Map<NodeId, { scopeId: number; bindingId: number | null }>>
  >;
  identityCreationScope: Map<number, number>; // identityId -> scopeId where it was created
  variableBindingIds: Map<string, number>; // varName -> current binding ID (increments on shadow)
  nextBindingId: number;
  mutableBindings: Map<string, boolean>; // varName -> is mutable binding
  functionParamEffects: Map<
    string,
    Map<
      number,
      Map<
        string,
        {
          requiresExact: Set<string>;
          requiresAny: Set<string>;
          requiresNot: Set<string>;
          adds: Set<string>;
        }
      >
    >
  >;
  functionParamStack: {
    name: string;
    params: Map<string, number>;
    scopeId: number;
  }[];
  functionScopeCounter: number;
  recordDefaultFields: Map<string, Set<string>>;
}

export interface InferOptions {
  initialEnv?: TypeEnv;
  initialAdtEnv?: TypeEnvADT;
  registerPrelude?: boolean;
  rawMode?: boolean; // Use raw/zig prelude instead of standard prelude
  resetCounter?: boolean;
  source?: string;
  infectionRegistry?: InfectionRegistry;
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
  infectionRegistry: InfectionRegistry;
  recordDefaultExprs: Map<string, Map<string, MExpr>>;
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
    rawMode: options.rawMode,
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
    infectionRegistry: options.infectionRegistry ?? new InfectionRegistry(),
    identityBindings: new Map(),
    identityStates: new Map(),
    exprIdentities: new Map(),
    identityUsage: new Map(),
    identityCreationScope: new Map(),
    variableBindingIds: new Map(),
    nextBindingId: 1,
    mutableBindings: new Map(),
    functionParamEffects: new Map(),
    functionParamStack: [],
    functionScopeCounter: 1,
    recordDefaultFields: new Map(),
  };
}

export interface UnknownInfo {
  id: HoleId;
  provenance: Provenance;
  category: UnknownCategory;
  relatedNodes: NodeId[];
  origin: HoleOrigin;
}

export interface EffectRowCoverageStub {
  row: Type;
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
    }
  | {
      kind: "branch_join";
      origin: NodeId;
      scrutinee: NodeId | null;
      branches: NodeId[];
      dischargesResult?: boolean;
      effectRowCoverage?: EffectRowCoverageStub;
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
    }
  // NEW: Constraint flow primitives (Phase 1: Unified Constraint Model)
  | {
      kind: "constraint_source";
      node: NodeId;
      label: ConstraintLabel;
    }
  | {
      kind: "constraint_flow";
      from: NodeId;
      to: NodeId;
    }
  | {
      kind: "constraint_rewrite";
      node: NodeId;
      remove: ConstraintLabel[];
      add: ConstraintLabel[];
    }
  | {
      kind: "constraint_alias";
      id1: Identity;
      id2: Identity;
    }
  | {
      kind: "require_exact_state";
      node: NodeId;
      domain: string;
      tags: string[];
    }
  | {
      kind: "require_any_state";
      node: NodeId;
      domain: string;
      tags: string[];
    }
  | {
      kind: "require_not_state";
      node: NodeId;
      domain: string;
      tags: string[];
    }
  | {
      kind: "add_state_tags";
      node: NodeId;
      domain: string;
      tags: string[];
    }
  | {
      kind: "require_at_return";
      node: NodeId;
      domain: string;
      tags: string[];
      policy?: string;
    }
  | {
      kind: "call_rejects_infection";
      node: NodeId;
      policy?: string;
    }
  | {
      kind: "call_rejects_domains";
      node: NodeId;
      domains: string[];
      policy?: string;
    };
// NOTE: constraint_merge is NOT needed - branch_join already handles merge semantics

export function recordCallConstraint(
  ctx: Context,
  origin: Expr,
  callee: Expr,
  argument: Expr,
  result: Expr,
  resultType: Type,
  index: number,
  argumentValueType: Type,
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
  });
}

export function recordBranchJoinConstraint(
  ctx: Context,
  origin: Expr,
  branchBodies: Expr[],
  scrutinee?: Expr,
  metadata?: {
    dischargesResult?: boolean;
    effectRowCoverage?: MatchEffectRowCoverage;
  },
): void {
  const coverage = metadata?.effectRowCoverage!
    ? {
        row: metadata.effectRowCoverage.effectRow,
        coveredConstructors: Array.from(
          metadata.effectRowCoverage.coveredConstructors,
        ),
        coversTail: metadata.effectRowCoverage.coversTail,
        missingConstructors: metadata.effectRowCoverage.missingConstructors,
      }
    : undefined;
  ctx.constraintStubs.push({
    kind: "branch_join",
    origin: origin.id,
    scrutinee: scrutinee?.id ?? null,
    branches: branchBodies.map((body) => body.id),
    dischargesResult: metadata?.dischargesResult ?? false,
    effectRowCoverage: coverage,
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

// ============================================================================
// Constraint Flow Emit Functions (Phase 1: Unified Constraint Model)
// ============================================================================

export function emitConstraintSource(
  ctx: Context,
  node: NodeId,
  label: ConstraintLabel,
): void {
  ctx.constraintStubs.push({
    kind: "constraint_source",
    node,
    label,
  });
}

export function emitConstraintFlow(
  ctx: Context,
  from: NodeId,
  to: NodeId,
): void {
  ctx.constraintStubs.push({
    kind: "constraint_flow",
    from,
    to,
  });
}

export function emitConstraintRewrite(
  ctx: Context,
  node: NodeId,
  remove: ConstraintLabel[],
  add: ConstraintLabel[],
): void {
  ctx.constraintStubs.push({
    kind: "constraint_rewrite",
    node,
    remove,
    add,
  });
}

export function emitConstraintAlias(
  ctx: Context,
  id1: Identity,
  id2: Identity,
): void {
  ctx.constraintStubs.push({
    kind: "constraint_alias",
    id1,
    id2,
  });
}

export function emitRequireExactState(
  ctx: Context,
  node: NodeId,
  domain: string,
  tags: string[],
): void {
  ctx.constraintStubs.push({
    kind: "require_exact_state",
    node,
    domain,
    tags: [...tags],
  });
}

export function emitRequireAnyState(
  ctx: Context,
  node: NodeId,
  domain: string,
  tags: string[],
): void {
  ctx.constraintStubs.push({
    kind: "require_any_state",
    node,
    domain,
    tags: [...tags],
  });
}

export function emitRequireNotState(
  ctx: Context,
  node: NodeId,
  domain: string,
  tags: string[],
): void {
  ctx.constraintStubs.push({
    kind: "require_not_state",
    node,
    domain,
    tags: [...tags],
  });
}

export function emitAddStateTags(
  ctx: Context,
  node: NodeId,
  domain: string,
  tags: string[],
): void {
  ctx.constraintStubs.push({
    kind: "add_state_tags",
    node,
    domain,
    tags: [...tags],
  });
}

export function emitRequireAtReturn(
  ctx: Context,
  node: NodeId,
  domain: string,
  tags: string[],
  policy?: string,
): void {
  ctx.constraintStubs.push({
    kind: "require_at_return",
    node,
    domain,
    tags: [...tags],
    policy,
  });
}

export function emitCallRejectsInfection(
  ctx: Context,
  node: NodeId,
  policy?: string,
): void {
  ctx.constraintStubs.push({
    kind: "call_rejects_infection",
    node,
    policy,
  });
}

export function emitCallRejectsDomains(
  ctx: Context,
  node: NodeId,
  domains: string[],
  policy?: string,
): void {
  if (domains.length === 0) return;
  ctx.constraintStubs.push({
    kind: "call_rejects_domains",
    node,
    domains: [...domains],
    policy,
  });
}

// ============================================================================
// End of Constraint Flow Emit Functions
// ============================================================================

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
  if (!isHoleType(type)) {
    if (ctx.holes.has(origin.nodeId)) {
      ctx.holes.delete(origin.nodeId);
    }
    return;
  }

  const provenance = getProvenance(type);
  if (!provenance) return;

  if (
    provenance.kind === "incomplete" &&
    typeof (provenance as Record<string, unknown>).nodeId !== "number"
  ) {
    (provenance as Record<string, unknown>).nodeId = origin.nodeId;
  }

  const resolvedCategory = category ?? categoryFromProvenance(provenance);
  ctx.holes.set(origin.nodeId, {
    id: origin.nodeId,
    provenance: provenance,
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

function cloneIdentityBindings(
  source: Map<string, Map<string, Set<number>>>,
): Map<string, Map<string, Set<number>>> {
  const clone = new Map<string, Map<string, Set<number>>>();
  for (const [name, byDomain] of source.entries()) {
    const domainClone = new Map<string, Set<number>>();
    for (const [domain, ids] of byDomain.entries()) {
      domainClone.set(domain, new Set(ids));
    }
    clone.set(name, domainClone);
  }
  return clone;
}

export function withScopedEnv<T>(ctx: Context, fn: () => T): T {
  const previous = ctx.env;
  const previousIdentities = ctx.identityBindings;
  const previousMutable = ctx.mutableBindings;
  ctx.env = new Map(ctx.env);
  ctx.identityBindings = cloneIdentityBindings(ctx.identityBindings);
  ctx.mutableBindings = new Map(ctx.mutableBindings);
  try {
    return fn();
  } finally {
    ctx.env = previous;
    ctx.identityBindings = previousIdentities;
    ctx.mutableBindings = previousMutable;
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

export type UnifyResult =
  | { success: true; subst: Substitution }
  | {
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
  const filtered = scheme.quantifiers.filter(
    (id) => !ctx.nonGeneralizable.has(id),
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

export type ExpectFunctionResult =
  | { success: true; from: Type; to: Type }
  | {
      success: false;
      type: Type;
    };

export function expectFunctionType(
  ctx: Context,
  type: Type,
  description: string,
): ExpectFunctionResult {
  const resolved = applyCurrentSubst(ctx, type);

  // Gradual typing: hole types can be treated as functions
  // Create fresh holes for parameter and return types
  if (isHoleType(resolved)) {
    const fromType = unknownType({
      kind: "incomplete",
      reason: "function_param",
    });
    const toType = unknownType({
      kind: "incomplete",
      reason: "function_return",
    });
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

export function recordLayer1Diagnostic(
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
    type: createUnknownAndRegister(
      ctx,
      origin,
      {
        kind: "error_free_var",
        name,
      },
      "free",
    ),
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

  // If the callee is already an incomplete hole (e.g., JS import),
  // preserve that provenance instead of wrapping it in error_not_function
  let resultType: Type;
  const calleeProvenance = getProvenance(calleeType);
  if (isHoleType(calleeType) && calleeProvenance?.kind === "incomplete") {
    const provenance = { ...calleeProvenance } as Record<string, unknown>;
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
  // For holes (JS imports, explicit holes), this is expected gradual typing behavior
  const calleeProvenance2 = getProvenance(calleeType);
  if (
    !(
      isHoleType(calleeType) &&
      (calleeProvenance2?.kind === "incomplete" ||
        calleeProvenance2?.kind === "expr_hole" ||
        calleeProvenance2?.kind === "user_hole")
    )
  ) {
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
  recordLayer1Diagnostic(ctx, expr.id, "occurs_cycle", {
    left: resolvedLeft,
    right: resolvedRight,
  });
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
  // Holes (holes, JS imports) are allowed to mismatch - Layer 2 will handle conflicts
  const expectedProvenance = getProvenance(expected);
  const actualProvenance = getProvenance(actual);
  const isGradualTyping =
    (isHoleType(expected) &&
      (expectedProvenance?.kind === "incomplete" ||
        expectedProvenance?.kind === "expr_hole" ||
        expectedProvenance?.kind === "user_hole")) ||
    (isHoleType(actual) &&
      (actualProvenance?.kind === "incomplete" ||
        actualProvenance?.kind === "expr_hole" ||
        actualProvenance?.kind === "user_hole"));

  if (!isGradualTyping) {
    recordLayer1Diagnostic(ctx, expr.id, "type_mismatch", { expected, actual });
  }

  return mark;
}

// treated as fatal
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
    type: createUnknownAndRegister(
      ctx,
      origin,
      {
        kind: "incomplete",
        reason: "expr.unsupported",
      },
      "incomplete",
    ),
    exprKind,
  };
  ctx.marks.set(expr, mark);
  recordLayer1Diagnostic(ctx, expr.id, "unsupported_expr", { exprKind });
  return mark;
}

export function markTypeDeclDuplicate(
  ctx: Context,
  decl: TypeDeclaration | import("../ast.ts").RecordDeclaration,
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
  decl: TypeDeclaration | import("../ast.ts").RecordDeclaration,
  member: TypeDeclaration["members"][0] | import("../ast.ts").RecordMember,
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

function coerceToEffectRow(state: Type): EffectRowType | null {
  if (state.kind === "effect_row") {
    return state;
  }
  if (state.kind === "var") {
    return null;
  }
  return ensureRow(state);
}

export function markNonExhaustive(
  ctx: Context,
  expr: Expr,
  scrutineeSpan: SourceSpan,
  missingCases: string[],
  scrutineeType?: Type,
  hint?: string,
): MMarkUnsupportedExpr {
  const origin = holeOriginFromExpr(expr);
  const mark: MMarkUnsupportedExpr = {
    kind: "mark_unsupported_expr",
    span: expr.span,
    id: expr.id,
    type: createUnknownAndRegister(
      ctx,
      origin,
      {
        kind: "incomplete",
        reason: "match.non_exhaustive",
      },
      "incomplete",
    ),
    exprKind: "match_non_exhaustive",
  };
  // Don't replace the match expression with a mark - just record the diagnostic
  // This allows the match to continue through the pipeline and be compiled
  // ctx.marks.set(expr, mark);
  recordLayer1Diagnostic(ctx, expr.id, "non_exhaustive_match", {
    missingCases,
    scrutineeSpan,
    scrutineeType,
    hint,
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

function unifyTypes(
  a: Type,
  b: Type,
  subst: Substitution,
  adtEnv: Map<string, import("../types.ts").TypeInfo>,
): UnifyResult {
  const left = applySubstitution(a, subst);
  const right = applySubstitution(b, subst);

  if (isHoleType(left) || isHoleType(right)) {
    return { success: true, subst };
  }

  if (left.kind === "var") {
    return bindVar(left.id, right, subst);
  }
  if (right.kind === "var") {
    return bindVar(right.id, left, subst);
  }

  if (left.kind === "func" && right.kind === "func") {
    const subst1 = unifyTypes(left.from, right.from, subst, adtEnv);
    if (!subst1.success) return subst1;
    return unifyTypes(left.to, right.to, subst1.subst, adtEnv);
  }

  if (left.kind === "constructor" && right.kind === "constructor") {
    // Special case: Check if both are carriers in the same domain
    // If so, unify their value and state components instead of requiring exact name match
    const leftCarrier = splitCarrier(left);
    const rightCarrier = splitCarrier(right);

    if (
      leftCarrier &&
      rightCarrier &&
      leftCarrier.domain === rightCarrier.domain
    ) {
      // Both are carriers in the same domain - unify value and state
      const valueUnify = unifyTypes(
        leftCarrier.value,
        rightCarrier.value,
        subst,
        adtEnv,
      );
      if (!valueUnify.success) return valueUnify;
      if (leftCarrier.domain === "effect") {
        const leftStateRow = coerceToEffectRow(leftCarrier.state);
        const rightStateRow = coerceToEffectRow(rightCarrier.state);
        if (leftStateRow && rightStateRow) {
          return unifyEffectRowTypes(
            leftStateRow,
            rightStateRow,
            valueUnify.subst,
            adtEnv,
          );
        }
      }
      return unifyTypes(
        leftCarrier.state,
        rightCarrier.state,
        valueUnify.subst,
        adtEnv,
      );
    }

    if (left.name === right.name && left.args.length !== right.args.length) {
      const adtInfo = adtEnv.get(left.name);
      const recordArity = adtInfo?.recordFields?.size;
      if (recordArity !== undefined) {
        const leftIsBare = left.args.length === 0;
        const rightIsBare = right.args.length === 0;
        const leftIsRecord = left.args.length === recordArity;
        const rightIsRecord = right.args.length === recordArity;
        if ((leftIsBare && rightIsRecord) || (rightIsBare && leftIsRecord)) {
          return { success: true, subst };
        }
      }
    }

    if (
      left.name !== right.name &&
      areNumericConstructorsCompatible(left.name, right.name)
    ) {
      return { success: true, subst };
    }

    if (left.name !== right.name) {
      const leftInfo = adtEnv.get(left.name);
      if (leftInfo?.alias) {
        return unifyTypes(leftInfo.alias, right, subst, adtEnv);
      }
      const rightInfo = adtEnv.get(right.name);
      if (rightInfo?.alias) {
        return unifyTypes(left, rightInfo.alias, subst, adtEnv);
      }
    }

    // Normal constructor unification - require exact name match
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
      const res = unifyTypes(left.args[i], right.args[i], current, adtEnv);
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
      const res = unifyTypes(
        left.elements[i],
        right.elements[i],
        current,
        adtEnv,
      );
      if (!res.success) return res;
      current = res.subst;
    }
    return { success: true, subst: current };
  }

  if (left.kind === "array" && right.kind === "array") {
    if (left.length !== right.length) {
      return {
        success: false,
        reason: { kind: "type_mismatch", left, right },
      };
    }
    return unifyTypes(left.element, right.element, subst, adtEnv);
  }

  if (left.kind === "record" && right.kind === "record") {
    if (left.fields.size !== right.fields.size) {
      return {
        success: false,
        reason: { kind: "arity_mismatch", left, right },
      };
    }
    let current = subst;
    for (const [field, leftType] of left.fields.entries()) {
      const rightType = right.fields.get(field);
      if (!rightType) {
        return {
          success: false,
          reason: { kind: "type_mismatch", left, right },
        };
      }
      const res = unifyTypes(leftType, rightType, current, adtEnv);
      if (!res.success) {
        return res;
      }
      current = res.subst;
    }
    return { success: true, subst: current };
  }

  if (left.kind === "record" && right.kind === "constructor") {
    const adtInfo = adtEnv.get(right.name);
    if (adtInfo && adtInfo.alias && adtInfo.alias.kind === "record") {
      return unifyTypes(left, adtInfo.alias, subst, adtEnv);
    }
    return {
      success: false,
      reason: { kind: "type_mismatch", left, right },
    };
  }

  if (right.kind === "record" && left.kind === "constructor") {
    const adtInfo = adtEnv.get(left.name);
    if (adtInfo && adtInfo.alias && adtInfo.alias.kind === "record") {
      return unifyTypes(adtInfo.alias, right, subst, adtEnv);
    }
    return {
      success: false,
      reason: { kind: "type_mismatch", left, right },
    };
  }

  if (left.kind === "effect_row" && right.kind === "effect_row") {
    return unifyEffectRowTypes(left, right, subst, adtEnv);
  }

  if (left.kind === right.kind) {
    return { success: true, subst };
  }

  return {
    success: false,
    reason: { kind: "type_mismatch", left, right },
  };
}

export const RAW_NUMERIC_COMPAT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Pointer-sized types
  ["Usize", new Set(["CULongLong", "CULong"])],
  ["CULongLong", new Set(["Usize"])],
  ["CULong", new Set(["Usize"])],
  // 32-bit unsigned types (CUInt is typically 32-bit)
  ["U32", new Set(["CUInt"])],
  ["CUInt", new Set(["U32"])],
  // 32-bit signed types (CInt is typically 32-bit)
  ["I32", new Set(["CInt"])],
  ["CInt", new Set(["I32"])],
  // 16-bit types
  ["U16", new Set(["CUShort"])],
  ["CUShort", new Set(["U16"])],
  ["I16", new Set(["CShort"])],
  ["CShort", new Set(["I16"])],
  // 8-bit types (CChar is typically 8-bit signed)
  ["I8", new Set(["CChar"])],
  ["CChar", new Set(["I8"])],
]);

function areNumericConstructorsCompatible(left: string, right: string): boolean {
  const leftSet = RAW_NUMERIC_COMPAT.get(left);
  return leftSet ? leftSet.has(right) : false;
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

function unifyEffectRowTypes(
  left: EffectRowType,
  right: EffectRowType,
  subst: Substitution,
  adtEnv: Map<string, import("../types.ts").TypeInfo>,
): UnifyResult {
  // Error domain uses UNION semantics, not exact match
  // Per INFECTION_REFACTOR_PLAN_V3.md: "Errors compose via union"

  // Apply current substitution to both sides
  const resolvedLeft = applySubstitution(left, subst) as EffectRowType;
  const resolvedRight = applySubstitution(right, subst) as EffectRowType;

  // If they're structurally equal, we're done
  if (effectRowsEqual(resolvedLeft, resolvedRight)) {
    return { success: true, subst };
  }

  // Check if either is a type variable tail - if so, bind it to the other side
  if (resolvedLeft.cases.size === 0 && resolvedLeft.tail?.kind === "var") {
    // Left is just a type variable - bind it to the right side (not the union!)
    // Binding to the union would create an occurs check failure
    return bindVar(resolvedLeft.tail.id, resolvedRight, subst);
  }

  if (resolvedRight.cases.size === 0 && resolvedRight.tail?.kind === "var") {
    // Right is just a type variable - bind it to the left side (not the union!)
    return bindVar(resolvedRight.tail.id, resolvedLeft, subst);
  }

  // Both have concrete cases - create a fresh type variable and bind it to the union
  // This allows the union to be represented in the type system
  const unionRow = effectRowUnion(resolvedLeft, resolvedRight);

  // If both tails are the same type variable, bind it to the union
  if (
    resolvedLeft.tail?.kind === "var" &&
    resolvedRight.tail?.kind === "var" &&
    resolvedLeft.tail.id === resolvedRight.tail.id
  ) {
    // Same tail variable - the union will have the same tail
    return { success: true, subst };
  }

  // Different tails or one has no tail - try to unify tails
  let current = subst;
  if (resolvedLeft.tail && resolvedRight.tail) {
    const tailUnify = unifyTypes(
      resolvedLeft.tail,
      resolvedRight.tail,
      current,
      adtEnv,
    );
    if (tailUnify.success) {
      current = tailUnify.subst;
    }
  }

  // Error rows always unify - they compose via union
  // The union is implicit - it will be computed when needed
  return { success: true, subst: current };
}

function effectRowsEqual(left: EffectRowType, right: EffectRowType): boolean {
  if (left.cases.size !== right.cases.size) return false;
  for (const [label, leftPayload] of left.cases) {
    const rightPayload = right.cases.get(label);
    if (rightPayload === undefined) return false;
    // Simplified equality check - could be more thorough
    if (leftPayload !== rightPayload) return false;
  }
  // Check tails
  if (left.tail?.kind !== right.tail?.kind) return false;
  if (left.tail?.kind === "var" && right.tail?.kind === "var") {
    return left.tail.id === right.tail.id;
  }
  return true;
}

export function unify(ctx: Context, a: Type, b: Type): boolean {
  const result = unifyTypes(a, b, ctx.subst, ctx.adtEnv);
  if (result.success) {
    ctx.subst = composeSubstitution(ctx.subst, result.subst);
    ctx.lastUnifyFailure = null;
    return true;
  }
  ctx.lastUnifyFailure = result.reason;
  return false;
}
