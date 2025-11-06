import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std/assert/mod.ts";
import type { TypeDeclaration } from "../src/ast.ts";

function inferWithProgram(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  return { program, result };
}

Deno.test("rejects undeclared type variables in constructors", () => {
  const source = `
    type Bad<T> = Bad<U>;
  `;
  const { program, result } = inferWithProgram(source);
  const typeDecl = program.declarations[0] as TypeDeclaration;
  const constructor = typeDecl.members[0];
  if (constructor.kind !== "constructor") {
    throw new Error("expected constructor member");
  }
  const unknownTypeRef = constructor.typeArgs[0];
  const mark = result.typeExprMarks.get(unknownTypeRef.id);
  assertExists(mark, "expected mark for unknown type variable");
  assertEquals(mark.kind, "mark_type_expr_unknown");
  assert(
    mark.reason.includes("Unknown type constructor 'U'"),
    `expected unknown type constructor reason, got ${mark.reason}`,
  );
});

Deno.test("rejects type constructor arity mismatch in annotation", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bad: Option<Int, Bool> = (x) => {
      None
    };
  `;
  const { program, result } = inferWithProgram(source);
  const letDecl = program.declarations.find((decl) =>
    decl.kind === "let"
  );
  assertExists(letDecl);
  if (letDecl?.kind !== "let" || !letDecl.annotation) {
    throw new Error("expected let declaration with annotation");
  }
  const annotation = letDecl.annotation;
  const mark = result.typeExprMarks.get(annotation.id);
  assertExists(mark, "expected annotation arity mark");
  assertEquals(mark.kind, "mark_type_expr_arity");
  assertEquals(mark.expected, 1);
  assertEquals(mark.actual, 2);
});

Deno.test("rejects non-exhaustive boolean match", () => {
  const source = `
    let onlyTrue = (b) => {
      match(b) {
        true => { false }
      }
    };
  `;
  const { result } = inferWithProgram(source);
  const marks = Array.from(result.marks.values());
  const nonExhaustive = marks.find((mark) =>
    mark.kind === "mark_unsupported_expr" &&
      mark.exprKind === "match_non_exhaustive"
  );
  assertExists(nonExhaustive, "expected non-exhaustive match mark");
});
