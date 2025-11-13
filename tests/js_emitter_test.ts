import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModule } from "../backends/compiler/js/emitter.ts";
import { toFileUrl as pathToFileURL } from "https://deno.land/std@0.224.0/path/mod.ts";

const RUNTIME_MODULE_SPEC = new URL(
  "../backends/compiler/js/runtime.mjs",
  import.meta.url,
).href;

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
    runtimeModule: RUNTIME_MODULE_SPEC,
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
    runtimeModule: RUNTIME_MODULE_SPEC,
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);

  assertEquals(mod.classify(true), "yes");
  assertEquals(mod.classify(false), "no");
});

Deno.test({
  name: "JS emitter handles record literals and projections",
  permissions: { read: true },
}, async () => {
  const { coreGraph } = await compileWorkmanGraph(
    "./tests/fixtures/compiler/records/main.wm",
  );
  const module = coreGraph.modules.get(coreGraph.entry);
  if (!module) throw new Error("missing module");

  const code = emitModule(module, coreGraph, {
    extension: ".js",
    runtimeModule: RUNTIME_MODULE_SPEC,
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);

  const user = mod.makeUser("Jill", 7);
  assertEquals(user.name, "Jill");
  assertEquals(user.age, 7);
  const renamed = mod.renameUser(user, "Bea");
  assertEquals(renamed.name, "Bea");
  assertEquals(renamed.age, 7);
  assertEquals(mod.describeUser(), "Renamed");
  assertEquals(mod.ageAfterBirthday(), 21);
});

Deno.test({
  name: "JS emitter preserves infectious Result semantics",
  permissions: { read: true, write: true, env: true },
}, async () => {
  const { coreGraph } = await compileWorkmanGraph(
    "./tests/fixtures/compiler/result_infectious/main.wm",
  );
  
  // Emit the full graph including prelude to get proper infectious type registrations
  const { emitModuleGraph } = await import("../backends/compiler/js/graph_emitter.ts");
  const tempDir = await Deno.makeTempDir();
  
  try {
    const { moduleFiles } = await emitModuleGraph(coreGraph, {
      outDir: tempDir,
      runtimeFileName: "runtime.mjs",
    });
    
    const entryFile = moduleFiles.get(coreGraph.entry);
    if (!entryFile) throw new Error("Entry file not found");
    
    const mod = await import(pathToFileURL(entryFile).href);
    
    assertEquals(mod.okFlow().tag, "IOk");
    assertEquals(mod.okFlow()._0, 42);
    assertEquals(mod.missingFlow().tag, "IErr");
    assertEquals(mod.badFlow().tag, "IErr");
  } finally {
    // Clean up temp directory
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test({
  name: "JS emitter lowers AllErrors patterns",
  permissions: { read: true },
}, async () => {
  const { coreGraph } = await compileWorkmanGraph(
    "./tests/fixtures/compiler/all_errors_match/main.wm",
  );
  const module = coreGraph.modules.get(coreGraph.entry);
  if (!module) throw new Error("missing module");

  const code = emitModule(module, coreGraph, {
    extension: ".js",
    runtimeModule: RUNTIME_MODULE_SPEC,
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);

  const missing = mod.missingCase();
  const other = mod.otherCase();

  assertEquals(missing.tag, "Missing");
  assertEquals(other.tag, "Other");
});
