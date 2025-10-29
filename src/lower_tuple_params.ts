import type {
  ArrowFunctionExpr,
  BlockExpr,
  Expr,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  Parameter,
  Pattern,
  Program,
  SourceSpan,
} from "./ast.ts";
import { nextNodeId, resetNodeIds } from "./node_ids.ts";

interface LoweringContext {
  counter: number;
}

export function lowerTupleParameters(program: Program): void {
  const ctx: LoweringContext = { counter: 0 };
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      lowerLetDeclaration(decl, ctx);
    }
  }
}

function lowerLetDeclaration(decl: LetDeclaration, ctx: LoweringContext): void {
  lowerLetBinding(decl, ctx);
  if (decl.mutualBindings) {
    for (const binding of decl.mutualBindings) {
      lowerLetBinding(binding, ctx);
    }
  }
}

function lowerLetBinding(binding: LetDeclaration, ctx: LoweringContext): void {
  lowerBlockExpr(binding.body, ctx);
  const lowered = lowerFunctionParameters(binding.parameters, binding.body, ctx);
  binding.parameters = lowered.parameters;
  binding.body = lowered.body;
}

function lowerBlockExpr(block: BlockExpr, ctx: LoweringContext): void {
  for (const statement of block.statements) {
    switch (statement.kind) {
      case "let_statement":
        lowerLetDeclaration(statement.declaration, ctx);
        break;
      case "expr_statement":
        lowerExpr(statement.expression, ctx);
        break;
    }
  }
  if (block.result) {
    lowerExpr(block.result, ctx);
  }
}

function lowerExpr(expr: Expr, ctx: LoweringContext): void {
  switch (expr.kind) {
    case "identifier":
    case "literal":
      return;
    case "constructor":
      for (const arg of expr.args) {
        lowerExpr(arg, ctx);
      }
      return;
    case "tuple":
      for (const element of expr.elements) {
        lowerExpr(element, ctx);
      }
      return;
    case "call":
      lowerExpr(expr.callee, ctx);
      for (const argument of expr.arguments) {
        lowerExpr(argument, ctx);
      }
      return;
    case "block":
      lowerBlockExpr(expr, ctx);
      return;
    case "arrow":
      lowerArrowFunction(expr, ctx);
      return;
    case "match":
      lowerExpr(expr.scrutinee, ctx);
      for (const arm of expr.bundle.arms) {
        if (arm.kind !== "match_pattern") {
          continue;
        }
        if (arm.body.kind === "block") {
          lowerBlockExpr(arm.body, ctx);
        } else {
          lowerExpr(arm.body, ctx);
        }
      }
      return;
    case "match_fn":
      for (const parameterExpr of expr.parameters) {
        lowerExpr(parameterExpr, ctx);
      }
      for (const arm of expr.bundle.arms) {
        if (arm.kind !== "match_pattern") {
          continue;
        }
        if (arm.body.kind === "block") {
          lowerBlockExpr(arm.body, ctx);
        } else {
          lowerExpr(arm.body, ctx);
        }
      }
      return;
    case "match_bundle_literal":
      for (const arm of expr.bundle.arms) {
        if (arm.kind !== "match_pattern") {
          continue;
        }
        if (arm.body.kind === "block") {
          lowerBlockExpr(arm.body, ctx);
        } else {
          lowerExpr(arm.body, ctx);
        }
      }
      return;
    default:
      return;
  }
}

function lowerArrowFunction(expr: ArrowFunctionExpr, ctx: LoweringContext): void {
  lowerBlockExpr(expr.body, ctx);
  const lowered = lowerFunctionParameters(expr.parameters, expr.body, ctx);
  expr.parameters = lowered.parameters;
  expr.body = lowered.body;
}

interface LoweredFunction {
  parameters: Parameter[];
  body: BlockExpr;
}

function lowerFunctionParameters(
  parameters: Parameter[],
  body: BlockExpr,
  ctx: LoweringContext,
): LoweredFunction {
  if (parameters.length === 0) {
    return { parameters, body };
  }

  let needsLowering = false;
  for (const param of parameters) {
    if (param.pattern.kind !== "variable") {
      needsLowering = true;
      break;
    }
  }

  const normalizedParams: Parameter[] = new Array(parameters.length);
  for (let index = 0; index < parameters.length; index += 1) {
    const param = parameters[index];
    if (param.pattern.kind === "variable") {
      const name = param.pattern.name;
      normalizedParams[index] = {
        kind: "parameter",
        pattern: { kind: "variable", name, span: param.pattern.span, id: nextNodeId() },
        name,
        annotation: param.annotation,
        span: param.span,
        id: nextNodeId(),
      };
    } else {
      const name = freshParamName(ctx);
      normalizedParams[index] = {
        kind: "parameter",
        pattern: { kind: "variable", name, span: param.pattern.span, id: nextNodeId() },
        name,
        annotation: param.annotation,
        span: param.span,
        id: nextNodeId(),
      };
    }
  }

  if (!needsLowering) {
    return { parameters: normalizedParams, body };
  }

  let currentBody = body;
  for (let index = parameters.length - 1; index >= 0; index -= 1) {
    const original = parameters[index];
    if (original.pattern.kind === "variable") {
      continue;
    }
    const targetName = normalizedParams[index].name!;
    currentBody = wrapWithMatch(original.pattern, targetName, currentBody);
  }

  return { parameters: normalizedParams, body: currentBody };
}

function wrapWithMatch(pattern: Pattern, tempName: string, body: BlockExpr): BlockExpr {
  const scrutineeSpan = pattern.span;
  const scrutinee = {
    kind: "identifier" as const,
    name: tempName,
    span: scrutineeSpan,
    id: nextNodeId(),
  };

  const armSpan: SourceSpan = {
    start: pattern.span.start,
    end: body.span.end,
  };

  const arm: MatchArm = {
    kind: "match_pattern",
    pattern,
    body,
    hasTrailingComma: false,
    span: armSpan,
    id: nextNodeId(),
  };

  const matchSpan: SourceSpan = {
    start: body.span.start,
    end: body.span.end,
  };

  const bundle: MatchBundle = {
    kind: "match_bundle",
    arms: [arm],
    span: matchSpan,
    id: nextNodeId(),
  };

  const matchExpr = {
    kind: "match" as const,
    scrutinee,
    bundle,
    span: matchSpan,
    id: nextNodeId(),
  };

  return {
    kind: "block",
    statements: [],
    result: matchExpr,
    span: matchSpan,
    id: nextNodeId(),
  };
}

function freshParamName(ctx: LoweringContext): string {
  const name = `__param${ctx.counter}`;
  ctx.counter += 1;
  return name;
}
