export interface SourceSpan {
  start: number;
  end: number;
}

interface NodeBase {
  span: SourceSpan;
}

export type Literal =
  | ({ kind: "int" } & NodeBase & { value: number })
  | ({ kind: "bool" } & NodeBase & { value: boolean })
  | ({ kind: "unit" } & NodeBase);

export type Pattern =
  | ({ kind: "wildcard" } & NodeBase)
  | ({ kind: "variable" } & NodeBase & { name: string })
  | ({ kind: "literal" } & NodeBase & { literal: Literal })
  | ({ kind: "constructor" } & NodeBase & { name: string; args: Pattern[] })
  | ({ kind: "tuple" } & NodeBase & { elements: Pattern[] });

export interface Parameter extends NodeBase {
  kind: "parameter";
  name: string;
  annotation?: TypeExpr;
}

export interface BlockExpr extends NodeBase {
  kind: "block";
  statements: BlockStatement[];
  result?: Expr;
}

export type BlockStatement = LetStatement | ExprStatement;

export interface LetStatement extends NodeBase {
  kind: "let_statement";
  declaration: LetDeclaration;
}

export interface ExprStatement extends NodeBase {
  kind: "expr_statement";
  expression: Expr;
}

export interface MatchArm extends NodeBase {
  pattern: Pattern;
  body: Expr;
  hasTrailingComma: boolean;
}

export type Expr =
  | IdentifierExpr
  | LiteralExpr
  | ConstructorExpr
  | TupleExpr
  | CallExpr
  | ArrowFunctionExpr
  | BlockExpr
  | MatchExpr
  | MatchFunctionExpr;

export interface IdentifierExpr extends NodeBase {
  kind: "identifier";
  name: string;
}

export interface LiteralExpr extends NodeBase {
  kind: "literal";
  literal: Literal;
}

export interface ConstructorExpr extends NodeBase {
  kind: "constructor";
  name: string;
  args: Expr[];
}

export interface TupleExpr extends NodeBase {
  kind: "tuple";
  elements: Expr[];
}

export interface CallExpr extends NodeBase {
  kind: "call";
  callee: Expr;
  arguments: Expr[];
}

export interface ArrowFunctionExpr extends NodeBase {
  kind: "arrow";
  parameters: Parameter[];
  body: BlockExpr;
}

export interface MatchExpr extends NodeBase {
  kind: "match";
  scrutinee: Expr;
  arms: MatchArm[];
}

export interface MatchFunctionExpr extends NodeBase {
  kind: "match_fn";
  parameters: Expr[];
  arms: MatchArm[];
}

export type TypeExpr =
  | TypeVariable
  | TypeFunction
  | TypeReference
  | TypeTuple
  | TypeUnit;

export interface TypeVariable extends NodeBase {
  kind: "type_var";
  name: string;
}

export interface TypeFunction extends NodeBase {
  kind: "type_fn";
  parameters: TypeExpr[];
  result: TypeExpr;
}

export interface TypeReference extends NodeBase {
  kind: "type_ref";
  name: string;
  typeArgs: TypeExpr[];
}

export interface TypeTuple extends NodeBase {
  kind: "type_tuple";
  elements: TypeExpr[];
}

export interface TypeUnit extends NodeBase {
  kind: "type_unit";
}

export type TypeAliasMember = ConstructorAlias | TypeAliasExprMember;

export interface ConstructorAlias extends NodeBase {
  kind: "constructor";
  name: string;
  typeArgs: TypeExpr[];
}

export interface TypeAliasExprMember extends NodeBase {
  kind: "alias";
  type: TypeExpr;
}

export interface TypeParameter extends NodeBase {
  name: string;
}

export interface TypeDeclaration extends NodeBase {
  kind: "type";
  name: string;
  typeParams: TypeParameter[];
  members: TypeAliasMember[];
}

export interface LetDeclaration extends NodeBase {
  kind: "let";
  name: string;
  parameters: Parameter[];
  annotation?: TypeExpr;
  body: BlockExpr;
}

export type TopLevel = LetDeclaration | TypeDeclaration;

export interface Program {
  declarations: TopLevel[];
}
