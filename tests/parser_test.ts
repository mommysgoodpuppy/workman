import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { assertEquals } from "https://deno.land/std/assert/mod.ts";

Deno.test("parses simple type declaration", () => {
  const source = `type Option<T> = None | Some<T>;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "type") {
    throw new Error("expected type declaration");
  }

  assertEquals(decl.name, "Option");
  assertEquals(decl.typeParams.length, 1);
  assertEquals(decl.typeParams[0].name, "T");
  assertEquals(decl.members.length, 2);

  const none = decl.members[0];
  if (none.kind !== "constructor") {
    throw new Error("expected constructor member for None");
  }
  assertEquals(none.name, "None");
  assertEquals(none.typeArgs.length, 0);

  const some = decl.members[1];
  if (some.kind !== "constructor") {
    throw new Error("expected constructor member for Some");
  }
  assertEquals(some.name, "Some");
  assertEquals(some.typeArgs.length, 1);
  assertEquals(some.typeArgs[0].kind, "type_ref");
  if (some.typeArgs[0].kind === "type_ref") {
    assertEquals(some.typeArgs[0].name, "T");
  }
});

Deno.test("parses match expression with constructors", () => {
  const source = `
let example = (input) => {
  match(input) {
    case Some(x) => x,
    case None => 0
  }
};
`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  assertEquals(decl.parameters.length, 1);

  const body = decl.body;
  if (body.result?.kind !== "match") {
    throw new Error("expected match expression");
  }
  const matchExpr = body.result;
  if (!matchExpr || matchExpr.kind !== "match") {
    throw new Error("expected match expression");
  }

  assertEquals(matchExpr.arms.length, 2);

  const firstCase = matchExpr.arms[0];
  assertEquals(firstCase.pattern.kind, "constructor");
  if (firstCase.pattern.kind === "constructor") {
    assertEquals(firstCase.pattern.name, "Some");
    assertEquals(firstCase.pattern.args.length, 1);
  }

  const secondCase = matchExpr.arms[1];
  assertEquals(secondCase.pattern.kind, "constructor");
  if (secondCase.pattern.kind === "constructor") {
    assertEquals(secondCase.pattern.name, "None");
    assertEquals(secondCase.pattern.args.length, 0);
  }
});
