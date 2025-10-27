// Tests for code generation

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { compile } from "../src/compile.ts";

Deno.test("compile simple constant", () => {
  const source = `let x = 42;`;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "const WM =");
  assertStringIncludes(result.js, "function x()");
  assertStringIncludes(result.js, "return");
});

Deno.test("compile function with primitive", () => {
  const source = `
    infixl 7 * = nativeMul;
    let double = (x) => { x * 2 };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "function double(x)");
  assertStringIncludes(result.js, "WM.mul");
});

Deno.test("compile ADT with tag table", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let x = None;
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "Tag_Option");
  assertStringIncludes(result.js, "Some:");
  assertStringIncludes(result.js, "None:");
});

Deno.test("compile constructor application", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let x = Some(42);
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "WM.mk(");
});

Deno.test("compile pattern match", () => {
  const source = `
    type Option<a> = Some<a> | None;
    let unwrap = match(opt) {
      Some(x) => { x },
      None => { 0 }
    };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "function unwrap(opt)");
  assertStringIncludes(result.js, "WM.getTag");
  assertStringIncludes(result.js, "if"); // Now uses if/else instead of switch
});

Deno.test("compile tuple", () => {
  const source = `let pair = (1, 2);`;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "[");
  assertStringIncludes(result.js, "]");
});

Deno.test("compile multiple functions", () => {
  const source = `
    infixl 6 + = nativeAdd;
    let inc = (x) => { x + 1 };
    let dec = (x) => { x + -1 };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "function inc(x)");
  assertStringIncludes(result.js, "function dec(x)");
});

Deno.test("compile with exports", () => {
  const source = `
    export let double = (x) => { x };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "export { double }");
});

Deno.test("compile arithmetic operations", () => {
  const source = `
    infixl 6 + = nativeAdd;
    infixl 6 - = nativeSub;
    infixl 7 * = nativeMul;
    infixl 7 / = nativeDiv;
    let calc = (x) => { (x + 1) * 2 };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "WM.add");
  assertStringIncludes(result.js, "WM.mul");
});

Deno.test("compile print operation", () => {
  const source = `
    let printValue = (x) => { nativePrint(x) };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  // Native functions are compiled as function calls for now
  assertStringIncludes(result.js, "nativePrint");
});

Deno.test("compile cmpInt operation", () => {
  const source = `
    let compare = (x, y) => { nativeCmpInt(x, y) };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  // Native functions are compiled as function calls for now
  assertStringIncludes(result.js, "nativeCmpInt");
});

Deno.test("compile recursive function", () => {
  const source = `
    infixl 7 * = nativeMul;
    infixl 6 - = nativeSub;
    let rec factorial = match(n) {
      0 => { 1 },
      _ => { n * factorial(n - 1) }
    };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  assertStringIncludes(result.js, "function factorial(n)");
  // Should have loop for tail-call optimization
  assertStringIncludes(result.js, "for (;;)");
});
