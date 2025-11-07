import { assertEquals, assertStringIncludes } from "https://deno.land/std/assert/mod.ts";
import { toFileUrl } from "std/path/mod.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";

Deno.test({
  name: "module graph emitter writes files and executes entry",
  permissions: { read: true, write: true, run: false },
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const fixture = "./tests/fixtures/compiler/match/main.wm";
    const { coreGraph } = await compileWorkmanGraph(fixture);
    const result = await emitModuleGraph(coreGraph, { outDir: tmpDir });

    const entryUrl = toFileUrl(result.entryPath).href;
    const mod = await import(entryUrl);

    assertEquals(mod.classify(true), "yes");
    assertEquals(mod.classify(false), "no");

    const runtimeContents = await Deno.readTextFile(result.runtimePath);
    assertStringIncludes(runtimeContents, "nativeStrFromLiteral");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test({
  name: "module graph emitter can evaluate run fixture main",
  permissions: { read: true, write: true, run: false },
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const fixture = "./tests/fixtures/compiler/run/main.wm";
    const { coreGraph } = await compileWorkmanGraph(fixture);
    const result = await emitModuleGraph(coreGraph, { outDir: tmpDir });

    const entryUrl = toFileUrl(result.entryPath).href;
    const mod = await import(entryUrl);

    const value = await mod.main();
    assertEquals(value, 42);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test({
  name: "module graph emitter executes program relying on prelude list constructors",
  permissions: { read: true, write: true, run: false },
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const fixture = "./tests/fixtures/compiler/prelude_run/main.wm";
    const { coreGraph } = await compileWorkmanGraph(fixture);
    const result = await emitModuleGraph(coreGraph, { outDir: tmpDir });

    const entryUrl = toFileUrl(result.entryPath).href;
    const mod = await import(entryUrl);

    assertEquals(mod.main(), 6);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
