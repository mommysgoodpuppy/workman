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
    
    infectious error type Tainted<T, E> = @value Clean<T> | @effect Dirty<E>;

    let getUserInput = () => {
      Dirty(UserInput)
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

  // User-defined infectious type should propagate without errors
  assertEquals(
    result.layer2.diagnostics.length,
    0,
    "User-defined infectious type should propagate through expressions",
  );
});

Deno.test("Pattern matching on Tainted discharges infection", () => {
  const source = `
    type TaintSrc = UserInput;
    
    infectious error type Tainted<T, E> = @value Clean<T> | @effect Dirty<E>;

    let getUserInput = () => {
      Dirty(UserInput)
    };

    let sanitize = (tainted) => {
      match(tainted) {
        Clean(x) => { x },
        Dirty(UserInput) => { 0 }
      }
    };

    let run = () => {
      let input = getUserInput();
      sanitize(input)
    };
  `;

  const result = analyzeSource(source);

  // Pattern matching should discharge infection
  if (result.layer2.diagnostics.length > 0) {
    console.error("Unexpected diagnostics:", result.layer2.diagnostics);
  }
  assertEquals(
    result.layer2.diagnostics.length,
    0,
    "Pattern matching should discharge user-defined infection",
  );
});

Deno.test({
  name: "BUG: Wildcard pattern in user-defined infectious type fails",
  ignore: true
}, () => {
  const source = `
    type TaintSrc = UserInput | FileRead;
    
    infectious error type Tainted<T, E> = @value Clean<T> | @effect Dirty<E>;

    let getUserInput = () => {
      Dirty(UserInput)
    };

    let sanitize = (tainted) => {
      match(tainted) {
        Clean(x) => { x },
        Dirty(_) => { 0 }
      }
    };

    let run = () => {
      let input = getUserInput();
      sanitize(input)
    };
  `;

  const result = analyzeSource(source);

  // BUG: This should work like IErr(_) does, but currently fails with type_mismatch
  // When fixed, this test should pass (0 diagnostics)
  // Currently: 1 diagnostic (type_mismatch on error_row vs constructor)
  if (result.layer2.diagnostics.length > 0) {
    console.log("BUG CONFIRMED - wildcard pattern fails:", result.layer2.diagnostics[0].reason);
  }
  assertEquals(
    result.layer2.diagnostics.length,
    0,
    "BUG: Wildcard pattern should work like IErr(_) does",
  );
});

Deno.test("Undischarged Tainted causes boundary violation", () => {
  const source = `
    type TaintSrc = UserInput;
    
    infectious error type Tainted<T, E> = @value Clean<T> | @effect Dirty<E>;

    let getUserInput = () => {
      Dirty(UserInput)
    };

    let unsafeRun : Int = {
      getUserInput()
    };
  `;

  const result = analyzeSource(source);

  // Should have diagnostic for undischarged infection at type boundary
  assertEquals(
    result.layer2.diagnostics.length > 0,
    true,
    "Should have diagnostics for undischarged user-defined infection",
  );
});
