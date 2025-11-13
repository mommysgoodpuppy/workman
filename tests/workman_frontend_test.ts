import { fromFileUrl } from "std/path/mod.ts";
import { assert, assertEquals } from "https://deno.land/std/assert/mod.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";

function fixturePath(relative: string): string {
  return fromFileUrl(
    new URL(`./fixtures/${relative}`, import.meta.url),
  );
}

Deno.test({
  name: "compileWorkmanGraph returns analyzed modules with placeholder Core IR",
  permissions: { read: true },
  ignore:true
}, async () => {
  const entry = fixturePath("module_loader/basic/main.wm");
  const result = await compileWorkmanGraph(entry);

  assertEquals(result.coreGraph.entry, entry);
  const lastModule = result.coreGraph.order[result.coreGraph.order.length - 1];
  assertEquals(lastModule, entry);
  assert(result.modules.has(entry));

  const entryModule = result.coreGraph.modules.get(entry);
  assert(entryModule);
  assertEquals(entryModule.values.length, 1);
  const mainBinding = entryModule.values[0];
  assertEquals(mainBinding.name, "main");
  assertEquals(mainBinding.value.kind, "lambda");
  assertEquals(entryModule.exports.length > 0, true);
  assertEquals(entryModule.imports.length, 1);
  assert(entryModule.imports[0].source.endsWith("lib.wm"));

  const libPath = result.coreGraph.order.find((p) =>
    p.includes("basic\\lib.wm")
  );
  assert(libPath);
  const libModule = result.coreGraph.modules.get(libPath!);
  assert(libModule);
  assertEquals(libModule.values.length, 1);
  assertEquals(libModule.values[0].value.kind, "lambda");

  const preludePath = result.coreGraph.order.find((p) =>
    p.includes("\\std\\prelude.wm")
  );
  assert(preludePath);
  const preludeModule = result.coreGraph.modules.get(preludePath!);
  assert(preludeModule);
  assertEquals(preludeModule.values.length > 0, true);
});

Deno.test({
  name: "lowering emits match expressions with pattern cases",
  permissions: { read: true },
}, async () => {
  const entry = fixturePath("compiler/match/main.wm");
  const result = await compileWorkmanGraph(entry);

  const module = result.coreGraph.modules.get(entry);
  assert(module);
  assertEquals(module.values.length, 1);
  const binding = module.values[0];
  assertEquals(binding.value.kind, "lambda");

  const functionBody = binding.value.body;
  assertEquals(functionBody.kind, "match");
  assertEquals(functionBody.cases.length, 2);
  assertEquals(functionBody.cases[0].pattern.kind, "literal");
  assertEquals(functionBody.cases[1].pattern.kind, "literal");
  assertEquals(functionBody.cases[0].body.kind, "literal");
});

Deno.test({
  name: "lowering maps arithmetic and boolean operators to prim ops",
  permissions: { read: true },
}, async () => {
  const entry = fixturePath("compiler/ops/main.wm");
  const result = await compileWorkmanGraph(entry);

  const module = result.coreGraph.modules.get(entry);
  assert(module);

  const compute = module.values.find((binding) => binding.name === "compute");
  assert(compute);
  const computeValue = compute.value;
  if (computeValue.kind !== "lambda") {
    throw new Error("expected compute to lower to a lambda");
  }
  const computeBody = computeValue.body;
  if (computeBody.kind !== "prim") {
    throw new Error("expected compute body to lower to prim expression");
  }
  assertEquals(computeBody.op, "int_add");
  assertEquals(computeBody.args.length, 2);
  const right = computeBody.args[1];
  if (right.kind !== "prim") {
    throw new Error("expected multiply operand to lower to prim expression");
  }
  assertEquals(right.op, "int_mul");

  const negate = module.values.find((binding) => binding.name === "negate");
  assert(negate);
  const negateValue = negate.value;
  if (negateValue.kind !== "lambda") {
    throw new Error("expected negate to lower to a lambda");
  }
  const negateBody = negateValue.body;
  if (negateBody.kind !== "prim") {
    throw new Error("expected negate body to lower to prim expression");
  }
  assertEquals(negateBody.op, "bool_not");
});

Deno.test({
  name: "compileWorkmanGraph allows JS imports when evaluation is skipped",
  permissions: { read: true },
}, async () => {
  const entry = fixturePath("module_loader/js_import/main.wm");
  const result = await compileWorkmanGraph(entry);
  const module = result.coreGraph.modules.get(entry);
  assert(module);
  assertEquals(module.imports.length, 1);
  assert(module.imports[0].source.endsWith("native.js"));
});
