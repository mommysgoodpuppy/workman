import { fromFileUrl } from "std/path/mod.ts";
import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { runEntryPath } from "../src/module_loader.ts";

function fixturePath(relative: string): string {
  return fromFileUrl(new URL(`./fixtures/${relative}`, import.meta.url));
}

function mapsFromResult<T>(
  result: Awaited<ReturnType<typeof runEntryPath>>,
): { types: Map<string, string>; values: Map<string, string> } {
  return {
    types: new Map(result.types.map((entry) => [entry.name, entry.type])),
    values: new Map(result.values.map((entry) => [entry.name, entry.value])),
  };
}

Deno.test({
  name: "std list utilities operate with tuple lowering",
  permissions: { read: true },
}, async () => {
  const result = await runEntryPath(fixturePath("std_list/main.wm"));
  const { types, values } = mapsFromResult(result);

  assertEquals(types.get("sumSquares"), "Int");
  assertEquals(types.get("reversedRange"), "List<Int>");
  assertEquals(types.get("sortedDemo"), "List<Int>");

  assertEquals(values.get("sumSquares"), "55");
  assertEquals(values.get("reversedRange"), "Cons 4 Cons 3 Cons 2 Cons 1 Nil");
  assertEquals(values.get("sortedDemo"), "Cons 1 Cons 2 Cons 3 Nil");
});

Deno.test({
  name: "std option helpers compose results",
  permissions: { read: true },
}, async () => {
  const result = await runEntryPath(fixturePath("std_option/main.wm"));
  const { types, values } = mapsFromResult(result);

  assertEquals(types.get("useOption"), "Int");
  assertEquals(values.get("useOption"), "16");

  assertEquals(types.get("boolExample"), "Option<Int>");
  assertEquals(values.get("boolExample"), "Some 9");

  assertEquals(types.get("listExample"), "List<Int>");
  assertEquals(values.get("listExample"), "Cons 7 Nil");
});

Deno.test({
  name: "std result helpers propagate success and error info",
  permissions: { read: true },
}, async () => {
  const result = await runEntryPath(fixturePath("std_result/main.wm"));
  const { types, values } = mapsFromResult(result);

  assertEquals(types.get("defaultOk"), "Int");
  assertEquals(values.get("defaultOk"), "5");

  assertEquals(types.get("foldOk"), "Int");
  assertEquals(values.get("foldOk"), "10");

  assertEquals(types.get("foldErr"), "Int");
  assertEquals(values.get("foldErr"), "4");
});

