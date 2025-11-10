import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

function inferSource(source: string) {
  const context = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    context.initialOperators,
    context.initialPrefixOperators,
  );
  return inferProgram(program, {
    initialEnv: context.initialEnv,
    initialAdtEnv: context.initialAdtEnv,
    registerPrelude: false,
  });
}

Deno.test("call constraint captures infectious error rows", () => {
  const source = `
    type ParseError = Missing;

    let parseMaybe = (flag) => {
      match(flag) {
        true => { Ok(1) },
        false => { Err(Missing) }
      }
    };

    let addOne = (x) => {
      x + 1
    };

    let run = () => {
      addOne(parseMaybe(false))
    };
  `;
  const result = inferSource(source);
  const callStub = result.constraintStubs.find((stub) =>
    stub.kind === "call" && stub.argumentErrorRow
  );
  assertExists(callStub);
  const row = callStub.argumentErrorRow!;
  const cases = Array.from(row.cases.keys());
  if (cases.length > 0) {
    assertEquals(cases, ["Missing"]);
  } else {
    const tail = row.tail;
    if (!tail || tail.kind !== "constructor") {
      throw new Error("expected error row to reference ParseError");
    }
    assertEquals(tail.name, "ParseError");
  }
});
