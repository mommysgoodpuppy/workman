import {
  ensureRow,
  isCarrierType,
  provenanceToString,
  type Type,
  type TypeScheme,
} from "./types.ts";

interface PrintContext {
  names: Map<number, string>;
  next: number;
}

const GENERIC_NAMES = ["T", "U", "V", "W", "X", "Y", "Z"];

export function formatScheme(scheme: TypeScheme): string {
  const context: PrintContext = { names: new Map(), next: 0 };
  const quantifiers = [...new Set(scheme.quantifiers)].sort((a, b) => a - b);
  for (const id of quantifiers) {
    ensureName(context, id);
  }
  return formatType(scheme.type, context, 0);
}

export function formatType(type: Type, context: PrintContext, prec: number): string {
  //console.log(`[DEBUG] Formatting type: ${JSON.stringify(type)}`);
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

      // Special handling for carrier types with domain state
      // If the second parameter is just a bare type variable, show it as <_>
      if (
        isCarrierType(type) && type.args.length === 2 &&
        type.args[1].kind === "var"
      ) {
        const firstArg = formatType(type.args[0], context, 2);
        return `${type.name}<${firstArg}, <_>>`;
      }

      const args = type.args.map((arg) => formatType(arg, context, 2)).join(
        ", ",
      );
      return `${type.name}<${args}>`;
    }
    case "tuple": {
      const elements = type.elements.map((el) => formatType(el, context, 0))
        .join(", ");
      return `(${elements})`;
    }
    case "record": {
      const entries = Array.from(type.fields.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const fields = entries
        .map(([name, fieldType]) =>
          `${name}: ${formatType(fieldType, context, 0)}`
        )
        .join(", ");
      return `{ ${fields} }`;
    }
    case "effect_row": {
      // Flatten nested error_rows before displaying
      let flattenedType = type;
      if (type.tail?.kind === "effect_row") {
        flattenedType = ensureRow(type);
      }

      // Show error_row structure to make infectious types visible
      // If this row has no explicit cases and only a tail, wrap it in angle brackets
      // to show it's an error row (e.g., <ParseError> instead of ParseError)
      const entries = Array.from(flattenedType.cases.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const parts = entries.map(([label, payload]) =>
        payload ? `${label}(${formatType(payload, context, 0)})` : label
      );

      if (flattenedType.tail) {
        const tailStr = formatType(flattenedType.tail, context, 0);
        if (parts.length === 0) {
          // Just a tail, no specific cases - show as <TailType>
          return `<${tailStr}>`;
        }
        // Cases with tail - use .. prefix to indicate "and more"
        parts.push(`..${tailStr}`);
      } else if (parts.length === 0) {
        // Empty error row
        return `<>`;
      }
      return `<${parts.join(" | ")}>`;
    }
    case "unit":
      return "Unit";
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    default:
      return "?";
  }
}

function ensureName(context: PrintContext, id: number): string {
  const existing = context.names.get(id);
  if (existing) {
    return existing;
  }
  const name = nextName(context.next);
  context.names.set(id, name);
  context.next += 1;
  return name;
}

function nextName(index: number): string {
  const base = GENERIC_NAMES[index % GENERIC_NAMES.length];
  const suffix = Math.floor(index / GENERIC_NAMES.length);
  return suffix === 0 ? base : `${base}${suffix + 1}`;
}
