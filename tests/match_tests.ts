import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { InferError, inferProgram } from "../src/infer.ts";
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

Deno.test("parses match bundle literal", () => {
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

Deno.test("infers match bundle literal function type", () => {
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

Deno.test("evaluates match bundle literal to callable", () => {
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

Deno.test("composes match bundles", () => {
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

Deno.test("match expressions can reference bundle arms", () => {
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

  assertEquals(someOnlyBinding.type, "Option<Int> -> Int");
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

Deno.test("rejects non-exhaustive match expression", () => {
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
