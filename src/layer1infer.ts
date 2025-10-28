import {
  BlockExpr,
  BlockStatement,
  ConstructorAlias,
  Expr,
  InfixDeclaration,
  LetDeclaration,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import { lowerTupleParameters } from "./lower_tuple_params.ts";
import {
  ConstructorInfo,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
  applySubstitutionScheme,
  freshTypeVar,
  typeToString,
} from "./types.ts";
import { formatScheme } from "./type_printer.ts";
import {
  Context,
  InferOptions,
  InferResult,
  applyCurrentSubst,
  createContext,
  expectFunctionType,
  generalizeInContext,
  inferError,
  instantiateAndApply,
  literalType,
  lookupEnv,
  unify,
  withScopedEnv,
} from "./layer1/context.ts";
import {
  convertTypeExpr,
  registerPrelude,
  registerTypeConstructors,
  registerTypeName,
  resetTypeParamsCache,
} from "./layer1/declarations.ts";
import { inferMatchExpression, inferMatchFunction, inferMatchBundleLiteral } from "./infermatch.ts";

export type { Context, InferOptions, InferResult } from "./layer1/context.ts";
export { InferError } from "./error.ts";
export { inferError } from "./layer1/context.ts";

function expectParameterName(param: Parameter): string {
  if (!param.name) {
    throw inferError("Internal error: missing parameter name after tuple lowering");
  }
  return param.name;
}

export function inferProgram(program: Program, options: InferOptions = {}): InferResult {
  lowerTupleParameters(program);
  const ctx = createContext({
    initialEnv: options.initialEnv,
    initialAdtEnv: options.initialAdtEnv,
    registerPrelude: options.registerPrelude,
    resetCounter: options.resetCounter,
    source: options.source ?? program.sourceText ?? undefined,
  });
  const summaries: { name: string; scheme: TypeScheme }[] = [];

  // Clear the type params cache for this program
  resetTypeParamsCache();

  if (options.registerPrelude !== false) {
    registerPrelude(ctx);
  }

  // Pass 1: Register all type names (allows forward references)
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeName(ctx, decl);
    }
  }

  // Pass 2: Register constructors (now all type names are known)
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeConstructors(ctx, decl);
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

  const finalSummaries = summaries.map(({ name, scheme }) => ({
    name,
    scheme: applySubstitutionScheme(scheme, ctx.subst),
  }));

  console.log("[debug] final substitution entries", Array.from(ctx.subst.entries()).map(([id, type]) => [id, formatScheme({ quantifiers: [], type })]));
  console.log("[debug] final summaries", finalSummaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) })));

  return {
    env: finalEnv,
    adtEnv: ctx.adtEnv,
    summaries: finalSummaries,
    allBindings: ctx.allBindings,
  };
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

function inferLetDeclaration(ctx: Context, decl: LetDeclaration): { name: string; scheme: TypeScheme }[] {
  // Non-recursive case
  if (!decl.isRecursive) {
    const fnType = inferLetBinding(ctx, decl.parameters, decl.body, decl.annotation);
    const scheme = generalizeInContext(ctx, fnType);
    ctx.env.set(decl.name, scheme);
    if (decl.name === "zero" || decl.name === "describeNumber" || decl.name === "grouped") {
      console.log(`[debug] scheme ${decl.name}`, {
        quantifiers: scheme.quantifiers,
        type: formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
      });
    }
    ctx.allBindings.set(decl.name, scheme); // Track in allBindings
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
  // Remove bindings from environment before generalization to avoid capturing their own type vars
  for (const binding of allBindings) {
    const existing = ctx.env.get(binding.name);
    if (existing) {
      ctx.env.delete(binding.name);
    }
  }

  const results: { name: string; scheme: TypeScheme }[] = [];
  for (const binding of allBindings) {
    const inferredType = inferredTypes.get(binding.name)!;
    const resolvedType = applyCurrentSubst(ctx, inferredType);
    const scheme = generalizeInContext(ctx, resolvedType);
    ctx.env.set(binding.name, scheme);
    ctx.allBindings.set(binding.name, scheme); // Track in allBindings
    results.push({ name: binding.name, scheme });
  }
  
  return results;
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

    const bodyType = applyCurrentSubst(ctx, inferBlockExpr(ctx, body));

    let fnType: Type;
    if (parameters.length === 0) {
      fnType = bodyType;
    } else {
      fnType = paramTypes.reduceRight<Type>((acc, paramType) => ({
        kind: "func",
        from: applyCurrentSubst(ctx, paramType),
        to: acc,
      }), bodyType);
    }

    if (annotation) {
      const annotated = convertTypeExpr(ctx, annotation, annotationScope);
      unify(ctx, fnType, annotated);
      fnType = applyCurrentSubst(ctx, annotated);
    }

    return fnType;
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

export function inferExpr(ctx: Context, expr: Expr): Type {
  switch (expr.kind) {
    case "identifier": {
      const scheme = lookupEnv(ctx, expr.name);
      if (
        expr.name === "formatRuntimeValue" &&
        ctx.source?.includes("Runtime value printer for Workman using std library")
      ) {
        console.log(
          "[debug] identifier formatRuntimeValue scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "listMap" &&
        ctx.source?.includes("Runtime value printer for Workman using std library")
      ) {
        console.log(
          "[debug] identifier listMap scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "fromLiteral" &&
        ctx.source?.includes("Runtime value printer for Workman using std library")
      ) {
        console.log(
          "[debug] identifier fromLiteral scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
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
        const calleeIdentifierName = expr.callee.kind === "identifier"
          ? expr.callee.name
          : null;
        const calleeName = calleeIdentifierName ?? "<expression>";
        const shouldLogFormatter = calleeIdentifierName === "formatter";
        if (
          calleeIdentifierName === "listMap" &&
          ctx.source?.includes("Runtime value printer for Workman using std library")
        ) {
          console.log("[debug] listMap arg type:", typeToString(applyCurrentSubst(ctx, argType)));
          console.log(
            "[debug] fnType before unify:",
            typeToString(applyCurrentSubst(ctx, fnType)),
          );
        }
        if (ctx.source?.includes("Runtime value printer for Workman using std library")) {
          console.log("[debug] call callee:", calleeName);
        }
        if (shouldLogFormatter) {
          console.log("[debug] formatter call before unify", {
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
            argType: typeToString(applyCurrentSubst(ctx, argType)),
          });
        }
        try {
          unify(ctx, fnType, { kind: "func", from: argType, to: resultType });
        } catch (e) {
          // Add context about which function call failed
          const fnTypeStr = typeToString(applyCurrentSubst(ctx, fnType));
          const argTypeStr = typeToString(applyCurrentSubst(ctx, argType));
          if (ctx.source?.includes("Runtime value printer for Workman using std library")) {
            const snippet = ctx.source.slice(expr.span.start, expr.span.end);
            console.log("[debug] failing call snippet:", snippet.trim());
            console.log(
              "[debug] resultType raw/applied:",
              typeToString(resultType),
              typeToString(applyCurrentSubst(ctx, resultType)),
            );
            if (resultType.kind === "var") {
              const mapped = ctx.subst.get(resultType.id);
              if (mapped) {
                console.log("[debug] resultType mapped to:", typeToString(mapped));
              }
            }
          }
          throw inferError(`Type error in function call to '${calleeName}':\n  Function type: ${fnTypeStr}\n  Argument type: ${argTypeStr}\n\nOriginal error: ${e instanceof Error ? e.message : String(e)}`, expr.span, ctx.source);
        }
        if (shouldLogFormatter) {
          console.log("[debug] formatter call after unify", {
            resultType: typeToString(applyCurrentSubst(ctx, resultType)),
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
          });
        }
        fnType = applyCurrentSubst(ctx, resultType);
      }
      const callType = applyCurrentSubst(ctx, fnType);
      if (
        ctx.source?.includes("Runtime value printer for Workman using std library") &&
        ctx.source.slice(expr.span.start, expr.span.end).includes("listMap")
      ) {
        console.log("[debug] listMap call type:", typeToString(callType));
        const fmtScheme = ctx.env.get("formatRuntimeValue");
        if (fmtScheme) {
          console.log(
            "[debug] formatRuntimeValue scheme after listMap:",
            formatScheme(applySubstitutionScheme(fmtScheme, ctx.subst)),
          );
        }
      }
      return callType;
    }
    case "arrow":
      return inferArrowFunction(ctx, expr.parameters, expr.body);
    case "block":
      return inferBlockExpr(ctx, expr);
    case "match":
      return inferMatchExpression(ctx, expr.scrutinee, expr.bundle);
    case "match_fn":
      return inferMatchFunction(ctx, expr.parameters, expr.bundle);
    case "match_bundle_literal":
      return inferMatchBundleLiteral(ctx, expr);
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

export function inferPattern(ctx: Context, pattern: Pattern, expected: Type): PatternInfo {
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
        if (pattern.name === "Data") {
          console.log(
            "[debug] Data pattern field type:",
            typeToString(applyCurrentSubst(ctx, fnType.from)),
          );
        }
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

export function ensureExhaustive(
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


