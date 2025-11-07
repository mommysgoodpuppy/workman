import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModule } from "../backends/compiler/js/emitter.ts";

Deno.test({
  name: "JS emitter generates executable code for simple module",
  permissions: { read: true },
}, async () => {
  const { coreGraph } = await compileWorkmanGraph(
    "./tests/fixtures/compiler/ops/main.wm",
  );
  const module = coreGraph.modules.get(coreGraph.entry);
  if (!module) throw new Error("missing module");

  const code = emitModule(module, coreGraph, {
    extension: ".js",
    runtimeModule: "./runtime.mjs",
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);

  assertEquals(mod.compute(3, 4), 11);
  assertEquals(mod.negate(true), false);
});

Deno.test({
  name: "JS emitter handles simple match expressions",
  permissions: { read: true },
}, async () => {
  const { coreGraph } = await compileWorkmanGraph(
    "./tests/fixtures/compiler/match/main.wm",
  );
  const module = coreGraph.modules.get(coreGraph.entry);
  if (!module) throw new Error("missing module");

  const code = emitModule(module, coreGraph, {
    extension: ".js",
    runtimeModule: "./runtime.mjs",
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);

  assertEquals(mod.classify(true), "yes");
  assertEquals(mod.classify(false), "no");
});
