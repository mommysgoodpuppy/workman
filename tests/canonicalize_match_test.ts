import {
  assert,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { canonicalizeMatch } from "../src/passes/canonicalize_match.ts";
import type { LetDeclaration } from "../src/ast.ts";

Deno.test("canonicalizeMatch currently leaves program unchanged", () => {
  const source = `
    let id = (x) => { x };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  const result = canonicalizeMatch(program);
  assertStrictEquals(result, program);
});

Deno.test("canonicalizeMatch rewrites match_fn into arrow function", () => {
  const source = `
    let matcher = match(x) => {
      0 => { x },
      _ => { x }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  canonicalizeMatch(program);

  const firstDecl = program.declarations[0] as LetDeclaration;
  if (firstDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const bodyResult = firstDecl.body.result;
  if (!bodyResult) {
    throw new Error("expected body result");
  }
  if (bodyResult.kind !== "arrow") {
    throw new Error(`expected arrow, got ${bodyResult.kind}`);
  }

  const [parameter] = bodyResult.parameters;
  if (!parameter) {
    throw new Error("expected generated parameter");
  }
  if (parameter.pattern.kind !== "variable") {
    throw new Error("expected variable pattern parameter");
  }
  if (parameter.pattern.name !== "x") {
    throw new Error(`expected parameter name 'x', got '${parameter.pattern.name}'`);
  }

  const matchExpr = bodyResult.body.result;
  if (!matchExpr || matchExpr.kind !== "match") {
    throw new Error("expected match expression in arrow body");
  }
  if (matchExpr.scrutinee.kind !== "identifier") {
    throw new Error("expected scrutinee to be identifier");
  }
  if (matchExpr.scrutinee.name !== "x") {
    throw new Error("expected scrutinee identifier to match parameter name");
  }
  if (!firstDecl.isFirstClassMatch) {
    throw new Error("expected let declaration to be marked as first-class match");
  }
});

Deno.test("block-level match binding stays a value", () => {
  const source = `
    let outer = () => {
      let res = IOk(0);
      let adds = match (res) {
        IOk(_) => {0},
        IErr(_) => {1}
      };
      adds
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens, source);
  canonicalizeMatch(program);

  const firstDecl = program.declarations[0];
  if (firstDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }
  const outerBody = firstDecl.body;
  if (outerBody.kind !== "block") {
    throw new Error("expected outer block body");
  }
  const addsStatement = outerBody.statements.find((statement) =>
    statement.kind === "let_statement" &&
    statement.declaration.name === "adds"
  );
  assert(addsStatement && addsStatement.kind === "let_statement");
  const addsDecl = addsStatement.declaration;
  assertStrictEquals(addsDecl.parameters.length, 0);
  assertStrictEquals(addsDecl.isFirstClassMatch, undefined);
});

