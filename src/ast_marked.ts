import type {
  CommentBlock,
  ExportModifier,
  InfixDeclaration,
  Literal,
  ModuleImport,
  ModuleReexport,
  NodeId,
  PrefixDeclaration,
  SourceSpan,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import type { Type } from "./types.ts";

interface MNodeBase {
  span: SourceSpan;
  id: NodeId;
}

export interface MTypedNode extends MNodeBase {
  type: Type;
}

export interface MIdentifierExpr extends MTypedNode {
  kind: "identifier";
  name: string;
}

export interface MLiteralExpr extends MTypedNode {
  kind: "literal";
  literal: Literal;
}

export interface MConstructorExpr extends MTypedNode {
  kind: "constructor";
  name: string;
  args: MExpr[];
}

export interface MTupleExpr extends MTypedNode {
  kind: "tuple";
  elements: MExpr[];
  isMultiLine?: boolean;
}

export interface MCallExpr extends MTypedNode {
  kind: "call";
  callee: MExpr;
  arguments: MExpr[];
}

export interface MBinaryExpr extends MTypedNode {
  kind: "binary";
  operator: string;
  left: MExpr;
  right: MExpr;
}

export interface MUnaryExpr extends MTypedNode {
  kind: "unary";
  operator: string;
  operand: MExpr;
}

export interface MParameter extends MTypedNode {
  kind: "parameter";
  pattern: MPattern;
  name?: string;
  annotation?: TypeExpr;
}

export interface MArrowFunctionExpr extends MTypedNode {
  kind: "arrow";
  parameters: MParameter[];
  body: MBlockExpr;
}

export interface MBlockExpr extends MTypedNode {
  kind: "block";
  statements: MBlockStatement[];
  result?: MExpr;
  isMultiLine?: boolean;
}

export type MBlockStatement = MLetStatement | MExprStatement;

export function blockStatementFrom(expr: MExpr): MExprStatement {
  return {
    kind: "expr_statement",
    span: expr.span,
    id: expr.id,
    expression: expr,
  };
}

export interface MLetStatement extends MNodeBase {
  kind: "let_statement";
  declaration: MLetDeclaration;
}

export interface MExprStatement extends MNodeBase {
  kind: "expr_statement";
  expression: MExpr;
}

export interface MMatchBundle extends MTypedNode {
  kind: "match_bundle";
  arms: MMatchArm[];
}

export type MMatchArm = MMatchPatternArm | MMatchBundleReferenceArm;

export interface MMatchPatternArm extends MNodeBase {
  kind: "match_pattern";
  pattern: MPattern;
  body: MExpr;
  hasTrailingComma: boolean;
  type: Type;
}

export interface MMatchBundleReferenceArm extends MNodeBase {
  kind: "match_bundle_reference";
  name: string;
  hasTrailingComma: boolean;
}

export interface MMatchExpr extends MTypedNode {
  kind: "match";
  scrutinee: MExpr;
  bundle: MMatchBundle;
}

export interface MMatchFunctionExpr extends MTypedNode {
  kind: "match_fn";
  parameters: MExpr[];
  bundle: MMatchBundle;
}

export interface MMatchBundleLiteralExpr extends MTypedNode {
  kind: "match_bundle_literal";
  bundle: MMatchBundle;
}

export interface MMarkFreeVar extends MTypedNode {
  kind: "mark_free_var";
  name: string;
}

export interface MMarkNotFunction extends MTypedNode {
  kind: "mark_not_function";
  callee: MExpr;
  args: MExpr[];
  calleeType: Type;
}

export interface MMarkUnsupportedExpr extends MTypedNode {
  kind: "mark_unsupported_expr";
  exprKind: string;
}

export interface MMarkInconsistent extends MTypedNode {
  kind: "mark_inconsistent";
}

export type MMarkExpr = MMarkFreeVar | MMarkNotFunction | MMarkInconsistent | MMarkUnsupportedExpr;

export type MExpr =
  | MIdentifierExpr
  | MLiteralExpr
  | MConstructorExpr
  | MTupleExpr
  | MCallExpr
  | MBinaryExpr
  | MUnaryExpr
  | MArrowFunctionExpr
  | MBlockExpr
  | MMatchExpr
  | MMatchFunctionExpr
  | MMatchBundleLiteralExpr
  | MMarkExpr;

export type MPattern =
  | MWildcardPattern
  | MVariablePattern
  | MLiteralPattern
  | MConstructorPattern
  | MTuplePattern
  | MMarkPattern;

export interface MWildcardPattern extends MTypedNode {
  kind: "wildcard";
}

export interface MVariablePattern extends MTypedNode {
  kind: "variable";
  name: string;
}

export interface MLiteralPattern extends MTypedNode {
  kind: "literal";
  literal: Literal;
}

export interface MConstructorPattern extends MTypedNode {
  kind: "constructor";
  name: string;
  args: MPattern[];
}

export interface MTuplePattern extends MTypedNode {
  kind: "tuple";
  elements: MPattern[];
}

export interface MMarkPattern extends MTypedNode {
  kind: "mark_pattern";
  reason: "non_exhaustive" | "wrong_constructor" | "other";
  data?: Record<string, unknown>;
}

export interface MLetDeclaration extends MTypedNode {
  kind: "let";
  name: string;
  parameters: MParameter[];
  annotation?: TypeExpr;
  body: MBlockExpr;
  isRecursive: boolean;
  isFirstClassMatch?: boolean;
  isArrowSyntax?: boolean;
  mutualBindings?: MLetDeclaration[];
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
}

export type MTopLevel =
  | MLetDeclaration
  | { kind: "type"; node: TypeDeclaration }
  | { kind: "prefix"; node: PrefixDeclaration }
  | { kind: "infix"; node: InfixDeclaration };

export interface MProgram {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  declarations: MTopLevel[];
}

export function isMarkedExpression(expr: MExpr): expr is MMarkExpr {
  switch (expr.kind) {
    case "mark_free_var":
    case "mark_not_function":
    case "mark_inconsistent":
    case "mark_unsupported_expr":
      return true;
    default:
      return false;
  }
}
