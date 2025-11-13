export type Provenance =
  | { kind: "user_hole"; id: number }
  | { kind: "expr_hole"; id: number }
  | { kind: "error_free_var"; name: string }
  | { kind: "error_inconsistent"; expected: Type; actual: Type }
  | { kind: "error_not_function"; calleeType: Type }
  | { kind: "error_occurs_check"; left: Type; right: Type }
  | { kind: "error_unify_conflict"; typeA: Type; typeB: Type }
  | { kind: "error_unfillable_hole"; holeId: number; conflicts: any[] }
  | { kind: "error_type_expr_unknown"; name: string }
  | { kind: "error_type_expr_arity"; expected: number; actual: number }
  | { kind: "error_type_expr_unsupported" }
  | { kind: "error_internal"; reason: string }
  | { kind: "incomplete"; reason: string };

export type Type =
  | { kind: "var"; id: number }
  | { kind: "func"; from: Type; to: Type }
  | { kind: "constructor"; name: string; args: Type[] }
  | { kind: "tuple"; elements: Type[] }
  | { kind: "record"; fields: Map<string, Type> }
  | { kind: "error_row"; cases: Map<string, Type | null>; tail?: Type | null }
  | { kind: "unit" }
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "char" }
  | { kind: "string" };
// REMOVED: | { kind: "unknown"; provenance: Provenance };
// Holes are now modeled as Hole<T, HoleRow> carrier type

export interface TypeScheme {
  quantifiers: number[];
  type: Type;
}

export type Substitution = Map<number, Type>;

export type ErrorRowType = Extract<Type, { kind: "error_row" }>;

export function isErrorRow(type: Type): type is ErrorRowType {
  return type.kind === "error_row";
}

export function createErrorRow(
  entries: Iterable<[string, Type | null]> = [],
  tail?: Type | null,
): ErrorRowType {
  return {
    kind: "error_row",
    cases: new Map(entries),
    tail,
  };
}

// Internal helper: converts any type to a row type (used by carriers)
// If already a row, return as-is; otherwise wrap as tail
function ensureRow(type: Type): ErrorRowType {
  if (type.kind === "error_row") {
    return type;
  }
  return {
    kind: "error_row",
    cases: new Map(),
    tail: type,
  };
}

export function errorRowUnion(left: Type, right: Type): ErrorRowType {
  const lhs = ensureRow(left);
  const rhs = ensureRow(right);
  const merged = new Map<string, Type | null>();
  for (const [label, payload] of lhs.cases.entries()) {
    merged.set(label, payload ? cloneType(payload) : null);
  }
  for (const [label, payload] of rhs.cases.entries()) {
    if (!merged.has(label)) {
      merged.set(label, payload ? cloneType(payload) : null);
      continue;
    }
    const existing = merged.get(label);
    if (!existing && payload) {
      merged.set(label, cloneType(payload));
    }
  }
  return {
    kind: "error_row",
    cases: merged,
    tail: mergeErrorRowTails(lhs.tail, rhs.tail),
  };
}

function mergeErrorRowTails(
  left?: Type | null,
  right?: Type | null,
): Type | null | undefined {
  if (!left) return right;
  if (!right) return left;
  // Prefer the left tail for now; more advanced unification happens at call sites.
  return left;
}

// ============================================================================
// Constraint System Types (Phase 1: Unified Constraint Model)
// ============================================================================

// Identity tracking for resources, borrows, and type holes
export type Identity =
  | { kind: "resource"; id: number } // ψ - file handle, allocation, etc.
  | { kind: "borrow"; id: number } // κ - borrow token
  | { kind: "hole"; id: number }; // α - type hole (reuses type var IDs)

let nextResourceId = 0;
let nextBorrowId = 0;

export function freshResource(): Identity {
  return { kind: "resource", id: nextResourceId++ };
}

export function freshBorrow(): Identity {
  return { kind: "borrow", id: nextBorrowId++ };
}

// Constraint labels - domain-specific constraint states
// NOTE: Each node has AT MOST ONE constraint label per domain (per-domain singleton invariant)
// Multiple sources for the same domain are merged using domain-specific rules
export type ConstraintLabel =
  // Error domain - reuses existing ErrorRowType structure
  | { domain: "error"; row: ErrorRowType }
  // Taint domain - uses same row structure as errors (parallel domain)
  | { domain: "taint"; row: TaintRowType }
  // Memory domain - capability tracking (future: Phase 5)
  | { domain: "mem"; label: string; identity: Identity }
  // Hole domain - type hole tracking (integration with existing hole system)
  | { domain: "hole"; identity: Identity; provenance: Provenance };

// Helper constructors for constraint labels
export function errorLabel(row: ErrorRowType): ConstraintLabel {
  return { domain: "error", row };
}

export function taintLabel(row: TaintRowType): ConstraintLabel {
  return { domain: "taint", row };
}

export function memLabel(label: string, identity: Identity): ConstraintLabel {
  return { domain: "mem", label, identity };
}

export function holeLabel(
  identity: Identity,
  provenance: Provenance,
): ConstraintLabel {
  return { domain: "hole", identity, provenance };
}

// Helper: check if two identities are the same
export function sameIdentity(id1: Identity, id2: Identity): boolean {
  return id1.kind === id2.kind && id1.id === id2.id;
}

// Helper: format identity for display
export function formatIdentity(id: Identity): string {
  switch (id.kind) {
    case "resource":
      return `ψ${id.id}`;
    case "borrow":
      return `κ${id.id}`;
    case "hole":
      return `α${id.id}`;
  }
}

// Helper: format label for display
export function formatLabel(label: ConstraintLabel): string {
  switch (label.domain) {
    case "error":
      // For error domain, we could format the row constructors
      return `error:<${Array.from(label.row.cases.keys()).join("|")}>`;
    case "taint":
      // For taint domain, format the taint constructors
      return `taint:<${Array.from(label.row.cases.keys()).join("|")}>`;
    case "mem":
      return `${label.label}[${formatIdentity(label.identity)}]`;
    case "hole":
      return `Unknown[${formatIdentity(label.identity)}]`;
  }
}

// ============================================================================
// End of Constraint System Types
// ============================================================================

// ============================================================================
// Generic Carrier Type System (Infectious Types)
// ============================================================================
//
// Carrier types "carry" constraint information at the value level.
// Examples: Result<T, E>, Option<T>, Tainted<T>
//
// This generalizes the hardcoded Result-specific code to work with any
// infectious type domain.

export interface CarrierInfo {
  // The "clean" value type (e.g., T from Result<T, E>)
  value: Type;
  // The constraint state type (e.g., E from Result<T, E>)
  state: Type;
}

export interface CarrierOperations {
  // Check if a type is this carrier
  is: (type: Type) => boolean;
  // Split carrier into value and state: Result<T, E> → {value: T, state: E}
  split: (type: Type) => CarrierInfo | null;
  // Join value and state into carrier: T + E → Result<T, E>
  join: (value: Type, state: Type) => Type;
  // Remove carrier wrapper: Result<T, E> → T (strips state)
  collapse: (type: Type) => Type;
  // Union two state types: E1 ∪ E2 → E3
  unionStates: (left: Type, right: Type) => Type;
}

// Registry of carrier types by domain
const CARRIER_REGISTRY = new Map<string, CarrierOperations>();

export function registerCarrier(domain: string, ops: CarrierOperations): void {
  CARRIER_REGISTRY.set(domain, ops);
}

export function getCarrier(domain: string): CarrierOperations | undefined {
  return CARRIER_REGISTRY.get(domain);
}

export function findCarrierDomain(type: Type): string | null {
  for (const [domain, ops] of CARRIER_REGISTRY.entries()) {
    if (ops.is(type)) {
      return domain;
    }
  }
  return null;
}

// Generic carrier operations (work with any registered carrier)
export interface GenericCarrierInfo {
  domain: string;
  value: Type;
  state: Type;
}

// Split any carrier type into domain + value + state
export function splitCarrier(type: Type): GenericCarrierInfo | null {
  const domain = findCarrierDomain(type);
  if (!domain) return null;

  const ops = getCarrier(domain);
  if (!ops) return null;

  const info = ops.split(type);
  if (!info) return null;

  return {
    domain,
    value: info.value,
    state: info.state,
  };
}

// Join value and state into appropriate carrier for domain
export function joinCarrier(
  domain: string,
  value: Type,
  state: Type,
): Type | null {
  const ops = getCarrier(domain);
  if (!ops) return null;
  return ops.join(value, state);
}

// Collapse any carrier type (remove wrapper, keep state)
export function collapseCarrier(type: Type): Type {
  const domain = findCarrierDomain(type);
  if (!domain) return type;

  const ops = getCarrier(domain);
  if (!ops) return type;

  return ops.collapse(type);
}

// Check if a type is ANY carrier type
export function isCarrierType(type: Type): boolean {
  return findCarrierDomain(type) !== null;
}

// Check if a type has a specific carrier domain
export function hasCarrierDomain(type: Type, domain: string): boolean {
  return findCarrierDomain(type) === domain;
}

// Union two carrier states using domain-specific logic
export function unionCarrierStates(
  domain: string,
  left: Type,
  right: Type,
): Type | null {
  const ops = getCarrier(domain);
  if (!ops) return null;
  return ops.unionStates(left, right);
}

// ============================================================================
// Result<T, E> Carrier (Error Domain)
// ============================================================================

// Result carrier operations (refactored from hardcoded functions)
const ResultCarrier: CarrierOperations = {
  is: (type: Type): boolean => {
    return type.kind === "constructor" && type.name === "Result" &&
      type.args.length === 2;
  },

  split: (type: Type): CarrierInfo | null => {
    if (!ResultCarrier.is(type)) {
      return null;
    }
    const resultType = type as Extract<Type, { kind: "constructor" }>;
    const value = resultType.args[0];
    const errorRow = ensureRow(resultType.args[1]);

    // Handle nested Results by flattening
    const inner = ResultCarrier.split(value);
    if (!inner) {
      return { value, state: errorRow };
    }
    return {
      value: inner.value,
      state: errorRowUnion(inner.state, errorRow),
    };
  },

  join: (value: Type, state: Type): Type => {
    const errorRow = ensureRow(state);
    return {
      kind: "constructor",
      name: "Result",
      args: [value, errorRow],
    };
  },

  collapse: (type: Type): Type => {
    const info = ResultCarrier.split(type);
    if (!info) {
      return type;
    }
    const collapsedValue = ResultCarrier.collapse(info.value);
    return ResultCarrier.join(collapsedValue, info.state);
  },

  unionStates: (left: Type, right: Type): Type => {
    return errorRowUnion(left, right);
  },
};

// Register Result carrier for error domain
registerCarrier("error", ResultCarrier);

// ============================================================================
// Tainted<T, TaintRow> Carrier (Taint Domain)
// ============================================================================

// Taint row type - identical structure to error row
export type TaintRowType = Extract<Type, { kind: "error_row" }>;

export function isTaintRow(type: Type): type is TaintRowType {
  return type.kind === "error_row";
}

export function createTaintRow(
  entries: Iterable<[string, Type | null]> = [],
  tail?: Type | null,
): TaintRowType {
  return {
    kind: "error_row",
    cases: new Map(entries),
    tail,
  };
}

// Note: ensureTaintRow removed - use internal ensureRow() instead

export function taintRowUnion(left: Type, right: Type): TaintRowType {
  const lhs = ensureRow(left);
  const rhs = ensureRow(right);
  const merged = new Map<string, Type | null>();
  for (const [label, payload] of lhs.cases.entries()) {
    merged.set(label, payload ? cloneType(payload) : null);
  }
  for (const [label, payload] of rhs.cases.entries()) {
    if (!merged.has(label)) {
      merged.set(label, payload ? cloneType(payload) : null);
      continue;
    }
    const existing = merged.get(label);
    if (!existing && payload) {
      merged.set(label, cloneType(payload));
    }
  }
  return {
    kind: "error_row",
    cases: merged,
    tail: lhs.tail || rhs.tail,
  };
}

// Tainted carrier operations (parallel to Result)
const TaintedCarrier: CarrierOperations = {
  is: (type: Type): boolean => {
    return type.kind === "constructor" && type.name === "Tainted" &&
      type.args.length === 2;
  },

  split: (type: Type): CarrierInfo | null => {
    if (!TaintedCarrier.is(type)) {
      return null;
    }
    const taintedType = type as Extract<Type, { kind: "constructor" }>;
    const value = taintedType.args[0];
    const taintRow = ensureRow(taintedType.args[1]);

    // Handle nested Tainted by flattening
    const inner = TaintedCarrier.split(value);
    if (!inner) {
      return { value, state: taintRow };
    }
    return {
      value: inner.value,
      state: taintRowUnion(inner.state, taintRow),
    };
  },

  join: (value: Type, state: Type): Type => {
    const taintRow = ensureRow(state);
    return {
      kind: "constructor",
      name: "Tainted",
      args: [value, taintRow],
    };
  },

  collapse: (type: Type): Type => {
    const info = TaintedCarrier.split(type);
    if (!info) {
      return type;
    }
    const collapsedValue = TaintedCarrier.collapse(info.value);
    return TaintedCarrier.join(collapsedValue, info.state);
  },

  unionStates: (left: Type, right: Type): Type => {
    return taintRowUnion(left, right);
  },
};

// Register Tainted carrier for taint domain
registerCarrier("taint", TaintedCarrier);

// ============================================================================
// Public API for Tainted type
// ============================================================================

export interface TaintedTypeInfo {
  value: Type;
  taint: TaintRowType;
}

export function isTaintedType(type: Type): boolean {
  return TaintedCarrier.is(type);
}

export function flattenTaintedType(type: Type): TaintedTypeInfo | null {
  const info = TaintedCarrier.split(type);
  if (!info) return null;
  return { value: info.value, taint: info.state as TaintRowType };
}

export function makeTaintedType(value: Type, taint?: Type): Type {
  const taintRow = taint ? ensureRow(taint) : createTaintRow();
  return TaintedCarrier.join(value, taintRow);
}

export function collapseTaintedType(type: Type): Type {
  return TaintedCarrier.collapse(type);
}

// ============================================================================
// Hole<T, HoleRow> Carrier (Hole Domain)
// ============================================================================
// Represents incomplete/unknown types that propagate through expressions.
// Instead of using { kind: "unknown", provenance }, we model this as
// Hole<T, HoleRow> where T is the "best guess" type and HoleRow tracks
// reasons for incompleteness.

// HoleRow uses the same error_row structure but with provenance labels
export type HoleRowType = ErrorRowType;

export function createHoleRow(
  cases?: Map<string, Type | null>,
  tail?: Type | null,
): HoleRowType {
  return {
    kind: "error_row",
    cases: cases ?? new Map(),
    tail,
  };
}

export function holeRowUnion(left: Type, right: Type): HoleRowType {
  const lhs = ensureRow(left);
  const rhs = ensureRow(right);
  const merged = new Map<string, Type | null>();
  for (const [label, payload] of lhs.cases.entries()) {
    merged.set(label, payload ? cloneType(payload) : null);
  }
  for (const [label, payload] of rhs.cases.entries()) {
    if (!merged.has(label)) {
      merged.set(label, payload ? cloneType(payload) : null);
      continue;
    }
    const existing = merged.get(label);
    if (!existing && payload) {
      merged.set(label, cloneType(payload));
    }
  }
  return {
    kind: "error_row",
    cases: merged,
    tail: mergeErrorRowTails(lhs.tail, rhs.tail),
  };
}

const HoleCarrier: CarrierOperations = {
  is: (type: Type): boolean => {
    return type.kind === "constructor" && type.name === "Hole" &&
      type.args.length === 2;
  },

  split: (type: Type): CarrierInfo | null => {
    if (!HoleCarrier.is(type)) {
      return null;
    }
    const holeType = type as Extract<Type, { kind: "constructor" }>;
    const value = holeType.args[0];
    const holeRow = ensureRow(holeType.args[1]);

    // Handle nested Holes by flattening
    const inner = HoleCarrier.split(value);
    if (!inner) {
      return { value, state: holeRow };
    }
    return {
      value: inner.value,
      state: holeRowUnion(inner.state, holeRow),
    };
  },

  join: (value: Type, state: Type): Type => {
    const holeRow = ensureRow(state);
    return {
      kind: "constructor",
      name: "Hole",
      args: [value, holeRow],
    };
  },

  collapse: (type: Type): Type => {
    const info = HoleCarrier.split(type);
    if (!info) {
      return type;
    }
    const collapsedValue = HoleCarrier.collapse(info.value);
    return HoleCarrier.join(collapsedValue, info.state);
  },

  unionStates: (left: Type, right: Type): Type => {
    return holeRowUnion(left, right);
  },
};

// Register Hole carrier for hole domain
registerCarrier("hole", HoleCarrier);

// ============================================================================
// Public API for Hole type
// ============================================================================

export interface HoleTypeInfo {
  value: Type;
  holeRow: HoleRowType;
}

export function isHoleType(type: Type): boolean {
  return HoleCarrier.is(type);
}

export function flattenHoleType(type: Type): HoleTypeInfo | null {
  const info = HoleCarrier.split(type);
  if (!info) return null;
  return { value: info.value, holeRow: info.state as HoleRowType };
}

export function makeHoleType(value: Type, holeRow?: Type): Type {
  const row = holeRow ? ensureRow(holeRow) : createHoleRow();
  return HoleCarrier.join(value, row);
}

export function collapseHoleType(type: Type): Type {
  return HoleCarrier.collapse(type);
}

// Helper: Extract provenance from hole type
export function getProvenance(type: Type): Provenance | null {
  const holeInfo = flattenHoleType(type);
  if (!holeInfo) return null;
  // Extract provenance from hole row labels (JSON-encoded)
  for (const label of holeInfo.holeRow.cases.keys()) {
    if (label.startsWith("hole:")) {
      try {
        return JSON.parse(label.substring(5)) as Provenance;
      } catch {
        // If parsing fails, return incomplete provenance
        return { kind: "incomplete", reason: "invalid_provenance" };
      }
    }
  }
  // If no hole: prefix found, return a default
  return { kind: "incomplete", reason: "no_provenance" };
}

// ============================================================================
// Backward Compatibility: Keep old Result functions as wrappers
// ============================================================================
// These are now thin wrappers around the generic carrier system

export interface ResultTypeInfo {
  value: Type;
  error: ErrorRowType;
}

export function isResultType(type: Type): boolean {
  return ResultCarrier.is(type);
}

export function flattenResultType(type: Type): ResultTypeInfo | null {
  const info = ResultCarrier.split(type);
  if (!info) return null;
  // Convert state back to error for API compatibility
  return { value: info.value, error: info.state as ErrorRowType };
}

export function makeResultType(value: Type, error?: Type): Type {
  const errorRow = error ? ensureRow(error) : createErrorRow();
  return ResultCarrier.join(value, errorRow);
}

export function collapseResultType(type: Type): Type {
  return ResultCarrier.collapse(type);
}

// ============================================================================
// End of Carrier Type System
// ============================================================================

let nextTypeVarId = 0;

export function resetTypeVarCounter(): void {
  nextTypeVarId = 0;
}

export function freshTypeVar(): Type {
  return { kind: "var", id: nextTypeVarId++ };
}

export function unknownType(provenance: Provenance): Type {
  // NEW: Model unknown types as Hole<α, provenance>
  // Instead of { kind: "unknown", provenance }, use Hole carrier
  // Store provenance as JSON-encoded label for recovery
  const provenanceLabel = `hole:${JSON.stringify(provenance)}`;
  const holeRow = createHoleRow(
    new Map([[provenanceLabel, null]]),
  );
  const valueVar = freshTypeVar(); // The "best guess" type
  return makeHoleType(valueVar, holeRow);
}

export function applySubstitution(type: Type, subst: Substitution): Type {
  switch (type.kind) {
    case "var": {
      // Iteratively chase substitutions to avoid deep recursion and handle cycles/identity mappings
      let current: Type = type;
      const seen = new Set<number>();
      while (current.kind === "var") {
        const mapped = subst.get(current.id);
        if (!mapped) {
          return current;
        }
        if (mapped.kind === "var") {
          if (mapped.id === current.id) {
            // Identity mapping, return as-is to avoid infinite recursion
            return current;
          }
          if (seen.has(current.id)) {
            // Cycle detected (e.g., v1 -> v2 -> v1). Break by returning current var.
            return current;
          }
          seen.add(current.id);
          current = mapped;
          continue;
        }
        // Mapped to a non-var: apply substitution recursively into that structure
        return applySubstitution(mapped, subst);
      }
      return current;
    }
    case "func":
      return {
        kind: "func",
        from: applySubstitution(type.from, subst),
        to: applySubstitution(type.to, subst),
      };
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map((arg) => applySubstitution(arg, subst)),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((el) => applySubstitution(el, subst)),
      };
    case "record": {
      let changed = false;
      const updated = new Map<string, Type>();
      for (const [field, fieldType] of type.fields.entries()) {
        const applied = applySubstitution(fieldType, subst);
        if (applied !== fieldType) {
          changed = true;
        }
        updated.set(field, applied);
      }
      if (!changed) {
        return type;
      }
      return { kind: "record", fields: updated };
    }
    case "error_row": {
      let changed = false;
      const nextCases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        if (!payload) {
          nextCases.set(label, null);
          continue;
        }
        const applied = applySubstitution(payload, subst);
        if (applied !== payload) {
          changed = true;
        }
        nextCases.set(label, applied);
      }
      const nextTail = type.tail
        ? applySubstitution(type.tail, subst)
        : undefined;
      if (!changed && nextTail === type.tail) {
        return type;
      }
      return {
        kind: "error_row",
        cases: nextCases,
        tail: nextTail,
      };
    }
    default:
      return type;
  }
}

export function applySubstitutionScheme(
  scheme: TypeScheme,
  subst: Substitution,
): TypeScheme {
  const filtered = new Map<number, Type>();
  for (const [id, ty] of subst.entries()) {
    if (!scheme.quantifiers.includes(id)) {
      filtered.set(id, ty);
    }
  }
  return {
    quantifiers: scheme.quantifiers,
    type: applySubstitution(scheme.type, filtered),
  };
}

export function composeSubstitution(
  a: Substitution,
  b: Substitution,
): Substitution {
  const result: Substitution = new Map();
  for (const [id, type] of b.entries()) {
    const applied = applySubstitution(type, a);
    // Avoid identity mappings like id -> Var(id), which can cause infinite recursion when applied
    if (!(applied.kind === "var" && applied.id === id)) {
      result.set(id, applied);
    }
  }
  for (const [id, type] of a.entries()) {
    result.set(id, type);
  }
  return result;
}

export function occursInType(id: number, type: Type): boolean {
  switch (type.kind) {
    case "var":
      return type.id === id;
    case "func":
      return occursInType(id, type.from) || occursInType(id, type.to);
    case "constructor":
      return type.args.some((arg) => occursInType(id, arg));
    case "tuple":
      return type.elements.some((el) => occursInType(id, el));
    case "record":
      for (const fieldType of type.fields.values()) {
        if (occursInType(id, fieldType)) {
          return true;
        }
      }
      return false;
    case "error_row":
      for (const payload of type.cases.values()) {
        if (payload && occursInType(id, payload)) {
          return true;
        }
      }
      return type.tail ? occursInType(id, type.tail) : false;
    default:
      return false;
  }
}

export function freeTypeVars(type: Type): Set<number> {
  switch (type.kind) {
    case "var":
      return new Set([type.id]);
    case "func":
      return unionSets(freeTypeVars(type.from), freeTypeVars(type.to));
    case "constructor": {
      const sets = type.args.map(freeTypeVars);
      return unionMany(sets);
    }
    case "tuple": {
      const sets = type.elements.map(freeTypeVars);
      return unionMany(sets);
    }
    case "record": {
      const sets = Array.from(type.fields.values()).map(freeTypeVars);
      return unionMany(sets);
    }
    case "error_row": {
      const caseSets = Array.from(type.cases.values())
        .filter((payload): payload is Type => Boolean(payload))
        .map(freeTypeVars);
      const tailSet = type.tail ? [freeTypeVars(type.tail)] : [];
      return unionMany([...caseSets, ...tailSet]);
    }
    default:
      return new Set();
  }
}

export function freeTypeVarsScheme(scheme: TypeScheme): Set<number> {
  const vars = freeTypeVars(scheme.type);
  for (const q of scheme.quantifiers) {
    vars.delete(q);
  }
  return vars;
}

export function generalize(
  type: Type,
  env: TypeEnv,
  extraQuantifiers: number[] = [],
): TypeScheme {
  const typeVars = freeTypeVars(type);
  for (const scheme of env.values()) {
    const envVars = freeTypeVarsScheme(scheme);
    for (const v of envVars) {
      typeVars.delete(v);
    }
  }
  for (const id of extraQuantifiers) {
    typeVars.add(id);
  }
  return { quantifiers: Array.from(typeVars), type };
}

export function instantiate(scheme: TypeScheme): Type {
  // Ensure fresh vars don't conflict with quantifiers
  // Find the max quantifier ID and make sure nextTypeVarId is beyond it
  const maxQuantifierId = Math.max(...scheme.quantifiers, nextTypeVarId - 1);
  if (nextTypeVarId <= maxQuantifierId) {
    nextTypeVarId = maxQuantifierId + 1;
  }

  const subst: Substitution = new Map();
  for (const id of scheme.quantifiers) {
    subst.set(id, freshTypeVar());
  }

  return applySubstitution(scheme.type, subst);
}

export type TypeEnv = Map<string, TypeScheme>;

export interface ConstructorInfo {
  name: string;
  arity: number;
  scheme: TypeScheme;
}

export interface TypeInfo {
  name: string;
  parameters: number[];
  constructors: ConstructorInfo[];
  alias?: Type;
  isAlias?: boolean;
}

export type TypeEnvADT = Map<string, TypeInfo>;

export function cloneType(type: Type): Type {
  switch (type.kind) {
    case "var":
      return { kind: "var", id: type.id };
    case "func":
      return {
        kind: "func",
        from: cloneType(type.from),
        to: cloneType(type.to),
      };
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map(cloneType),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map(cloneType),
      };
    case "record": {
      const clonedFields = new Map<string, Type>();
      for (const [field, fieldType] of type.fields.entries()) {
        clonedFields.set(field, cloneType(fieldType));
      }
      return {
        kind: "record",
        fields: clonedFields,
      };
    }
    case "error_row": {
      const clonedCases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        clonedCases.set(label, payload ? cloneType(payload) : null);
      }
      return {
        kind: "error_row",
        cases: clonedCases,
        tail: type.tail ? cloneType(type.tail) : undefined,
      };
    }
    case "unit":
      return { kind: "unit" };
    case "int":
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "char":
      return { kind: "char" };
    case "string":
      return { kind: "string" };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function cloneTypeScheme(scheme: TypeScheme): TypeScheme {
  return {
    quantifiers: [...scheme.quantifiers],
    type: cloneType(scheme.type),
  };
}

export function cloneConstructorInfo(info: ConstructorInfo): ConstructorInfo {
  return {
    name: info.name,
    arity: info.arity,
    scheme: cloneTypeScheme(info.scheme),
  };
}

export function typeToString(type: Type): string {
  switch (type.kind) {
    case "var":
      return `'t${type.id}`;
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    case "unit":
      return "()";
    case "func":
      return `(${typeToString(type.from)} -> ${typeToString(type.to)})`;
    case "constructor": {
      if (type.args.length === 0) {
        return type.name;
      }
      const args = type.args.map(typeToString).join(", ");
      return `${type.name}<${args}>`;
    }
    case "tuple": {
      const elems = type.elements.map(typeToString).join(", ");
      return `(${elems})`;
    }
    case "record": {
      const entries = Array.from(type.fields.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const rendered = entries.map(([name, fieldType]) =>
        `${name}: ${typeToString(fieldType)}`
      ).join(", ");
      return `{ ${rendered} }`;
    }
    case "error_row": {
      const entries = Array.from(type.cases.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const rendered = entries.map(([label, payload]) =>
        payload ? `${label}(${typeToString(payload)})` : label
      );

      // Simplify display for common cases:
      // 1. If no concrete cases and just a tail, show the tail directly
      if (rendered.length === 0 && type.tail) {
        return typeToString(type.tail);
      }
      // 2. If one concrete case with an open tail variable, hide the tail
      if (rendered.length === 1 && type.tail?.kind === "var") {
        return `<${rendered[0]}>`;
      }

      // Otherwise show full notation with tail
      if (type.tail) {
        const tailStr = typeToString(type.tail);
        // Tail represents "all other potential errors" - prefix with _
        rendered.push(`_${tailStr}`);
      } else if (rendered.length === 0) {
        // Empty error row
        rendered.push("_");
      }
      return `<${rendered.join(" | ")}>`;
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function cloneProvenance(provenance: Provenance): Provenance {
  switch (provenance.kind) {
    case "user_hole":
    case "expr_hole":
      return { ...provenance };
    case "error_free_var":
      return { ...provenance };
    case "error_not_function":
      return {
        kind: "error_not_function",
        calleeType: cloneType(provenance.calleeType),
      };
    case "error_occurs_check":
      return {
        kind: "error_occurs_check",
        left: cloneType(provenance.left),
        right: cloneType(provenance.right),
      };
    case "error_inconsistent":
      return {
        kind: "error_inconsistent",
        expected: cloneType(provenance.expected),
        actual: cloneType(provenance.actual),
      };
    case "error_unify_conflict":
      return {
        kind: "error_unify_conflict",
        typeA: cloneType(provenance.typeA),
        typeB: cloneType(provenance.typeB),
      };
    case "error_type_expr_unknown":
    case "error_type_expr_arity":
    case "error_type_expr_unsupported":
    case "error_internal":
    case "incomplete":
      return { ...provenance };
    default: {
      const _exhaustive = provenance;
      return _exhaustive;
    }
  }
}

export function provenanceToString(provenance: Provenance): string {
  switch (provenance.kind) {
    case "user_hole":
      return "?";
    case "expr_hole":
      return "?";
    case "error_free_var":
      return `?(free ${provenance.name})`;
    case "error_not_function":
      return "?(not-function)";
    case "error_occurs_check":
      return "?(occurs-check)";
    case "error_inconsistent":
      return "?(inconsistent)";
    case "error_unify_conflict":
      return "?(conflict)";
    case "error_unfillable_hole":
      return `?(unfillable: ${provenance.conflicts.length} conflicting constraints)`;
    case "error_type_expr_unknown":
      return `?(unknown type: ${provenance.name})`;
    case "error_type_expr_arity":
      return `?(arity mismatch: expected ${provenance.expected}, got ${provenance.actual})`;
    case "error_type_expr_unsupported":
      return "?(unsupported type expression)";
    case "error_internal":
      return `?(internal error: ${provenance.reason})`;
    case "incomplete":
      return `?(incomplete:${provenance.reason})`;
    default: {
      const _exhaustive: never = provenance;
      return _exhaustive;
    }
  }
}

export function cloneTypeInfo(info: TypeInfo): TypeInfo {
  return {
    name: info.name,
    parameters: [...info.parameters],
    constructors: info.constructors.map(cloneConstructorInfo),
    alias: info.alias ? cloneType(info.alias) : undefined,
    isAlias: info.isAlias,
  };
}

function unionSets(a: Set<number>, b: Set<number>): Set<number> {
  const result = new Set(a);
  for (const value of b) {
    result.add(value);
  }
  return result;
}

function unionMany(sets: Set<number>[]): Set<number> {
  const result = new Set<number>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}
