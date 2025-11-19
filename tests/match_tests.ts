import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { InferError, inferProgram } from "../src/layer1/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import { formatScheme } from "../src/type_printer.ts";
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std/assert/mod.ts";

function parseSource(source: string) {
  const tokens = lex(source);
  return parseSurfaceProgram(tokens);
}

function inferTypes(source: string) {
  const program = parseSource(source);
  const result = inferProgram(program);
  return result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
}

function evaluateSource(source: string) {
  const program = parseSource(source);
  return evaluateProgram(program);
}

Deno.test("parses match bundle literal", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let handler = match {
      Some(x) => { x },
      None => { 0 }
    };
  `;

  const program = parseSource(source);
  const handlerDecl = program.declarations.find(
    (decl): decl is import("../src/ast.ts").LetDeclaration =>
      decl.kind === "let" && decl.name === "handler",
  );

  if (!handlerDecl) {
    throw new Error("expected handler declaration");
  }

  const result = handlerDecl.body.result;
  if (!result || result.kind !== "match_bundle_literal") {
    throw new Error("expected match bundle literal");
  }

  const patternArms = result.bundle.arms.filter((arm) => arm.kind === "match_pattern");
  assertEquals(patternArms.length, 2);
});

Deno.test("infers match bundle literal function type", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bundle = match {
      Some(_) => { 0 },
      None => { 0 }
    };
  `;

  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "bundle");
  if (!binding) {
    throw new Error("expected bundle binding");
  }

  // Bundle literals now produce a single-argument function
  assertEquals(binding.type, "Option<T> -> Int");
});

Deno.test("evaluates match bundle literal to callable", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let handler = match {
      Some(x) => { x },
      None => { 0 }
    };
  `;

  // Ensure the program type-checks before evaluation
  inferTypes(source);
  const evaluation = evaluateSource(source);
  const handler = evaluation.summaries.find((entry) =>
    entry.name === "handler"
  );
  if (!handler) {
    throw new Error("expected handler summary");
  }

  const { value } = handler;
  if (value.kind !== "native") {
    throw new Error(
      `expected handler to evaluate to native function, received ${value.kind}`,
    );
  }
  assertEquals(value.arity, 1);
  const applied = value.impl([
    {
      kind: "data",
      constructor: "Some",
      fields: [{ kind: "int", value: 3 }],
    },
  ], undefined);
  if (applied.kind !== "int") {
    throw new Error(
      `expected handler application to produce Int, received ${applied.kind}`,
    );
  }
  assertEquals(applied.value, 3);
});

Deno.test("composes match bundles", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let check = match {
      Some(_) => { 0 },
      None => { 1 }
    };
    let format = match {
      0 => { "zero" },
      _ => { "nonzero" }
    };
    let result = {
      format(check(Some(0)))
    };
  `;

  const summaries = inferTypes(source);
  const checkBinding = summaries.find((entry) => entry.name === "check");
  const formatBinding = summaries.find((entry) => entry.name === "format");
  const resultBinding = summaries.find((entry) => entry.name === "result");
  if (!checkBinding || !formatBinding || !resultBinding) {
    throw new Error("expected check, format, and result bindings");
  }

  assertEquals(checkBinding.type, "Option<T> -> Int");
  assertEquals(formatBinding.type, "Int -> String");
  assertEquals(resultBinding.type, "String");

  const evaluation = evaluateSource(source);
  const resultValue = evaluation.summaries.find((entry) =>
    entry.name === "result"
  );
  if (!resultValue) {
    throw new Error("expected result binding in evaluation");
  }
  const { value } = resultValue;
  if (value.kind !== "string") {
    throw new Error(
      `expected result to evaluate to string, received ${value.kind}`,
    );
  }
  assertEquals(value.value, "zero");
});

Deno.test("match expressions can reference bundle arms", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let someOnly = match {
      Some(x) => { x }
    };
    let handle = (opt) => {
      match(opt) {
        someOnly,
        None => { 0 }
      }
    };
    let someResult = handle(Some(5));
    let noneResult = handle(None);
  `;

  const summaries = inferTypes(source);
  const someOnlyBinding = summaries.find((entry) => entry.name === "someOnly");
  const handleBinding = summaries.find((entry) => entry.name === "handle");
  const someResultBinding = summaries.find((entry) => entry.name === "someResult");
  const noneResultBinding = summaries.find((entry) => entry.name === "noneResult");
  if (!someOnlyBinding || !handleBinding || !someResultBinding || !noneResultBinding) {
    throw new Error("expected bindings for someOnly, handle, someResult, and noneResult");
  }

  assertEquals(someOnlyBinding.type, "Option<T> -> T");
  assertEquals(handleBinding.type, "Option<Int> -> Int");
  assertEquals(someResultBinding.type, "Int");
  assertEquals(noneResultBinding.type, "Int");

  const evaluation = evaluateSource(source);
  const someResultValue = evaluation.summaries.find((entry) => entry.name === "someResult");
  const noneResultValue = evaluation.summaries.find((entry) => entry.name === "noneResult");
  if (!someResultValue || !noneResultValue) {
    throw new Error("expected runtime values for someResult and noneResult");
  }
  if (someResultValue.value.kind !== "int") {
    throw new Error(`expected someResult to evaluate to int, received ${someResultValue.value.kind}`);
  }
  if (noneResultValue.value.kind !== "int") {
    throw new Error(`expected noneResult to evaluate to int, received ${noneResultValue.value.kind}`);
  }
  assertEquals(someResultValue.value.value, 5);
  assertEquals(noneResultValue.value.value, 0);
});

Deno.test("composes nested bundle references", () => {
  const source = `
    let zero = match {
      0 => { ("zero", (0, true), (_) => { "zero" }) }
    };
    let one = match {
      1 => { ("one", (1, false), (_) => { "one" }) }
    };
    let other = match {
      Var(value) => { ("other", (value, false), (_) => { "other" }) }
    };
    let grouped = match {
      zero,
      one
    };
    let describeNumber = match(n) {
      grouped,
      other
    };
    let a = describeNumber(0);
    let b = describeNumber(1);
    let c = describeNumber(42);
    let aLabel = match(a) {
      (label, _, _) => { label }
    };
    let cExtracted = match(c) {
      (_, (value, _), _) => { value }
    };
    let bFormatted = match(b) {
      (_, _, formatter) => { formatter(999) }
    };
  `;

  const summaries = inferTypes(source);
  const zeroBinding = summaries.find((entry) => entry.name === "zero");
  const oneBinding = summaries.find((entry) => entry.name === "one");
  const otherBinding = summaries.find((entry) => entry.name === "other");
  const groupedBinding = summaries.find((entry) => entry.name === "grouped");
  const describeBinding = summaries.find((entry) => entry.name === "describeNumber");
  const aBinding = summaries.find((entry) => entry.name === "a");
  const bBinding = summaries.find((entry) => entry.name === "b");
  const cBinding = summaries.find((entry) => entry.name === "c");
  const aLabelBinding = summaries.find((entry) => entry.name === "aLabel");
  const cExtractedBinding = summaries.find((entry) => entry.name === "cExtracted");
  const bFormattedBinding = summaries.find((entry) => entry.name === "bFormatted");
  if (
    !zeroBinding || !oneBinding || !otherBinding || !groupedBinding || !describeBinding ||
    !aBinding || !bBinding || !cBinding || !aLabelBinding || !cExtractedBinding || !bFormattedBinding
  ) {
    throw new Error("expected bindings for composed match bundles and derived results");
  }

  const expectedBundleType = "Int -> (String, (Int, Bool), Int -> String)";
  const expectedResultType = "(String, (Int, Bool), Int -> String)";

  assertEquals(zeroBinding.type, expectedBundleType);
  assertEquals(oneBinding.type, expectedBundleType);
  assertEquals(otherBinding.type, expectedBundleType);
  assertEquals(groupedBinding.type, expectedBundleType);
  assertEquals(describeBinding.type, expectedBundleType);

  assertEquals(aBinding.type, expectedResultType);
  assertEquals(bBinding.type, expectedResultType);
  assertEquals(cBinding.type, expectedResultType);
  assertEquals(aLabelBinding.type, "String");
  assertEquals(cExtractedBinding.type, "Int");
  assertEquals(bFormattedBinding.type, "String");

  const evaluation = evaluateSource(source);
  const aResult = evaluation.summaries.find((entry) => entry.name === "a");
  const bResult = evaluation.summaries.find((entry) => entry.name === "b");
  const cResult = evaluation.summaries.find((entry) => entry.name === "c");
  const aLabelResult = evaluation.summaries.find((entry) => entry.name === "aLabel");
  const cExtractedResult = evaluation.summaries.find((entry) => entry.name === "cExtracted");
  const bFormattedResult = evaluation.summaries.find((entry) => entry.name === "bFormatted");
  if (!aResult || !bResult || !cResult || !aLabelResult || !cExtractedResult || !bFormattedResult) {
    throw new Error("expected runtime values for describeNumber results and derived bindings");
  }
  if (aResult.value.kind !== "tuple" || bResult.value.kind !== "tuple" || cResult.value.kind !== "tuple") {
    throw new Error("expected describeNumber results to be tuples");
  }
  const [aLabelRuntime, aPayloadRuntime, aFormatterRuntime] = aResult.value.elements;
  const [bLabelRuntime, bPayloadRuntime, bFormatterRuntime] = bResult.value.elements;
  const [cLabelRuntime, cPayloadRuntime, cFormatterRuntime] = cResult.value.elements;

  if (
    aLabelRuntime.kind !== "string" ||
    bLabelRuntime.kind !== "string" ||
    cLabelRuntime.kind !== "string"
  ) {
    throw new Error("expected tuple labels to be strings");
  }
  if (
    aPayloadRuntime.kind !== "tuple" ||
    bPayloadRuntime.kind !== "tuple" ||
    cPayloadRuntime.kind !== "tuple"
  ) {
    throw new Error("expected tuple payloads to be nested tuples");
  }

  const [aNumberRuntime, aFlagRuntime] = aPayloadRuntime.elements;
  const [bNumberRuntime, bFlagRuntime] = bPayloadRuntime.elements;
  const [cNumberRuntime, cFlagRuntime] = cPayloadRuntime.elements;

  if (
    aNumberRuntime.kind !== "int" ||
    bNumberRuntime.kind !== "int" ||
    cNumberRuntime.kind !== "int"
  ) {
    throw new Error("expected tuple payload numbers to be ints");
  }
  if (
    aFlagRuntime.kind !== "bool" ||
    bFlagRuntime.kind !== "bool" ||
    cFlagRuntime.kind !== "bool"
  ) {
    throw new Error("expected tuple payload flags to be bools");
  }
  if (
    aFormatterRuntime.kind !== "closure" ||
    bFormatterRuntime.kind !== "closure" ||
    cFormatterRuntime.kind !== "closure"
  ) {
    throw new Error("expected tuple formatters to be closures");
  }

  assertEquals(aLabelRuntime.value, "zero");
  assertEquals(bLabelRuntime.value, "one");
  assertEquals(cLabelRuntime.value, "other");

  assertEquals(aNumberRuntime.value, 0);
  assertEquals(bNumberRuntime.value, 1);
  assertEquals(cNumberRuntime.value, 42);

  assertEquals(aFlagRuntime.value, true);
  assertEquals(bFlagRuntime.value, false);
  assertEquals(cFlagRuntime.value, false);

  if (aLabelResult.value.kind !== "string" || bFormattedResult.value.kind !== "string") {
    throw new Error("expected derived string bindings to be strings");
  }
  if (cExtractedResult.value.kind !== "int") {
    throw new Error("expected extracted numeric binding to be an int");
  }

  assertEquals(aLabelResult.value.value, "zero");
  assertEquals(cExtractedResult.value.value, 42);
  assertEquals(bFormattedResult.value.value, "one");
});

Deno.test("supports recursive match bundles", { ignore: true }, () => {
  const source = `
    type List<T> = Nil | Cons<T, List<T>>;
    let rec describeList = match(list) {
      Nil => { "empty" },
      Cons(_, Nil) => { "singleton" },
      Cons(_, rest) => { describeList(rest) }
    };
    let emptyDesc = describeList(Nil);
    let nested = describeList(Cons(1, Cons(2, Nil)));
  `;

  const summaries = inferTypes(source);
  const describeBinding = summaries.find((entry) => entry.name === "describeList");
  const emptyBinding = summaries.find((entry) => entry.name === "emptyDesc");
  const nestedBinding = summaries.find((entry) => entry.name === "nested");
  if (!describeBinding || !emptyBinding || !nestedBinding) {
    throw new Error("expected describeList and result bindings");
  }

  assertEquals(describeBinding.type, "List<T> -> String");
  assertEquals(emptyBinding.type, "String");
  assertEquals(nestedBinding.type, "String");

  const evaluation = evaluateSource(source);
  const emptyValue = evaluation.summaries.find((entry) => entry.name === "emptyDesc");
  const nestedValue = evaluation.summaries.find((entry) => entry.name === "nested");
  if (!emptyValue || !nestedValue) {
    throw new Error("expected runtime values for emptyDesc and nested");
  }
  if (emptyValue.value.kind !== "string" || nestedValue.value.kind !== "string") {
    throw new Error("expected recursive match bundle results to be strings");
  }

  assertEquals(emptyValue.value.value, "empty");
  assertEquals(nestedValue.value.value, "singleton");
});

Deno.test("rejects mutual bundle references without recursion", { ignore: true }, () => {
  const source = `
    let first = match {
      second
    };
    let second = match {
      first
    };
  `;

  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown match bundle 'second'",
  );
});

Deno.test("rejects non-exhaustive match expression", { ignore: true }, () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bad = (opt) => {
      match(opt) {
        Some(_) => { 1 }
      }
    };
  `;

  assertThrows(() => inferTypes(source), InferError, "Non-exhaustive patterns");
});
