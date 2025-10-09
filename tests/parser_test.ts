import { lex } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { assertEquals } from "https://deno.land/std/assert/mod.ts";

Deno.test("parses simple type declaration", () => {
  const source = `type Option a = None | Some a`;
  const tokens = lex(source);
  const program = parse(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "type") {
    throw new Error("expected type declaration");
  }

  assertEquals(decl.name, "Option");
  assertEquals(decl.parameters, ["a"]);
  assertEquals(decl.constructors.length, 2);

  const none = decl.constructors[0];
  assertEquals(none.name, "None");
  assertEquals(none.args.length, 0);

  const some = decl.constructors[1];
  assertEquals(some.name, "Some");
  assertEquals(some.args.length, 1);
  const argType = some.args[0];
  assertEquals(argType.kind, "var");
  if (argType.kind === "var") {
    assertEquals(argType.name, "a");
  }
});

Deno.test("parses match expression with constructors", () => {
  const source = `
let example = match input with
  | Some x -> x
  | None -> 0;
`;
  const tokens = lex(source);
  const program = parse(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const matchExpr = decl.value;
  if (matchExpr.kind !== "match") {
    throw new Error("expected match expression");
  }

  assertEquals(matchExpr.cases.length, 2);

  const firstCase = matchExpr.cases[0];
  assertEquals(firstCase.pattern.kind, "constructor");
  if (firstCase.pattern.kind === "constructor") {
    assertEquals(firstCase.pattern.name, "Some");
    assertEquals(firstCase.pattern.args.length, 1);
  }

  const secondCase = matchExpr.cases[1];
  assertEquals(secondCase.pattern.kind, "constructor");
  if (secondCase.pattern.kind === "constructor") {
    assertEquals(secondCase.pattern.name, "None");
    assertEquals(secondCase.pattern.args.length, 0);
  }
});
