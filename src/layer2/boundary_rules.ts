// ============================================================================
// Boundary Checking Rules (Phase 5: Unified Constraint Model)
// ============================================================================
//
// Per-domain boundary rules that determine what constraints are allowed
// at function return positions.

import type { ConstraintLabel, Type } from "../types.ts";
import {
  flattenResultType,
  formatIdentity,
  splitCarrier,
} from "../types.ts";

export interface BoundaryRule {
  check: (labels: Set<ConstraintLabel>, returnType: Type) => string | null;
}

// Error domain: must be reified in Result or empty
function errorBoundary(
  labels: Set<ConstraintLabel>,
  returnType: Type,
): string | null {
  const errorLabels = Array.from(labels).filter((l) => l.domain === "error");
  if (errorLabels.length === 0) return null; // No errors, OK

  // Check if return type is ANY carrier type in the error domain (generic check)
  const carrierInfo = splitCarrier(returnType);
  if (carrierInfo && carrierInfo.domain === "error") {
    // Error is reified in an error-domain carrier type (Result, IResult, etc.) - OK
    return null;
  }

  // Fallback: check hardcoded Result type for backward compatibility
  const resultInfo = flattenResultType(returnType);
  if (resultInfo) {
    // Error is reified in Result type - OK
    return null;
  }

  // Errors not captured!
  const errorConstructors = errorLabels.flatMap((l) =>
    l.domain === "error" ? Array.from(l.row.cases.keys()) : []
  );
  const errorNames = errorConstructors.join(", ");
  return `Undischarged errors: <${errorNames}>. Return type must be Result<T, E> or errors must be handled with pattern matching.`;
}

// Taint domain: must be reified in Tainted or empty (parallel to error domain)
function taintBoundary(
  labels: Set<ConstraintLabel>,
  returnType: Type,
): string | null {
  const taintLabels = Array.from(labels).filter((l) => l.domain === "taint");
  if (taintLabels.length === 0) return null; // No taints, OK

  // Check if return type is Tainted
  const taintedInfo = flattenTaintedType(returnType);
  if (taintedInfo) {
    // Taint is reified in Tainted type - OK
    return null;
  }

  // Taints not captured!
  const taintConstructors = taintLabels.flatMap((l) =>
    l.domain === "taint" ? Array.from(l.row.cases.keys()) : []
  );
  const taintNames = taintConstructors.join(", ");
  return `Undischarged taints: <${taintNames}>. Return type must be Tainted<T, T> or taints must be handled with pattern matching.`;
}

// Memory domain: no MustClose/MustEnd obligations
function memBoundary(
  labels: Set<ConstraintLabel>,
  _returnType: Type,
): string | null {
  const obligations = Array.from(labels).filter((l) =>
    l.domain === "mem" && (l.label === "MustClose" || l.label === "MustEnd")
  );

  if (obligations.length === 0) return null; // OK

  const obligationNames = obligations.map((l) => {
    if (l.domain === "mem") {
      return `${l.label}[${formatIdentity(l.identity)}]`;
    }
    return "";
  }).join(", ");
  return `Unfulfilled obligations: ${obligationNames}. Resources must be properly closed/ended before return.`;
}

// Hole domain: depends on mode
function holeBoundary(
  labels: Set<ConstraintLabel>,
  _returnType: Type,
): string | null {
  const unknownHoles = Array.from(labels).filter((l) => l.domain === "hole" // TODO: Add && !isFilled(l) check when hole filling is integrated
  );

  if (unknownHoles.length === 0) return null; // OK

  // TODO: Check mode (Total vs Hazel)
  const isHazelMode = true; // Placeholder
  if (isHazelMode) {
    return null; // Live holes allowed
  }

  return `Unfilled holes at return. All type holes must be resolved.`;
}

// Export boundary rules per domain
export const BOUNDARY_RULES = new Map<string, BoundaryRule>([
  ["error", { check: errorBoundary }],
  ["taint", { check: taintBoundary }],
  ["mem", { check: memBoundary }],
  ["hole", { check: holeBoundary }],
]);
