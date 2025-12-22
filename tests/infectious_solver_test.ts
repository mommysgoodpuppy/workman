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

    let parseMaybe = match(flag) => {
      true => { IOk(1) },
      false => { IErr(Missing) }
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
  // Should be IResult<Int, ParseError>, not Int
  assert(
    forcedType.includes("IResult"),
    `Expected IResult type, got: ${forcedType}`,
  );
});

Deno.test("solver flags annotation mismatch when match discharges but annotation claims infectious", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let leak = (value: IResult<Int, ParseError>) => {
      let cleaned: IResult<Int, ParseError> = match(value) => {
        IOk(v) => { v },
        IErr(Missing) => { 0 },
        IErr(_) => { 0 }
      };
      cleaned
    };
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  // The match discharges the infectious type (returns Int), but the annotation
  // says it should still be IResult<Int, ParseError>, so we get a type_mismatch
  assertArrayIncludes(reasons, ["type_mismatch"]);
});

Deno.test("solver allows infectious record projections and spreads Result types", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;
    record V { value: Int };
    let wrap = (value) => {
      { value: value }
    };

    let parseMaybe = match(flag) => {
      true => { IOk(1) },
      false => { IErr(Missing) }
    };

    let forcedField = () => {
      wrap(parseMaybe(false)).value
    };
  `);

  // Should have no errors - infection spreading is allowed
  console.log(analysis.layer2.diagnostics);
  assertEquals(analysis.layer2.diagnostics.length, 0);

  // Verify that 'forcedField' has the infected return type
  const forcedFieldScheme = analysis.layer1.summaries.find((s) =>
    s.name === "forcedField"
  )?.scheme;
  assertExists(forcedFieldScheme);
  const forcedFieldType = formatScheme(forcedFieldScheme);
  // Should be Unit -> IResult<Int, ParseError>, not Unit -> Int
  assert(
    forcedFieldType.includes("IResult"),
    `Expected IResult type, got: ${forcedFieldType}`,
  );
});

Deno.test("solver flags infectious annotations expecting bare types", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let parseMaybe = match(flag) => {
      true => { IOk(1) },
      false => { IErr(Missing) }
    };

    let forced: Int = parseMaybe(true);
  `);

  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assertArrayIncludes(reasons, ["infectious_call_result_mismatch"]);
});

Deno.test("match with empty error branch still discharges", () => {
  const analysis = analyzeSource(`
    type ParseError = Missing;

    let stripErr = (value) => {
      match(value) {
        IOk(x) => { x },
        IErr(_) => {
        --noop
        }
      }
    };
  `);

  assertEquals(analysis.layer2.diagnostics.length, 0);
  const binding = analysis.layer1.summaries.find((entry) =>
    entry.name === "stripErr"
  );
  assertExists(binding);
  const typeStr = formatScheme(binding.scheme);
  assert(typeStr === "IResult<T, U> -> T", `stripErr type is wrong, got ${typeStr} instead of IResult<T, U> -> T`)
  assert(
    typeStr.includes("IResult"),
    `expected stripErr to accept an infectious argument, got ${typeStr}`,
  );
  assert(
    !typeStr.includes("-> IResult"),
    `expected stripErr to return bare Int, got ${typeStr}`,
  );
});

