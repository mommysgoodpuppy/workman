import type {
  BlockExpr,
  BlockStatement,
  Expr,
  ExprStatement,
  LetDeclaration,
  MatchBundle,
  Parameter,
  Pattern,
  TypeExpr,
} from "../ast.ts";
import type {
  MBlockExpr,
  MBlockStatement,
  MExpr,
  MExprStatement,
  MLetDeclaration,
  MLetStatement,
  MMarkPattern,
  MMatchArm,
  MMatchBundle,
  MMatchBundleReferenceArm,
  MMatchPatternArm,
  MParameter,
  MPattern,
  MTypeExpr,
} from "../ast_marked.ts";
import type { Type } from "../types.ts";
import {
  type Context,
  holeOriginFromExpr,
  holeOriginFromPattern,
  literalType,
  registerHoleForType,
} from "./context.ts";
import { convertTypeExpr } from "./declarations.ts";
import { getExprTypeOrUnknown, unknownFromReason } from "./infer_utils.ts";

export function materializeMatchBundle(
  ctx: Context,
  bundle: MatchBundle,
  inferredType?: Type,
): MMatchBundle {
  const matchResult = ctx.matchResults.get(bundle);
  const patternInfos = matchResult?.patternInfos ?? [];
  const resolvedBundleType = matchResult?.type ?? inferredType ??
    unknownFromReason("match.bundle");
  const effectRowCoverage = matchResult?.effectRowCoverage
    ? {
      row: matchResult.effectRowCoverage.effectRow,
      coveredConstructors: Array.from(
        matchResult.effectRowCoverage.coveredConstructors,
      ).filter((ctor) => ctor !== "_"),
      coversTail: matchResult.effectRowCoverage.coversTail,
      missingConstructors: matchResult.effectRowCoverage.missingConstructors,
    }
    : undefined;
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
    effectRowCoverage: effectRowCoverage,
    dischargesResult: matchResult?.dischargesResult ?? false,
  } satisfies MMatchBundle;
}

export function materializeBlockExpr(
  ctx: Context,
  block: BlockExpr,
): MBlockExpr {
  const statements = block.statements.map((statement) =>
    materializeBlockStatement(ctx, statement)
  );
  const result = block.result ? materializeExpr(ctx, block.result) : undefined;
  const type = ctx.nodeTypes.get(block.id) ??
    (result ? result.type : { kind: "unit" as const });
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

export function materializeBlockStatement(
  ctx: Context,
  statement: BlockStatement,
): MBlockStatement {
  switch (statement.kind) {
    case "let_statement":
      return {
        kind: "let_statement",
        span: statement.span,
        id: statement.id,
        declaration: materializeMarkedLet(
          ctx,
          statement.declaration,
          undefined,
        ),
      } satisfies MLetStatement;
    case "pattern_let_statement":
      return {
        kind: "pattern_let_statement",
        span: statement.span,
        id: statement.id,
        pattern: materializePattern(ctx, statement.pattern),
        initializer: materializeExpr(ctx, statement.initializer),
      };
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

export function materializeExpr(ctx: Context, expr: Expr): MExpr {
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
      const elements = expr.elements.map((element) =>
        materializeExpr(ctx, element)
      );
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
    case "record_literal": {
      const fields = expr.fields.map((field) => ({
        kind: "record_field" as const,
        span: field.span,
        id: field.id,
        name: field.name,
        value: materializeExpr(ctx, field.value),
        hasTrailingComma: field.hasTrailingComma,
      }));
      const type = getExprTypeOrUnknown(ctx, expr, "expr.record_literal");
      return {
        kind: "record_literal",
        span: expr.span,
        id: expr.id,
        fields,
        isMultiLine: expr.isMultiLine,
        type,
      };
    }
    case "record_projection": {
      const target = materializeExpr(ctx, expr.target);
      const type = getExprTypeOrUnknown(
        ctx,
        expr,
        `expr.record_projection:${expr.field}`,
      );
      registerHoleForType(ctx, holeOriginFromExpr(expr), type);
      return {
        kind: "record_projection",
        span: expr.span,
        id: expr.id,
        target,
        field: expr.field,
        type,
      };
    }
    case "call": {
      const callee = materializeExpr(ctx, expr.callee);
      const args = expr.arguments.map((arg) => materializeExpr(ctx, arg));
      const type = getExprTypeOrUnknown(ctx, expr, "expr.call");
      registerHoleForType(ctx, holeOriginFromExpr(expr), type);
      return {
        kind: "call",
        span: expr.span,
        id: expr.id,
        callee,
        arguments: args,
        type,
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
      const parameters = expr.parameters.map((param) =>
        materializeParameter(ctx, param)
      );
      const body = materializeBlockExpr(ctx, expr.body);
      return {
        kind: "arrow",
        span: expr.span,
        id: expr.id,
        parameters,
        body,
        returnAnnotation: expr.returnAnnotation
          ? materializeTypeExpr(ctx, expr.returnAnnotation)
          : undefined,
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
      const parameters = expr.parameters.map((param) =>
        materializeExpr(ctx, param)
      );
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

export function materializeMarkedLet(
  ctx: Context,
  decl: LetDeclaration,
  resolvedType: Type | undefined,
): MLetDeclaration {
  const parameters = decl.parameters.map((param) =>
    materializeParameter(ctx, param)
  );
  const body = materializeBlockExpr(ctx, decl.body);
  const type = resolvedType ?? unknownFromReason(`let:${decl.name}`);

  const marked: MLetDeclaration = {
    kind: "let",
    span: decl.span,
    id: decl.id,
    name: decl.name,
    nameSpan: decl.nameSpan,
    parameters,
    annotation: decl.annotation
      ? materializeTypeExpr(ctx, decl.annotation)
      : undefined,
    returnAnnotation: decl.returnAnnotation
      ? materializeTypeExpr(ctx, decl.returnAnnotation)
      : undefined,
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

export function materializeParameter(
  ctx: Context,
  param: Parameter,
): MParameter {
  const pattern = materializePattern(ctx, param.pattern);
  const annotationScope = new Map<string, Type>();
  const explicitType = param.annotation
    ? convertTypeExpr(ctx, param.annotation, annotationScope)
    : undefined;
  const type = explicitType ?? pattern.type ??
    unknownFromReason(`parameter:${param.name ?? "_"}`);
  return {
    kind: "parameter",
    span: param.span,
    id: param.id,
    pattern,
    name: param.name,
    annotation: param.annotation
      ? materializeTypeExpr(ctx, param.annotation)
      : undefined,
    type,
  };
}

export function materializePattern(ctx: Context, pattern: Pattern): MPattern {
  switch (pattern.kind) {
    case "wildcard": {
      const type = unknownFromReason("pattern.wildcard");
      registerHoleForType(ctx, holeOriginFromPattern(pattern), type);
      return {
        kind: "wildcard",
        span: pattern.span,
        id: pattern.id,
        type,
      };
    }
    case "variable": {
      const type = unknownFromReason(`pattern.var:${pattern.name}`);
      registerHoleForType(ctx, holeOriginFromPattern(pattern), type);
      return {
        kind: "variable",
        span: pattern.span,
        id: pattern.id,
        name: pattern.name,
        type,
      };
    }
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
      const elements = pattern.elements.map((element) =>
        materializePattern(ctx, element)
      );
      const type: Type = {
        kind: "tuple",
        elements: elements.map((el) =>
          el.type ?? unknownFromReason("pattern.tuple.elem")
        ),
      };
      registerHoleForType(ctx, holeOriginFromPattern(pattern), type);
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
        args: args.map((arg) =>
          arg.type ?? unknownFromReason("pattern.constructor.arg")
        ),
      };
      registerHoleForType(ctx, holeOriginFromPattern(pattern), type);
      return {
        kind: "constructor",
        span: pattern.span,
        id: pattern.id,
        name: pattern.name,
        args,
        type,
      };
    }
    case "all_errors": {
      const type = unknownFromReason("pattern.all_errors");
      registerHoleForType(ctx, holeOriginFromPattern(pattern), type);
      return {
        kind: "all_errors",
        span: pattern.span,
        id: pattern.id,
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

export function materializeTypeExpr(
  ctx: Context,
  typeExpr: TypeExpr,
): MTypeExpr {
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
        parameters: typeExpr.parameters.map((param) =>
          materializeTypeExpr(ctx, param)
        ),
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
    case "type_record":
      return {
        kind: "type_record",
        span: typeExpr.span,
        id: typeExpr.id,
        fields: typeExpr.fields.map((field) => ({
          kind: "type_record_field" as const,
          span: field.span,
          id: field.id,
          name: field.name,
          type: materializeTypeExpr(ctx, field.type),
          hasTrailingComma: field.hasTrailingComma,
        })),
      };
    case "type_unit":
      return {
        kind: "type_unit",
        span: typeExpr.span,
        id: typeExpr.id,
      };
    case "type_effect_row":
      return {
        kind: "type_effect_row",
        span: typeExpr.span,
        id: typeExpr.id,
        hasTailWildcard: typeExpr.hasTailWildcard,
        cases: typeExpr.cases.map((entry) => ({
          kind: "type_effect_row_case",
          span: entry.span,
          id: entry.id,
          name: entry.name,
          payload: entry.payload
            ? materializeTypeExpr(ctx, entry.payload)
            : undefined,
        })),
      };
  }
}
