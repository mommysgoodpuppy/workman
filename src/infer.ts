import {
  Expr,
  LetDeclaration,
  Pattern,
  Program,
  TypeDeclaration,
  TypeExpr,
  Literal,
} from "./ast.ts";
import {
  ConstructorInfo,
  Substitution,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
  applySubstitution,
  applySubstitutionScheme,
  composeSubstitution,
  freshTypeVar,
  generalize,
  instantiate,
  occursInType,
  resetTypeVarCounter,
} from "./types.ts";

export class InferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferError";
  }
}

export interface InferResult {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  summaries: { name: string; scheme: TypeScheme }[];
}

interface Context {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  subst: Substitution;
}

export function inferProgram(program: Program): InferResult {
  resetTypeVarCounter();
  const env: TypeEnv = new Map();
  const adtEnv: TypeEnvADT = new Map();
  const ctx: Context = { env, adtEnv, subst: new Map() };
  const summaries: { name: string; scheme: TypeScheme }[] = [];

  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeDeclaration(ctx, decl);
    }
  }

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const scheme = inferLetDeclaration(ctx, decl);
      summaries.push({ name: decl.name, scheme: applySubstitutionScheme(scheme, ctx.subst) });
    }
  }

  const finalEnv: TypeEnv = new Map();
  for (const [name, scheme] of ctx.env.entries()) {
    finalEnv.set(name, applySubstitutionScheme(scheme, ctx.subst));
  }

  return { env: finalEnv, adtEnv: ctx.adtEnv, summaries };
}

function registerTypeDeclaration(ctx: Context, decl: TypeDeclaration) {
  const parameterTypes = decl.parameters.map(() => freshTypeVar());
  const typeScope = new Map<string, Type>();
  decl.parameters.forEach((param, index) => {
    typeScope.set(param, parameterTypes[index]);
  });

  const constructors: ConstructorInfo[] = [];
  for (const ctor of decl.constructors) {
    const ctorResult = makeDataConstructor(decl.name, parameterTypes);
    const ctorType = ctor.args.reduceRight<Type>((acc, arg) => {
      const argType = convertTypeExpr(ctx, arg, new Map(typeScope));
      return { kind: "func", from: argType, to: acc };
    }, ctorResult);
    const quantifiers = parameterTypes
      .map((type) => (type.kind === "var" ? type.id : null))
      .filter((id): id is number => id !== null);
    const scheme: TypeScheme = {
      quantifiers,
      type: ctorType,
    };
    const info: ConstructorInfo = {
      name: ctor.name,
      arity: ctor.args.length,
      scheme,
    };
    constructors.push(info);
    ctx.env.set(ctor.name, scheme);
  }

  ctx.adtEnv.set(decl.name, {
    name: decl.name,
    parameters: parameterTypes
      .map((type) => (type.kind === "var" ? type.id : -1))
      .filter((id) => id >= 0),
    constructors,
  });
}

function inferLetDeclaration(ctx: Context, decl: LetDeclaration): TypeScheme {
  const inferredType = inferExpr(ctx, decl.value);

  if (decl.annotation) {
    const annotated = convertTypeExpr(ctx, decl.annotation);
    unify(ctx, inferredType, annotated);
  }

  const scheme = generalizeInContext(ctx, inferredType);
  ctx.env.set(decl.name, scheme);
  return scheme;
}

function inferExpr(ctx: Context, expr: Expr): Type {
  switch (expr.kind) {
    case "var": {
      const scheme = lookupEnv(ctx, expr.name);
      return instantiateAndApply(ctx, scheme);
    }
    case "constructor": {
      const scheme = lookupEnv(ctx, expr.name);
      const ctorType = instantiateAndApply(ctx, scheme);
      if (expr.args.length === 0) {
        return ctorType;
      }
      let result = ctorType;
      for (const arg of expr.args) {
        const argType = inferExpr(ctx, arg);
        const fnType = expectFunctionType(ctx, result, `Constructor ${expr.name}`);
        unify(ctx, fnType.from, argType);
        result = fnType.to;
      }
      return applyCurrentSubst(ctx, result);
    }
    case "literal":
      return literalType(expr.literal);
    case "tuple": {
      const elements = expr.elements.map((el) => inferExpr(ctx, el));
      return applyCurrentSubst(ctx, {
        kind: "tuple",
        elements: elements.map((t) => applyCurrentSubst(ctx, t)),
      });
    }
    case "lambda": {
      const paramType = freshTypeVar();
      const previousEnv = ctx.env;
      ctx.env = new Map(ctx.env);
      ctx.env.set(expr.param, { quantifiers: [], type: paramType });
      const bodyType = inferExpr(ctx, expr.body);
      const funcType: Type = {
        kind: "func",
        from: applyCurrentSubst(ctx, paramType),
        to: applyCurrentSubst(ctx, bodyType),
      };
      ctx.env = previousEnv;
      return funcType;
    }
    case "apply": {
      const fnType = inferExpr(ctx, expr.fn);
      const argType = inferExpr(ctx, expr.argument);
      const resultType = freshTypeVar();
      unify(ctx, fnType, { kind: "func", from: argType, to: resultType });
      return applyCurrentSubst(ctx, resultType);
    }
    case "let": {
      const valueType = inferExpr(ctx, expr.value);
      const scheme = generalizeInContext(ctx, valueType);
      const previousEnv = ctx.env;
      ctx.env = new Map(ctx.env);
      ctx.env.set(expr.name, scheme);
      const bodyType = inferExpr(ctx, expr.body);
      ctx.env = previousEnv;
      return applyCurrentSubst(ctx, bodyType);
    }
    case "match": {
      return inferMatchExpression(ctx, expr);
    }
    default:
      throw new InferError(`Unsupported expression kind ${(expr as Expr).kind}`);
  }
}

function convertTypeExpr(
  ctx: Context,
  typeExpr: TypeExpr,
  scope: Map<string, Type> = new Map(),
): Type {
  switch (typeExpr.kind) {
    case "var": {
      const existing = scope.get(typeExpr.name);
      if (existing) return existing;
      const fresh = freshTypeVar();
      scope.set(typeExpr.name, fresh);
      return fresh;
    }
    case "func":
      return {
        kind: "func",
        from: convertTypeExpr(ctx, typeExpr.from, scope),
        to: convertTypeExpr(ctx, typeExpr.to, scope),
      };
    case "constructor": {
      if (typeExpr.args.length === 0) {
        switch (typeExpr.name) {
          case "Int":
            return { kind: "int" };
          case "Bool":
            return { kind: "bool" };
          case "Unit":
            return { kind: "unit" };
        }
      }
      const args = typeExpr.args.map((arg) => convertTypeExpr(ctx, arg, new Map(scope)));
      if (!ctx.adtEnv.has(typeExpr.name)) {
        throw new InferError(`Unknown type constructor '${typeExpr.name}'`);
      }
      return {
        kind: "constructor",
        name: typeExpr.name,
        args,
      };
    }
    case "tuple":
      return {
        kind: "tuple",
        elements: typeExpr.elements.map((el) => convertTypeExpr(ctx, el, scope)),
      };
    case "unit":
      return { kind: "unit" };
    default:
      throw new InferError("Unsupported type expression");
  }
}

function makeDataConstructor(name: string, parameters: Type[]): Type {
  return {
    kind: "constructor",
    name,
    args: parameters,
  };
}

export function unify(ctx: Context, a: Type, b: Type) {
  const updated = unifyTypes(a, b, ctx.subst);
  ctx.subst = composeSubstitution(updated, ctx.subst);
}

function applyCurrentSubst(ctx: Context, type: Type): Type {
  return applySubstitution(type, ctx.subst);
}

function lookupEnv(ctx: Context, name: string): TypeScheme {
  const scheme = ctx.env.get(name);
  if (!scheme) {
    throw new InferError(`Unknown identifier '${name}'`);
  }
  return scheme;
}

function instantiateAndApply(ctx: Context, scheme: TypeScheme): Type {
  const type = instantiate(scheme);
  return applyCurrentSubst(ctx, type);
}

function literalType(literal: Literal): Type {
  switch (literal.kind) {
    case "int":
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "unit":
      return { kind: "unit" };
    default:
      throw new InferError("Unsupported literal");
  }
}

function expectFunctionType(ctx: Context, type: Type, description: string): {
  from: Type;
  to: Type;
} {
  const resolved = applyCurrentSubst(ctx, type);
  if (resolved.kind !== "func") {
    throw new InferError(`${description} is not fully applied`);
  }
  return resolved;
}

function inferMatchExpression(ctx: Context, expr: Expr & { kind: "match" }): Type {
  const scrutineeType = inferExpr(ctx, expr.value);
  const resolvedScrutinee = applyCurrentSubst(ctx, scrutineeType);

  let resultType: Type | null = null;
  const coverageMap = new Map<string, Set<string>>();
  let hasWildcard = false;

  for (const matchCase of expr.cases) {
    const patternInfo = inferPattern(ctx, matchCase.pattern, resolvedScrutinee);
    if (patternInfo.coverage.kind === "wildcard") {
      hasWildcard = true;
    } else if (patternInfo.coverage.kind === "constructor") {
      const key = patternInfo.coverage.typeName;
      const set = coverageMap.get(key) ?? new Set<string>();
      set.add(patternInfo.coverage.ctor);
      coverageMap.set(key, set);
    }

    const previousEnv = ctx.env;
    ctx.env = new Map(ctx.env);
    for (const [name, type] of patternInfo.bindings.entries()) {
      ctx.env.set(name, { quantifiers: [], type: applyCurrentSubst(ctx, type) });
    }
    const bodyType = inferExpr(ctx, matchCase.body);
    ctx.env = previousEnv;

    if (!resultType) {
      resultType = bodyType;
    } else {
      unify(ctx, resultType, bodyType);
      resultType = applyCurrentSubst(ctx, resultType);
    }
  }

  const finalScrutinee = applyCurrentSubst(ctx, resolvedScrutinee);
  ensureExhaustive(ctx, finalScrutinee, hasWildcard, coverageMap);

  return resultType ? applyCurrentSubst(ctx, resultType) : freshTypeVar();
}

type PatternCoverage =
  | { kind: "wildcard" }
  | { kind: "constructor"; typeName: string; ctor: string }
  | { kind: "none" };

interface PatternInfo {
  type: Type;
  bindings: Map<string, Type>;
  coverage: PatternCoverage;
}

function inferPattern(ctx: Context, pattern: Pattern, expected: Type): PatternInfo {
  switch (pattern.kind) {
    case "wildcard": {
      const target = applyCurrentSubst(ctx, expected);
      return { type: target, bindings: new Map(), coverage: { kind: "wildcard" } };
    }
    case "variable": {
      const target = applyCurrentSubst(ctx, expected);
      const bindings = new Map<string, Type>();
      bindings.set(pattern.name, target);
      return { type: target, bindings, coverage: { kind: "wildcard" } };
    }
    case "literal": {
      const litType = literalType(pattern.literal);
      unify(ctx, expected, litType);
      return {
        type: applyCurrentSubst(ctx, litType),
        bindings: new Map(),
        coverage: { kind: "none" },
      };
    }
    case "tuple": {
      if (expected.kind !== "tuple") {
        unify(ctx, expected, {
          kind: "tuple",
          elements: pattern.elements.map(() => freshTypeVar()),
        });
      }
      const resolved = applyCurrentSubst(ctx, expected);
      if (resolved.kind !== "tuple") {
        throw new InferError("Expected tuple type for tuple pattern");
      }
      if (resolved.elements.length !== pattern.elements.length) {
        throw new InferError("Tuple pattern arity mismatch");
      }
      const bindings = new Map<string, Type>();
      for (let i = 0; i < pattern.elements.length; i++) {
        const subPattern = pattern.elements[i];
        const elementType = resolved.elements[i];
        const info = inferPattern(ctx, subPattern, elementType);
        mergeBindings(bindings, info.bindings);
      }
      return {
        type: resolved,
        bindings,
        coverage: { kind: "none" },
      };
    }
    case "constructor": {
      const scheme = lookupEnv(ctx, pattern.name);
      const ctorType = instantiateAndApply(ctx, scheme);
      let current = ctorType;
      const bindings = new Map<string, Type>();
      for (const argPattern of pattern.args) {
        const fnType = expectFunctionType(ctx, current, `Constructor ${pattern.name}`);
        const info = inferPattern(ctx, argPattern, fnType.from);
        mergeBindings(bindings, info.bindings);
        current = fnType.to;
      }
      unify(ctx, expected, current);
      const final = applyCurrentSubst(ctx, current);
      if (final.kind !== "constructor") {
        throw new InferError(`Constructor pattern '${pattern.name}' does not result in a data type`);
      }
      return {
        type: final,
        bindings,
        coverage: { kind: "constructor", typeName: final.name, ctor: pattern.name },
      };
    }
    default:
      throw new InferError("Unsupported pattern kind");
  }
}

function mergeBindings(target: Map<string, Type>, source: Map<string, Type>) {
  for (const [name, type] of source.entries()) {
    if (target.has(name)) {
      throw new InferError(`Duplicate variable '${name}' in pattern`);
    }
    target.set(name, type);
  }
}

function ensureExhaustive(
  ctx: Context,
  scrutineeType: Type,
  hasWildcard: boolean,
  coverageMap: Map<string, Set<string>>,
) {
  if (hasWildcard) return;
  const resolved = applyCurrentSubst(ctx, scrutineeType);
  if (resolved.kind !== "constructor") {
    return;
  }
  const info = ctx.adtEnv.get(resolved.name);
  if (!info) return;
  const seenForType = coverageMap.get(resolved.name) ?? new Set();
  const missing = info.constructors
    .map((ctor) => ctor.name)
    .filter((name) => !seenForType.has(name));
  if (missing.length > 0) {
    throw new InferError(`Non-exhaustive patterns, missing: ${missing.join(", ")}`);
  }
}

function generalizeInContext(ctx: Context, type: Type): TypeScheme {
  const appliedType = applyCurrentSubst(ctx, type);
  const appliedEnv: TypeEnv = new Map();
  for (const [name, scheme] of ctx.env.entries()) {
    appliedEnv.set(name, applySubstitutionScheme(scheme, ctx.subst));
  }
  return generalize(appliedType, appliedEnv);
}

function unifyTypes(a: Type, b: Type, subst: Substitution): Substitution {
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
    return unifyTypes(left.to, right.to, subst1);
  }

  if (left.kind === "constructor" && right.kind === "constructor") {
    if (left.name !== right.name || left.args.length !== right.args.length) {
      throw new InferError(`Cannot unify constructors ${left.name} and ${right.name}`);
    }
    let current = subst;
    for (let i = 0; i < left.args.length; i++) {
      current = unifyTypes(left.args[i], right.args[i], current);
    }
    return current;
  }

  if (left.kind === "tuple" && right.kind === "tuple") {
    if (left.elements.length !== right.elements.length) {
      throw new InferError("Cannot unify tuples of different length");
    }
    let current = subst;
    for (let i = 0; i < left.elements.length; i++) {
      current = unifyTypes(left.elements[i], right.elements[i], current);
    }
    return current;
  }

  if (left.kind === right.kind) {
    return subst;
  }

  throw new InferError("Type mismatch");
}

function bindVar(id: number, type: Type, subst: Substitution): Substitution {
  const resolved = applySubstitution(type, subst);
  if (resolved.kind === "var" && resolved.id === id) {
    return subst;
  }
  if (occursInType(id, resolved)) {
    throw new InferError("Occurs check failed");
  }
  const next = new Map(subst);
  next.set(id, resolved);
  return next;
}
