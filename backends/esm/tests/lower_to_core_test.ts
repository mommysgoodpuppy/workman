// Tests for Surface → Core lowering

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";
import { lex } from "../../../src/lexer.ts";
import { inferProgram } from "../../../src/infer.ts";
import { lowerToCore } from "../src/lower_to_core.ts";

Deno.test("lower simple let binding", () => {
  const source = `let x = 42;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  assertEquals(core.bindings.length, 1);
  assertEquals(core.bindings[0].name, "x");
  assertEquals(core.bindings[0].expr.kind, "core_lit");
});

Deno.test("lower function", () => {
  const source = `
    infixl 7 * = nativeMul;
    let double = (x) => { x * 2 };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  assertEquals(core.bindings.length, 1);
  assertEquals(core.bindings[0].name, "double");
  assertEquals(core.bindings[0].expr.kind, "core_lam");
  
  const lam = core.bindings[0].expr;
  if (lam.kind === "core_lam") {
    assertEquals(lam.params, ["x"]);
    assertEquals(lam.body.kind, "core_prim");
  }
});

Deno.test("lower binary operations to primitives", () => {
  const source = `
    infixl 6 + = nativeAdd;
    let sum = (a, b) => { a + b };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  const lam = core.bindings[0].expr;
  if (lam.kind === "core_lam") {
    const body = lam.body;
    assertEquals(body.kind, "core_prim");
    if (body.kind === "core_prim") {
      assertEquals(body.op, "add");
      assertEquals(body.args.length, 2);
    }
  }
});

Deno.test("lower type declaration", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let x = None;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  assertEquals(core.types.length, 1);
  assertEquals(core.types[0].name, "Option");
  assertEquals(core.types[0].constructors.length, 2);
  assertEquals(core.types[0].constructors[0].name, "Some");
  assertEquals(core.types[0].constructors[1].name, "None");
});

Deno.test("lower match expression", () => {
  const source = `
    let isZero = match(n) {
      0 => { true },
      _ => { false }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  const lam = core.bindings[0].expr;
  if (lam.kind === "core_lam") {
    assertEquals(lam.body.kind, "core_match");
    if (lam.body.kind === "core_match") {
      assertEquals(lam.body.cases.length, 2);
      assertEquals(lam.body.cases[0].pattern.kind, "core_plit");
      assertEquals(lam.body.cases[1].pattern.kind, "core_pwildcard");
    }
  }
});

Deno.test("lower recursive function", () => {
  const source = `
    infixl 7 * = nativeMul;
    infixl 6 - = nativeSub;
    let rec factorial = match(n) {
      0 => { 1 },
      _ => { n * factorial(n - 1) }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  
  const core = lowerToCore(program, inferResult);
  
  assertEquals(core.bindings[0].expr.kind, "core_letrec");
  if (core.bindings[0].expr.kind === "core_letrec") {
    assertEquals(core.bindings[0].expr.bindings.length, 1);
    assertEquals(core.bindings[0].expr.bindings[0].name, "factorial");
  }
});
