// Tests for let binding lowering and variable substitution

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";
import { lex } from "../../../src/lexer.ts";
import { inferProgram } from "../../../src/layer1/infer.ts";
import { lowerToCore } from "../src/lower_to_core.ts";
import { lowerToMir } from "../src/lower_to_mir.ts";
import type { MirFunction } from "../src/mir.ts";

Deno.test("lower simple computation", () => {
  const source = `
    infixl 6 + = nativeAdd;
    let compute = (x) => { x + 1 };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "compute");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have instructions for: const 1, prim add
    const block = func.blocks[0];
    const hasPrim = block.instructions.some((i) => i.kind === "mir_prim");
    assertEquals(hasPrim, true);
  }
});

Deno.test("lower chained operations", () => {
  const source = `
    infixl 6 + = nativeAdd;
    infixl 7 * = nativeMul;
    let compute = (x) => { (x + 1) * 2 };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "compute");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have two prim operations
    const block = func.blocks[0];
    const primCount = block.instructions.filter((i) => i.kind === "mir_prim").length;
    assertEquals(primCount, 2);
  }
});

Deno.test("lower top-level let bindings", () => {
  const source = `
    let x = 42;
    let y = x;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  // Should have two functions (one for each binding)
  assertEquals(mir.functions.length, 2);
  assertEquals(mir.functions[0].name, "x");
  assertEquals(mir.functions[1].name, "y");
});

Deno.test("lower match with computation in arm", () => {
  const source = `
    infixl 6 + = nativeAdd;
    type Option<a> = Some<a> | None;
    
    let increment = match(opt) {
      Some(x) => { x + 1 },
      None => { 0 }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "increment");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have if/else and prim operations
    const block = func.blocks[0];
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    const hasPrim = block.instructions.some((i) => i.kind === "mir_prim");
    assertEquals(hasIfElse, true);
    assertEquals(hasPrim, true);
  }
});

Deno.test("lower multiple parameters", () => {
  const source = `
    infixl 6 + = nativeAdd;
    let add = (x, y) => { x + y };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "add");
  assertEquals(func !== undefined, true);
  
  if (func) {
    assertEquals(func.params.length, 2);
    assertEquals(func.params[0], "x");
    assertEquals(func.params[1], "y");
  }
});
