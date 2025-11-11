import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

function analyzeSource(source: string) {
  const context = freshPreludeTypeEnv();
  const tokens = lex(source, "todo_infectious.wm");
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

function expectNoDiagnostics(source: string) {
  const analysis = analyzeSource(source);
  if (analysis.layer2.diagnostics.length > 0) {
    console.error("Unexpected diagnostics:", analysis.layer2.diagnostics);
  }
  assertEquals(
    analysis.layer2.diagnostics.length,
    0,
    "Infectious Result discharging should succeed in this scenario",
  );
}

Deno.test("first-class match bundle discharges AllErrors infection", () => {
  const source = `
    type ParseError = Missing | Other;

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let handler = match(result) {
      Ok(value) => { value },
      Err(_) => { 0 },
      AllErrors => { 0 }
    };

    let forced = handler(parseMaybe(true)) + 1;
  `;
  expectNoDiagnostics(source);
});

Deno.test("helper function using AllErrors stops infection", () => {
  const source = `
    type ParseError = Missing | Other;

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let addOne = (value) => {
      value + 1
    };

    let check = (result) => {
      match(result) {
        Ok(value) => { value },
        Err(_) => { 0 },
        AllErrors => { 0 }
      }
    };

    let forced = addOne(check(parseMaybe(true))) + 1;
  `;
  expectNoDiagnostics(source);
});

Deno.test("factory returning AllErrors handler stays infectious-free", () => {
  const source = `
    type ParseError = Missing | Other;

    let parseMaybe = match(flag) {
      true => { Ok(1) },
      false => { Err(Missing) }
    };

    let makeChecker = () => {
      match(result) => {
        Ok(value) => { value },
        Err(_) => { 0 },
        AllErrors => { 0 }
      }
    };

    let forced = makeChecker()(parseMaybe(true)) + 1;
  `;
  expectNoDiagnostics(source);
});
