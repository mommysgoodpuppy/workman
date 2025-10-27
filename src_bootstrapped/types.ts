export type Type =
  | { kind: "var"; id: number }
  | { kind: "func"; from: Type; to: Type }
  | { kind: "constructor"; name: string; args: Type[] }
  | { kind: "tuple"; elements: Type[] }
  | { kind: "unit" }
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "char" }
  | { kind: "string" };

export interface TypeScheme {
  quantifiers: number[];
  type: Type;
}

export type Substitution = Map<number, Type>;

let nextTypeVarId = 0;

export function resetTypeVarCounter(): void {
  nextTypeVarId = 0;
}

export function freshTypeVar(): Type {
  return { kind: "var", id: nextTypeVarId++ };
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
    default:
      return type;
  }
}

export function applySubstitutionScheme(scheme: TypeScheme, subst: Substitution): TypeScheme {
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

export function composeSubstitution(a: Substitution, b: Substitution): Substitution {
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

export function generalize(type: Type, env: TypeEnv): TypeScheme {
  const typeVars = freeTypeVars(type);
  for (const scheme of env.values()) {
    const envVars = freeTypeVarsScheme(scheme);
    for (const v of envVars) {
      typeVars.delete(v);
    }
  }
  return {
    quantifiers: [...typeVars],
    type,
  };
}

export function instantiate(scheme: TypeScheme): Type {
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
  }
}

export function cloneTypeInfo(info: TypeInfo): TypeInfo {
  return {
    name: info.name,
    parameters: [...info.parameters],
    constructors: info.constructors.map(cloneConstructorInfo),
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
