import type { Type } from "../types.ts";
import type { Context } from "./context.ts";
import { unify } from "./context.ts";

export type ZigRawCoercionKind =
  | "comptime_int_to_numeric"
  | "slice_to_ptr";

const RAW_NUMERIC_CONSTRUCTORS = new Set<string>([
  "ComptimeInt",
  "ComptimeFloat",
  "I8",
  "I16",
  "I32",
  "I64",
  "I128",
  "Isize",
  "U8",
  "U16",
  "U32",
  "U64",
  "U128",
  "Usize",
  "F16",
  "F32",
  "F64",
  "F128",
  "CChar",
  "CShort",
  "CUShort",
  "CInt",
  "CUInt",
  "CLong",
  "CULong",
  "CLongLong",
  "CULongLong",
]);

function isNumericConstructorName(name: string): boolean {
  return RAW_NUMERIC_CONSTRUCTORS.has(name);
}

export function getZigRawCoercion(
  expected: Type,
  actual: Type,
  ctx?: Context,
): ZigRawCoercionKind | null {
  if (expected.kind !== "constructor" || actual.kind !== "constructor") {
    return null;
  }
  if (actual.name === "ComptimeInt" && isNumericConstructorName(expected.name)) {
    return "comptime_int_to_numeric";
  }
  if (actual.name === "Slice" && (expected.name === "Ptr" || expected.name === "ManyPtr")) {
    if (ctx) {
      if (expected.args.length > 0 && actual.args.length > 0) {
        unify(ctx, expected.args[0], actual.args[0]);
      }
      if (expected.args.length > 1 && actual.args.length > 1) {
        unify(ctx, expected.args[1], actual.args[1]);
      }
    }
    return "slice_to_ptr";
  }
  return null;
}
