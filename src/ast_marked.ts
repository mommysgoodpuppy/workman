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

export interface MHoleExpr extends MTypedNode {
  kind: "hole";
}

export interface MRecordField extends MNodeBase {
  kind: "record_field";
  name: string;
  value: MExpr;
  hasTrailingComma: boolean;
}

export interface MConstructorExpr extends MTypedNode {
  kind: "constructor";
  name: string;
  args: MExpr[];
}

export interface MRecordProjectionExpr extends MTypedNode {
  kind: "record_projection";
  target: MExpr;
  field: string;
}

export interface MTupleExpr extends MTypedNode {
  kind: "tuple";
  elements: MExpr[];
  isMultiLine?: boolean;
}

export interface MRecordLiteralExpr extends MTypedNode {
  kind: "record_literal";
  fields: MRecordField[];
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
  annotation?: MTypeExpr;
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

export interface MErrorRowCoverage {
  row: Type;
  coveredConstructors: string[];
  coversTail: boolean;
  missingConstructors: string[];
}

export interface MMatchBundle extends MTypedNode {
  kind: "match_bundle";
  arms: MMatchArm[];
  errorRowCoverage?: MErrorRowCoverage;
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

export interface MMarkOccursCheck extends MTypedNode {
  kind: "mark_occurs_check";
  subject: MExpr;
  left: Type;
  right: Type;
}

export interface MMarkUnsupportedExpr extends MTypedNode {
  kind: "mark_unsupported_expr";
  exprKind: string;
}

export interface MMarkInconsistent extends MTypedNode {
  kind: "mark_inconsistent";
  subject: MExpr;
  expected: Type;
  actual: Type;
}

export interface MMarkUnfillableHole extends MTypedNode {
  kind: "mark_unfillable_hole";
  subject: MExpr;
  conflictingTypes: Type[];
  reason: string;
}

export interface MMarkTypeExprUnknown extends MTypedNode {
  kind: "mark_type_expr_unknown";
  typeExpr: TypeExpr;
  reason: string;
}

export interface MMarkTypeExprArity extends MTypedNode {
  kind: "mark_type_expr_arity";
  typeExpr: TypeExpr;
  expected: number;
  actual: number;
}

export interface MMarkTypeExprUnsupported extends MTypedNode {
  kind: "mark_type_expr_unsupported";
  typeExpr: TypeExpr;
}

export interface MTypeVariable extends MNodeBase {
  kind: "type_var";
  name: string;
}

export interface MTypeFunction extends MNodeBase {
  kind: "type_fn";
  parameters: MTypeExpr[];
  result: MTypeExpr;
}

export interface MTypeReference extends MNodeBase {
  kind: "type_ref";
  name: string;
  typeArgs: MTypeExpr[];
}

export interface MTypeTuple extends MNodeBase {
  kind: "type_tuple";
  elements: MTypeExpr[];
}

export interface MTypeRecordField extends MNodeBase {
  kind: "type_record_field";
  name: string;
  type: MTypeExpr;
  hasTrailingComma: boolean;
}

export interface MTypeRecordExpr extends MNodeBase {
  kind: "type_record";
  fields: MTypeRecordField[];
}

export interface MTypeUnit extends MNodeBase {
  kind: "type_unit";
}

export interface MTypeErrorRowCase extends MNodeBase {
  kind: "type_error_row_case";
  name: string;
  payload?: MTypeExpr;
}

export interface MTypeErrorRowExpr extends MNodeBase {
  kind: "type_error_row";
  cases: MTypeErrorRowCase[];
  hasTailWildcard: boolean;
}

export type MTypeExpr =
  | MTypeVariable
  | MTypeFunction
  | MTypeReference
  | MTypeTuple
  | MTypeRecordExpr
  | MTypeUnit
  | MTypeErrorRowExpr
  | MTypeExprMark;

export type MMarkExpr =
  | MMarkFreeVar
  | MMarkNotFunction
  | MMarkOccursCheck
  | MMarkInconsistent
  | MMarkUnsupportedExpr
  | MMarkUnfillableHole;

export type MExpr =
  | MIdentifierExpr
  | MLiteralExpr
  | MConstructorExpr
  | MTupleExpr
  | MRecordLiteralExpr
  | MCallExpr
  | MRecordProjectionExpr
  | MBinaryExpr
  | MUnaryExpr
  | MArrowFunctionExpr
  | MBlockExpr
  | MMatchExpr
  | MMatchFunctionExpr
  | MMatchBundleLiteralExpr
  | MHoleExpr
  | MMarkExpr
  | MTypeExprMark;

export type MPattern =
  | MWildcardPattern
  | MVariablePattern
  | MLiteralPattern
  | MConstructorPattern
  | MTuplePattern
  | MAllErrorsPattern
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

export interface MAllErrorsPattern extends MTypedNode {
  kind: "all_errors";
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
  annotation?: MTypeExpr;
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

export interface MMarkTypeDeclDuplicate extends MNodeBase {
  kind: "mark_type_decl_duplicate";
  declaration: TypeDeclaration;
  duplicate: TypeDeclaration;
}

export interface MMarkTypeDeclInvalidMember extends MNodeBase {
  kind: "mark_type_decl_invalid_member";
  declaration: TypeDeclaration;
  member: TypeDeclaration["members"][0];
}

export interface MMarkInternal extends MNodeBase {
  kind: "mark_internal";
  reason: string;
}

export interface MMarkTypeExprUnknown extends MNodeBase {
  kind: "mark_type_expr_unknown";
  type: Type;
  typeExpr: TypeExpr;
  reason: string;
}

export interface MMarkTypeExprArity extends MNodeBase {
  kind: "mark_type_expr_arity";
  type: Type;
  typeExpr: TypeExpr;
  expected: number;
  actual: number;
}

export interface MMarkTypeExprUnsupported extends MNodeBase {
  kind: "mark_type_expr_unsupported";
  type: Type;
}

export type MTopLevelMark = MMarkTypeDeclDuplicate | MMarkTypeDeclInvalidMember | MMarkInternal;
export type MTypeExprMark = MMarkTypeExprUnknown | MMarkTypeExprArity | MMarkTypeExprUnsupported;

export type MTopLevel =
  | MLetDeclaration
  | { kind: "type"; node: TypeDeclaration }
  | { kind: "prefix"; node: PrefixDeclaration }
  | { kind: "infix"; node: InfixDeclaration }
  | MTopLevelMark;

export interface MProgram {
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  declarations: MTopLevel[];
}

export function isMarkedExpression(expr: MExpr): expr is MMarkExpr | MTypeExprMark {
  switch (expr.kind) {
    case "mark_free_var":
    case "mark_not_function":
    case "mark_occurs_check":
    case "mark_inconsistent":
    case "mark_unsupported_expr":
    case "mark_type_expr_unknown":
    case "mark_type_expr_arity":
    case "mark_type_expr_unsupported":
      return true;
    default:
      return false;
  }
}
