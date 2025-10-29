import { lex } from "../src/lexer.ts";
import { NodeId, Program } from "../src/ast.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { assertEquals } from "https://deno.land/std/assert/mod.ts";

function collectNodeIds(program: Program): NodeId[] {
  const ids: NodeId[] = [];
  const seen = new Set<NodeId>();

  function visit(node: any): void {
    if (node && typeof node === 'object' && 'id' in node) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        ids.push(node.id);
      }
    }

    // Recursively visit all properties that might contain AST nodes
    for (const key in node) {
      if (node.hasOwnProperty(key)) {
        const value = node[key];
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === 'object') {
          visit(value);
        }
      }
    }
  }

  visit(program);
  return ids.sort((a, b) => a - b);
}

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
    Some(x) => { x },
    None => { 0 }
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

  assertEquals(matchExpr.bundle.arms.length, 2);

  const firstCase = matchExpr.bundle.arms[0];
  if (firstCase.kind !== "match_pattern") {
    throw new Error("expected match pattern arm");
  }
  assertEquals(firstCase.pattern.kind, "constructor");
  if (firstCase.pattern.kind === "constructor") {
    assertEquals(firstCase.pattern.name, "Some");
    assertEquals(firstCase.pattern.args.length, 1);
  }

  const secondCase = matchExpr.bundle.arms[1];
  if (secondCase.kind !== "match_pattern") {
    throw new Error("expected match pattern arm");
  }
  assertEquals(secondCase.pattern.kind, "constructor");
  if (secondCase.pattern.kind === "constructor") {
    assertEquals(secondCase.pattern.name, "None");
    assertEquals(secondCase.pattern.args.length, 0);
  }
});

Deno.test("parses tuple parameter patterns", () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
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
  const param = decl.parameters[0];
  assertEquals(param.name, undefined);
  assertEquals(param.pattern.kind, "tuple");
  if (param.pattern.kind !== "tuple") {
    throw new Error("expected tuple pattern");
  }
  assertEquals(param.pattern.elements.length, 2);

  const first = param.pattern.elements[0];
  assertEquals(first.kind, "variable");
  if (first.kind === "variable") {
    assertEquals(first.name, "a");
  }

  const second = param.pattern.elements[1];
  assertEquals(second.kind, "variable");
  if (second.kind === "variable") {
    assertEquals(second.name, "b");
  }
});

Deno.test("parser assigns unique and deterministic node IDs", () => {
  const source = `type Option<T> = None | Some<T>;`;
  const tokens1 = lex(source);
  const program1 = parseSurfaceProgram(tokens1);
  const ids1 = collectNodeIds(program1);

  // Parse the same source again
  const tokens2 = lex(source);
  const program2 = parseSurfaceProgram(tokens2);
  const ids2 = collectNodeIds(program2);

  // IDs should be deterministic - same source produces same IDs
  assertEquals(ids1, ids2);

  // Should have some IDs (at least the type declaration and its components)
  assertEquals(ids1.length > 0, true);

  // IDs should start from 0 and be strictly increasing
  for (let i = 0; i < ids1.length - 1; i++) {
    assertEquals(ids1[i] < ids1[i + 1], true);
  }

  // First ID should be 0
  assertEquals(ids1[0], 0);
});
