import { assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

function analyzeSource(source: string) {
  const context = freshPreludeTypeEnv();
  const tokens = lex(source, "test.wm");
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    context.initialOperators,
    context.initialPrefixOperators,
  );
  return analyzeProgram(program, {
    initialEnv: context.initialEnv,
    initialAdtEnv: context.initialAdtEnv,
    registerPrelude: false,
  });
}

Deno.test("solver flags infectious calls that lose Result rows", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let addOne = (value) => {
      value + 1
    };

    let forced = addOne(parseMaybe(false)) + 1;
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  console.log("Emitted diagnostics:", reasons);
  assertArrayIncludes(reasons, ["infectious_call_result_mismatch"]);
});

Deno.test("solver flags matches that claim to discharge but remain infectious", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let leak = (value: Result<Int, ParseError>) => {
      let cleaned: Result<Int, ParseError> = match(value) {
        Ok(v) => { v },
        Err(Missing) => { 0 },
        AllErrors => { 0 }
      };
      cleaned
    };
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assertArrayIncludes(reasons, ["infectious_match_result_mismatch"]);
});

Deno.test("solver flags infectious record projections", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;
    let wrap = (value) => {
      { value: value }
    };

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let forcedField = () => {
      wrap(parseMaybe(false)).value
    };
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assertArrayIncludes(reasons, ["infectious_call_result_mismatch"]);
});

Deno.test("solver flags infectious annotations expecting bare types", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let forced: Int = parseMaybe(true);
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assertArrayIncludes(reasons, ["infectious_call_result_mismatch"]);
});
