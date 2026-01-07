import type {
  BlockExpr,
  BlockStatement,
  Expr,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  Program,
} from "../ast.ts";
import { nextNodeId } from "../node_ids.ts";

export function lowerIndexAccess(program: Program): void {
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      lowerLetDeclaration(decl);
    }
  }
}

function lowerLetDeclaration(decl: LetDeclaration): void {
  lowerBlockExpr(decl.body);
  if (decl.mutualBindings) {
    for (const binding of decl.mutualBindings) {
      lowerLetDeclaration(binding);
    }
  }
}

function lowerBlockExpr(block: BlockExpr): void {
  for (const statement of block.statements) {
    lowerBlockStatement(statement);
  }
  if (block.result) {
    block.result = lowerExpr(block.result);
  }
}

function lowerBlockStatement(statement: BlockStatement): void {
  switch (statement.kind) {
    case "let_statement":
      lowerLetDeclaration(statement.declaration);
      return;
    case "pattern_let_statement":
      statement.initializer = lowerExpr(statement.initializer);
      return;
    case "expr_statement":
      statement.expression = lowerExpr(statement.expression);
      return;
  }
}

function lowerExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case "identifier":
    case "literal":
    case "hole":
      return expr;
    case "constructor":
      expr.args = expr.args.map((arg) => lowerExpr(arg));
      return expr;
    case "tuple":
      expr.elements = expr.elements.map((el) => lowerExpr(el));
      return expr;
    case "record_literal":
      for (const field of expr.fields) {
        field.value = lowerExpr(field.value);
      }
      return expr;
    case "call":
      expr.callee = lowerExpr(expr.callee);
      expr.arguments = expr.arguments.map((arg) => lowerExpr(arg));
      return expr;
    case "record_projection":
      expr.target = lowerExpr(expr.target);
      return expr;
    case "index": {
      const target = lowerExpr(expr.target);
      const index = lowerExpr(expr.index);
      const callee: Expr = {
        kind: "identifier",
        name: "read",
        span: { start: expr.span.start, end: expr.span.start },
        id: nextNodeId(),
      };
      return {
        kind: "call",
        callee,
        arguments: [target, index],
        span: expr.span,
        id: nextNodeId(),
      };
    }
    case "binary":
      expr.left = lowerExpr(expr.left);
      expr.right = lowerExpr(expr.right);
      return expr;
    case "unary":
      expr.operand = lowerExpr(expr.operand);
      return expr;
    case "arrow":
      lowerBlockExpr(expr.body);
      return expr;
    case "block":
      lowerBlockExpr(expr);
      return expr;
    case "if":
      expr.condition = lowerExpr(expr.condition);
      expr.thenBranch = lowerIfBranch(expr.thenBranch);
      expr.elseBranch = lowerIfBranch(expr.elseBranch);
      return expr;
    case "match":
      expr.scrutinee = lowerExpr(expr.scrutinee);
      lowerMatchBundle(expr.bundle);
      return expr;
    case "match_fn":
      expr.parameters = expr.parameters.map((param) => lowerExpr(param));
      lowerMatchBundle(expr.bundle);
      return expr;
    case "match_bundle_literal":
      lowerMatchBundle(expr.bundle);
      return expr;
    default:
      return expr;
  }
}

function lowerIfBranch(expr: Expr): Expr {
  if (expr.kind === "block") {
    lowerBlockExpr(expr);
    return expr;
  }
  return lowerExpr(expr);
}

function lowerMatchBundle(bundle: MatchBundle): void {
  for (const arm of bundle.arms) {
    lowerMatchArm(arm);
  }
}

function lowerMatchArm(arm: MatchArm): void {
  if (arm.kind === "match_pattern") {
    if (arm.guard) {
      arm.guard = lowerExpr(arm.guard);
    }
    if (arm.body.kind === "block") {
      lowerBlockExpr(arm.body);
    } else {
      arm.body = lowerExpr(arm.body);
    }
  }
}
