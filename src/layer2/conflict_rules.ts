// ============================================================================
// Conflict Detection Rules (Phase 4: Unified Constraint Model)
// ============================================================================
//
// Per-domain conflict rules that determine which constraint labels are
// incompatible with each other.

import type { ConstraintLabel, Identity } from "../types.ts";
import { isMemLabel, sameIdentity } from "../types.ts";

// Per-domain conflict rule
export interface ConflictRule {
  check: (label1: ConstraintLabel, label2: ConstraintLabel) => boolean;
  message: (label1: ConstraintLabel, label2: ConstraintLabel) => string;
}

// Error domain: never conflicts (row union)
function errorConflict(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): boolean {
  return false; // Errors compose via union
}

function errorConflictMessage(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): string {
  return ""; // Never conflicts
}

// Taint domain: never conflicts (row union, identical to error domain)
function taintConflict(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): boolean {
  return false; // Taints compose via union
}

function taintConflictMessage(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): string {
  return ""; // Never conflicts
}

// Memory domain: check incompatibilities on same identity
function memConflict(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  if (!isMemLabel(label1) || !isMemLabel(label2)) return false;

  // Must be same identity to conflict
  if (!sameIdentity(label1.identity, label2.identity)) return false;

  const l1 = label1.label;
  const l2 = label2.label;

  // Conflict table (symmetric)
  const conflicts: [string, string][] = [
    ["DirectRead", "Lent"],
    ["DirectRead", "Closed"],
    ["BorrowRead", "Ended"],
    ["Closed", "Open"],
    ["Open", "Lent"], // At merge points
  ];

  for (const [a, b] of conflicts) {
    if ((l1 === a && l2 === b) || (l1 === b && l2 === a)) {
      return true;
    }
  }

  return false;
}

function memConflictMessage(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): string {
  if (!isMemLabel(label1) || !isMemLabel(label2)) {
    return "Incompatible constraints";
  }
  return `Cannot combine ${label1.label} and ${label2.label} on same resource`;
}

// Hole domain: conflicting required types
function holeConflict(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): boolean {
  // TODO: check if constrained to different types
  // This will be integrated with existing hole conflict detection
  return false; // Placeholder
}

function holeConflictMessage(
  _label1: ConstraintLabel,
  _label2: ConstraintLabel,
): string {
  return "Unfillable hole";
}

// Export conflict rules per domain
export const CONFLICT_RULES = new Map<string, ConflictRule>([
  ["effect", { check: errorConflict, message: errorConflictMessage }],
  ["taint", { check: taintConflict, message: taintConflictMessage }],
  ["mem", { check: memConflict, message: memConflictMessage }],
  ["hole", { check: holeConflict, message: holeConflictMessage }],
]);

export function areIncompatible(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): boolean {
  const rule = CONFLICT_RULES.get(label1.domain);
  if (!rule) return false;
  return rule.check(label1, label2);
}

export function conflictMessage(
  label1: ConstraintLabel,
  label2: ConstraintLabel,
): string {
  const rule = CONFLICT_RULES.get(label1.domain);
  if (!rule) return "Incompatible constraints";
  return rule.message(label1, label2);
}
