import {
  BlockExpr,
  BlockStatement,
  ConstructorAlias,
  Expr,
  NodeId,
  InfixDeclaration,
  LetDeclaration,
  MatchArm,
  MatchBundleLiteralExpr,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  TypeDeclaration,
  TypeExpr,
} from "../ast.ts";
import { lowerTupleParameters } from "../lower_tuple_params.ts";
import { canonicalizeMatch } from "../passes/canonicalize_match.ts";
import {
  applySubstitutionScheme,
  ConstructorInfo,
  freshTypeVar,
  Type,
  TypeEnv,
  TypeEnvADT,
  TypeScheme,
  typeToString,
  unknownType,
} from "../types.ts";
import { formatScheme } from "../type_printer.ts";
import type {
  MMarkPattern,
  MPattern,
  MProgram,
  MTopLevel,
  MTypeExpr,
} from "../ast_marked.ts";
import {
  applyCurrentSubst,
  Context,
  createContext,
  createUnknownAndRegister,
  expectFunctionType,
  generalizeInContext,
  holeOriginFromExpr,
  holeOriginFromPattern,
  inferError,
  InferOptions,
  InferResult,
  instantiateAndApply,
  literalType,
  lookupEnv,
  markFreeVariable,
  markInconsistent,
  markNonExhaustive,
  markNotFunction,
  markOccursCheck,
  markUnsupportedExpr,
  recordAnnotationConstraint,
  recordBooleanConstraint,
  recordCallConstraint,
  recordHasFieldConstraint,
  recordNumericConstraint,
  registerHoleForType,
  unify,
  withScopedEnv,
} from "./context.ts";
import {
  convertTypeExpr,
  registerPrelude,
  registerTypeConstructors,
  registerTypeName,
  resetTypeParamsCache,
} from "./declarations.ts";
import {
  inferMatchBundleLiteral,
  inferMatchExpression,
  inferMatchFunction,
} from "./infermatch.ts";
import { materializeExpr, materializeMarkedLet } from "./materialize.ts";

export type { Context, InferOptions, InferResult } from "./context.ts";
export { InferError } from "../error.ts";
export { inferError } from "./context.ts";

const NUMERIC_BINARY_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
]);

const COMPARISON_OPERATORS = new Set([
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
]);

const ORDERING_COMPARISON_OPERATORS = new Set([
  "<",
  "<=",
  ">",
  ">=",
]);

const BOOLEAN_BINARY_OPERATORS = new Set([
  "&&",
  "||",
]);

const NUMERIC_UNARY_OPERATORS = new Set([
  "+",
  "-",
]);

const BOOLEAN_UNARY_OPERATORS = new Set([
  "!",
]);

function expectParameterName(param: Parameter): string {
  if (!param.name) {
    throw inferError(
      "Internal error: missing parameter name after tuple lowering",
    );
  }
  return param.name;
}

function recordExprType(ctx: Context, expr: Expr, type: Type): Type {
  const resolved = applyCurrentSubst(ctx, type);
  if (resolved.kind === "unknown") {
    registerHoleForType(ctx, holeOriginFromExpr(expr), resolved);
  }
  ctx.nodeTypes.set(expr, resolved);
  return resolved;
}

function storeAnnotationType(
  ctx: Context,
  annotation: TypeExpr,
  type: Type,
): void {
  ctx.annotationTypes.set(annotation.id, applyCurrentSubst(ctx, type));
}

function resolveTypeForName(ctx: Context, name: string): Type | undefined {
  const scheme = ctx.env.get(name) ?? ctx.allBindings.get(name);
  if (!scheme) {
    return undefined;
  }
  const applied = applySubstitutionScheme(scheme, ctx.subst);
  return applied.type;
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

function inferLetDeclaration(
  ctx: Context,
  decl: LetDeclaration,
): { name: string; scheme: TypeScheme }[] {
  // Non-recursive case
  if (!decl.isRecursive) {
    let fnType = inferLetBinding(
      ctx,
      decl.parameters,
      decl.body,
      decl.annotation,
    );
    
    // Zero-parameter arrow functions () => { ... } should have type Unit -> T
    // But block expressions { ... } and block let statements should NOT be wrapped
    if (decl.isArrowSyntax && decl.parameters.length === 0) {
      fnType = {
        kind: "func",
        from: { kind: "unit" },
        to: fnType,
      };
    }
    
    const scheme = generalizeInContext(ctx, fnType);
    ctx.env.set(decl.name, scheme);
    if (
      decl.name === "zero" || decl.name === "describeNumber" ||
      decl.name === "grouped"
    ) {
      console.log(`[debug] scheme ${decl.name}`, {
        quantifiers: scheme.quantifiers,
        type: formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
      });
    }
    ctx.allBindings.set(decl.name, scheme); // Track in allBindings
    if (decl.annotation) {
      recordAnnotationConstraint(ctx, decl.id, decl.annotation, decl.body.result ?? decl.body);
    }
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
    const inferredType = inferLetBinding(
      ctx,
      binding.parameters,
      binding.body,
      binding.annotation,
    );
    inferredTypes.set(binding.name, inferredType);
  }

  // STEP 3: Unify pre-bound types with inferred types
  for (const binding of allBindings) {
    const preBound = preBoundTypes.get(binding.name)!;
    const inferred = inferredTypes.get(binding.name)!;
    unify(ctx, preBound, inferred);

    // Also check annotation if present
    if (binding.annotation) {
      const annotationType = convertTypeExpr(
        ctx,
        binding.annotation,
        new Map(),
      );
      storeAnnotationType(ctx, binding.annotation, annotationType);
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
    let inferredType = inferredTypes.get(binding.name)!;
    let resolvedType = applyCurrentSubst(ctx, inferredType);
    
    // Zero-parameter arrow functions () => { ... } should have type Unit -> T
    // But block expressions { ... } and block let statements should NOT be wrapped
    if (binding.isArrowSyntax && binding.parameters.length === 0) {
      resolvedType = {
        kind: "func",
        from: { kind: "unit" },
        to: resolvedType,
      };
    }
    
    const scheme = generalizeInContext(ctx, resolvedType);
    ctx.env.set(binding.name, scheme);
    ctx.allBindings.set(binding.name, scheme); // Track in allBindings
    results.push({ name: binding.name, scheme });
  }

  for (const binding of allBindings) {
    if (binding.annotation) {
      recordAnnotationConstraint(ctx, binding.id, binding.annotation, binding.body.result ?? binding.body);
    }
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
    param.annotation
      ? convertTypeExpr(ctx, param.annotation, annotationScope)
      : freshTypeVar()
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
    // Note: Zero-parameter bindings are NOT treated as functions here
    // They are just value bindings. Top-level zero-parameter functions
    // are handled separately in inferLetDeclaration.
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
      storeAnnotationType(ctx, annotation, annotated);
      if (unify(ctx, fnType, annotated)) {
        fnType = applyCurrentSubst(ctx, annotated);
      } else {
        const failure = ctx.lastUnifyFailure;
        const subject = materializeExpr(ctx, body.result ?? body);
        if (failure?.kind === "occurs_check") {
          const mark = markOccursCheck(
            ctx,
            body,
            subject,
            failure.left,
            failure.right,
          );
          fnType = mark.type;
        } else {
          const expected = applyCurrentSubst(ctx, annotated);
          const actual = applyCurrentSubst(ctx, fnType);
          const mark = markInconsistent(ctx, body, subject, expected, actual);
          fnType = mark.type;
        }
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

function inferArrowFunction(
  ctx: Context,
  parameters: Parameter[],
  body: BlockExpr,
): Type {
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
      // Zero-parameter function: () => body has type Unit -> bodyType
      return {
        kind: "func",
        from: { kind: "unit" },
        to: bodyType,
      };
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
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier formatRuntimeValue scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "listMap" &&
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier listMap scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "fromLiteral" &&
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier fromLiteral scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      const instantiated = instantiateAndApply(ctx, scheme);
      if (instantiated.kind === "unknown") {
        registerHoleForType(ctx, holeOriginFromExpr(expr), instantiated);
      }
      return recordExprType(ctx, expr, instantiated);
    }
    case "literal":
      const litType = literalType(expr.literal);
      if (
        litType.kind === "unknown" &&
        litType.provenance.kind === "incomplete" &&
        litType.provenance.reason === "literal.unsupported"
      ) {
        const mark = markUnsupportedExpr(ctx, expr, "literal");
        return recordExprType(ctx, expr, mark.type);
      }
      return recordExprType(ctx, expr, litType);
    case "hole": {
      // Explicit hole expression - create unknown type with expr_hole provenance
      const origin: HoleOrigin = {
        nodeId: expr.id,
        span: expr.span,
      };
      const provenance: Provenance = {
        kind: "expr_hole",
        id: expr.id,
      };
      const holeType = createUnknownAndRegister(ctx, origin, provenance);
      return recordExprType(ctx, expr, holeType);
    }
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
        const fnType = expectFunctionType(
          ctx,
          result,
          `Constructor ${expr.name}`,
        );
        if (!fnType.success) {
          // This should be handled by marking, but for now continue with unknown
          return recordExprType(
            ctx,
            expr,
            unknownType({
              kind: "incomplete",
              reason: "constructor_not_function",
            }),
          );
        }
        if (!unify(ctx, fnType.from, argType)) {
          const failure = ctx.lastUnifyFailure;
          const subject = materializeExpr(ctx, arg);
          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              expr,
              subject,
              failure.left,
              failure.right,
            );
            return recordExprType(ctx, expr, mark.type);
          }
          const resolvedFn = applyCurrentSubst(ctx, fnType.from);
          const resolvedArg = applyCurrentSubst(ctx, argType);
          const mark = markInconsistent(
            ctx,
            expr,
            subject,
            resolvedFn,
            resolvedArg,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        result = fnType.to;
      }
      const applied = applyCurrentSubst(ctx, result);
      if (applied.kind === "func") {
        const calleeMarked = materializeExpr(ctx, expr);
        const argsMarked = expr.args.map((arg) => materializeExpr(ctx, arg));
        const mark = markNotFunction(
          ctx,
          expr,
          calleeMarked,
          argsMarked,
          applied,
        );
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
    case "record_literal": {
      const fields = new Map<string, Type>();
      for (const field of expr.fields) {
        const fieldType = inferExpr(ctx, field.value);
        const resolvedFieldType = applyCurrentSubst(ctx, fieldType);
        if (fields.has(field.name)) {
          ctx.layer1Diagnostics.push({
            origin: field.id,
            reason: "duplicate_record_field",
            details: { field: field.name },
          });
          continue;
        }
        fields.set(field.name, resolvedFieldType);
      }
      return recordExprType(ctx, expr, { kind: "record", fields });
    }
    case "record_projection": {
      const targetType = inferExpr(ctx, expr.target);
      const resultType = freshTypeVar();
      recordHasFieldConstraint(ctx, expr, expr.target, expr.field, expr);
      registerHoleForType(
        ctx,
        holeOriginFromExpr(expr.target),
        applyCurrentSubst(ctx, targetType),
      );
      registerHoleForType(ctx, holeOriginFromExpr(expr), resultType);
      return recordExprType(ctx, expr, resultType);
    }
    case "call": {
      let fnType = inferExpr(ctx, expr.callee);
      
      // Handle zero-argument calls: f() should unify with Unit -> T
      if (expr.arguments.length === 0) {
        const resultType = freshTypeVar();
        registerHoleForType(
          ctx,
          holeOriginFromExpr(expr.callee),
          applyCurrentSubst(ctx, fnType),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), resultType);
        
        const unifySucceeded = unify(ctx, fnType, {
          kind: "func",
          from: { kind: "unit" },
          to: resultType,
        });
        
        if (!unifySucceeded) {
          const resolvedFn = applyCurrentSubst(ctx, fnType);
          if (
            resolvedFn.kind === "unknown" &&
            resolvedFn.provenance.kind === "incomplete"
          ) {
            fnType = applyCurrentSubst(ctx, resultType);
            return recordExprType(ctx, expr, fnType);
          }
          if (resolvedFn.kind !== "func") {
            const calleeMarked = materializeExpr(ctx, expr.callee);
            const mark = markNotFunction(
              ctx,
              expr,
              calleeMarked,
              [],
              resolvedFn,
            );
            return recordExprType(ctx, expr, mark.type);
          }
        }
        fnType = applyCurrentSubst(ctx, resultType);
        return recordExprType(ctx, expr, fnType);
      }
      
      for (let index = 0; index < expr.arguments.length; index++) {
        const argExpr = expr.arguments[index];
        const argType = inferExpr(ctx, argExpr);
        const resultType = freshTypeVar();
        // Ensure participating expressions are tracked as potential holes
        registerHoleForType(
          ctx,
          holeOriginFromExpr(expr.callee),
          applyCurrentSubst(ctx, fnType),
        );
        registerHoleForType(
          ctx,
          holeOriginFromExpr(argExpr),
          applyCurrentSubst(ctx, argType),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), resultType);
        const calleeIdentifierName = expr.callee.kind === "identifier"
          ? expr.callee.name
          : null;
        const calleeName = calleeIdentifierName ?? "<expression>";
        const shouldLogFormatter = calleeIdentifierName === "formatter";
        if (
          calleeIdentifierName === "listMap" &&
          ctx.source?.includes(
            "Runtime value printer for Workman using std library",
          )
        ) {
          /* console.debug("[debug] listMap arg type:", typeToString(applyCurrentSubst(ctx, argType)));
          console.log(
            "[debug] fnType before unify:",
            typeToString(applyCurrentSubst(ctx, fnType)),
          ); */
        }
        if (
          ctx.source?.includes(
            "Runtime value printer for Workman using std library",
          )
        ) {
          /* console.debug("[debug] call callee:", calleeName); */
        }
        if (shouldLogFormatter) {
          /* console.debug("[debug] formatter call before unify", {
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
            argType: typeToString(applyCurrentSubst(ctx, argType)),
          }); */
        }
        recordCallConstraint(
          ctx,
          expr,
          expr.callee,
          argExpr,
          expr,
          resultType,
          index,
        );
        const unifySucceeded = unify(ctx, fnType, {
          kind: "func",
          from: argType,
          to: resultType,
        });
        if (!unifySucceeded) {
          const resolvedFn = applyCurrentSubst(ctx, fnType);
          if (
            resolvedFn.kind === "unknown" &&
            resolvedFn.provenance.kind === "incomplete"
          ) {
            fnType = applyCurrentSubst(ctx, resultType);
            continue;
          }
          
          const failure = ctx.lastUnifyFailure;
          const calleeMarked = materializeExpr(ctx, expr.callee);
          const argsMarked = expr.arguments.map((argument) =>
            materializeExpr(ctx, argument)
          );
          const subject = argsMarked[index];

          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              expr,
              subject,
              failure.left,
              failure.right,
            );
            return recordExprType(ctx, expr, mark.type);
          }

          if (resolvedFn.kind !== "func") {
            const mark = markNotFunction(
              ctx,
              expr,
              calleeMarked,
              argsMarked,
              resolvedFn,
            );
            return recordExprType(ctx, expr, mark.type);
          }

          const expectedArg = applyCurrentSubst(ctx, resolvedFn.from);
          const actualArg = applyCurrentSubst(ctx, argType);
          const mark = markInconsistent(
            ctx,
            expr,
            subject,
            expectedArg,
            actualArg,
          );
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
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        ) &&
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
      return recordExprType(
        ctx,
        expr,
        inferArrowFunction(ctx, expr.parameters, expr.body),
      );
    case "block": {
      const type = inferBlockExpr(ctx, expr);
      return recordExprType(ctx, expr, type);
    }
    case "match":
      return recordExprType(
        ctx,
        expr,
        inferMatchExpression(ctx, expr, expr.scrutinee, expr.bundle),
      );
    case "match_fn":
      return recordExprType(
        ctx,
        expr,
        inferMatchFunction(ctx, expr, expr.parameters, expr.bundle),
      );
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
      if (NUMERIC_BINARY_OPERATORS.has(expr.operator)) {
        recordNumericConstraint(ctx, expr, [expr.left, expr.right], expr.operator);
      }
      if (COMPARISON_OPERATORS.has(expr.operator)) {
        if (ORDERING_COMPARISON_OPERATORS.has(expr.operator)) {
          recordNumericConstraint(ctx, expr, [expr.left, expr.right], expr.operator);
        }
        unify(ctx, resultType1, { kind: "bool" });
      }
      if (BOOLEAN_BINARY_OPERATORS.has(expr.operator)) {
        recordBooleanConstraint(ctx, expr, [expr.left, expr.right], expr.operator);
      }
      if (
        !unify(ctx, opType, {
          kind: "func",
          from: leftType,
          to: { kind: "func", from: rightType, to: resultType1 },
        })
      ) {
        const failure = ctx.lastUnifyFailure;
        if (failure?.kind === "occurs_check") {
          const mark = markOccursCheck(
            ctx,
            expr,
            materializeExpr(ctx, expr.left),
            failure.left,
            failure.right,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        const expected = applyCurrentSubst(ctx, opType);
        const mark = markInconsistent(
          ctx,
          expr,
          materializeExpr(ctx, expr.left),
          expected,
          applyCurrentSubst(ctx, leftType),
        );
        return recordExprType(ctx, expr, mark.type);
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
      if (NUMERIC_UNARY_OPERATORS.has(expr.operator)) {
        recordNumericConstraint(ctx, expr, [expr.operand], expr.operator);
      }
      if (BOOLEAN_UNARY_OPERATORS.has(expr.operator)) {
        recordBooleanConstraint(ctx, expr, [expr.operand], expr.operator);
      }
      if (
        !unify(ctx, opType, { kind: "func", from: operandType, to: resultType })
      ) {
        const failure = ctx.lastUnifyFailure;
        if (failure?.kind === "occurs_check") {
          const mark = markOccursCheck(
            ctx,
            expr,
            materializeExpr(ctx, expr.operand),
            failure.left,
            failure.right,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        const expected = applyCurrentSubst(ctx, opType);
        const mark = markInconsistent(
          ctx,
          expr,
          materializeExpr(ctx, expr.operand),
          expected,
          applyCurrentSubst(ctx, operandType),
        );
        return recordExprType(ctx, expr, mark.type);
      }

      return recordExprType(ctx, expr, applyCurrentSubst(ctx, resultType));
    }
    default:
      const mark = markUnsupportedExpr(ctx, expr, (expr as Expr).kind);
      return recordExprType(ctx, expr, mark.type);
  }
}

type PatternCoverage =
  | { kind: "wildcard" }
  | { kind: "constructor"; typeName: string; ctor: string }
  | { kind: "bool"; value: boolean }
  | { kind: "none" };

export function inferProgram(
  program: Program,
  options: InferOptions = {},
): InferResult {
  const canonicalProgram = canonicalizeMatch(program);
  lowerTupleParameters(canonicalProgram);
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
  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "type") {
      const result = registerTypeName(ctx, decl);
      if (!result.success) {
        markedDeclarations.push(result.mark);
      } else {
        successfulTypeDecls.add(decl);
      }
    }
  }

  if (ctx.topLevelMarks.length > 0) {
    markedDeclarations.push(...ctx.topLevelMarks);
  }

  // Pass 2: Register constructors (now all type names are known)
  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "type" && successfulTypeDecls.has(decl)) {
      const result = registerTypeConstructors(ctx, decl);
      if (!result.success) {
        markedDeclarations.push(result.mark);
        successfulTypeDecls.delete(decl); // Remove from successful set
      }
    }
  }

  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "let") {
      const results = inferLetDeclaration(ctx, decl);
      for (const { name, scheme } of results) {
        summaries.push({
          name,
          scheme: applySubstitutionScheme(scheme, ctx.subst),
        });
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

  const nodeTypeById: Map<NodeId, Type> = new Map();
  for (const [expr, type] of ctx.nodeTypes.entries()) {
    nodeTypeById.set(expr.id, applyCurrentSubst(ctx, type));
  }

  const markedProgram: MProgram = {
    imports: canonicalProgram.imports,
    reexports: canonicalProgram.reexports,
    declarations: markedDeclarations,
  };

  const typeExprMarks: Map<NodeId, MTypeExpr> = new Map();
  for (const [typeExpr, mark] of ctx.typeExprMarks.entries()) {
    typeExprMarks.set(typeExpr.id, mark);
  }

  /* console.debug("[debug] final substitution entries", Array.from(ctx.subst.entries()).map(([id, type]) => [id, formatScheme({ quantifiers: [], type })]));
  console.debug("[debug] final summaries", finalSummaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) })));
 */
  return {
    env: finalEnv,
    adtEnv: ctx.adtEnv,
    summaries: finalSummaries,
    allBindings: ctx.allBindings,
    markedProgram,
    marks: ctx.marks,
    typeExprMarks,
    holes: ctx.holes,
    constraintStubs: ctx.constraintStubs,
    nodeTypeById,
    marksVersion: 1,
    layer1Diagnostics: ctx.layer1Diagnostics,
  };
}

export function getExprTypeOrUnknown(
  ctx: Context,
  expr: Expr,
  reason: string,
): Type {
  return ctx.nodeTypes.get(expr) ?? unknownFromReason(reason);
}

export function unknownFromReason(reason: string): Type {
  return unknownType({ kind: "incomplete", reason });
}

export interface PatternInfo {
  type: Type;
  bindings: Map<string, Type>;
  coverage: PatternCoverage;
  marked: MPattern;
}

export function inferPattern(
  ctx: Context,
  pattern: Pattern,
  expected: Type,
): PatternInfo {
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.literal.unify_failed" },
        );
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
        coverage: pattern.literal.kind === "bool"
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.tuple.expected_tuple" },
        );
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.tuple.arity_mismatch" },
        );
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
            const markType = createUnknownAndRegister(
              ctx,
              holeOriginFromPattern(subPattern),
              {
                kind: "incomplete",
                reason: `pattern.duplicate_variable:${name}`,
              },
            );
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.not_found" },
        );
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
        const fnType = expectFunctionType(
          ctx,
          current,
          `Constructor ${pattern.name}`,
        );
        if (!fnType.success) {
          // Handle non-function constructor type
          const markType = createUnknownAndRegister(
            ctx,
            holeOriginFromPattern(pattern),
            { kind: "incomplete", reason: "pattern.constructor.not_function" },
          );
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
            const markType = unknownFromReason(
              `pattern.duplicate_variable:${name}`,
            );
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.unify_failed" },
        );
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
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.invalid_result" },
        );
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
        coverage: {
          kind: "constructor",
          typeName: final.name,
          ctor: pattern.name,
        },
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
      const markType = createUnknownAndRegister(
        ctx,
        holeOriginFromPattern(pattern as Pattern),
        { kind: "incomplete", reason: "pattern.unsupported_kind" },
      );
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
