import { fromFileUrl } from "std/path/mod.ts";
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std/assert/mod.ts";
import { runEntryPath } from "../src/module_loader.ts";
import { runCompiledEntryPath } from "./test_prelude.ts";

function failingFixture(relative: string): string {
  return fromFileUrl(
    new URL(`./fixtures/failing/${relative}`, import.meta.url),
  );
}

function fixturePath(relative: string): string {
  return fromFileUrl(
    new URL(`./fixtures/std_usage/${relative}`, import.meta.url),
  );
}

Deno.test({
  name: "std option complex pipeline (map -> flatMap -> orElse)",
  permissions: { read: true },
}, async () => {
  const result = await runEntryPath(failingFixture("std_option_complex.wm"));
  const types = new Map(result.types.map((e) => [e.name, e.type]));
  const values = new Map(result.values.map((e) => [e.name, e.value]));

  assertEquals(types.get("pipeline"), "Unit -> Int");
  assertEquals(values.get("pipeline"), "22"); // (10+1)=11 -> odd -> double -> withDefault passthrough

  assertEquals(types.get("fallback"), "Unit -> Option<Int>");
  assertEquals(values.get("fallback"), "Some 42");
});

Deno.test({
  name: "std result complex pipeline (map -> andThen -> fold)",
  permissions: { read: true, write: true },
}, async () => {
  const result = await runCompiledEntryPath(
    failingFixture("std_result_complex.wm"),
  );
  const types = new Map(result.types.map((e) => [e.name, e.type]));
  const values = new Map(result.values.map((e) => [e.name, e.value]));

  assertEquals(types.get("pipeline"), "Unit -> Int");
  assertEquals(values.get("pipeline"), "22");

  assertEquals(types.get("foldBoth"), "Unit -> Int");
  assertEquals(values.get("foldBoth"), "0");
});

// Not sure what these tests should expect, no longer stack overflows
Deno.test({
  name: "repro: option map self-application is rejected",
  permissions: { read: true },
}, async () => {
  const entry = failingFixture("std_option_self_apply.wm");
  await assertRejects(
    () => runEntryPath(entry),
    Error,
    "Non-exhaustive patterns at runtime",
  );
});

Deno.test({
  name: "repro: result map self-application is rejected",
  permissions: { read: true },
}, async () => {
  const entry = failingFixture("std_result_self_apply.wm");
  await assertRejects(
    () => runEntryPath(entry),
    Error,
    "Non-exhaustive patterns at runtime",
  );
});

Deno.test({
  name: "std list utilities operate with tuple lowering",
  permissions: { read: true },
}, async () => {
  const entry = fixturePath("main.wm");
  const result = await runEntryPath(entry);
  const typeMap = new Map(
    result.types.map((entry) => [entry.name, entry.type]),
  );
  const valueMap = new Map(
    result.values.map((entry) => [entry.name, entry.value]),
  );

  assertEquals(typeMap.get("sumSquares"), "Unit -> Int");
  assertEquals(typeMap.get("sortedDemo"), "Unit -> List<Int>");
  assertEquals(valueMap.get("sumSquares"), "55");
  assertEquals(valueMap.get("sortedDemo"), "Link 1 Link 2 Link 3 Empty");
});
