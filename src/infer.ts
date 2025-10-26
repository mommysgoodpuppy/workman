import {
  BlockExpr,
  BlockStatement,
  ConstructorAlias,
  Expr,
  InfixDeclaration,
  LetDeclaration,
  Literal,
  MatchArm,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  SourceSpan,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import { lowerTupleParameters } from "./lower_tuple_params.ts";
import {
  ConstructorInfo,
  Substitution,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
  applySubstitution,
  applySubstitutionScheme,
  cloneTypeInfo,
  cloneTypeScheme,
  composeSubstitution,
  freeTypeVars,
  freshTypeVar,
  generalize,
  instantiate,
  occursInType,
  resetTypeVarCounter,
} from "./types.ts";
import { formatScheme } from "./type_printer.ts";
import { InferError as InferErrorClass } from "./error.ts";

// Re-export InferError from error module
export { InferError } from "./error.ts";

// Helper to create InferError (for internal use)
function inferError(message: string, span?: SourceSpan, source?: string): InferErrorClass {
  return new InferErrorClass(message, span, source);
}

function cloneTypeEnv(source: TypeEnv): TypeEnv {
  const clone: TypeEnv = new Map();
  for (const [name, scheme] of source.entries()) {
    clone.set(name, cloneTypeScheme(scheme));
  }
  return clone;
}

function cloneAdtEnv(source: TypeEnvADT): TypeEnvADT {
  const clone: TypeEnvADT = new Map();
  for (const [name, info] of source.entries()) {
    clone.set(name, cloneTypeInfo(info));
  }
  return clone;
}

export interface InferOptions {
  initialEnv?: TypeEnv;
  initialAdtEnv?: TypeEnvADT;
  registerPrelude?: boolean;
  resetCounter?: boolean;
  source?: string;  // Source code for error reporting
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
  source?: string;  // Source code for error reporting
}

function withScopedEnv<T>(ctx: Context, fn: () => T): T {
  const previous = ctx.env;
  ctx.env = new Map(ctx.env);
  try {
    return fn();
  } finally {
    ctx.env = previous;
  }
}

function expectParameterName(param: Parameter): string {
  if (!param.name) {
    throw inferError("Internal error: missing parameter name after tuple lowering");
  }
  return param.name;
}

export function inferProgram(program: Program, options: InferOptions = {}): InferResult {
  lowerTupleParameters(program);
  if (options.resetCounter !== false) {
    resetTypeVarCounter();
  }
  const env: TypeEnv = options.initialEnv ? cloneTypeEnv(options.initialEnv) : new Map();
  const adtEnv: TypeEnvADT = options.initialAdtEnv ? cloneAdtEnv(options.initialAdtEnv) : new Map();
  const ctx: Context = { env, adtEnv, subst: new Map(), source: options.source };
  const summaries: { name: string; scheme: TypeScheme }[] = [];

  if (options.registerPrelude !== false) {
    registerPrelude(ctx);
  }

  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeDeclaration(ctx, decl);
    }
  }

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const results = inferLetDeclaration(ctx, decl);
      for (const { name, scheme } of results) {
        summaries.push({ name, scheme: applySubstitutionScheme(scheme, ctx.subst) });
      }
    } else if (decl.kind === "infix") {
      registerInfixDeclaration(ctx, decl);
    } else if (decl.kind === "prefix") {
      registerPrefixDeclaration(ctx, decl);
    }
  }

  const finalEnv: TypeEnv = new Map();
  for (const [name, scheme] of ctx.env.entries()) {
    finalEnv.set(name, applySubstitutionScheme(scheme, ctx.subst));
  }

  return { env: finalEnv, adtEnv: ctx.adtEnv, summaries };
}

function registerInfixDeclaration(ctx: Context, decl: InfixDeclaration) {
  // Register the operator's implementation function in the environment
  // with a special name so binary expressions can look it up
  const opFuncName = `__op_${decl.operator}`;
  
  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  
  // Register it under the operator name
  ctx.env.set(opFuncName, implScheme);
}

function registerPrefixDeclaration(ctx: Context, decl: PrefixDeclaration) {
  // Register the prefix operator's implementation function
  const opFuncName = `__prefix_${decl.operator}`;
  
  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  
  // Register it under the operator name
  ctx.env.set(opFuncName, implScheme);
}

function registerTypeDeclaration(ctx: Context, decl: TypeDeclaration) {
  if (ctx.adtEnv.has(decl.name)) {
    throw inferError(`Type '${decl.name}' is already defined`);
  }

  const parameterTypes = decl.typeParams.map(() => freshTypeVar());
  const typeScope = new Map<string, Type>();
  decl.typeParams.forEach((param, index) => {
    typeScope.set(param.name, parameterTypes[index]);
  });

  const parameterIds = parameterTypes
    .map((type) => (type.kind === "var" ? type.id : -1))
    .filter((id) => id >= 0);

  const adtInfo = {
    name: decl.name,
    parameters: parameterIds,
    constructors: [] as ConstructorInfo[],
  };
  ctx.adtEnv.set(decl.name, adtInfo);

  const constructors: ConstructorInfo[] = [];
  for (const member of decl.members) {
    if (member.kind !== "constructor") {
      throw inferError(
        `Type '${decl.name}' only supports constructor members in this version (found alias member)`,
      );
    }
    const info = buildConstructorInfo(ctx, decl.name, parameterTypes, member, typeScope);
    constructors.push(info);
    ctx.env.set(member.name, info.scheme);
  }

  adtInfo.constructors.push(...constructors);
}

function buildConstructorInfo(
  ctx: Context,
  typeName: string,
  parameterTypes: Type[],
  ctor: ConstructorAlias,
  scope: Map<string, Type>,
): ConstructorInfo {
  const ctorResult = makeDataConstructor(typeName, parameterTypes);
  const args = ctor.typeArgs.map((arg) => convertTypeExpr(ctx, arg, scope, { allowNewVariables: false }));
  const ctorType = args.reduceRight<Type>((acc, argType) => ({
    kind: "func",
    from: argType,
    to: acc,
  }), ctorResult);

  const quantifiers = parameterTypes
    .map((type) => (type.kind === "var" ? type.id : null))
    .filter((id): id is number => id !== null);

  const scheme: TypeScheme = {
    quantifiers,
    type: ctorType,
  };

  return {
    name: ctor.name,
    arity: ctor.typeArgs.length,
    scheme,
  };
}

function registerPrelude(ctx: Context) {
  registerCmpIntPrimitive(ctx, "nativeCmpInt");
  registerIntBinaryPrimitive(ctx, "nativeAdd");
  registerIntBinaryPrimitive(ctx, "nativeSub");
  registerIntBinaryPrimitive(ctx, "nativeMul");
  registerIntBinaryPrimitive(ctx, "nativeDiv");
  registerPrintPrimitive(ctx, "nativePrint");
}

function registerCmpIntPrimitive(ctx: Context, name: string, aliasOf?: string) {
  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: {
        kind: "func",
        from: { kind: "int" },
        to: { kind: "constructor", name: "Ordering", args: [] },
      },
    },
  };
  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerIntBinaryPrimitive(ctx: Context, name: string, aliasOf?: string) {
  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: {
        kind: "func",
        from: { kind: "int" },
        to: { kind: "int" },
      },
    },
  };
  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerPrintPrimitive(ctx: Context, name: string, aliasOf?: string) {
  const typeVar = freshTypeVar();
  if (typeVar.kind !== "var") {
    throw new Error("Expected fresh type variable");
  }

  const scheme: TypeScheme = {
    quantifiers: [typeVar.id],
    type: {
      kind: "func",
      from: typeVar,
      to: { kind: "unit" },
    },
  };

  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function bindTypeAlias(ctx: Context, name: string, scheme: TypeScheme, aliasOf?: string) {
  if (aliasOf && ctx.env.has(name)) {
    return;
  }
  const target = aliasOf ? ctx.env.get(aliasOf) : undefined;
  ctx.env.set(name, aliasOf && target ? target : scheme);
}

function inferLetDeclaration(ctx: Context, decl: LetDeclaration): { name: string; scheme: TypeScheme }[] {
  // Non-recursive case
  if (!decl.isRecursive) {
    const fnType = inferLetBinding(ctx, decl.parameters, decl.body, decl.annotation);
    const scheme = generalizeInContext(ctx, fnType);
    ctx.env.set(decl.name, scheme);
    return [{ name: decl.name, scheme }];
  }

  // Recursive case (with optional mutual bindings)
  const allBindings = [decl, ...(decl.mutualBindings || [])];
  
  // STEP 1: Pre-bind all names with fresh type variables
  const preBoundTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    const freshVar = freshTypeVar();
    preBoundTypes.set(binding.name, freshVar);
    // Add to environment with empty quantifiers so recursive calls can find it
    ctx.env.set(binding.name, { quantifiers: [], type: freshVar });
  }
  
  // STEP 2: Infer each body with all names in scope
  const inferredTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    const inferredType = inferLetBinding(ctx, binding.parameters, binding.body, binding.annotation);
    inferredTypes.set(binding.name, inferredType);
  }
  
  // STEP 3: Unify pre-bound types with inferred types
  for (const binding of allBindings) {
    const preBound = preBoundTypes.get(binding.name)!;
    const inferred = inferredTypes.get(binding.name)!;
    unify(ctx, preBound, inferred);
    
    // Also check annotation if present
    if (binding.annotation) {
      const annotationType = convertTypeExpr(ctx, binding.annotation, new Map());
      unify(ctx, inferred, annotationType);
    }
  }
  
  // STEP 4: Apply substitutions and generalize
  const results: { name: string; scheme: TypeScheme }[] = [];
  for (const binding of allBindings) {
    const inferredType = inferredTypes.get(binding.name)!;
    const resolvedType = applyCurrentSubst(ctx, inferredType);
    const scheme = generalizeInContext(ctx, resolvedType);
    ctx.env.set(binding.name, scheme);
    results.push({ name: binding.name, scheme });
  }
  
  return results;
}

interface ConvertTypeOptions {
  allowNewVariables: boolean;
}

function convertTypeExpr(
  ctx: Context,
  typeExpr: TypeExpr,
  scope: Map<string, Type> = new Map(),
  options: ConvertTypeOptions = { allowNewVariables: true },
): Type {
  switch (typeExpr.kind) {
    case "type_var": {
      const existing = scope.get(typeExpr.name);
      if (existing) {
        return existing;
      }
      if (!options.allowNewVariables) {
        throw inferError(`Unknown type variable '${typeExpr.name}'`);
      }
      const fresh = freshTypeVar();
      scope.set(typeExpr.name, fresh);
      return fresh;
    }
    case "type_fn": {
      if (typeExpr.parameters.length === 0) {
        throw inferError("Function type must include at least one parameter");
      }
      const result = convertTypeExpr(ctx, typeExpr.result, scope, options);
      return typeExpr.parameters.reduceRight<Type>((acc, param) => {
        const paramType = convertTypeExpr(ctx, param, scope, options);
        return {
          kind: "func",
          from: paramType,
          to: acc,
        };
      }, result);
    }
    case "type_ref": {
      const scoped = scope.get(typeExpr.name);
      if (scoped && typeExpr.typeArgs.length === 0) {
        return scoped;
      }
      switch (typeExpr.name) {
        case "Int":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Int' does not accept arguments");
          }
          return { kind: "int" };
        case "Bool":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Bool' does not accept arguments");
          }
          return { kind: "bool" };
        case "Char":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Char' does not accept arguments");
          }
          return { kind: "char" };
        case "Unit":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Unit' does not accept arguments");
          }
          return { kind: "unit" };
        case "String":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'String' does not accept arguments");
          }
          return { kind: "string" };
      }

      const typeInfo = ctx.adtEnv.get(typeExpr.name);

      if (typeExpr.typeArgs.length === 0) {
        if (typeInfo) {
          if (typeInfo.parameters.length > 0) {
            throw inferError(
              `Type constructor '${typeExpr.name}' expects ${typeInfo.parameters.length} type argument(s)`,
            );
          }
          return {
            kind: "constructor",
            name: typeExpr.name,
            args: [],
          };
        }
        if (options.allowNewVariables) {
          const fresh = freshTypeVar();
          scope.set(typeExpr.name, fresh);
          return fresh;
        }
        throw inferError(`Unknown type constructor '${typeExpr.name}'`, typeExpr.span, ctx.source);
      }

      if (!typeInfo) {
        throw inferError(`Unknown type constructor '${typeExpr.name}'`, typeExpr.span, ctx.source);
      }

      if (typeInfo.parameters.length !== typeExpr.typeArgs.length) {
        throw inferError(
          `Type constructor '${typeExpr.name}' expects ${typeInfo.parameters.length} type argument(s)`,
        );
      }

      const args = typeExpr.typeArgs.map((arg) => convertTypeExpr(ctx, arg, scope, options));
      return {
        kind: "constructor",
        name: typeExpr.name,
        args,
      };
    }
    case "type_tuple": {
      return {
        kind: "tuple",
        elements: typeExpr.elements.map((el) => convertTypeExpr(ctx, el, scope, options)),
      };
    }
    case "type_unit":
      return { kind: "unit" };
    default:
      throw inferError("Unsupported type expression");
  }
}

function makeDataConstructor(name: string, parameters: Type[]): Type {
  return {
    kind: "constructor",
    name,
    args: parameters,
  };
}

function inferLetBinding(
  ctx: Context,
  parameters: Parameter[],
  body: BlockExpr,
  annotation: TypeExpr | undefined,
): Type {
  const annotationScope = new Map<string, Type>();
  const paramTypes = parameters.map((param) => (
    param.annotation ? convertTypeExpr(ctx, param.annotation, annotationScope) : freshTypeVar()
  ));

  return withScopedEnv(ctx, () => {
    parameters.forEach((param, index) => {
      const paramName = expectParameterName(param);
      ctx.env.set(paramName, {
        quantifiers: [],
        type: paramTypes[index],
      });
    });

    let inferred = inferBlockExpr(ctx, body);

    if (annotation) {
      const annotated = convertTypeExpr(ctx, annotation, annotationScope);
      unify(ctx, inferred, annotated);
      inferred = applyCurrentSubst(ctx, annotated);
    }

    const resolved = applyCurrentSubst(ctx, inferred);

    if (parameters.length === 0) {
      return resolved;
    }

    return paramTypes.reduceRight<Type>((acc, paramType) => ({
      kind: "func",
      from: applyCurrentSubst(ctx, paramType),
      to: acc,
    }), resolved);
  });
}

function inferBlockExpr(ctx: Context, block: BlockExpr): Type {
  return withScopedEnv(ctx, () => {
    for (const statement of block.statements) {
      inferBlockStatement(ctx, statement);
    }

    if (block.result) {
      const resultType = inferExpr(ctx, block.result);
      return applyCurrentSubst(ctx, resultType);
    }

    return { kind: "unit" };
  });
}

function inferBlockStatement(ctx: Context, statement: BlockStatement): void {
  switch (statement.kind) {
    case "let_statement": {
      const { declaration } = statement;
      inferLetDeclaration(ctx, declaration);
      break;
    }
    case "expr_statement": {
      inferExpr(ctx, statement.expression);
      break;
    }
    default:
      throw inferError(`Unknown block statement kind ${(statement as BlockStatement).kind}`);
  }
}

function inferExpr(ctx: Context, expr: Expr): Type {
  switch (expr.kind) {
    case "identifier": {
      const scheme = lookupEnv(ctx, expr.name);
      return instantiateAndApply(ctx, scheme);
    }
    case "literal":
      return literalType(expr.literal);
    case "constructor": {
      const scheme = lookupEnv(ctx, expr.name);
      const ctorType = instantiateAndApply(ctx, scheme);
      let result = ctorType;
      for (const arg of expr.args) {
        const argType = inferExpr(ctx, arg);
        const fnType = expectFunctionType(ctx, result, `Constructor ${expr.name}`);
        unify(ctx, fnType.from, argType);
        result = fnType.to;
      }
      const applied = applyCurrentSubst(ctx, result);
      if (applied.kind === "func") {
        throw inferError(`Constructor ${expr.name} is not fully applied`);
      }
      return applied;
    }
    case "tuple": {
      const elements = expr.elements.map((el) => inferExpr(ctx, el));
      return applyCurrentSubst(ctx, {
        kind: "tuple",
        elements: elements.map((t) => applyCurrentSubst(ctx, t)),
      });
    }
    case "call": {
      let fnType = inferExpr(ctx, expr.callee);
      for (const arg of expr.arguments) {
        const argType = inferExpr(ctx, arg);
        const resultType = freshTypeVar();
        unify(ctx, fnType, { kind: "func", from: argType, to: resultType });
        fnType = applyCurrentSubst(ctx, resultType);
      }
      return applyCurrentSubst(ctx, fnType);
    }
    case "arrow":
      return inferArrowFunction(ctx, expr.parameters, expr.body);
    case "block":
      return inferBlockExpr(ctx, expr);
    case "match":
      return inferMatchExpression(ctx, expr.scrutinee, expr.arms);
    case "match_fn":
      return inferMatchFunction(ctx, expr.parameters, expr.arms);
    case "binary": {
      // Binary operators are desugared to function calls
      // e.g., `a + b` becomes `add(a, b)` where `add` is the implementation function
      // The operator itself should have been registered with its implementation function
      // For type inference, we treat it as a call to the implementation function
      const leftType = inferExpr(ctx, expr.left);
      const rightType = inferExpr(ctx, expr.right);
      
      // Look up the operator's implementation function in the environment
      // This will be set during the declaration phase
      const opFuncName = `__op_${expr.operator}`;
      const scheme = lookupEnv(ctx, opFuncName);
      const opType = instantiateAndApply(ctx, scheme);
      
      // Apply the function to both arguments
      const resultType1 = freshTypeVar();
      unify(ctx, opType, { kind: "func", from: leftType, to: { kind: "func", from: rightType, to: resultType1 } });
      
      return applyCurrentSubst(ctx, resultType1);
    }
    case "unary": {
      // Unary operators are desugared to function calls
      // e.g., `!x` becomes `not(x)` where `not` is the implementation function
      const operandType = inferExpr(ctx, expr.operand);
      
      // Look up the prefix operator's implementation function
      const opFuncName = `__prefix_${expr.operator}`;
      const scheme = lookupEnv(ctx, opFuncName);
      const opType = instantiateAndApply(ctx, scheme);
      
      // Apply the function to the operand
      const resultType = freshTypeVar();
      unify(ctx, opType, { kind: "func", from: operandType, to: resultType });
      
      return applyCurrentSubst(ctx, resultType);
    }
    default:
      throw inferError(`Unsupported expression kind ${(expr as Expr).kind}`);
  }
}

function inferArrowFunction(ctx: Context, parameters: Parameter[], body: BlockExpr): Type {
  return withScopedEnv(ctx, () => {
    const paramTypes = parameters.map((param) => (
      param.annotation ? convertTypeExpr(ctx, param.annotation) : freshTypeVar()
    ));

    parameters.forEach((param, index) => {
      const paramName = expectParameterName(param);
      ctx.env.set(paramName, {
        quantifiers: [],
        type: paramTypes[index],
      });
    });

    const bodyType = applyCurrentSubst(ctx, inferBlockExpr(ctx, body));

    if (parameters.length === 0) {
      return bodyType;
    }

    return paramTypes.reduceRight<Type>((acc, paramType) => ({
      kind: "func",
      from: applyCurrentSubst(ctx, paramType),
      to: acc,
    }), bodyType);
  });
}

function inferMatchExpression(ctx: Context, scrutinee: Expr, arms: MatchArm[]): Type {
  const scrutineeType = inferExpr(ctx, scrutinee);
  return inferMatchBranches(ctx, scrutineeType, arms);
}

function inferMatchFunction(ctx: Context, parameters: Expr[], arms: MatchArm[]): Type {
  if (parameters.length !== 1) {
    throw inferError("Match functions currently support exactly one argument");
  }
  const parameterType = inferExpr(ctx, parameters[0]);
  const resultType = inferMatchBranches(ctx, parameterType, arms);
  return {
    kind: "func",
    from: applyCurrentSubst(ctx, parameterType),
    to: applyCurrentSubst(ctx, resultType),
  };
}

function inferMatchBranches(
  ctx: Context,
  scrutineeType: Type,
  arms: MatchArm[],
): Type {
  let resultType: Type | null = null;
  const coverageMap = new Map<string, Set<string>>();
  const booleanCoverage = new Set<"true" | "false">();
  let hasWildcard = false;

  for (const arm of arms) {
    const expected = applyCurrentSubst(ctx, scrutineeType);
    const patternInfo = inferPattern(ctx, arm.pattern, expected);
    if (patternInfo.coverage.kind === "wildcard") {
      hasWildcard = true;
    } else if (patternInfo.coverage.kind === "constructor") {
      const key = patternInfo.coverage.typeName;
      const set = coverageMap.get(key) ?? new Set<string>();
      set.add(patternInfo.coverage.ctor);
      coverageMap.set(key, set);
    } else if (patternInfo.coverage.kind === "bool") {
      booleanCoverage.add(patternInfo.coverage.value ? "true" : "false");
    }

    const bodyType = withScopedEnv(ctx, () => {
      for (const [name, type] of patternInfo.bindings.entries()) {
        ctx.env.set(name, { quantifiers: [], type: applyCurrentSubst(ctx, type) });
      }
      return inferExpr(ctx, arm.body);
    });

    if (!resultType) {
      resultType = bodyType;
    } else {
      unify(ctx, resultType, bodyType);
      resultType = applyCurrentSubst(ctx, resultType);
    }
  }

  ensureExhaustive(ctx, applyCurrentSubst(ctx, scrutineeType), hasWildcard, coverageMap, booleanCoverage);

  if (!resultType) {
    resultType = freshTypeVar();
  }

  return applyCurrentSubst(ctx, resultType);
}

function expectFunctionType(ctx: Context, type: Type, description: string): { from: Type; to: Type } {
  const resolved = applyCurrentSubst(ctx, type);
  if (resolved.kind !== "func") {
    throw inferError(`${description} is not fully applied`);
  }
  return resolved;
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
    throw inferError(`Unknown identifier '${name}'`);
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
    case "char":
      return { kind: "char" };
    case "unit":
      return { kind: "unit" };
    case "string":
      return { kind: "string" };
    default:
      throw inferError("Unsupported literal");
  }
}

function mergeBindings(target: Map<string, Type>, source: Map<string, Type>) {
  for (const [name, type] of source.entries()) {
    if (target.has(name)) {
      throw inferError(`Duplicate variable '${name}' in pattern`);
    }
    target.set(name, type);
  }
}

type PatternCoverage =
  | { kind: "wildcard" }
  | { kind: "constructor"; typeName: string; ctor: string }
  | { kind: "bool"; value: boolean }
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
        coverage:
          pattern.literal.kind === "bool"
            ? { kind: "bool", value: pattern.literal.value }
            : { kind: "none" },
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
        throw inferError("Expected tuple type for tuple pattern");
      }
      if (resolved.elements.length !== pattern.elements.length) {
        throw inferError("Tuple pattern arity mismatch");
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
        throw inferError(`Constructor pattern '${pattern.name}' does not result in a data type`);
      }
      return {
        type: final,
        bindings,
        coverage: { kind: "constructor", typeName: final.name, ctor: pattern.name },
      };
    }
    default:
      throw inferError("Unsupported pattern kind");
  }
}

function ensureExhaustive(
  ctx: Context,
  scrutineeType: Type,
  hasWildcard: boolean,
  coverageMap: Map<string, Set<string>>,
  booleanCoverage: Set<"true" | "false">,
) {
  if (hasWildcard) return;
  const resolved = applyCurrentSubst(ctx, scrutineeType);
  if (resolved.kind === "bool") {
    const missing: string[] = [];
    if (!booleanCoverage.has("true")) missing.push("true");
    if (!booleanCoverage.has("false")) missing.push("false");
    if (missing.length > 0) {
      throw inferError(`Non-exhaustive patterns, missing: ${missing.join(", ")}`);
    }
    return;
  }
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
    throw inferError(`Non-exhaustive patterns, missing: ${missing.join(", ")}`);
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
      throw inferError(`Cannot unify constructors ${left.name} and ${right.name}`);
    }
    let current = subst;
    for (let i = 0; i < left.args.length; i++) {
      current = unifyTypes(left.args[i], right.args[i], current);
    }
    return current;
  }

  if (left.kind === "tuple" && right.kind === "tuple") {
    if (left.elements.length !== right.elements.length) {
      throw inferError("Cannot unify tuples of different length");
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

  const leftDesc = formatTypeForError(left);
  const rightDesc = formatTypeForError(right);
  throw inferError(`Type mismatch: cannot unify ${leftDesc} with ${rightDesc}`);
}

function bindVar(id: number, type: Type, subst: Substitution): Substitution {
  const resolved = applySubstitution(type, subst);
  if (resolved.kind === "var" && resolved.id === id) {
    return subst;
  }
  if (occursInType(id, resolved)) {
    throw inferError("Occurs check failed");
  }
  const next = new Map(subst);
  next.set(id, resolved);
  return next;
}

function formatTypeForError(type: Type): string {
  const quantifiers = [...freeTypeVars(type)].sort((a, b) => a - b);
  return formatScheme({ quantifiers, type });
}
