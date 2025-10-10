import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { assertThrows } from "https://deno.land/std/assert/mod.ts";

function inferTypes(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  return inferProgram(program);
}

Deno.test("rejects undeclared type variables in constructors", () => {
  const source = `
    type Bad<T> = Bad<U>;
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown type constructor 'U'",
  );
});

Deno.test("rejects type constructor arity mismatch in annotation", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bad: Option<Int, Bool> = (x) => {
      None
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Type constructor 'Option' expects 1 type argument(s)",
  );
});

Deno.test("rejects non-exhaustive boolean match", () => {
  const source = `
    let onlyTrue = (b) => {
      match(b) {
        true => { false }
      }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Non-exhaustive patterns, missing: false",
  );
});
