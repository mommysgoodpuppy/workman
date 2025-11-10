import { assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
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

Deno.test("Result match guardrails flag Result-returning arms", () => {
  const source = `
    type ParseError = Bad;
    let handle = (value: Result<Int, <Bad>>) => {
      match(value) {
        Ok(x) => { Ok(x) },
        Err(_) => { Err(Bad) }
      }
    };
  `;
  const result = inferSource(source);
  const reasons = result.layer1Diagnostics.map((diag) => diag.reason);
  assertArrayIncludes(reasons, [
    "result_match_ok_returns_result",
    "result_match_err_returns_result",
  ]);
  const binding = result.summaries.find((entry) => entry.name === "handle");
  if (!binding) {
    throw new Error("expected handle summary");
  }
  const typeStr = formatScheme(binding.scheme);
  if (!typeStr.includes("Result<Int")) {
    throw new Error(`expected handle to return a Result, got ${typeStr}`);
  }
});
