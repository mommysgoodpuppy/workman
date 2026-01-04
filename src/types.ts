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
  | { kind: "array"; length: number; element: Type }
  | { kind: "record"; fields: Map<string, Type> }
  | { kind: "effect_row"; cases: Map<string, Type | null>; tail?: Type | null }
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

export type EffectRowType = Extract<Type, { kind: "effect_row" }>;

export function isEffectRow(type: Type): type is EffectRowType {
  return type.kind === "effect_row";
}

export function createEffectRow(
  entries: Iterable<[string, Type | null]> = [],
  tail?: Type | null,
): EffectRowType {
  return {
    kind: "effect_row",
    cases: new Map(entries),
    tail,
  };
}

// Internal helper: converts any type to a row type (used by carriers)
// If already a row, return as-is (flattening nested rows); otherwise wrap as tail
// Exported for use in dynamic carrier registration
export function ensureRow(type: Type): EffectRowType {
  if (type.kind === "effect_row") {
    if (!(type.cases instanceof Map)) {
      const entries = Object.entries(type.cases as Record<string, Type | null>);
      type = {
        kind: "effect_row",
        cases: new Map(entries),
        tail: type.tail,
      };
    }
    // Flatten nested effect_rows: if the tail is also an effect_row, merge them
    if (type.tail?.kind === "effect_row") {
      const tailRow = type.tail;
      const mergedCases = new Map(type.cases);
      // Add cases from the tail
      for (const [label, payload] of tailRow.cases) {
        if (!mergedCases.has(label)) {
          mergedCases.set(label, payload);
        }
      }
      // Recursively flatten the tail's tail
      return ensureRow({
        kind: "effect_row",
        cases: mergedCases,
        tail: tailRow.tail,
      });
    }
    return type;
  }
  return {
    kind: "effect_row",
    cases: new Map(),
    tail: type,
  };
}

export function effectRowUnion(left: Type, right: Type): EffectRowType {
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
    kind: "effect_row",
    cases: merged,
    tail: mergeEffectRowTails(lhs.tail, rhs.tail),
  };
}

function mergeEffectRowTails(
  left?: Type | null,
  right?: Type | null,
): Type | null | undefined {
  if (!left) return right;
  if (!right) return left;
  // If one side is still a type variable, prefer the concrete tail from the other side.
  const leftIsVar = left.kind === "var";
  const rightIsVar = right.kind === "var";
  if (leftIsVar && !rightIsVar) {
    return right;
  }
  if (rightIsVar && !leftIsVar) {
    return left;
  }
  // Fall back to left; downstream unification will reconcile any remaining differences.
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
  // Row-based domains (effect, mem, taint, etc.)
  | { domain: string; row: EffectRowType }
  // Memory domain - capability tracking (legacy shape; kept for back-compat)
  | { domain: "mem"; label: string; identity: Identity }
  // Hole domain - type hole tracking (integration with existing hole system)
  | { domain: "hole"; identity: Identity; provenance: Provenance };

// Helper constructors for constraint labels
export function rowLabel(domain: string, row: EffectRowType): ConstraintLabel {
  return { domain, row };
}

export function effectLabel(row: EffectRowType): ConstraintLabel {
  return rowLabel("effect", row);
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

export function isMemLabel(
  label: ConstraintLabel,
): label is { domain: "mem"; label: string; identity: Identity } {
  return label.domain === "mem" && "label" in label;
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
  if ("row" in label) {
    return `${label.domain}:<${Array.from(label.row.cases.keys()).join("|")}>`;
  }
  if (label.domain === "mem") {
    return `${label.label}[${formatIdentity(label.identity)}]`;
  }
  return `Unknown[${formatIdentity(label.identity)}]`;
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
  // Runtime metadata: which constructor carries the value
  valueConstructor?: string; // e.g., "IOk"
  // Runtime metadata: which constructors carry effects
  effectConstructors?: string[]; // e.g., ["IErr"]
}

// Registry of carrier types by domain - supports multiple carriers per domain
const CARRIER_REGISTRY = new Map<string, CarrierOperations[]>();

export function registerCarrier(domain: string, ops: CarrierOperations): void {
  const existing = CARRIER_REGISTRY.get(domain) || [];
  existing.push(ops);
  CARRIER_REGISTRY.set(domain, existing);
}

export function getCarrier(
  domain: string,
  type: Type,
): CarrierOperations | undefined {
  const carriers = CARRIER_REGISTRY.get(domain);
  if (!carriers) return undefined;
  // Find the first carrier that matches this type
  for (const ops of carriers) {
    if (ops.is(type)) {
      return ops;
    }
  }
  return undefined;
}

// Get constructor metadata for a type name (used by compiler)
export function getConstructorMetadata(
  typeName: string,
): { valueConstructor: string; effectConstructors: string[] } | null {
  for (const carriers of CARRIER_REGISTRY.values()) {
    for (const ops of carriers) {
      // Check if this carrier matches the type name
      if (ops.valueConstructor && ops.effectConstructors) {
        // Try to match by checking a dummy type
        const dummyType: Type = {
          kind: "constructor",
          name: typeName,
          args: [],
        };
        if (ops.is(dummyType)) {
          return {
            valueConstructor: ops.valueConstructor,
            effectConstructors: ops.effectConstructors,
          };
        }
      }
    }
  }
  return null;
}

export function findCarrierDomain(type: Type): string | null {
  for (const [domain, carriers] of CARRIER_REGISTRY.entries()) {
    for (const ops of carriers) {
      if (ops.is(type)) {
        return domain;
      }
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

  const ops = getCarrier(domain, type);
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
  // Get the first carrier for this domain
  // TODO: This assumes all carriers in a domain have the same join logic
  const carriers = CARRIER_REGISTRY.get(domain);
  if (!carriers || carriers.length === 0) return null;
  return carriers[0].join(value, state);
}

// Collapse any carrier type (remove wrapper, keep state)
export function collapseCarrier(type: Type): Type {
  const domain = findCarrierDomain(type);
  if (!domain) return type;

  const ops = getCarrier(domain, type);
  if (!ops) return type;

  return ops.collapse(type);
}

// Check if a type is ANY carrier type
export function isCarrierType(type: Type): boolean {
  if (type.kind !== "constructor") return false;
  return findCarrierDomain(type) !== null;
}

// Debug: get registry size
export function getCarrierRegistrySize(): number {
  return CARRIER_REGISTRY.size;
}

// Debug: get all registered carrier type names
export function getRegisteredCarrierInfo(): { domain: string; sampleTypeName: string }[] {
  const result: { domain: string; sampleTypeName: string }[] = [];
  for (const [domain, carriers] of CARRIER_REGISTRY.entries()) {
    for (const ops of carriers) {
      // Try to guess the type name by testing common names
      for (const testName of ["Mem", "Result", "Hole", "Async", "IResult"]) {
        const testType: Type = {
          kind: "constructor",
          name: testName,
          args: [{ kind: "int" }, { kind: "int" }],
        };
        if (ops.is(testType)) {
          result.push({ domain, sampleTypeName: testName });
          break;
        }
      }
    }
  }
  return result;
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
  // For unionStates, we need a sample type - use left as the sample
  const ops = getCarrier(domain, left);
  if (!ops) return null;
  return ops.unionStates(left, right);
}

// ============================================================================
// Result<T, E> Carrier (Error Domain)
// ============================================================================

// ============================================================================
// Hole<T, Row> Carrier (Hole Domain)
// ============================================================================
// Represents incomplete/unknown types that propagate through expressions.
// Instead of using { kind: "unknown", provenance }, we model this as
// Hole<T, Row> where T is the "best guess" type and the row tracks reasons.

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
      state: effectRowUnion(inner.state, holeRow),
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
    return effectRowUnion(left, right);
  },
};

// Register Hole carrier for hole domain
registerCarrier("hole", HoleCarrier);

// ============================================================================
// Public API for Hole type
// ============================================================================

const HOLE_EFFECT_PREFIX = "hole_effect:" as const;

export interface HoleTypeInfo {
  value: Type;
  holeRow: EffectRowType;
}

export function isHoleType(type: Type): boolean {
  return HoleCarrier.is(type);
}

export function flattenHoleType(type: Type): HoleTypeInfo | null {
  const info = HoleCarrier.split(type);
  if (!info) return null;
  return { value: info.value, holeRow: ensureRow(info.state) };
}

export function makeHoleType(value: Type, holeRow?: Type): Type {
  const row = holeRow ? ensureRow(holeRow) : createEffectRow();
  return HoleCarrier.join(value, row);
}

export function getHoleEffectTags(type: Type): Type[] {
  const info = flattenHoleType(type);
  if (!info) return [];
  if (!(info.holeRow.cases instanceof Map)) {
    console.warn(
      "[warn] holeRow.cases is not a Map",
      info.holeRow,
      type,
    );
    return [];
  }
  const tags: Type[] = [];
  for (const [label, payload] of info.holeRow.cases.entries()) {
    if (label.startsWith(HOLE_EFFECT_PREFIX) && payload) {
      tags.push(payload);
    }
  }
  return tags;
}

export function addHoleEffectTag(type: Type, tag: Type): Type {
  const info = flattenHoleType(type);
  if (!info) {
    return type;
  }
  const row = ensureRow(info.holeRow);
  const newCases = new Map(row.cases);
  let index = 0;
  let label = `${HOLE_EFFECT_PREFIX}${index}`;
  while (newCases.has(label)) {
    index += 1;
    label = `${HOLE_EFFECT_PREFIX}${index}`;
  }
  newCases.set(label, cloneType(tag));
  const updatedRow: EffectRowType = {
    kind: "effect_row",
    cases: newCases,
    tail: row.tail,
  };
  return makeHoleType(info.value, updatedRow);
}

export function collapseHoleType(type: Type): Type {
  return HoleCarrier.collapse(type);
}

// Helper: Extract provenance from hole type
export function getProvenance(type: Type): Provenance | null {
  const holeInfo = flattenHoleType(type);
  if (!holeInfo) return null;
  // Extract provenance from hole row labels (JSON-encoded)
  if (!(holeInfo.holeRow.cases instanceof Map)) {
    console.warn("[warn] invalid hole row in getProvenance", holeInfo);
    return { kind: "incomplete", reason: "invalid_hole_row" };
  }
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
  effect: Type; // Can be effect_row or type variable during inference
}

export function isResultType(type: Type): boolean {
  return hasCarrierDomain(type, "effect");
}

export function flattenResultType(type: Type): ResultTypeInfo | null {
  const info = splitCarrier(type);
  if (!info || info.domain !== "effect") return null;
  // During inference, the state might be a type variable that will become an effect_row
  // So we don't require state.kind === "effect_row" here
  return { value: info.value, effect: info.state };
}

export interface TaintedTypeInfo {
  value: Type;
  taint: Type; // Can be effect_row or type variable during inference
}

export function flattenTaintedType(type: Type): TaintedTypeInfo | null {
  const info = splitCarrier(type);
  if (!info || info.domain !== "taint") return null;
  return { value: info.value, taint: info.state };
}

export function makeResultType(value: Type, error?: Type): Type {
  const effectRow = error ? ensureRow(error) : createEffectRow();
  const carrier = getCarrier("effect", {
    kind: "constructor",
    name: "Result",
    args: [value, effectRow],
  });
  if (carrier) {
    return carrier.join(value, effectRow);
  }
  // Fallback for backward compatibility
  return {
    kind: "constructor",
    name: "Result",
    args: [value, effectRow],
  };
}

export function collapseResultType(type: Type): Type {
  const carrier = getCarrier("effect", type);
  if (carrier) {
    return carrier.collapse(type);
  }
  return type;
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
  const holeRow = createEffectRow(
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
    case "array":
      return {
        kind: "array",
        length: type.length,
        element: applySubstitution(type.element, subst),
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
    case "effect_row": {
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
        kind: "effect_row",
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
    case "array":
      return occursInType(id, type.element);
    case "record":
      for (const fieldType of type.fields.values()) {
        if (occursInType(id, fieldType)) {
          return true;
        }
      }
      return false;
    case "effect_row":
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
    case "array":
      return freeTypeVars(type.element);
    case "record": {
      const sets = Array.from(type.fields.values()).map(freeTypeVars);
      return unionMany(sets);
    }
    case "effect_row": {
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
  recordFields?: Map<string, number>;
  recordDefaults?: Set<string>;
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
    case "array":
      return {
        kind: "array",
        length: type.length,
        element: cloneType(type.element),
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
    case "effect_row": {
      const clonedCases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        clonedCases.set(label, payload ? cloneType(payload) : null);
      }
      return {
        kind: "effect_row",
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

const GENERIC_NAMES_TYPETOSTRING = ["T", "U", "V", "W", "X", "Y", "Z"];

function getGenericName(id: number): string {
  // Just cycle through T, U, V, etc. without showing the raw ID
  return GENERIC_NAMES_TYPETOSTRING[id % GENERIC_NAMES_TYPETOSTRING.length];
}

export function typeToString(type: Type): string {
  switch (type.kind) {
    case "var":
      return getGenericName(type.id);
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

      // Special handling for carrier types with domain state
      // If the second parameter is just a bare type variable, show it as <_>
      if (
        isCarrierType(type) &&
        type.args.length === 2 && type.args[1].kind === "var"
      ) {
        const firstArg = typeToString(type.args[0]);
        return `${type.name}<${firstArg}, <_>>`;
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
    case "effect_row": {
      const entries = Array.from(type.cases.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const rendered = entries.map(([label, payload]) =>
        payload ? `${label}(${typeToString(payload)})` : label
      );

      // Simplify display for common cases:
      // 1. If no concrete cases and just a tail, show the tail directly
      // DISABLED: We want to show effect_row structure for infectious types
      // if (rendered.length === 0 && type.tail) {
      //   return typeToString(type.tail);
      // }

      // 2. If one concrete case with an open tail variable, hide the tail
      if (rendered.length === 1 && type.tail?.kind === "var") {
        return `<${rendered[0]}>`;
      }

      // Show full notation with tail
      if (type.tail) {
        const tailStr = typeToString(type.tail);
        // If no specific cases, just show the tail in angle brackets to indicate it's an error row
        if (rendered.length === 0) {
          // Show as <TailType> to indicate this is an error row, not just the type
          return `<${tailStr}>`;
        }
        // Otherwise show cases with tail using .. prefix
        rendered.push(`..${tailStr}`);
      } else if (rendered.length === 0) {
        // Empty error row (no cases, no tail)
        return `<>`;
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
    recordFields: info.recordFields
      ? new Map(info.recordFields)
      : undefined,
    recordDefaults: info.recordDefaults
      ? new Set(info.recordDefaults)
      : undefined,
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
