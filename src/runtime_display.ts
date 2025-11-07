import type { CoreModule } from "../backends/compiler/ir/core.ts";

export interface CompiledValueSummary {
  readonly name: string;
  readonly value: string;
}

export interface CollectCompiledValuesOptions {
  readonly forcedValueNames?: readonly string[];
}

export function collectCompiledValues(
  moduleExports: Record<string, unknown>,
  module: CoreModule,
  options: CollectCompiledValuesOptions = {},
): CompiledValueSummary[] {
  const results: CompiledValueSummary[] = [];
  const seen = new Set<string>();
  const forcedNames = options.forcedValueNames ?? [];

  for (const exp of module.exports) {
    if (exp.kind !== "value") continue;
    if (seen.has(exp.exported)) continue;
    seen.add(exp.exported);

    if (Object.prototype.hasOwnProperty.call(moduleExports, exp.exported)) {
      results.push({
        name: exp.exported,
        value: formatCompiledValue(moduleExports[exp.exported]),
      });
    } else {
      results.push({
        name: exp.exported,
        value: "<unavailable>",
      });
    }
  }

  for (const name of forcedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (Object.prototype.hasOwnProperty.call(moduleExports, name)) {
      results.push({
        name,
        value: formatCompiledValue(moduleExports[name]),
      });
    } else {
      results.push({
        name,
        value: "<unavailable>",
      });
    }
  }

  return results;
}

export async function invokeMainIfPresent(
  moduleExports: Record<string, unknown>,
): Promise<void> {
  const candidate = moduleExports["main"];
  if (typeof candidate !== "function") {
    return;
  }
  const result = candidate();
  if (isPromiseLike(result)) {
    await result;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function";
}

export function formatCompiledValue(
  value: unknown,
  seen: Set<unknown> = new Set(),
): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "number" || valueType === "bigint") {
    return String(value);
  }
  if (valueType === "boolean") {
    return value ? "true" : "false";
  }
  if (valueType === "string") {
    return JSON.stringify(value);
  }
  if (valueType === "function") {
    return "<function>";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "<cyclic>";
    seen.add(value);
    return `[${value.map((item) => formatCompiledValue(item, seen)).join(", ")}]`;
  }
  if (valueType === "object") {
    if (seen.has(value)) return "<cyclic>";
    seen.add(value);

    const obj = value as Record<string, unknown>;
    if (isListNode(obj)) {
      return formatList(obj, seen);
    }
    if (isTaggedValue(obj)) {
      return formatTaggedValue(obj, seen);
    }

    const entries = Object.entries(obj)
      .map(([key, entryValue]) => `${key}: ${formatCompiledValue(entryValue, seen)}`);
    return `{ ${entries.join(", ")} }`;
  }

  return String(value);
}

function isTaggedValue(value: Record<string, unknown>): boolean {
  return typeof value["tag"] === "string" && typeof value["type"] === "string";
}

function isListNode(value: Record<string, unknown>): boolean {
  return value["type"] === "List" && typeof value["tag"] === "string";
}

function formatList(
  node: Record<string, unknown>,
  seen: Set<unknown>,
): string {
  const elements: string[] = [];
  let current: unknown = node;
  const visited = new Set<unknown>();

  while (
    typeof current === "object" && current !== null && isLinkNode(current as Record<string, unknown>)
  ) {
    if (visited.has(current)) return "[<cyclic>]";
    visited.add(current);
    const link = current as Record<string, unknown>;
    elements.push(formatCompiledValue(link["_0"], seen));
    current = link["_1"];
  }

  if (
    typeof current === "object" && current !== null && isEmptyNode(current as Record<string, unknown>)
  ) {
    return `[${elements.join(", ")}]`;
  }

  const tail = formatCompiledValue(current, seen);
  const prefix = elements.join(", ");
  return `[${prefix}${prefix ? " | " : ""}${tail}]`;
}

function isLinkNode(value: Record<string, unknown>): boolean {
  return value["type"] === "List" && value["tag"] === "Link";
}

function isEmptyNode(value: Record<string, unknown>): boolean {
  return value["type"] === "List" && value["tag"] === "Empty";
}

function formatTaggedValue(
  value: Record<string, unknown>,
  seen: Set<unknown>,
): string {
  const fieldNames = Object.keys(value)
    .filter((name) => name.startsWith("_"))
    .sort((a, b) => {
      const left = Number.parseInt(a.slice(1), 10);
      const right = Number.parseInt(b.slice(1), 10);
      if (Number.isNaN(left) || Number.isNaN(right)) {
        return a.localeCompare(b);
      }
      return left - right;
    });

  if (fieldNames.length === 0) {
    return String(value["tag"]);
  }

  const parts = fieldNames.map((name) => formatCompiledValue(value[name], seen));
  return `${value["tag"]}(${parts.join(", ")})`;
}
