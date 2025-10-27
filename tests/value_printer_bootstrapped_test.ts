import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { formatRuntimeValue } from "../src_bootstrapped/value_printer.ts";
import type { RuntimeValue } from "../src/value.ts";
import { UNIT_VALUE, createEnvironment } from "../src/value.ts";

const char = (character: string): RuntimeValue => ({
  kind: "char",
  value: character.codePointAt(0) ?? 0,
});

const int = (value: number): RuntimeValue => ({
  kind: "int",
  value,
});

const bool = (value: boolean): RuntimeValue => ({
  kind: "bool",
  value,
});

const str = (value: string): RuntimeValue => ({
  kind: "string",
  value,
});

const tuple = (...elements: RuntimeValue[]): RuntimeValue => ({
  kind: "tuple",
  elements,
});

const data = (constructor: string, ...fields: RuntimeValue[]): RuntimeValue => ({
  kind: "data",
  constructor,
  fields,
});

const closure = (): RuntimeValue => ({
  kind: "closure",
  parameters: [],
  body: { kind: "block", statements: [], result: null } as any,
  env: createEnvironment(null),
});

const nativeFn = (name: string): RuntimeValue => ({
  kind: "native",
  name,
  arity: 0,
  collectedArgs: [],
  impl: () => UNIT_VALUE,
});

Deno.test("bootstrapped value_printer formats runtime values", () => {
  const cases: Array<[string, RuntimeValue]> = [
    ["unit", UNIT_VALUE],
    ["int", int(42)],
    ["bool_true", bool(true)],
    ["bool_false", bool(false)],
    ["char", char("a")],
    ["string", str("hello")],
    ["tuple", tuple(int(1), bool(true), str("ok"))],
    ["data_empty", data("Nothing")],
    ["data_with_fields", data("Just", int(99))],
    [
      "nested_data",
      data("Result", data("Ok", str("value")), data("Err", tuple(char("b"), int(2)))),
    ],
    ["closure", closure()],
    ["native", nativeFn("debug")],
  ];

  const expectations: Record<string, string> = {
    unit: "()",
    int: "42",
    bool_true: "true",
    bool_false: "false",
    char: "'a'",
    string: "hello",
    tuple: "(1, true, ok)",
    data_empty: "Nothing",
    data_with_fields: "Just 99",
    nested_data: "Result Ok value Err ('b', 2)",
    closure: "<closure>",
    native: "<native debug>",
  };

  for (const [name, input] of cases) {
    assertEquals(formatRuntimeValue(input), expectations[name], `case ${name}`);
  }
});
