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
  | { kind: "string" }
  | { kind: "unknown"; provenance: Provenance };

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

export function ensureErrorRow(type: Type): ErrorRowType {
  if (isErrorRow(type)) {
    return type;
  }
  return {
    kind: "error_row",
    cases: new Map(),
    tail: type,
  };
}

export function errorRowUnion(left: Type, right: Type): ErrorRowType {
  const lhs = ensureErrorRow(left);
  const rhs = ensureErrorRow(right);
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

export interface ResultTypeInfo {
  value: Type;
  error: ErrorRowType;
}

export function isResultType(type: Type): type is {
  kind: "constructor";
  name: "Result";
  args: [Type, Type];
} {
  return type.kind === "constructor" && type.name === "Result" &&
    type.args.length === 2;
}

export function makeResultType(value: Type, error?: Type): Type {
  const errorRow = error ? ensureErrorRow(error) : createErrorRow();
  return {
    kind: "constructor",
    name: "Result",
    args: [value, errorRow],
  };
}

export function flattenResultType(type: Type): ResultTypeInfo | null {
  if (!isResultType(type)) {
    return null;
  }
  const value = type.args[0];
  const errorRow = ensureErrorRow(type.args[1]);
  const inner = flattenResultType(value);
  if (!inner) {
    return { value, error: errorRow };
  }
  return {
    value: inner.value,
    error: errorRowUnion(inner.error, errorRow),
  };
}

export function collapseResultType(type: Type): Type {
  const info = flattenResultType(type);
  if (!info) {
    return type;
  }
  const collapsedValue = collapseResultType(info.value);
  return makeResultType(collapsedValue, info.error);
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

let nextTypeVarId = 0;

export function resetTypeVarCounter(): void {
  nextTypeVarId = 0;
}

export function freshTypeVar(): Type {
  return { kind: "var", id: nextTypeVarId++ };
}

export function unknownType(provenance: Provenance): Type {
  return { kind: "unknown", provenance };
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
    case "unknown":
      return type;
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
    case "unknown":
      return false;
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
    case "unknown":
      return new Set();
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
    case "unknown":
      return {
        kind: "unknown",
        provenance: cloneProvenance(type.provenance),
      };
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
    case "unknown":
      return provenanceToString(type.provenance);
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
