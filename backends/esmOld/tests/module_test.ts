// Tests for module compilation

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { compileProject } from "../src/compile.ts";
import { buildModuleGraph } from "../src/module_resolver.ts";

Deno.test("module resolver: builds dependency graph", async () => {
  // Create test modules
  const testDir = await Deno.makeTempDir();
  
  try {
    // Module A (entry)
    await Deno.writeTextFile(
      `${testDir}/a.wm`,
      `from "./b" import { foo };
       export let bar = (x) => { foo(x) };`
    );
    
    // Module B (dependency)
    await Deno.writeTextFile(
      `${testDir}/b.wm`,
      `export let foo = (x) => { x };`
    );
    
    const graph = await buildModuleGraph(`${testDir}/a.wm`, {
      stdRoots: [],
      preludeModule: undefined, // No prelude for this test
    });
    
    // Should have 2 modules in dependency order
    assertEquals(graph.order.length, 2);
    assertEquals(graph.order[0].endsWith("b.wm"), true);
    assertEquals(graph.order[1].endsWith("a.wm"), true);
    assertEquals(graph.entry.endsWith("a.wm"), true);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("module resolver: detects circular dependencies", async () => {
  const testDir = await Deno.makeTempDir();
  
  try {
    // Module A imports B
    await Deno.writeTextFile(
      `${testDir}/a.wm`,
      `from "./b" import { foo };
       export let bar = (x) => { foo(x) };`
    );
    
    // Module B imports A (circular!)
    await Deno.writeTextFile(
      `${testDir}/b.wm`,
      `from "./a" import { bar };
       export let foo = (x) => { bar(x) };`
    );
    
    let error: Error | undefined;
    try {
      await buildModuleGraph(`${testDir}/a.wm`, {
        stdRoots: [],
        preludeModule: undefined,
      });
    } catch (e) {
      error = e as Error;
    }
    
    assertEquals(error !== undefined, true);
    assertEquals(error?.message.includes("Circular"), true);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("module compiler: compiles two-module project", async () => {
  const testDir = await Deno.makeTempDir();
  
  try {
    // Module B (dependency) - simple identity function
    await Deno.writeTextFile(
      `${testDir}/b.wm`,
      `export let identity = (x) => { x };`
    );
    
    // Module A (entry) - uses B
    await Deno.writeTextFile(
      `${testDir}/a.wm`,
      `from "./b" import { identity };
       export let double = (x) => { identity(x) };`
    );
    
    const result = await compileProject(`${testDir}/a.wm`, {
      stdRoots: [],
      preludeModule: undefined,
    });
    
    assertEquals(result.errors, undefined);
    assertEquals(result.modules.size, 2);
    
    // Check that A imports from B
    const moduleA = Array.from(result.modules.values()).find(m => m.path.endsWith("a.js"));
    assertEquals(moduleA !== undefined, true);
    if (moduleA) {
      assertEquals(moduleA.js.includes('import'), true);
      assertEquals(moduleA.js.includes('from "./b.js"'), true);
    }
    
    // Check that B exports identity
    const moduleB = Array.from(result.modules.values()).find(m => m.path.endsWith("b.js"));
    assertEquals(moduleB !== undefined, true);
    if (moduleB) {
      assertEquals(moduleB.js.includes('export'), true);
      assertEquals(moduleB.js.includes('identity'), true);
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("module compiler: handles type imports", async () => {
  const testDir = await Deno.makeTempDir();
  
  try {
    // Module with type definition
    await Deno.writeTextFile(
      `${testDir}/types.wm`,
      `export type Option<a> = Some<a> | None;`
    );
    
    // Module using the type
    await Deno.writeTextFile(
      `${testDir}/main.wm`,
      `from "./types" import { Some };
       export let mkSome = (x) => { Some(x) };`
    );
    
    const result = await compileProject(`${testDir}/main.wm`, {
      stdRoots: [],
      preludeModule: undefined,
    });
    
    if (result.errors) {
      console.log("Compilation errors:", result.errors);
    }
    assertEquals(result.errors, undefined);
    assertEquals(result.modules.size, 2);
    
    // Main should import constructors
    const mainModule = Array.from(result.modules.values()).find(m => m.path.endsWith("main.js"));
    if (mainModule) {
      assertEquals(mainModule.js.includes('import { Some }'), true);
      assertEquals(mainModule.js.includes('from "./types.js"'), true);
    }
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});
