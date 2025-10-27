import type { RuntimeValue } from "./value.ts";
import { formatRuntimeValue as workmanFormatRuntimeValue } from "./value_printer_v2.js";

type WorkmanList<T> =
  | { tag: typeof LIST_TAG_EMPTY }
  | { tag: typeof LIST_TAG_LINK; _0: T; _1: WorkmanList<T> };

interface WorkmanValue {
  tag: number;
  _0?: unknown;
  _1?: unknown;
}

const LIST_TAG_EMPTY = 0;
const LIST_TAG_LINK = 1;

const RUNTIME_TAG_UNIT = 0;
const RUNTIME_TAG_INT = 1;
const RUNTIME_TAG_BOOL = 2;
const RUNTIME_TAG_CHAR = 3;
const RUNTIME_TAG_STRING = 4;
const RUNTIME_TAG_TUPLE = 5;
const RUNTIME_TAG_DATA = 6;
const RUNTIME_TAG_CLOSURE = 7;
const RUNTIME_TAG_NATIVE = 8;

const EMPTY_LIST: WorkmanList<never> = { tag: LIST_TAG_EMPTY };

export function formatRuntimeValue(value: RuntimeValue): string {
  const workmanValue = toWorkmanValue(value);
  const workmanString = workmanFormatRuntimeValue(workmanValue) as WorkmanList<number>;
  return workmanListToString(workmanString);
}

function toWorkmanValue(value: RuntimeValue): WorkmanValue {
  switch (value.kind) {
    case "unit":
      return { tag: RUNTIME_TAG_UNIT };
    case "int":
      return { tag: RUNTIME_TAG_INT, _0: value.value };
    case "bool":
      return { tag: RUNTIME_TAG_BOOL, _0: value.value };
    case "char":
      return { tag: RUNTIME_TAG_CHAR, _0: value.value };
    case "string":
      return { tag: RUNTIME_TAG_STRING, _0: stringToList(value.value) };
    case "tuple":
      return {
        tag: RUNTIME_TAG_TUPLE,
        _0: arrayToList(value.elements.map(toWorkmanValue)),
      };
    case "data":
      return {
        tag: RUNTIME_TAG_DATA,
        _0: stringToList(value.constructor),
        _1: arrayToList(value.fields.map(toWorkmanValue)),
      };
    case "closure":
      return { tag: RUNTIME_TAG_CLOSURE };
    case "native":
      return { tag: RUNTIME_TAG_NATIVE, _0: stringToList(value.name) };
    default:
      throw new Error(`Unsupported runtime value kind: ${(value as { kind?: unknown }).kind}`);
  }
}

function arrayToList<T>(items: T[]): WorkmanList<T> {
  let result = EMPTY_LIST as WorkmanList<T>;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    result = { tag: LIST_TAG_LINK, _0: items[i], _1: result };
  }
  return result;
}

function stringToList(value: string): WorkmanList<number> {
  const codes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    codes.push(code);
  }
  return arrayToList(codes);
}

function workmanListToString(list: WorkmanList<number>): string {
  let result = "";
  let cursor: WorkmanList<number> | undefined = list;

  while (cursor && cursor.tag === LIST_TAG_LINK) {
    const code = cursor._0;
    if (typeof code !== "number") {
      throw new Error("Workman string contained non-numeric character code");
    }
    result += String.fromCodePoint(code);
    cursor = cursor._1;
  }

  if (!cursor || cursor.tag !== LIST_TAG_EMPTY) {
    throw new Error("Unexpected Workman list terminator while reading string");
  }

  return result;
}
