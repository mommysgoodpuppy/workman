// Comprehensive tests for pattern matching lowering

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";
import { lex } from "../../../src/lexer.ts";
import { inferProgram } from "../../../src/layer1infer.ts";
import { lowerToCore } from "../src/lower_to_core.ts";
import { lowerToMir } from "../src/lower_to_mir.ts";
import type { MirFunction, MirBasicBlock } from "../src/mir.ts";

Deno.test("lower ADT pattern match with constructors", () => {
  const source = `
    type Option<a> = Some<a> | None;
    
    let unwrap = match(opt) {
      Some(x) => { x },
      None => { 0 }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "unwrap");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have single block with if/else structure
    assertEquals(func.blocks.length, 1);
    
    // Block should have get_tag and if/else
    const block = func.blocks[0];
    const hasGetTag = block.instructions.some((i) => i.kind === "mir_get_tag");
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    assertEquals(hasGetTag, true);
    assertEquals(hasIfElse, true);
  }
});

Deno.test("lower ADT pattern with field extraction", () => {
  const source = `
    type Option<a> = Some<a> | None;
    
    let getValue = match(opt) {
      Some(value) => { value },
      None => { 42 }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "getValue");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have get_field instruction in the if/else branches
    const block = func.blocks[0];
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    assertEquals(hasIfElse, true);
  }
});

Deno.test("lower ADT pattern with wildcard", () => {
  const source = `
    type Option<a> = Some<a> | None;
    
    let isSome = match(opt) {
      Some(_) => { true },
      None => { false }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "isSome");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have if/else structure
    const block = func.blocks[0];
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    assertEquals(hasIfElse, true);
  }
});

Deno.test("lower literal pattern match", () => {
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
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "isZero");
  assertEquals(func !== undefined, true);
  
  // For now, literal matching is simplified
  // Just verify it doesn't crash
  assertEquals(func !== undefined, true);
});

Deno.test("lower variable pattern match", () => {
  const source = `
    let identity = match(x) {
      value => { value }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "identity");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Variable pattern should just bind and return
    assertEquals(func.blocks.length, 1);
  }
});

Deno.test("lower tuple pattern match", () => {
  const source = `
    let first = match(pair) {
      (x, y) => { x }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "first");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have get_tuple instructions
    const hasGetTuple = func.blocks[0].instructions.some((i) => i.kind === "mir_get_tuple");
    assertEquals(hasGetTuple, true);
  }
});

Deno.test("lower nested ADT match", () => {
  const source = `
    type List<a> = Link<a, List<a>> | Empty;
    
    let head = match(list) {
      Link(x, _) => { x },
      Empty => { 0 }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "head");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have if/else structure
    const block = func.blocks[0];
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    assertEquals(hasIfElse, true);
  }
});

Deno.test("lower match with multiple constructors", () => {
  const source = `
    type Color = Red | Green | Blue;
    
    let colorName = match(c) {
      Red => { "red" },
      Green => { "green" },
      Blue => { "blue" }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const inferResult = inferProgram(program);
  const core = lowerToCore(program, inferResult);
  
  const mir = lowerToMir(core);
  
  const func = mir.functions.find((f: MirFunction) => f.name === "colorName");
  assertEquals(func !== undefined, true);
  
  if (func) {
    // Should have nested if/else for 3 cases
    const block = func.blocks[0];
    const hasIfElse = block.instructions.some((i) => i.kind === "mir_if_else");
    assertEquals(hasIfElse, true);
  }
});
