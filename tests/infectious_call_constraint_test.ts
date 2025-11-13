import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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
        true => { IOk(1) },
        false => { IErr(Missing) }
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

  // Check that constraint_source stubs are emitted for error propagation
  const constraintSourceStubs = result.constraintStubs.filter((stub) =>
    stub.kind === "constraint_source"
  );

  // Should have at least one error constraint source (from parseMaybe call)
  const hasErrorSource = constraintSourceStubs.some((stub) =>
    stub.kind === "constraint_source" && stub.label.domain === "error"
  );
  assertEquals(hasErrorSource, true, "Should have error constraint sources");

  // Check that constraint_flow stubs connect the pieces
  const flowStubs = result.constraintStubs.filter((stub) =>
    stub.kind === "constraint_flow"
  );

  // Should have flow edges for propagation
  assertEquals(flowStubs.length > 0, true, "Should have constraint flow edges");
});
