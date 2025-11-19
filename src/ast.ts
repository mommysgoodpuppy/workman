export interface SourceSpan {
  start: number;
  end: number;
}

export type NodeId = number;

interface NodeBase {
  span: SourceSpan;
  id: NodeId;
}

export type Literal =
  | ({ kind: "int" } & NodeBase & { value: number })
  | ({ kind: "bool" } & NodeBase & { value: boolean })
  | ({ kind: "char" } & NodeBase & { value: string })
  | ({ kind: "string" } & NodeBase & { value: string })
  | ({ kind: "unit" } & NodeBase);

export type Pattern =
  | ({ kind: "wildcard" } & NodeBase)
  | ({ kind: "variable" } & NodeBase & { name: string; isExplicitPin?: boolean })
  | ({ kind: "literal" } & NodeBase & { literal: Literal })
  | ({ kind: "constructor" } & NodeBase & { name: string; args: Pattern[] })
  | ({ kind: "tuple" } & NodeBase & { elements: Pattern[] })
  | ({ kind: "all_errors" } & NodeBase);

export interface ModuleImport extends NodeBase {
  kind: "module_import";
  source: string;
  specifiers: ImportSpecifier[];
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
  hasTerminatingSemicolon?: boolean;
}

export interface ModuleReexport extends NodeBase {
  kind: "module_reexport";
  source: string;
  typeExports: TypeReexport[];
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
  hasTerminatingSemicolon?: boolean;
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
  resultTrailingComment?: string;
  resultCommentStatements?: CommentStatement[];
}

export interface CommentStatement extends NodeBase {
  kind: "comment_statement";
  text: string;
  hasBlankLineAfter?: boolean;
  rawText?: string;
}

export type BlockStatement =
  | LetStatement
  | PatternLetStatement
  | ExprStatement
  | CommentStatement;

export interface LetStatement extends NodeBase {
  kind: "let_statement";
  declaration: LetDeclaration;
}

export interface PatternLetStatement extends NodeBase {
  kind: "pattern_let_statement";
  pattern: Pattern;
  initializer: Expr;
}

export interface ExprStatement extends NodeBase {
  kind: "expr_statement";
  expression: Expr;
  trailingComment?: string;
}

export type MatchArm =
  | MatchPatternArm
  | MatchBundleReferenceArm
  | CommentStatement;

export interface MatchPatternArm extends NodeBase {
  kind: "match_pattern";
  pattern: Pattern;
  body: Expr;
  hasTrailingComma: boolean;
  trailingComment?: string;
}

export interface MatchBundleReferenceArm extends NodeBase {
  kind: "match_bundle_reference";
  name: string;
  hasTrailingComma: boolean;
  trailingComment?: string;
}

export interface MatchBundle extends NodeBase {
  kind: "match_bundle";
  arms: MatchArm[];
}

export type MatchBundleExpr = MatchBundle;

export type Expr =
  | IdentifierExpr
  | LiteralExpr
  | ConstructorExpr
  | TupleExpr
  | RecordLiteralExpr
  | CallExpr
  | RecordProjectionExpr
  | BinaryExpr
  | UnaryExpr
  | ArrowFunctionExpr
  | BlockExpr
  | MatchExpr
  | MatchFunctionExpr
  | MatchBundleLiteralExpr
  | HoleExpr;

export interface IdentifierExpr extends NodeBase {
  kind: "identifier";
  name: string;
}

export interface LiteralExpr extends NodeBase {
  kind: "literal";
  literal: Literal;
}

export interface HoleExpr extends NodeBase {
  kind: "hole";
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

export interface RecordField extends NodeBase {
  kind: "record_field";
  name: string;
  value: Expr;
  hasTrailingComma: boolean;
}

export interface RecordLiteralExpr extends NodeBase {
  kind: "record_literal";
  fields: RecordField[];
  isMultiLine?: boolean;
}

export interface CallExpr extends NodeBase {
  kind: "call";
  callee: Expr;
  arguments: Expr[];
}

export interface RecordProjectionExpr extends NodeBase {
  kind: "record_projection";
  target: Expr;
  field: string;
}

export interface BinaryExpr extends NodeBase {
  kind: "binary";
  operator: string;
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends NodeBase {
  kind: "unary";
  operator: string;
  operand: Expr;
}

export interface ArrowFunctionExpr extends NodeBase {
  kind: "arrow";
  parameters: Parameter[];
  body: BlockExpr;
  returnAnnotation?: TypeExpr;
}

export interface MatchExpr extends NodeBase {
  kind: "match";
  scrutinee: Expr;
  bundle: MatchBundle;
}

export interface MatchFunctionExpr extends NodeBase {
  kind: "match_fn";
  parameters: Expr[];
  bundle: MatchBundle;
}

export interface MatchBundleLiteralExpr extends NodeBase {
  kind: "match_bundle_literal";
  bundle: MatchBundle;
}

export interface TypeRecordField extends NodeBase {
  kind: "type_record_field";
  name: string;
  type: TypeExpr;
  hasTrailingComma: boolean;
}

export type TypeExpr =
  | TypeVariable
  | TypeFunction
  | TypeReference
  | TypeTuple
  | TypeRecordExpr
  | TypeUnit
  | TypeEffectRowExpr;

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

export interface TypeRecordExpr extends NodeBase {
  kind: "type_record";
  fields: TypeRecordField[];
}

export interface TypeUnit extends NodeBase {
  kind: "type_unit";
}

export interface TypeEffectRowCase extends NodeBase {
  kind: "type_effect_row_case";
  name: string;
  payload?: TypeExpr;
}

export interface TypeEffectRowExpr extends NodeBase {
  kind: "type_effect_row";
  cases: TypeEffectRowCase[];
  hasTailWildcard: boolean;
}

export type TypeAliasMember = ConstructorAlias | TypeAliasExprMember;

export type ConstructorAnnotation = "value" | "effect";

export interface ConstructorAlias extends NodeBase {
  kind: "constructor";
  name: string;
  typeArgs: TypeExpr[];
  annotation?: ConstructorAnnotation; // @value or @effect for infectious types
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
  rawText?: string;
}

export interface InfectiousModifier {
  kind: "infectious";
  domain: string; // e.g., "error", "taint"
  span: SourceSpan;
}

export interface TypeDeclaration extends NodeBase {
  kind: "type";
  name: string;
  typeParams: TypeParameter[];
  members: TypeAliasMember[];
  declarationKind?: "record";
  infectious?: InfectiousModifier; // Optional infectious modifier
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean; // True if there was a blank line before this declaration
  hasTerminatingSemicolon?: boolean;
}

export interface LetDeclaration extends NodeBase {
  kind: "let";
  name: string;
  nameSpan: SourceSpan;
  parameters: Parameter[];
  annotation?: TypeExpr;
  returnAnnotation?: TypeExpr;
  body: BlockExpr;
  isRecursive: boolean;
  isFirstClassMatch?: boolean; // True if originally written as `let f = match(x) { ... }`
  isArrowSyntax?: boolean; // True if originally written with arrow syntax `() => { ... }`
  mutualBindings?: LetDeclaration[];
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean; // True if there was a blank line before this declaration
  hasTerminatingSemicolon?: boolean;
}

export type Associativity = "left" | "right" | "none";

export interface InfixDeclaration extends NodeBase {
  kind: "infix";
  operator: string;
  associativity: Associativity;
  precedence: number;
  implementation: string; // Name of the function that implements this operator
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
  hasTerminatingSemicolon?: boolean;
}

export interface PrefixDeclaration extends NodeBase {
  kind: "prefix";
  operator: string;
  implementation: string; // Name of the function that implements this operator
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
  hasTerminatingSemicolon?: boolean;
}

export interface InfectiousDeclaration extends NodeBase {
  kind: "infectious";
  domain: string; // The domain name (e.g., "error", "taint", "hole")
  typeName: string; // The type constructor name (e.g., "Result", "Tainted")
  valueParam: string; // The value type parameter name (e.g., "T")
  stateParam: string; // The state type parameter name (e.g., "E")
  export?: ExportModifier;
  leadingComments?: CommentBlock[];
  trailingComment?: string;
  hasBlankLineBefore?: boolean;
  hasTerminatingSemicolon?: boolean;
}

export type TopLevel =
  | LetDeclaration
  | TypeDeclaration
  | InfixDeclaration
  | PrefixDeclaration
  | InfectiousDeclaration;

export interface Program {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  declarations: TopLevel[];
  trailingComments?: CommentBlock[];
}
