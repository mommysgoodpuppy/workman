import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import { formatScheme } from "../src/type_printer.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";

function parseSource(source: string) {
  const tokens = lex(source);
  return parseSurfaceProgram(tokens);
}

function inferTypes(source: string) {
  const program = parseSource(source);
  const result = inferProgram(program);
  return result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
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
    (decl): decl is import("../src/ast.ts").LetDeclaration => decl.kind === "let" && decl.name === "handler",
  );

  if (!handlerDecl) {
    throw new Error("expected handler declaration");
  }

  const result = handlerDecl.body.result;
  if (!result || result.kind !== "match_bundle_literal") {
    throw new Error("expected match bundle literal");
  }

  assertEquals(result.bundle.arms.length, 2);
  assertEquals(result.bundle.arms[0].pattern.kind, "constructor");
  assertEquals(result.bundle.arms[1].pattern.kind, "constructor");
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
  const handler = evaluation.summaries.find((entry) => entry.name === "handler");
  if (!handler) {
    throw new Error("expected handler summary");
  }

  const { value } = handler;
  if (value.kind !== "native") {
    throw new Error(`expected handler to evaluate to native function, received ${value.kind}`);
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
    throw new Error(`expected handler application to produce Int, received ${applied.kind}`);
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
  const resultValue = evaluation.summaries.find((entry) => entry.name === "result");
  if (!resultValue) {
    throw new Error("expected result binding in evaluation");
  }
  const { value } = resultValue;
  if (value.kind !== "string") {
    throw new Error(`expected result to evaluate to string, received ${value.kind}`);
  }
  assertEquals(value.value, "zero");
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
