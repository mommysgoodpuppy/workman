import { lex } from "../src/lexer.ts";
import type { NodeId, Program } from "../src/ast.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { ParseError } from "../src/error.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";

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

Deno.test("parses index expression", () => {
  const source = `let x = buffer[0];`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = decl.body;
  if (body.result?.kind !== "index") {
    throw new Error("expected index expression");
  }
  const indexExpr = body.result;
  assertEquals(indexExpr.target.kind, "identifier");
  if (indexExpr.target.kind === "identifier") {
    assertEquals(indexExpr.target.name, "buffer");
  }
  assertEquals(indexExpr.index.kind, "literal");
  if (indexExpr.index.kind === "literal") {
    assertEquals(indexExpr.index.literal.kind, "int");
    if (indexExpr.index.literal.kind === "int") {
      assertEquals(indexExpr.index.literal.value, 0);
    }
  }
});

Deno.test("parses pipe into index as write call", () => {
  const source = `let x = 'H' >> buffer[0];`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = decl.body;
  if (body.result?.kind !== "call") {
    throw new Error("expected call expression");
  }

  const call = body.result;
  assertEquals(call.callee.kind, "identifier");
  if (call.callee.kind === "identifier") {
    assertEquals(call.callee.name, "write");
  }
  assertEquals(call.arguments.length, 3);
  assertEquals(call.arguments[0].kind, "identifier");
  if (call.arguments[0].kind === "identifier") {
    assertEquals(call.arguments[0].name, "buffer");
  }
  assertEquals(call.arguments[1].kind, "literal");
  if (call.arguments[1].kind === "literal") {
    assertEquals(call.arguments[1].literal.kind, "int");
  }
  assertEquals(call.arguments[2].kind, "literal");
  if (call.arguments[2].kind === "literal") {
    assertEquals(call.arguments[2].literal.kind, "char");
  }
});

Deno.test("parses if expression", () => {
  const source = `
let result = if (debug) {
  1
} else {
  2
};
`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = decl.body;
  if (body.result?.kind !== "if") {
    throw new Error("expected if expression");
  }
  const ifExpr = body.result;
  assertEquals(ifExpr.condition.kind, "identifier");
  assertEquals(ifExpr.thenBranch.kind, "block");
  assertEquals(ifExpr.elseBranch.kind, "block");
});

Deno.test("parses dot record literal", () => {
  const source = `let result = .{ value: 1, next: 2 };`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const decl = program.declarations[0];
  if (decl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = decl.body;
  if (body.result?.kind !== "record_literal") {
    throw new Error("expected record literal");
  }
  assertEquals(body.result.fields.length, 2);
});

Deno.test("requires else for if expression", () => {
  const source = `let result = if (debug) { 1 };`;
  const tokens = lex(source);
  assertThrows(
    () => parseSurfaceProgram(tokens),
    ParseError,
    "'if' expression is missing 'else' block.",
  );
});

Deno.test("rejects else if syntax", () => {
  const source = `
let result = if (x > 0) {
  1
} else if (x < 0) {
  -1
} else {
  0
};
`;
  const tokens = lex(source);
  assertThrows(
    () => parseSurfaceProgram(tokens),
    ParseError,
    "Workman does not support 'else if'. Use 'match' for multiple conditions.",
  );
});

Deno.test("supports both -- and // single-line comments", () => {
  const source = `
// top-level comment
let value = 1; -- trailing with legacy comment
// another comment
let doubled = value + value;
`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 2);
  const [first, second] = program.declarations;
  if (first.kind !== "let" || second.kind !== "let") {
    throw new Error("expected let declarations");
  }
  assertEquals(first.name, "value");
  assertEquals(second.name, "doubled");
});
