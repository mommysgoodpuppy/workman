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

export type Expr =
  | ({ kind: "var" } & NodeBase & { name: string })
  | ({ kind: "lambda" } & NodeBase & { param: string; body: Expr })
  | ({ kind: "apply" } & NodeBase & { fn: Expr; argument: Expr })
  | ({ kind: "let" } & NodeBase & { name: string; value: Expr; body: Expr })
  | ({ kind: "match" } & NodeBase & { value?: Expr; cases: MatchCase[] })
  | ({ kind: "literal" } & NodeBase & { literal: Literal })
  | ({ kind: "constructor" } & NodeBase & { name: string; args: Expr[] })
  | ({ kind: "tuple" } & NodeBase & { elements: Expr[] });

export interface MatchCase {
  pattern: Pattern;
  body: Expr;
}

export type TypeExpr =
  | ({ kind: "var" } & NodeBase & { name: string })
  | ({ kind: "func" } & NodeBase & { from: TypeExpr; to: TypeExpr })
  | ({ kind: "constructor" } & NodeBase & { name: string; args: TypeExpr[] })
  | ({ kind: "tuple" } & NodeBase & { elements: TypeExpr[] })
  | ({ kind: "unit" } & NodeBase);

export interface ConstructorDecl extends NodeBase {
  kind: "constructor";
  name: string;
  args: TypeExpr[];
}

export interface TypeDeclaration extends NodeBase {
  kind: "type";
  name: string;
  parameters: string[];
  constructors: ConstructorDecl[];
}

export interface LetDeclaration extends NodeBase {
  kind: "let";
  name: string;
  value: Expr;
  annotation?: TypeExpr;
}

export type TopLevel = TypeDeclaration | LetDeclaration;

export interface Program {
  declarations: TopLevel[];
}
