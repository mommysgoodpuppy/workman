// Tests for Core → MIR lowering

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";
import { lex } from "../../../src/lexer.ts";
import { inferProgram } from "../../../src/layer1/infer.ts";
import { lowerToCore } from "../src/lower_to_core.ts";
import { lowerToMir } from "../src/lower_to_mir.ts";

Deno.test("lower simple constant to MIR", () => {
  const source = `let x = 42;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  assertEquals(mir.functions.length, 1);
  assertEquals(mir.functions[0].name, "x");
  assertEquals(mir.functions[0].params.length, 0);
  assertEquals(mir.functions[0].blocks.length, 1);
  
  const block = mir.functions[0].blocks[0];
  assertEquals(block.instructions.length, 1);
  assertEquals(block.instructions[0].kind, "mir_const");
});

Deno.test("lower function with primitive to MIR", () => {
  const source = `
    infixl 7 * = nativeMul;
    let double = (x) => { x * 2 };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  assertEquals(mir.functions.length, 1);
  assertEquals(mir.functions[0].name, "double");
  assertEquals(mir.functions[0].params, ["x"]);
  
  const block = mir.functions[0].blocks[0];
  // Should have: const 2, prim mul
  assertEquals(block.instructions.length, 2);
  assertEquals(block.instructions[0].kind, "mir_const");
  assertEquals(block.instructions[1].kind, "mir_prim");
});

Deno.test("lower type declaration generates tag table", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let x = None;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  assertEquals(mir.tagTables.length, 1);
  assertEquals(mir.tagTables[0].typeName, "Option");
  assertEquals(mir.tagTables[0].constructors.length, 2);
  assertEquals(mir.tagTables[0].constructors[0].name, "Some");
  assertEquals(mir.tagTables[0].constructors[0].tag, 0);
  assertEquals(mir.tagTables[0].constructors[1].name, "None");
  assertEquals(mir.tagTables[0].constructors[1].tag, 1);
});

Deno.test("lower constructor application", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let x = Some(42);
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f) => f.name === "x");
  assertEquals(func !== undefined, true);
  
  if (func) {
    const block = func.blocks[0];
    // Should have: const 42, make_tuple, alloc_ctor
    const allocInstr = block.instructions.find((i) => i.kind === "mir_alloc_ctor");
    assertEquals(allocInstr !== undefined, true);
  }
});

Deno.test("lower tuple expression", () => {
  const source = `let pair = (1, 2);`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions[0];
  const block = func.blocks[0];
  
  // Should have: const 1, const 2, make_tuple
  const tupleInstr = block.instructions.find((i) => i.kind === "mir_make_tuple");
  assertEquals(tupleInstr !== undefined, true);
});
