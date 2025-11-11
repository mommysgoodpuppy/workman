import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";
import { formatScheme } from "../src/type_printer.ts";

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

Deno.test("solver allows infectious calls and spreads Result types", () => {
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

  // Should have no errors - infection spreading is allowed
  assertEquals(analysis.layer2.diagnostics.length, 0);

  // Verify that 'forced' has the infected type
  const forcedScheme = analysis.layer1.summaries.find((s) =>
    s.name === "forced"
  )?.scheme;
  assertExists(forcedScheme);
  const forcedType = formatScheme(forcedScheme);
  // Should be Result<Int, ParseError>, not Int
  assert(
    forcedType.includes("Result"),
    `Expected Result type, got: ${forcedType}`,
  );
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

Deno.test("solver allows infectious record projections and spreads Result types", () => {
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

  // Should have no errors - infection spreading is allowed
  assertEquals(analysis.layer2.diagnostics.length, 0);

  // Verify that 'forcedField' has the infected return type
  const forcedFieldScheme = analysis.layer1.summaries.find((s) =>
    s.name === "forcedField"
  )?.scheme;
  assertExists(forcedFieldScheme);
  const forcedFieldType = formatScheme(forcedFieldScheme);
  // Should be Unit -> Result<Int, ParseError>, not Unit -> Int
  assert(
    forcedFieldType.includes("Result"),
    `Expected Result type, got: ${forcedFieldType}`,
  );
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
