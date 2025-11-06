import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import type { TypeScheme } from "../src/types.ts";
import type { RuntimeValue, NativeFunctionValue } from "../src/value.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std/assert/mod.ts";
import { RuntimeError } from "../src/value.ts";

function evaluateSource(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const intBinScheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: { kind: "func", from: { kind: "int" }, to: { kind: "int" } },
    },
  };

  const initialEnv = new Map<string, TypeScheme>([
    ["add", intBinScheme],
    ["sub", intBinScheme],
    ["mul", intBinScheme],
    ["div", intBinScheme],
  ]);

  const initialBindings = new Map<string, RuntimeValue>([
    ["add", native2("add", (a, b) => a + b)],
    ["sub", native2("sub", (a, b) => a - b)],
    ["mul", native2("mul", (a, b) => a * b)],
    ["div", native2("div", (a, b) => {
      if (b === 0) throw new Error("Division by zero");
      return Math.trunc(a / b);
    })],
  ]);

  inferProgram(program, { initialEnv });
  return evaluateProgram(program, { initialBindings });
}

function native2(name: string, impl: (a: number, b: number) => number): NativeFunctionValue {
  return {
    kind: "native",
    name,
    arity: 2,
    collectedArgs: [],
    impl: (args) => ({ kind: "int", value: impl(expectInt(args[0]), expectInt(args[1])) }),
  };
}

function expectInt(value: RuntimeValue): number {
  if (value.kind !== "int") {
    throw new Error("Expected Int argument");
  }
  return value.value;
}

Deno.test("evaluates non-recursive let-binding", () => {
  const source = `
    let identity = (x) => {
      x
    };
  `;
  const result = evaluateSource(source);
  assertEquals(result.summaries.length, 1);
  const identity = result.summaries[0];
  assertEquals(identity.name, "identity");
  assertEquals(identity.value.kind, "closure");
});

Deno.test("supports recursive factorial", () => {
  const source = `
    let rec fact = (n) => {
      match(n) {
        0 => { 1 },
        _ => { mul(n, fact(sub(n, 1))) }
      }
    };
    let five = {
      fact(5)
    };
  `;
  const result = evaluateSource(source);
  const five = result.summaries.find((entry) => entry.name === "five");
  if (!five) {
    throw new Error("Expected 'five' binding");
  }
  if (five.value.kind !== "int") {
    throw new Error(`Expected five to evaluate to an int, received ${five.value.kind}`);
  }
  assertEquals(five.value.value, 120);
});

Deno.test("throws on constructor arity mismatch", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let fail = {
      Some()
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  const notFunction = Array.from(result.marks.values()).find((mark) =>
    mark.kind === "mark_not_function"
  );
  assertExists(notFunction, "expected mark_not_function for constructor arity mismatch");
});

Deno.test("throws on non-exhaustive runtime match", () => {
  const source = `
    let check = match(b) {
      true => { false }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  const nonExhaustive = Array.from(result.marks.values()).find((mark) =>
    mark.kind === "mark_unsupported_expr" && mark.exprKind === "match_non_exhaustive"
  );
  assertExists(nonExhaustive, "expected non-exhaustive match mark");
});

Deno.test("evaluates tuple parameter destructuring", () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
    };
    let result = {
      swap((1, 2))
    };
  `;
  const evaluation = evaluateSource(source);
  const binding = evaluation.summaries.find((entry) => entry.name === "result");
  if (!binding) {
    throw new Error("expected result binding");
  }
  const value = binding.value;
  if (value.kind !== "tuple") {
    throw new Error("expected tuple result");
  }
  const [first, second] = value.elements;
  if (first.kind !== "int" || second.kind !== "int") {
    throw new Error("expected tuple of ints");
  }
  assertEquals(first.value, 2);
  assertEquals(second.value, 1);
});
