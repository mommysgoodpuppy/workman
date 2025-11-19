import { fromFileUrl } from "std/path/mod.ts";
import { assertEquals, assertRejects } from "https://deno.land/std/assert/mod.ts";
import { runEntryPath, ModuleLoaderError } from "../src/module_loader.ts";

function fixturePath(relative: string): string {
  return fromFileUrl(new URL(`./fixtures/module_loader/${relative}`, import.meta.url));
}

Deno.test({
  name: "module loader executes basic imported function",
  permissions: { read: true, write: true },
}, async () => {
  const entry = fixturePath("basic/main.wm");
  const result = await runEntryPath(entry);
  const typeSummary = result.types.find((entry) => entry.name === "main");
  if (!typeSummary) {
    throw new Error("expected main in type summaries");
  }
  assertEquals(typeSummary.type, "Unit -> Unit");
  assertEquals(result.runtimeLogs, ["hello"]);
});

Deno.test({
  name: "module loader reports unknown import names",
  permissions: { read: true, write: true },
}, async () => {
  const entry = fixturePath("unknown/main.wm");
  await assertRejects(
    () => runEntryPath(entry),
    ModuleLoaderError,
    "does not export 'missing'",
  );
});

Deno.test({
  name: "module loader detects circular imports",
  permissions: { read: true, write: true },
}, async () => {
  const entry = fixturePath("cycle/a.wm");
  await assertRejects(
    () => runEntryPath(entry),
    ModuleLoaderError,
    "Circular import",
  );
});

Deno.test({
  name: "module loader executes modules that import JavaScript helpers",
  permissions: { read: true, write: true },
}, async () => {
  const entry = fixturePath("js_import/main.wm");
  const result = await runEntryPath(entry);
  const typeSummary = result.types.find((entry) => entry.name === "main");
  assertEquals(typeSummary?.type, "Unit -> Unit");
  const valueSummary = result.values.find((entry) => entry.name === "main");
  assertEquals(valueSummary?.value, "()");
});
