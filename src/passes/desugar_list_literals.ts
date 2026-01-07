import type {
  BlockExpr,
  BlockStatement,
  Expr,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  Parameter,
  Pattern,
  Program,
  SourceSpan,
  TopLevel,
} from "../ast.ts";
import { nextNodeId } from "../node_ids.ts";

/**
 * Desugar list literal syntax into constructor calls.
 *
 * Expressions:
 *   [1, 2, 3]           => Link(1, Link(2, Link(3, Empty)))
 *   [a, b, ...rest]     => Link(a, Link(b, rest))
 *
 * Patterns:
 *   [a, b, c]           => Link(a, Link(b, Link(c, Empty)))
 *   [first, ...rest]    => Link(first, rest)
 *   [a, b, ..._]        => Link(a, Link(b, _))
 */
export function desugarListLiterals(program: Program): Program {
  for (const declaration of program.declarations) {
    desugarTopLevel(declaration);
  }
  return program;
}

function desugarTopLevel(node: TopLevel): void {
  switch (node.kind) {
    case "let":
      for (const param of node.parameters) {
        param.pattern = desugarPattern(param.pattern);
      }
      desugarLetDeclaration(node);
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
      // No expression children to desugar.
      break;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = node;
      void _exhaustive;
  }
}

function desugarLetDeclaration(decl: LetDeclaration): void {
  desugarBlock(decl.body);
}

function desugarBlock(block: BlockExpr): void {
  for (const statement of block.statements) {
    desugarStatement(statement);
  }
  if (block.result) {
    block.result = desugarExpr(block.result);
  }
}

function desugarStatement(statement: BlockStatement): void {
  switch (statement.kind) {
    case "let_statement":
      desugarLetDeclaration(statement.declaration);
      break;
    case "pattern_let_statement":
      statement.pattern = desugarPattern(statement.pattern);
      statement.initializer = desugarExpr(statement.initializer);
      break;
    case "expr_statement":
      statement.expression = desugarExpr(statement.expression);
      break;
    case "comment_statement":
      break;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = statement;
      void _exhaustive;
  }
}

function desugarExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case "identifier":
    case "literal":
    case "hole":
    case "enum_literal":
      return expr;
    case "constructor":
      for (let i = 0; i < expr.args.length; i++) {
        expr.args[i] = desugarExpr(expr.args[i]);
      }
      return expr;
    case "tuple":
      for (let i = 0; i < expr.elements.length; i++) {
        expr.elements[i] = desugarExpr(expr.elements[i]);
      }
      return expr;
    case "list_literal":
      return desugarListLiteralExpr(expr);
    case "call":
      expr.callee = desugarExpr(expr.callee);
      for (let i = 0; i < expr.arguments.length; i++) {
        expr.arguments[i] = desugarExpr(expr.arguments[i]);
      }
      return expr;
    case "record_literal":
      for (const field of expr.fields) {
        field.value = desugarExpr(field.value);
      }
      return expr;
    case "record_projection":
      expr.target = desugarExpr(expr.target);
      return expr;
    case "index":
      expr.target = desugarExpr(expr.target);
      expr.index = desugarExpr(expr.index);
      return expr;
    case "binary":
      expr.left = desugarExpr(expr.left);
      expr.right = desugarExpr(expr.right);
      return expr;
    case "unary":
      expr.operand = desugarExpr(expr.operand);
      return expr;
    case "arrow":
      for (const param of expr.parameters) {
        param.pattern = desugarPattern(param.pattern);
      }
      desugarBlock(expr.body);
      return expr;
    case "block":
      desugarBlock(expr);
      return expr;
    case "if":
      expr.condition = desugarExpr(expr.condition);
      expr.thenBranch = desugarExpr(expr.thenBranch);
      expr.elseBranch = desugarExpr(expr.elseBranch);
      return expr;
    case "match":
      expr.scrutinee = desugarExpr(expr.scrutinee);
      desugarMatchBundle(expr.bundle);
      return expr;
    case "match_bundle_literal":
      desugarMatchBundle(expr.bundle);
      return expr;
    case "match_fn":
      for (let i = 0; i < expr.parameters.length; i++) {
        expr.parameters[i] = desugarExpr(expr.parameters[i]);
      }
      desugarMatchBundle(expr.bundle);
      return expr;
    case "type_as":
      expr.expression = desugarExpr(expr.expression);
      return expr;
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = expr;
      void _exhaustive;
      return expr;
  }
}

function desugarMatchBundle(bundle: MatchBundle): void {
  for (const arm of bundle.arms) {
    desugarMatchArm(arm);
  }
}

function desugarMatchArm(arm: MatchArm): void {
  if (arm.kind === "match_pattern") {
    arm.pattern = desugarPattern(arm.pattern);
    if (arm.guard) {
      arm.guard = desugarExpr(arm.guard);
    }
    arm.body = desugarExpr(arm.body);
  }
}

function desugarPattern(pattern: Pattern): Pattern {
  switch (pattern.kind) {
    case "wildcard":
    case "variable":
    case "literal":
    case "all_errors":
      return pattern;
    case "tuple":
      for (let i = 0; i < pattern.elements.length; i++) {
        pattern.elements[i] = desugarPattern(pattern.elements[i]);
      }
      return pattern;
    case "constructor":
      for (let i = 0; i < pattern.args.length; i++) {
        pattern.args[i] = desugarPattern(pattern.args[i]);
      }
      return pattern;
    case "list":
      return desugarListPattern(pattern);
    default:
      // Exhaustiveness guard.
      const _exhaustive: never = pattern;
      void _exhaustive;
      return pattern;
  }
}

/**
 * Desugar list literal expression:
 *   [1, 2, 3]       => Link(1, Link(2, Link(3, Empty)))
 *   [a, b, ...rest] => Link(a, Link(b, rest))
 */
function desugarListLiteralExpr(
  expr: Expr & { kind: "list_literal" },
): Expr {
  const { elements, spread, span } = expr;

  // Build the list from right to left
  // Start with the tail: either Empty or the spread expression
  let result: Expr;
  if (spread) {
    result = desugarExpr(spread);
  } else {
    result = makeEmpty(span);
  }

  // Wrap each element in Link, from right to left
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = desugarExpr(elements[i]);
    result = makeLink(element, result, span);
  }

  return result;
}

/**
 * Desugar list pattern:
 *   [a, b, c]        => Link(a, Link(b, Link(c, Empty)))
 *   [first, ...rest] => Link(first, rest)
 *   [a, b, ..._]     => Link(a, Link(b, _))
 */
function desugarListPattern(
  pattern: Pattern & { kind: "list" },
): Pattern {
  const { elements, rest, span } = pattern;

  // Build the pattern from right to left
  // Start with the tail: either Empty pattern or the rest pattern
  let result: Pattern;
  if (rest) {
    result = desugarPattern(rest);
  } else {
    result = makeEmptyPattern(span);
  }

  // Wrap each element in Link pattern, from right to left
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = desugarPattern(elements[i]);
    result = makeLinkPattern(element, result, span);
  }

  return result;
}

// Helper functions to create AST nodes

function makeEmpty(span: SourceSpan): Expr {
  return {
    kind: "constructor",
    name: "Empty",
    args: [],
    span,
    id: nextNodeId(),
  };
}

function makeLink(head: Expr, tail: Expr, span: SourceSpan): Expr {
  return {
    kind: "constructor",
    name: "Link",
    args: [head, tail],
    span,
    id: nextNodeId(),
  };
}

function makeEmptyPattern(span: SourceSpan): Pattern {
  return {
    kind: "constructor",
    name: "Empty",
    args: [],
    span,
    id: nextNodeId(),
  };
}

function makeLinkPattern(
  head: Pattern,
  tail: Pattern,
  span: SourceSpan,
): Pattern {
  return {
    kind: "constructor",
    name: "Link",
    args: [head, tail],
    span,
    id: nextNodeId(),
  };
}
