import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";
import { RuntimeError } from "../src/value.ts";

function evaluateSource(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  inferProgram(program);
  return evaluateProgram(program);
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
  assertThrows(() => evaluateSource(source), InferError);
});

Deno.test("throws on non-exhaustive runtime match", () => {
  const source = `
    let check = match(b) {
      true => { false }
    };
  `;
  assertThrows(() => evaluateSource(source), InferError);
});
