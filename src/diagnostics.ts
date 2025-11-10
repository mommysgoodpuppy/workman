import type { NodeId } from "./ast.ts";

export type ConstraintDiagnosticReason =
  | "not_function"
  | "branch_mismatch"
  | "missing_field"
  | "not_record"
  | "occurs_cycle"
  | "type_mismatch"
  | "arity_mismatch"
  | "not_numeric"
  | "not_boolean"
  | "free_variable"
  | "unsupported_expr"
  | "duplicate_record_field"
  | "non_exhaustive_match"
  | "all_errors_outside_result"
  | "all_errors_requires_err"
  | "error_row_partial_coverage"
  | "result_match_ok_returns_result"
  | "result_match_err_returns_result"
  | "infectious_call_result_mismatch"
  | "infectious_match_result_mismatch"
  | "type_expr_unknown"
  | "type_expr_arity"
  | "type_expr_unsupported"
  | "type_decl_duplicate"
  | "type_decl_invalid_member"
  | "unfillable_hole"
  | "internal_error";

export interface ConstraintDiagnostic {
  origin: NodeId;
  reason: ConstraintDiagnosticReason;
  details?: Record<string, unknown>;
}
