// End-to-end integration tests - compile and run JavaScript

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { compile } from "../src/compile.ts";

/**
 * Helper to execute compiled JavaScript and capture output
 */
async function runCompiled(js: string): Promise<any> {
  // Create a temporary file
  const tempFile = await Deno.makeTempFile({ suffix: ".js" });
  
  try {
    await Deno.writeTextFile(tempFile, js);
    
    // Import and execute
    const module = await import(`file://${tempFile}`);
    return module;
  } finally {
    await Deno.remove(tempFile);
  }
}

Deno.test("integration: simple constant", async () => {
  const source = `export let x = 42;`;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  assertEquals(typeof module.x, "function");
  assertEquals(module.x(), 42);
});

Deno.test("integration: simple function", async () => {
  const source = `
    infixl 6 + = nativeAdd;
    export let inc = (x) => { x + 1 };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  assertEquals(module.inc(5), 6);
  assertEquals(module.inc(0), 1);
});

Deno.test("integration: arithmetic operations", async () => {
  const source = `
    infixl 6 + = nativeAdd;
    infixl 7 * = nativeMul;
    export let calc = (x) => { (x + 2) * 3 };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  assertEquals(module.calc(0), 6);   // (0 + 2) * 3 = 6
  assertEquals(module.calc(3), 15);  // (3 + 2) * 3 = 15
});

Deno.test("integration: tuple creation and access", async () => {
  const source = `
    export let makePair = (x, y) => { (x, y) };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  const pair = module.makePair(1, 2);
  assertEquals(Array.isArray(pair), true);
  assertEquals(pair[0], 1);
  assertEquals(pair[1], 2);
});

Deno.test("integration: ADT constructor", async () => {
  const source = `
    export type Option<a> = Some<a> | None;
    export let none = None;
    export let some = (x) => { Some(x) };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  
  // None is a nullary constructor
  const noneVal = module.none();
  assertEquals(typeof noneVal, "object");
  assertEquals(noneVal.tag !== undefined, true);
  
  // Some is a unary constructor
  const someVal = module.some(42);
  assertEquals(typeof someVal, "object");
  assertEquals(someVal.tag !== undefined, true);
});

Deno.test("integration: pattern matching", async () => {
  const source = `
    type Option<a> = Some<a> | None;
    
    export let unwrapOr = (opt, fallback) => {
      match(opt) {
        Some(x) => { x },
        None => { fallback }
      }
    };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  
  // Create Some and None values manually
  const some42 = { tag: 0, _0: 42 };
  const none = { tag: 1 };
  
  assertEquals(module.unwrapOr(some42, 0), 42);
  assertEquals(module.unwrapOr(none, 99), 99);
});

Deno.test("integration: multiple parameters", async () => {
  const source = `
    infixl 6 + = nativeAdd;
    export let add = (x, y) => { x + y };
  `;
  const result = compile(source);
  
  assertEquals(result.errors, undefined);
  
  const module = await runCompiled(result.js);
  assertEquals(module.add(3, 4), 7);
  assertEquals(module.add(10, -5), 5);
});
