import { RuntimeValue } from "./value.ts";

export function formatRuntimeValue(value: RuntimeValue): string {
  switch (value.kind) {
    case "unit":
      return "()";
    case "int":
      return value.value.toString(10);
    case "bool":
      return value.value ? "true" : "false";
    case "char":
      return `'${String.fromCharCode(value.value)}'`;
    case "string":
      return value.value;
    case "tuple":
      return formatTuple(value);
    case "data":
      return formatData(value);
    case "closure":
      return "<closure>";
    case "native":
      return `<native ${value.name}>`;
    default:
      return "<unknown>";
  }
}

function formatTuple(tuple: Extract<RuntimeValue, { kind: "tuple" }>): string {
  if (tuple.elements.length === 0) {
    return "()";
  }
  const items = tuple.elements.map(formatRuntimeValue).join(", ");
  return `(${items})`;
}

function formatData(data: Extract<RuntimeValue, { kind: "data" }>): string {
  if (data.fields.length === 0) {
    return data.constructor;
  }
  const args = data.fields.map(formatRuntimeValue).join(" ");
  return `${data.constructor} ${args}`;
}
