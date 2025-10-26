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
  | ({ kind: "string" } & NodeBase & { value: string })
  | ({ kind: "unit" } & NodeBase);

export type Pattern =
  | ({ kind: "wildcard" } & NodeBase)
  | ({ kind: "variable" } & NodeBase & { name: string })
  | ({ kind: "literal" } & NodeBase & { literal: Literal })
  | ({ kind: "constructor" } & NodeBase & { name: string; args: Pattern[] })
  | ({ kind: "tuple" } & NodeBase & { elements: Pattern[] });

export interface ModuleImport extends NodeBase {
  kind: "module_import";
  source: string;
  specifiers: ImportSpecifier[];
}

export interface ModuleReexport extends NodeBase {
  kind: "module_reexport";
  source: string;
  typeExports: TypeReexport[];
}

export type ImportSpecifier = NamedImport | NamespaceImport;

export interface NamedImport extends NodeBase {
  kind: "named";
  imported: string;
  local: string;
}

export interface NamespaceImport extends NodeBase {
  kind: "namespace";
  local: string;
}

export interface TypeReexport extends NodeBase {
  name: string;
  exportConstructors: boolean;
}

export interface ExportModifier {
  kind: "export";
  span: SourceSpan;
}

export interface Parameter extends NodeBase {
  kind: "parameter";
  pattern: Pattern;
  name?: string;
  annotation?: TypeExpr;
}

export interface BlockExpr extends NodeBase {
  kind: "block";
  statements: BlockStatement[];
  result?: Expr;
  isMultiLine?: boolean; // True if the block was originally formatted across multiple lines
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
  isMultiLine?: boolean; // True if tuple was originally formatted across multiple lines
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

export interface CommentBlock {
  text: string;
  hasBlankLineAfter?: boolean; // True if there's a blank line after this comment
}

export interface TypeDeclaration extends NodeBase {
  kind: "type";
  name: string;
  typeParams: TypeParameter[];
  members: TypeAliasMember[];
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean; // True if there was a blank line before this declaration
}

export interface LetDeclaration extends NodeBase {
  kind: "let";
  name: string;
  parameters: Parameter[];
  annotation?: TypeExpr;
  body: BlockExpr;
  isRecursive: boolean;
  isFirstClassMatch?: boolean; // True if originally written as `let f = match(x) { ... }`
  isArrowSyntax?: boolean; // True if originally written with arrow syntax `() => { ... }`
  mutualBindings?: LetDeclaration[];
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean; // True if there was a blank line before this declaration
}

export type TopLevel = LetDeclaration | TypeDeclaration;

export interface Program {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  declarations: TopLevel[];
}
