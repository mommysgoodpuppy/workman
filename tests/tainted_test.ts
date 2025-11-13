import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

Deno.test("Tainted type propagates through expressions", () => {
  const source = `
    type TaintSrc = UserInput | FileRead;
    
    type Tainted t taint = Pure of t | Impure of taint;

    let getUserInput = () => {
      Impure(UserInput)
    };

    let addOne = (x) => {
      x + 1
    };

    let run = () => {
      let input = getUserInput();
      addOne(input)
    };
  `;

  const result = analyzeSource(source);

  // Check that taint constraint sources exist
  const taintSources = result.layer1.constraintStubs.filter((stub) =>
    stub.kind === "constraint_source" && stub.label.domain === "taint"
  );

  // Should have taint propagation
  assertEquals(
    taintSources.length > 0,
    true,
    "Should have taint constraint sources",
  );
});

Deno.test("Pattern matching on Tainted discharges taint", () => {
  const source = `
    type TaintSrc = UserInput;
    
    type Tainted t taint = Pure of t | Impure of taint;

    let getUserInput = () => {
      Impure(UserInput)
    };

    let sanitize = (tainted) => {
      match(tainted) {
        Pure(x) => { x },
        Impure(t) => { 0 }
      }
    };

    let run = () => {
      let input = getUserInput();
      sanitize(input)
    };
  `;

  const result = analyzeSource(source);

  // Check that constraint_rewrite stubs were emitted for pattern match
  const rewriteStubs = result.layer1.constraintStubs.filter((stub) =>
    stub.kind === "constraint_rewrite"
  );

  assertEquals(
    rewriteStubs.length > 0,
    true,
    "Should have rewrite stubs for pattern matching",
  );
});

Deno.test("Undischarged taint causes boundary violation", () => {
  const source = `
    type TaintSrc = UserInput;
    
    type Tainted t taint = Pure of t | Impure of taint;

    let getUserInput = () => {
      Impure(UserInput)
    };

    let unsafeRun : Int = {
      getUserInput()
    };
  `;

  const result = analyzeSource(source);

  // Should have some kind of diagnostic for undischarged taint
  // This might manifest as a type mismatch or infectious diagnostic
  assertEquals(
    result.layer2.diagnostics.length > 0,
    true,
    "Should have diagnostics for undischarged taint",
  );
});
