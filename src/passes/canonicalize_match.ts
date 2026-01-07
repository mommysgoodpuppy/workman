import type {
  BlockExpr,
  BlockStatement,
  Expr,
  IdentifierExpr,
  IfExpr,
  LetDeclaration,
  Literal,
  MatchArm,
  MatchBundle,
  MatchFunctionExpr,
  Parameter,
  Pattern,
  Program,
  SourceSpan,
  TopLevel,
} from "../ast.ts";
import { nextNodeId } from "../node_ids.ts";

/**
 * Canonicalise the various match syntaxes (regular, first-class, bundles)
 * into a uniform internal representation.
 *
 * Currently only rewrites `match_fn` nodes into arrow functions that apply the
 * underlying bundle. Additional normalisations will be layered on over time.
 */
export function canonicalizeMatch(program: Program): Program {
  for (const declaration of program.declarations) {
    canonicalizeTopLevel(declaration);
  }
  return program;
}

function canonicalizeTopLevel(node: TopLevel): void {
  switch (node.kind) {
    case "let":
      for (const param of node.parameters) {
        canonicalizePattern(param.pattern);
      }
      canonicalizeLetDeclaration(node);
      break;
    case "type":
    case "record_decl":
    case "infix":
    case "prefix":
    case "infectious":
    case "domain":
    case "op":
    case "policy":
    case "annotate":
      // No expression children to canonicalise.
      break;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = node;
      void _exhaustive;
  }
}

function canonicalizeLetDeclaration(decl: LetDeclaration): void {
  const originalResult = decl.body.result;
  canonicalizeBlock(decl.body);
  if (
    originalResult &&
    originalResult.kind === "match_fn" &&
    decl.body.result?.kind === "arrow"
  ) {
    decl.isFirstClassMatch = true;
  }
}

function canonicalizeBlock(block: BlockExpr): void {
  for (const statement of block.statements) {
    canonicalizeStatement(statement);
  }
  if (block.result) {
    block.result = canonicalizeExpr(block.result);
  }
}

function canonicalizeStatement(statement: BlockStatement): void {
  switch (statement.kind) {
    case "let_statement":
      canonicalizeLetDeclaration(statement.declaration);
      break;
    case "pattern_let_statement":
      canonicalizePattern(statement.pattern);
      statement.initializer = canonicalizeExpr(statement.initializer);
      break;
    case "expr_statement":
      statement.expression = canonicalizeExpr(statement.expression);
      break;
    case "comment_statement":
      break;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = statement;
      void _exhaustive;
  }
}

function canonicalizeExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case "identifier":
    case "literal":
    case "hole":
    case "enum_literal":
      return expr;
    case "constructor":
      for (let index = 0; index < expr.args.length; index += 1) {
        expr.args[index] = canonicalizeExpr(expr.args[index]);
      }
      return expr;
    case "tuple":
      for (let index = 0; index < expr.elements.length; index += 1) {
        expr.elements[index] = canonicalizeExpr(expr.elements[index]);
      }
      return expr;
    case "list_literal":
      // List literals should be desugared before this pass, but handle them anyway
      for (let index = 0; index < expr.elements.length; index += 1) {
        expr.elements[index] = canonicalizeExpr(expr.elements[index]);
      }
      if (expr.spread) {
        expr.spread = canonicalizeExpr(expr.spread);
      }
      return expr;
    case "call":
      expr.callee = canonicalizeExpr(expr.callee);
      for (let index = 0; index < expr.arguments.length; index += 1) {
        expr.arguments[index] = canonicalizeExpr(expr.arguments[index]);
      }
      return expr;
    case "record_literal":
      for (const field of expr.fields) {
        field.value = canonicalizeExpr(field.value);
      }
      return expr;
    case "record_projection":
      expr.target = canonicalizeExpr(expr.target);
      return expr;
    case "index":
      expr.target = canonicalizeExpr(expr.target);
      expr.index = canonicalizeExpr(expr.index);
      return expr;
    case "binary":
      expr.left = canonicalizeExpr(expr.left);
      expr.right = canonicalizeExpr(expr.right);
      return expr;
    case "unary":
      expr.operand = canonicalizeExpr(expr.operand);
      return expr;
    case "arrow":
      for (const param of expr.parameters) {
        canonicalizePattern(param.pattern);
      }
      canonicalizeBlock(expr.body);
      return expr;
    case "block":
      canonicalizeBlock(expr);
      return expr;
    case "if":
      return rewriteIfExpression(expr);
    case "match":
      expr.scrutinee = canonicalizeExpr(expr.scrutinee);
      canonicalizeMatchBundle(expr.bundle);
      return expr;
    case "match_bundle_literal":
      canonicalizeMatchBundle(expr.bundle);
      return expr;
    case "match_fn":
      return rewriteMatchFunction(expr);
    case "type_as":
      expr.expression = canonicalizeExpr(expr.expression);
      return expr;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = expr;
      void _exhaustive;
      return expr;
  }
}

function canonicalizeMatchBundle(bundle: MatchBundle): void {
  for (const arm of bundle.arms) {
    canonicalizeMatchArm(arm);
  }
}

function canonicalizeMatchArm(arm: MatchArm): void {
  if (arm.kind === "match_pattern") {
    canonicalizePattern(arm.pattern);
    if (arm.guard) {
      arm.guard = canonicalizeExpr(arm.guard);
    }
    arm.body = canonicalizeExpr(arm.body);
  }
}

function canonicalizePattern(pattern: Pattern): void {
  switch (pattern.kind) {
    case "tuple":
      for (const element of pattern.elements) {
        canonicalizePattern(element);
      }
      break;
    case "constructor":
      for (const arg of pattern.args) {
        canonicalizePattern(arg);
      }
      break;
    case "list":
      // List patterns should be desugared before this pass, but handle them anyway
      for (const element of pattern.elements) {
        canonicalizePattern(element);
      }
      if (pattern.rest) {
        canonicalizePattern(pattern.rest);
      }
      break;
    case "variable":
    case "wildcard":
    case "literal":
    case "all_errors":
      break;
    default:
      const _exhaustive: never = pattern;
      void _exhaustive;
  }
}

function rewriteMatchFunction(expr: MatchFunctionExpr): Expr {
  // Normalise the parameter expression and bundle before rewriting.
  for (let index = 0; index < expr.parameters.length; index += 1) {
    expr.parameters[index] = canonicalizeExpr(expr.parameters[index]);
  }
  canonicalizeMatchBundle(expr.bundle);

  if (expr.parameters.length !== 1) {
    // Fallback: leave the node unchanged for now (existing pipeline will raise an error).
    return expr;
  }

  const parameterExpr = expr.parameters[0];
  const parameterSpan = parameterExpr.span ?? expr.span;
  const parameterName = parameterExpr.kind === "identifier"
    ? parameterExpr.name
    : generateSyntheticParameterName(expr);

  const parameterPattern: Pattern = {
    kind: "variable",
    name: parameterName,
    span: parameterSpan,
    id: nextNodeId(),
  };

  const parameterNode: Parameter = {
    kind: "parameter",
    pattern: parameterPattern,
    name: parameterName,
    annotation: undefined,
    span: parameterSpan,
    id: nextNodeId(),
  };

  const scrutinee: IdentifierExpr = {
    kind: "identifier",
    name: parameterName,
    span: parameterSpan,
    id: nextNodeId(),
  };

  const matchExpr = {
    kind: "match",
    scrutinee,
    bundle: expr.bundle,
    span: expr.span,
    id: nextNodeId(),
  } as const;

  const body: BlockExpr = {
    kind: "block",
    statements: [],
    result: matchExpr,
    span: expr.span,
    isMultiLine: false,
    id: nextNodeId(),
  };

  // Ensure any nested expressions introduced above are canonicalised.
  canonicalizeBlock(body);

  return {
    kind: "arrow",
    parameters: [parameterNode],
    body,
    span: expr.span,
    id: expr.id,
  };
}

function rewriteIfExpression(expr: IfExpr): Expr {
  const condition = canonicalizeExpr(expr.condition);
  const thenBranch = canonicalizeExpr(expr.thenBranch);
  const elseBranch = canonicalizeExpr(expr.elseBranch);

  const truePattern = createBoolPattern(true, condition.span);
  // Use wildcard for else branch - catches false and any other value
  const wildcardPattern: Pattern = {
    kind: "wildcard",
    span: condition.span,
    id: nextNodeId(),
  };

  const thenArm: MatchArm = {
    kind: "match_pattern",
    pattern: truePattern,
    body: thenBranch,
    hasTrailingComma: false,
    span: { start: truePattern.span.start, end: thenBranch.span.end },
    id: nextNodeId(),
  };

  const elseArm: MatchArm = {
    kind: "match_pattern",
    pattern: wildcardPattern,
    body: elseBranch,
    hasTrailingComma: false,
    span: { start: wildcardPattern.span.start, end: elseBranch.span.end },
    id: nextNodeId(),
  };

  const bundle: MatchBundle = {
    kind: "match_bundle",
    arms: [thenArm, elseArm],
    span: expr.span,
    id: nextNodeId(),
  };

  return {
    kind: "match",
    scrutinee: condition,
    bundle,
    span: expr.span,
    id: nextNodeId(),
  };
}

function createBoolPattern(value: boolean, span: SourceSpan): Pattern {
  const literal: Literal = {
    kind: "bool",
    value,
    span,
    id: nextNodeId(),
  };
  return {
    kind: "literal",
    literal,
    span,
    id: nextNodeId(),
  };
}

function generateSyntheticParameterName(expr: MatchFunctionExpr): string {
  return `__match_arg_${expr.id}`;
}
