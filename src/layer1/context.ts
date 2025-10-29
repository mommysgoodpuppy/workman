import type { Expr, Literal, MatchBundle, SourceSpan } from "../ast.ts";
import type {
  MExpr,
  MMarkFreeVar,
  MMarkInconsistent,
  MMarkNotFunction,
  MMarkUnsupportedExpr,
  MProgram,
} from "../ast_marked.ts";
import type { MatchBranchesResult } from "../infermatch.ts";
import {
  applySubstitution,
  applySubstitutionScheme,
  cloneTypeInfo,
  cloneTypeScheme,
  composeSubstitution,
  generalize,
  instantiate,
  occursInType,
  resetTypeVarCounter,
  typeToString,
  unknownType,
  Substitution,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
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
  nodeTypes: Map<Expr, Type>;
  matchResults: Map<MatchBundle, MatchBranchesResult>;
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
}

export function createContext(options: InferOptions = {}): Context {
  if (options.resetCounter !== false) {
    resetTypeVarCounter();
  }
  return {
    env: options.initialEnv ? cloneTypeEnv(options.initialEnv) : new Map(),
    adtEnv: options.initialAdtEnv ? cloneAdtEnv(options.initialAdtEnv) : new Map(),
    subst: new Map(),
    source: options.source,
    allBindings: new Map(),
    nonGeneralizable: new Set(),
    marks: new Map(),
    nodeTypes: new Map(),
    matchResults: new Map(),
  };
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

export type UnifyResult = { success: true; subst: Substitution } | { success: false; reason: UnifyFailure };

export function lookupEnv(ctx: Context, name: string): TypeScheme | null {
  return ctx.env.get(name) ?? null;
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
  const filtered = scheme.quantifiers.filter((id) => !ctx.nonGeneralizable.has(id));
  ctx.nonGeneralizable.clear();
  if (filtered.length === scheme.quantifiers.length) {
    return scheme;
  }
  return {
    quantifiers: filtered,
    type: scheme.type,
  };
}

export function expectFunctionType(ctx: Context, type: Type, description: string): { from: Type; to: Type } {
  const resolved = applyCurrentSubst(ctx, type);
  if (resolved.kind !== "func") {
    throw inferError(`${description} is not fully applied`);
  }
  return resolved;
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
      return unknownType({ kind: 'incomplete', reason: 'literal.unsupported' });
  }
}

export function inferError(message: string, span?: SourceSpan, source?: string): InferError {
  return new InferError(message, span, source);
}

export function markFreeVariable(
  ctx: Context,
  expr: Expr,
  name: string,
): MMarkFreeVar {
  const mark: MMarkFreeVar = {
    kind: "mark_free_var",
    span: expr.span,
    type: unknownType({ kind: "error_free_var", name }),
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
  const mark: MMarkNotFunction = {
    kind: "mark_not_function",
    span: expr.span,
    type: unknownType({ kind: "error_not_function", calleeType }),
    callee,
    args,
    calleeType,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markUnsupportedExpr(
  ctx: Context,
  expr: Expr,
  exprKind: string,
): MMarkUnsupportedExpr {
  const mark: MMarkUnsupportedExpr = {
    kind: "mark_unsupported_expr",
    span: expr.span,
    type: unknownType({ kind: "incomplete", reason: "expr.unsupported" }),
    exprKind,
  };
  ctx.marks.set(expr, mark);
  return mark;
}

export function markNonExhaustive(
  ctx: Context,
  expr: Expr,
  scrutineeSpan: SourceSpan,
  missingCases: string[],
): MMarkPattern {
  const mark: MMarkPattern = {
    kind: "mark_pattern",
    span: expr.span,
    reason: "non_exhaustive",
    data: { missingCases, scrutineeSpan },
    type: unknownType({ kind: "incomplete", reason: "non_exhaustive" }),
  };
  ctx.marks.set(expr, mark);
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
      reason: { kind: "occurs_check", left: { kind: "var", id }, right: resolved },
    };
  }
  const next = new Map(subst);
  next.set(id, resolved);
  return { success: true, subst: next };
}
