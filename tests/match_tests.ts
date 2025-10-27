import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import { formatScheme } from "../src/type_printer.ts";
import type { RuntimeValue } from "../src/value.ts";
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

Deno.test("infers match bundle literal result type", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bundle = match {
      Some(x) => { x },
      None => { 0 }
    };
  `;

  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "bundle");
  if (!binding) {
    throw new Error("expected bundle binding");
  }

  // Returning x in the first arm and 0 in the second forces the bundle result to be Int
  assertEquals(binding.type, "Int");
});

Deno.test("evaluates match bundle literal to runtime value", () => {
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

  const value: RuntimeValue = handler.value;
  if (value.kind !== "match_bundle") {
    throw new Error(`expected handler to evaluate to match bundle, received ${value.kind}`);
  }
  assertEquals(value.bundle.arms.length, 2);
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
