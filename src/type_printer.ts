import { Type, TypeScheme } from "./types.ts";

interface PrintContext {
  names: Map<number, string>;
  next: number;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function formatScheme(scheme: TypeScheme): string {
  const context: PrintContext = { names: new Map(), next: 0 };
  const quantifiers = [...new Set(scheme.quantifiers)].sort((a, b) => a - b);
  for (const id of quantifiers) {
    ensureName(context, id);
  }
  return formatType(scheme.type, context, 0);
}

function formatType(type: Type, context: PrintContext, prec: number): string {
  switch (type.kind) {
    case "var":
      return ensureName(context, type.id);
    case "func": {
      const left = formatType(type.from, context, 1);
      const right = formatType(type.to, context, 0);
      const result = `${left} -> ${right}`;
      return prec > 0 ? `(${result})` : result;
    }
    case "constructor": {
      if (type.args.length === 0) {
        return type.name;
      }
      const args = type.args.map((arg) => formatType(arg, context, 2)).join(", ");
      return `${type.name}<${args}>`;
    }
    case "tuple": {
      const elements = type.elements.map((el) => formatType(el, context, 0)).join(", ");
      return `(${elements})`;
    }
    case "unit":
      return "()";
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    default:
      return "?";
  }
}

function ensureName(context: PrintContext, id: number): string {
  const existing = context.names.get(id);
  if (existing) {
    return existing;
  }
  const name = `'${nextName(context.next)}`;
  context.names.set(id, name);
  context.next += 1;
  return name;
}

function nextName(index: number): string {
  const letter = LETTERS[index % LETTERS.length];
  const suffix = Math.floor(index / LETTERS.length);
  return suffix === 0 ? letter : `${letter}${suffix}`;
}
