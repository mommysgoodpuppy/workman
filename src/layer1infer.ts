import {
  BlockExpr,
  BlockStatement,
  ConstructorAlias,
  Expr,
  ExprStatement,
  InfixDeclaration,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  MatchBundleLiteralExpr,
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
  unknownType,
} from "./types.ts";
import { formatScheme } from "./type_printer.ts";
import type {
  MBlockExpr,
  MBlockStatement,
  MExpr,
  MExprStatement,
  MLetDeclaration,
  MLetStatement,
  MMatchArm,
  MMatchBundle,
  MMatchBundleReferenceArm,
  MMatchPatternArm,
  MMarkPattern,
  MParameter,
  MPattern,
  MProgram,
  MTopLevel,
  MTypeExpr,
} from "./ast_marked.ts";
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
  markFreeVariable,
  markInconsistent,
  markNonExhaustive,
  markNotFunction,
  markUnsupportedExpr,
  unify,
  withScopedEnv,
} from "./layer1/context.ts";
import {
  convertTypeExpr,
  registerPrelude,
  registerTypeConstructors,
  registerTypeName,
  RegisterTypeResult,
  RegisterConstructorsResult,
  resetTypeParamsCache,
} from "./layer1/declarations.ts";
import {
  inferMatchExpression,
  inferMatchFunction,
  inferMatchBundleLiteral,
} from "./infermatch.ts";

export type { Context, InferOptions, InferResult } from "./layer1/context.ts";
export { InferError } from "./error.ts";
export { inferError } from "./layer1/context.ts";

function expectParameterName(param: Parameter): string {
  if (!param.name) {
    throw inferError("Internal error: missing parameter name after tuple lowering");
  }
  return param.name;
}

function recordExprType(ctx: Context, expr: Expr, type: Type): Type {
  const resolved = applyCurrentSubst(ctx, type);
  ctx.nodeTypes.set(expr, resolved);
  return resolved;
}

export function inferProgram(program: Program, options: InferOptions = {}): InferResult {
  lowerTupleParameters(program);
  const ctx = createContext({
    initialEnv: options.initialEnv,
    initialAdtEnv: options.initialAdtEnv,
    registerPrelude: options.registerPrelude,
    resetCounter: options.resetCounter,
    source: options.source ?? undefined,
  });
  const summaries: { name: string; scheme: TypeScheme }[] = [];
  const markedDeclarations: MTopLevel[] = [];
  const successfulTypeDecls = new Set<TypeDeclaration>();

  // Clear the type params cache for this program
  resetTypeParamsCache();

  if (options.registerPrelude !== false) {
    registerPrelude(ctx);
  }

  // Pass 1: Register all type names (allows forward references)
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      const result = registerTypeName(ctx, decl);
      if (!result.success) {
        markedDeclarations.push(result.mark);
      } else {
        successfulTypeDecls.add(decl);
      }
    }
  }

  // Pass 2: Register constructors (now all type names are known)
  for (const decl of program.declarations) {
    if (decl.kind === "type" && successfulTypeDecls.has(decl)) {
      const result = registerTypeConstructors(ctx, decl);
      if (!result.success) {
        markedDeclarations.push(result.mark);
        successfulTypeDecls.delete(decl); // Remove from successful set
      }
    }
  }

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const results = inferLetDeclaration(ctx, decl);
      for (const { name, scheme } of results) {
        summaries.push({ name, scheme: applySubstitutionScheme(scheme, ctx.subst) });
      }
      const resolvedType = resolveTypeForName(ctx, decl.name);
      const marked = materializeMarkedLet(ctx, decl, resolvedType);
      markedDeclarations.push(marked);
    } else if (decl.kind === "infix") {
      registerInfixDeclaration(ctx, decl);
      markedDeclarations.push({ kind: "infix", node: decl });
    } else if (decl.kind === "prefix") {
      registerPrefixDeclaration(ctx, decl);
      markedDeclarations.push({ kind: "prefix", node: decl });
    } else if (decl.kind === "type" && successfulTypeDecls.has(decl)) {
      markedDeclarations.push({ kind: "type", node: decl });
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

  const markedProgram: MProgram = {
    imports: program.imports,
    reexports: program.reexports,
    declarations: markedDeclarations,
  };

  /* console.debug("[debug] final substitution entries", Array.from(ctx.subst.entries()).map(([id, type]) => [id, formatScheme({ quantifiers: [], type })]));
  console.debug("[debug] final summaries", finalSummaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) })));
 */
  return {
    env: finalEnv,
    adtEnv: ctx.adtEnv,
    summaries: finalSummaries,
    allBindings: ctx.allBindings,
    markedProgram,
  };
}

function resolveTypeForName(ctx: Context, name: string): Type | undefined {
  const scheme = ctx.env.get(name) ?? ctx.allBindings.get(name);
  if (!scheme) {
    return undefined;
  }
  const applied = applySubstitutionScheme(scheme, ctx.subst);
  return applied.type;
}

function materializeMarkedLet(
  ctx: Context,
  decl: LetDeclaration,
  resolvedType: Type | undefined,
): MLetDeclaration {
  const parameters = decl.parameters.map((param) => materializeParameter(ctx, param));
  const body = materializeBlockExpr(ctx, decl.body);
  const type = resolvedType ?? unknownFromReason(`let:${decl.name}`);

  const marked: MLetDeclaration = {
    kind: "let",
    span: decl.span,
    id: decl.id,
    name: decl.name,
    parameters,
    annotation: decl.annotation ? materializeTypeExpr(ctx, decl.annotation) : undefined,
    body,
    isRecursive: decl.isRecursive,
    type,
  };

  if (decl.isFirstClassMatch) {
    marked.isFirstClassMatch = true;
  }
  if (decl.isArrowSyntax) {
    marked.isArrowSyntax = true;
  }
  if (decl.export) {
    marked.export = decl.export;
  }
  if (decl.leadingComments) {
    marked.leadingComments = decl.leadingComments;
  }
  if (decl.trailingComment) {
    marked.trailingComment = decl.trailingComment;
  }
  if (decl.hasBlankLineBefore) {
    marked.hasBlankLineBefore = true;
  }

  if (decl.mutualBindings && decl.mutualBindings.length > 0) {
    marked.mutualBindings = decl.mutualBindings.map((binding) =>
      materializeMarkedLet(ctx, binding, undefined)
    );
  }

  return marked;
}

function getExprTypeOrUnknown(ctx: Context, expr: Expr, reason: string): Type {
  return ctx.nodeTypes.get(expr) ?? unknownFromReason(reason);
}

function unknownFromReason(reason: string): Type {
  return unknownType({ kind: "incomplete", reason });
}

function materializeTypeExpr(ctx: Context, typeExpr: TypeExpr): MTypeExpr {
  const existingMark = ctx.typeExprMarks.get(typeExpr);
  if (existingMark) {
    return existingMark;
  }

  switch (typeExpr.kind) {
    case "type_var":
      return {
        kind: "type_var",
        span: typeExpr.span,
        id: typeExpr.id,
        name: typeExpr.name,
      };
    case "type_fn":
      return {
        kind: "type_fn",
        span: typeExpr.span,
        id: typeExpr.id,
        parameters: typeExpr.parameters.map((param) => materializeTypeExpr(ctx, param)),
        result: materializeTypeExpr(ctx, typeExpr.result),
      };
    case "type_ref":
      return {
        kind: "type_ref",
        span: typeExpr.span,
        id: typeExpr.id,
        name: typeExpr.name,
        typeArgs: typeExpr.typeArgs.map((arg) => materializeTypeExpr(ctx, arg)),
      };
    case "type_tuple":
      return {
        kind: "type_tuple",
        span: typeExpr.span,
        id: typeExpr.id,
        elements: typeExpr.elements.map((el) => materializeTypeExpr(ctx, el)),
      };
    case "type_unit":
      return {
        kind: "type_unit",
        span: typeExpr.span,
        id: typeExpr.id,
      };
    default:
      // This shouldn't happen with valid AST
      return {
        kind: "type_unit", // fallback
        span: typeExpr.span,
        id: typeExpr.id,
      };
  }
}

function materializePattern(ctx: Context, pattern: Pattern): MPattern {
  switch (pattern.kind) {
    case "wildcard":
      return {
        kind: "wildcard",
        span: pattern.span,
        id: pattern.id,
        type: unknownFromReason("pattern.wildcard"),
      };
    case "variable":
      return {
        kind: "variable",
        span: pattern.span,
        id: pattern.id,
        name: pattern.name,
        type: unknownFromReason(`pattern.var:${pattern.name}`),
      };
    case "literal": {
      const literal = pattern.literal;
      const type = literalType(literal);
      return {
        kind: "literal",
        span: pattern.span,
        id: pattern.id,
        literal,
        type,
      };
    }
    case "tuple": {
      const elements = pattern.elements.map((element) => materializePattern(ctx, element));
      const type: Type = {
        kind: "tuple",
        elements: elements.map((el) => el.type ?? unknownFromReason("pattern.tuple.elem")),
      };
      return {
        kind: "tuple",
        span: pattern.span,
        id: pattern.id,
        elements,
        type,
      };
    }
    case "constructor": {
      const args = pattern.args.map((arg) => materializePattern(ctx, arg));
      const type: Type = {
        kind: "constructor",
        name: pattern.name,
        args: args.map((arg) => arg.type ?? unknownFromReason("pattern.constructor.arg")),
      };
      return {
        kind: "constructor",
        span: pattern.span,
        id: pattern.id,
        name: pattern.name,
        args,
        type,
      };
    }
    default:
      return {
        kind: "mark_pattern",
        span: (pattern as any).span,
        id: (pattern as any).id,
        reason: "other",
        type: unknownFromReason("pattern.unknown"),
      } satisfies MMarkPattern;
  }
}

function materializeExpr(ctx: Context, expr: Expr): MExpr {
  const existingMark = ctx.marks.get(expr);
  if (existingMark) {
    return existingMark;
  }

  switch (expr.kind) {
    case "identifier":
      return {
        kind: "identifier",
        span: expr.span,
        id: expr.id,
        name: expr.name,
        type: getExprTypeOrUnknown(ctx, expr, `expr.id:${expr.name}`),
      };
    case "literal":
      return {
        kind: "literal",
        span: expr.span,
        id: expr.id,
        literal: expr.literal,
        type: getExprTypeOrUnknown(ctx, expr, "expr.literal"),
      };
    case "constructor": {
      const args = expr.args.map((arg) => materializeExpr(ctx, arg));
      return {
        kind: "constructor",
        span: expr.span,
        id: expr.id,
        name: expr.name,
        args,
        type: getExprTypeOrUnknown(ctx, expr, `expr.constructor:${expr.name}`),
      };
    }
    case "tuple": {
      const elements = expr.elements.map((element) => materializeExpr(ctx, element));
      const type = getExprTypeOrUnknown(ctx, expr, "expr.tuple");
      return {
        kind: "tuple",
        span: expr.span,
        id: expr.id,
        elements,
        isMultiLine: expr.isMultiLine,
        type,
      };
    }
    case "call": {
      const callee = materializeExpr(ctx, expr.callee);
      const args = expr.arguments.map((arg) => materializeExpr(ctx, arg));
      return {
        kind: "call",
        span: expr.span,
        id: expr.id,
        callee,
        arguments: args,
        type: getExprTypeOrUnknown(ctx, expr, "expr.call"),
      };
    }
    case "binary": {
      const left = materializeExpr(ctx, expr.left);
      const right = materializeExpr(ctx, expr.right);
      return {
        kind: "binary",
        span: expr.span,
        id: expr.id,
        operator: expr.operator,
        left,
        right,
        type: getExprTypeOrUnknown(ctx, expr, `expr.binary:${expr.operator}`),
      };
    }
    case "unary": {
      const operand = materializeExpr(ctx, expr.operand);
      return {
        kind: "unary",
        span: expr.span,
        id: expr.id,
        operator: expr.operator,
        operand,
        type: getExprTypeOrUnknown(ctx, expr, `expr.unary:${expr.operator}`),
      };
    }
    case "arrow": {
      const parameters = expr.parameters.map((param) => materializeParameter(ctx, param));
      const body = materializeBlockExpr(ctx, expr.body);
      return {
        kind: "arrow",
        span: expr.span,
        id: expr.id,
        parameters,
        body,
        type: getExprTypeOrUnknown(ctx, expr, "expr.arrow"),
      };
    }
    case "block":
      return materializeBlockExpr(ctx, expr);
    case "match": {
      const scrutinee = materializeExpr(ctx, expr.scrutinee);
      const type = getExprTypeOrUnknown(ctx, expr, "expr.match");
      const bundle = materializeMatchBundle(ctx, expr.bundle, type);
      return {
        kind: "match",
        span: expr.span,
        id: expr.id,
        scrutinee,
        bundle,
        type,
      };
    }
    case "match_fn": {
      const parameters = expr.parameters.map((param) => materializeExpr(ctx, param));
      const type = getExprTypeOrUnknown(ctx, expr, "expr.match_fn");
      const bundle = materializeMatchBundle(ctx, expr.bundle, type);
      return {
        kind: "match_fn",
        span: expr.span,
        id: expr.id,
        parameters,
        bundle,
        type,
      };
    }
    case "match_bundle_literal": {
      const type = getExprTypeOrUnknown(ctx, expr, "expr.match_bundle_literal");
      const bundle = materializeMatchBundle(ctx, expr.bundle, type);
      return {
        kind: "match_bundle_literal",
        span: expr.span,
        id: expr.id,
        bundle,
        type,
      };
    }
    default:
      return {
        kind: "block",
        span: (expr as Expr).span,
        id: (expr as Expr).id,
        statements: [],
        type: getExprTypeOrUnknown(ctx, expr, "expr.unknown"),
      } as MBlockExpr;
  }
}

function materializeParameter(ctx: Context, param: Parameter): MParameter {
  const pattern = materializePattern(ctx, param.pattern);
  const annotationScope = new Map<string, Type>();
  const explicitType = param.annotation ? convertTypeExpr(ctx, param.annotation, annotationScope) : undefined;
  const type = explicitType ?? pattern.type ?? unknownFromReason(`parameter:${param.name ?? "_"}`);
  return {
    kind: "parameter",
    span: param.span,
    id: param.id,
    pattern,
    name: param.name,
    annotation: param.annotation ? materializeTypeExpr(ctx, param.annotation) : undefined,
    type,
  };
}

function materializeBlockExpr(ctx: Context, block: BlockExpr): MBlockExpr {
  const statements = block.statements.map((statement) => materializeBlockStatement(ctx, statement));
  const result = block.result ? materializeExpr(ctx, block.result) : undefined;
  const type = ctx.nodeTypes.get(block) ?? (result ? result.type : { kind: "unit" as const });
  return {
    kind: "block",
    span: block.span,
    id: block.id,
    statements,
    result,
    isMultiLine: block.isMultiLine,
    type,
  };
}

function materializeBlockStatement(ctx: Context, statement: BlockStatement): MBlockStatement {
  switch (statement.kind) {
    case "let_statement":
      return {
        kind: "let_statement",
        span: statement.span,
        id: statement.id,
        declaration: materializeMarkedLet(ctx, statement.declaration, undefined),
      } satisfies MLetStatement;
    case "expr_statement":
      return {
        kind: "expr_statement",
        span: statement.span,
        id: statement.id,
        expression: materializeExpr(ctx, statement.expression),
      } satisfies MExprStatement;
    default:
      const exprStmt = statement as ExprStatement;
      return {
        kind: "expr_statement",
        span: exprStmt.span,
        id: exprStmt.id,
        expression: materializeExpr(ctx, exprStmt.expression),
      } satisfies MExprStatement;
  }
}

function materializeMatchBundle(ctx: Context, bundle: MatchBundle, inferredType?: Type): MMatchBundle {
  const matchResult = ctx.matchResults.get(bundle);
  const patternInfos = matchResult?.patternInfos ?? [];
  const resolvedBundleType = matchResult?.type ?? inferredType ?? unknownFromReason("match.bundle");
  const arms: MMatchArm[] = [];
  let patternIndex = 0;

  for (const arm of bundle.arms) {
    if (arm.kind === "match_bundle_reference") {
      const marked: MMatchBundleReferenceArm = {
        kind: "match_bundle_reference",
        span: arm.span,
        id: arm.id,
        name: arm.name,
        hasTrailingComma: arm.hasTrailingComma,
      } satisfies MMatchBundleReferenceArm;
      arms.push(marked);
      continue;
    }

    const info = patternInfos[patternIndex++];
    const pattern = info?.marked ?? materializePattern(ctx, arm.pattern);
    const body = materializeExpr(ctx, arm.body);
    const armType = matchResult?.type ?? body.type;

    const marked: MMatchPatternArm = {
      kind: "match_pattern",
      span: arm.span,
      id: arm.id,
      pattern,
      body,
      hasTrailingComma: arm.hasTrailingComma,
      type: armType,
    } satisfies MMatchPatternArm;
    arms.push(marked);
  }

  if (matchResult) {
    ctx.matchResults.delete(bundle);
  }

  return {
    kind: "match_bundle",
    span: bundle.span,
    id: bundle.id,
    arms,
    type: resolvedBundleType,
  } satisfies MMatchBundle;
}

function registerInfixDeclaration(ctx: Context, decl: InfixDeclaration) {
  // Register the operator's implementation function in the environment
  // with a special name so binary expressions can look it up
  const opFuncName = `__op_${decl.operator}`;
  
  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  if (!implScheme) {
    // Implementation not found - will be marked as free variable during inference
    return;
  }
  
  // Register it under the operator name
  ctx.env.set(opFuncName, implScheme);
}

function registerPrefixDeclaration(ctx: Context, decl: PrefixDeclaration) {
  // Register the prefix operator's implementation function
  const opFuncName = `__prefix_${decl.operator}`;
  
  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  if (!implScheme) {
    // Implementation not found - will be marked as free variable during inference
    return;
  }
  
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
      if (unify(ctx, fnType, annotated)) {
        fnType = applyCurrentSubst(ctx, annotated);
      } else {
        fnType = unknownType({ kind: "incomplete", reason: "annotation_unify_failed" });
      }
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
      const resolved = applyCurrentSubst(ctx, resultType);
      ctx.nodeTypes.set(block.result, resolved);
      ctx.nodeTypes.set(block, resolved);
      return resolved;
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
      // Unknown block statement kind - skip
      break;
  }
}

export function inferExpr(ctx: Context, expr: Expr): Type {
  switch (expr.kind) {
    case "identifier": {
      const scheme = ctx.env.get(expr.name);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, expr.name);
        ctx.nodeTypes.set(expr, mark.type);
        return mark.type;
      }
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
      return recordExprType(ctx, expr, instantiateAndApply(ctx, scheme));
    }
    case "literal":
      const litType = literalType(expr.literal);
      if (litType.kind === "unknown" && litType.provenance.kind === "incomplete" && litType.provenance.reason === "literal.unsupported") {
        const mark = markUnsupportedExpr(ctx, expr, "literal");
        return recordExprType(ctx, expr, mark.type);
      }
      return recordExprType(ctx, expr, litType);
    case "constructor": {
      const scheme = lookupEnv(ctx, expr.name);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, expr.name);
        return recordExprType(ctx, expr, mark.type);
      }
      const ctorType = instantiateAndApply(ctx, scheme);
      let result = ctorType;
      for (const arg of expr.args) {
        const argType = inferExpr(ctx, arg);
        const fnType = expectFunctionType(ctx, result, `Constructor ${expr.name}`);
        if (!fnType.success) {
          // This should be handled by marking, but for now continue with unknown
          return recordExprType(ctx, expr, unknownType({ kind: "incomplete", reason: "constructor_not_function" }));
        }
        unify(ctx, fnType.from, argType);
        result = fnType.to;
      }
      const applied = applyCurrentSubst(ctx, result);
      if (applied.kind === "func") {
        const calleeMarked = materializeExpr(ctx, expr);
        const argsMarked = expr.args.map((arg) => materializeExpr(ctx, arg));
        const mark = markNotFunction(ctx, expr, calleeMarked, argsMarked, applied);
        return recordExprType(ctx, expr, mark.type);
      }
      return recordExprType(ctx, expr, applied);
    }
    case "tuple": {
      const elements = expr.elements.map((el) => inferExpr(ctx, el));
      const tupleType = applyCurrentSubst(ctx, {
        kind: "tuple",
        elements: elements.map((t) => applyCurrentSubst(ctx, t)),
      });
      return recordExprType(ctx, expr, tupleType);
    }
    case "call": {
      let fnType = inferExpr(ctx, expr.callee);
      for (let index = 0; index < expr.arguments.length; index++) {
        const argExpr = expr.arguments[index];
        const argType = inferExpr(ctx, argExpr);
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
          /* console.debug("[debug] listMap arg type:", typeToString(applyCurrentSubst(ctx, argType)));
          console.log(
            "[debug] fnType before unify:",
            typeToString(applyCurrentSubst(ctx, fnType)),
          ); */
        }
        if (ctx.source?.includes("Runtime value printer for Workman using std library")) {
          /* console.debug("[debug] call callee:", calleeName); */
        }
        if (shouldLogFormatter) {
          /* console.debug("[debug] formatter call before unify", {
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
            argType: typeToString(applyCurrentSubst(ctx, argType)),
          }); */
        }
        try {
          unify(ctx, fnType, { kind: "func", from: argType, to: resultType });
        } catch (e) {
          const resolvedFn = applyCurrentSubst(ctx, fnType);
          const calleeMarked = materializeExpr(ctx, expr.callee);
          const argsMarked = expr.arguments.map((argument) => materializeExpr(ctx, argument));
          if (resolvedFn.kind !== "func") {
            const mark = markNotFunction(ctx, expr, calleeMarked, argsMarked, resolvedFn);
            return recordExprType(ctx, expr, mark.type);
          }

          const expectedArg = applyCurrentSubst(ctx, resolvedFn.from);
          const actualArg = applyCurrentSubst(ctx, argType);
          const subject = argsMarked[index];
          const mark = markInconsistent(ctx, expr, subject, expectedArg, actualArg);
          return recordExprType(ctx, expr, mark.type);
        }
        if (shouldLogFormatter) {
          /* console.debug("[debug] formatter call after unify", {
            resultType: typeToString(applyCurrentSubst(ctx, resultType)),
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
          }); */
        }
        fnType = applyCurrentSubst(ctx, resultType);
      }
      const callType = applyCurrentSubst(ctx, fnType);
      if (
        ctx.source?.includes("Runtime value printer for Workman using std library") &&
        ctx.source.slice(expr.span.start, expr.span.end).includes("listMap")
      ) {
        /* console.debug("[debug] listMap call type:", typeToString(callType));
        const fmtScheme = ctx.env.get("formatRuntimeValue");
        if (fmtScheme) {
          console.log(
            "[debug] formatRuntimeValue scheme after listMap:",
            formatScheme(applySubstitutionScheme(fmtScheme, ctx.subst)),
          );
        } */
      }
      return recordExprType(ctx, expr, callType);
    }
    case "arrow":
      return recordExprType(ctx, expr, inferArrowFunction(ctx, expr.parameters, expr.body));
    case "block": {
      const type = inferBlockExpr(ctx, expr);
      return recordExprType(ctx, expr, type);
    }
    case "match":
      return recordExprType(ctx, expr, inferMatchExpression(ctx, expr, expr.scrutinee, expr.bundle));
    case "match_fn":
      return recordExprType(ctx, expr, inferMatchFunction(ctx, expr, expr.parameters, expr.bundle));
    case "match_bundle_literal":
      return recordExprType(ctx, expr, inferMatchBundleLiteral(ctx, expr));
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
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, opFuncName);
        return recordExprType(ctx, expr, mark.type);
      }
      const opType = instantiateAndApply(ctx, scheme);
      
      // Apply the function to both arguments
      const resultType1 = freshTypeVar();
      if (!unify(ctx, opType, { kind: "func", from: leftType, to: { kind: "func", from: rightType, to: resultType1 } })) {
        return recordExprType(ctx, expr, unknownType({ kind: "incomplete", reason: "binary_unify_failed" }));
      }
      
      return recordExprType(ctx, expr, applyCurrentSubst(ctx, resultType1));
    }
    case "unary": {
      // Unary operators are desugared to function calls
      // e.g., `!x` becomes `not(x)` where `not` is the implementation function
      const operandType = inferExpr(ctx, expr.operand);
      
      // Look up the prefix operator's implementation function
      const opFuncName = `__prefix_${expr.operator}`;
      const scheme = lookupEnv(ctx, opFuncName);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, opFuncName);
        return recordExprType(ctx, expr, mark.type);
      }
      const opType = instantiateAndApply(ctx, scheme);
      
      // Apply the function to the operand
      const resultType = freshTypeVar();
      if (!unify(ctx, opType, { kind: "func", from: operandType, to: resultType })) {
        return recordExprType(ctx, expr, unknownType({ kind: "incomplete", reason: "unary_unify_failed" }));
      }
      
      return recordExprType(ctx, expr, applyCurrentSubst(ctx, resultType));
    }
    default:
      const mark = markUnsupportedExpr(ctx, expr, (expr as Expr).kind);
      return recordExprType(ctx, expr, mark.type);
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
    if (!target.has(name)) {
      target.set(name, type);
    }
    // If duplicate, skip (already marked the pattern)
  }
}

type PatternCoverage =
  | { kind: "wildcard" }
  | { kind: "constructor"; typeName: string; ctor: string }
  | { kind: "bool"; value: boolean }
  | { kind: "none" };

export interface PatternInfo {
  type: Type;
  bindings: Map<string, Type>;
  coverage: PatternCoverage;
  marked: MPattern;
}

export function inferPattern(ctx: Context, pattern: Pattern, expected: Type): PatternInfo {
  switch (pattern.kind) {
    case "wildcard": {
      const target = applyCurrentSubst(ctx, expected);
      return {
        type: target,
        bindings: new Map(),
        coverage: { kind: "wildcard" },
        marked: {
          kind: "wildcard",
          span: pattern.span,
          id: pattern.id,
          type: target,
        },
      };
    }
    case "variable": {
      const target = applyCurrentSubst(ctx, expected);
      const bindings = new Map<string, Type>();
      bindings.set(pattern.name, target);
      return {
        type: target,
        bindings,
        coverage: { kind: "wildcard" },
        marked: {
          kind: "variable",
          span: pattern.span,
          id: pattern.id,
          type: target,
          name: pattern.name,
        },
      };
    }
    case "literal": {
      const litType = literalType(pattern.literal);
      if (!unify(ctx, expected, litType)) {
        const markType = unknownFromReason("pattern.literal.unify_failed");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: { issue: "literal_unify_failed" },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const resolved = applyCurrentSubst(ctx, litType);
      return {
        type: resolved,
        bindings: new Map(),
        coverage:
          pattern.literal.kind === "bool"
            ? { kind: "bool", value: pattern.literal.value }
            : { kind: "none" },
        marked: {
          kind: "literal",
          span: pattern.span,
          id: pattern.id,
          type: resolved,
          literal: pattern.literal,
        },
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
        const markType = unknownFromReason("pattern.tuple.expected_tuple");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: {
            issue: "expected_tuple",
            actual: typeToString(resolved),
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      if (resolved.elements.length !== pattern.elements.length) {
        const markType = unknownFromReason("pattern.tuple.arity_mismatch");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: {
            issue: "tuple_arity",
            expected: resolved.elements.length,
            actual: pattern.elements.length,
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const bindings = new Map<string, Type>();
      const markedElements: MPattern[] = [];
      for (let i = 0; i < pattern.elements.length; i++) {
        const subPattern = pattern.elements[i];
        const elementType = resolved.elements[i];
        let info = inferPattern(ctx, subPattern, elementType);
        for (const [name, type] of info.bindings.entries()) {
          if (bindings.has(name)) {
            // Duplicate variable, mark the sub-pattern
            const markType = unknownFromReason(`pattern.duplicate_variable:${name}`);
            const mark: MMarkPattern = {
              kind: "mark_pattern",
              span: subPattern.span,
              id: subPattern.id,
              reason: "other",
              data: { issue: "duplicate_variable", name },
              type: markType,
            } satisfies MMarkPattern;
            info = {
              type: markType,
              bindings: new Map(),
              coverage: { kind: "none" },
              marked: mark,
            };
            break; // mark the whole sub-pattern
          }
        }
        mergeBindings(bindings, info.bindings);
        markedElements.push(info.marked);
      }
      return {
        type: resolved,
        bindings,
        coverage: { kind: "none" },
        marked: {
          kind: "tuple",
          span: pattern.span,
          id: pattern.id,
          type: resolved,
          elements: markedElements,
        },
      };
    }
    case "constructor": {
      const scheme = lookupEnv(ctx, pattern.name);
      if (!scheme) {
        const markType = unknownFromReason("pattern.constructor.not_found");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            issue: "not_found",
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const ctorType = instantiateAndApply(ctx, scheme);
      let current = ctorType;
      const bindings = new Map<string, Type>();
      const markedArgs: MPattern[] = [];
      for (const argPattern of pattern.args) {
        const fnType = expectFunctionType(ctx, current, `Constructor ${pattern.name}`);
        if (!fnType.success) {
          // Handle non-function constructor type
          const markType = unknownFromReason("pattern.constructor.not_function");
          const mark: MMarkPattern = {
            kind: "mark_pattern",
            span: pattern.span,
            id: pattern.id,
            reason: "wrong_constructor",
            data: {
              constructor: pattern.name,
              issue: "not_function",
            },
            type: markType,
          } satisfies MMarkPattern;
          return {
            type: markType,
            bindings: new Map(),
            coverage: { kind: "none" },
            marked: mark,
          };
        }
        let info = inferPattern(ctx, argPattern, fnType.from);
        for (const [name, type] of info.bindings.entries()) {
          if (bindings.has(name)) {
            // Duplicate variable, mark the arg pattern
            const markType = unknownFromReason(`pattern.duplicate_variable:${name}`);
            const mark: MMarkPattern = {
              kind: "mark_pattern",
              span: argPattern.span,
              id: argPattern.id,
              reason: "other",
              data: { issue: "duplicate_variable", name },
              type: markType,
            } satisfies MMarkPattern;
            info = {
              type: markType,
              bindings: new Map(),
              coverage: { kind: "none" },
              marked: mark,
            };
            break;
          }
        }
        mergeBindings(bindings, info.bindings);
        markedArgs.push(info.marked);
        current = fnType.to;
      }
      if (!unify(ctx, expected, current)) {
        const markType = unknownFromReason("pattern.constructor.unify_failed");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            issue: "unify_failed",
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings,
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const final = applyCurrentSubst(ctx, current);
      if (final.kind !== "constructor") {
        const markType = unknownFromReason("pattern.constructor.invalid_result");
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            actual: typeToString(final),
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings,
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      return {
        type: final,
        bindings,
        coverage: { kind: "constructor", typeName: final.name, ctor: pattern.name },
        marked: {
          kind: "constructor",
          span: pattern.span,
          id: pattern.id,
          type: final,
          name: pattern.name,
          args: markedArgs,
        },
      };
    }
    default:
      const markType = unknownFromReason("pattern.unsupported_kind");
      const mark: MMarkPattern = {
        kind: "mark_pattern",
        span: (pattern as Pattern).span,
        id: (pattern as Pattern).id,
        reason: "other",
        data: { issue: "unsupported_kind", kind: (pattern as Pattern).kind },
        type: markType,
      } satisfies MMarkPattern;
      return {
        type: markType,
        bindings: new Map(),
        coverage: { kind: "none" },
        marked: mark,
      };
  }
}

export function ensureExhaustive(
  ctx: Context,
  expr: Expr,
  scrutineeType: Type,
  hasWildcard: boolean,
  coverageMap: Map<string, Set<string>>,
  booleanCoverage: Set<"true" | "false">,
): void {
  if (hasWildcard) return;
  const resolved = applyCurrentSubst(ctx, scrutineeType);
  if (resolved.kind === "bool") {
    const missing: string[] = [];
    if (!booleanCoverage.has("true")) missing.push("true");
    if (!booleanCoverage.has("false")) missing.push("false");
    if (missing.length > 0) {
      markNonExhaustive(ctx, expr, expr.span, missing);
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
    markNonExhaustive(ctx, expr, expr.span, missing);
  }
}


