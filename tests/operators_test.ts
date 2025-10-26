import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { evaluateProgram } from "../src/eval.ts";
import type { TypeScheme } from "../src/types.ts";
import type { RuntimeValue, NativeFunctionValue } from "../src/value.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";
import { formatScheme } from "../src/type_printer.ts";

// ============================================================================
// PARSER TESTS
// ============================================================================

Deno.test("parser: parses infix declaration with left associativity", () => {
  const source = `infixl 6 + = add;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  
  if (decl.kind !== "infix") {
    throw new Error("expected infix declaration");
  }

  assertEquals(decl.operator, "+");
  assertEquals(decl.associativity, "left");
  assertEquals(decl.precedence, 6);
  assertEquals(decl.implementation, "add");
});

Deno.test("parser: parses infix declaration with right associativity", () => {
  const source = `infixr 5 ++ = concat;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  
  if (decl.kind !== "infix") {
    throw new Error("expected infix declaration");
  }

  assertEquals(decl.operator, "++");
  assertEquals(decl.associativity, "right");
  assertEquals(decl.precedence, 5);
  assertEquals(decl.implementation, "concat");
});

Deno.test("parser: parses infix declaration with no associativity", () => {
  const source = `infix 4 != = notEquals;`;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 1);
  const decl = program.declarations[0];
  
  if (decl.kind !== "infix") {
    throw new Error("expected infix declaration");
  }

  assertEquals(decl.operator, "!=");
  assertEquals(decl.associativity, "none");
  assertEquals(decl.precedence, 4);
  assertEquals(decl.implementation, "notEquals");
});

Deno.test("parser: parses binary expression", () => {
  const source = `
    infixl 6 + = add;
    let add = (a, b) => { a };
    let x = 5 + 3;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  assertEquals(program.declarations.length, 3);
  const xDecl = program.declarations[2];
  
  if (xDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = xDecl.body;
  if (body.result?.kind !== "binary") {
    throw new Error("expected binary expression");
  }

  assertEquals(body.result.operator, "+");
  assertEquals(body.result.left.kind, "literal");
  assertEquals(body.result.right.kind, "literal");
});

Deno.test("parser: respects operator precedence (multiplication before addition)", () => {
  const source = `
    infixl 6 + = add;
    infixl 7 * = mul;
    let add = (a, b) => { a };
    let mul = (a, b) => { a };
    let x = 2 + 3 * 4;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const xDecl = program.declarations[4];
  if (xDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = xDecl.body;
  if (body.result?.kind !== "binary") {
    throw new Error("expected binary expression");
  }

  // Should parse as: 2 + (3 * 4)
  assertEquals(body.result.operator, "+");
  assertEquals(body.result.left.kind, "literal");
  assertEquals(body.result.right.kind, "binary");
  
  if (body.result.right.kind === "binary") {
    assertEquals(body.result.right.operator, "*");
  }
});

Deno.test("parser: respects left associativity", () => {
  const source = `
    infixl 6 - = sub;
    let sub = (a, b) => { a };
    let x = 10 - 3 - 2;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const xDecl = program.declarations[2];
  if (xDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = xDecl.body;
  if (body.result?.kind !== "binary") {
    throw new Error("expected binary expression");
  }

  // Should parse as: (10 - 3) - 2
  assertEquals(body.result.operator, "-");
  assertEquals(body.result.left.kind, "binary");
  assertEquals(body.result.right.kind, "literal");
  
  if (body.result.left.kind === "binary") {
    assertEquals(body.result.left.operator, "-");
  }
});

Deno.test("parser: respects right associativity", () => {
  const source = `
    infixr 5 ++ = concat;
    let concat = (a, b) => { a };
    let x = 1 ++ 2 ++ 3;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const xDecl = program.declarations[2];
  if (xDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = xDecl.body;
  if (body.result?.kind !== "binary") {
    throw new Error("expected binary expression");
  }

  // Should parse as: 1 ++ (2 ++ 3)
  assertEquals(body.result.operator, "++");
  assertEquals(body.result.left.kind, "literal");
  assertEquals(body.result.right.kind, "binary");
  
  if (body.result.right.kind === "binary") {
    assertEquals(body.result.right.operator, "++");
  }
});

Deno.test("parser: parses complex expression with multiple operators", () => {
  const source = `
    infixl 6 + = add;
    infixl 6 - = sub;
    infixl 7 * = mul;
    let add = (a, b) => { a };
    let sub = (a, b) => { a };
    let mul = (a, b) => { a };
    let x = 10 * 2 + 5 - 3;
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  const xDecl = program.declarations[6];
  if (xDecl.kind !== "let") {
    throw new Error("expected let declaration");
  }

  const body = xDecl.body;
  if (body.result?.kind !== "binary") {
    throw new Error("expected binary expression");
  }

  // Should parse as: ((10 * 2) + 5) - 3
  assertEquals(body.result.operator, "-");
  assertEquals(body.result.right.kind, "literal");
  
  if (body.result.left.kind === "binary") {
    assertEquals(body.result.left.operator, "+");
    
    if (body.result.left.left.kind === "binary") {
      assertEquals(body.result.left.left.operator, "*");
    }
  }
});

// ============================================================================
// TYPE INFERENCE TESTS
// ============================================================================

function inferTypes(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program, { registerPrelude: false });
  return result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
}

Deno.test("infer: infers type of binary expression with operators", () => {
  const source = `
    let add = (a, b) => { a };
    infixl 6 + = add;
    let result = 5 + 3;
  `;
  const summaries = inferTypes(source);
  
  const addBinding = summaries.find((entry) => entry.name === "add");
  const resultBinding = summaries.find((entry) => entry.name === "result");
  
  assertEquals(addBinding?.type, "T -> U -> T");
  assertEquals(resultBinding?.type, "Int");
});

Deno.test("infer: infers polymorphic operator", () => {
  const source = `
    let concat = (a, b) => { a };
    infixr 5 ++ = concat;
    let x = 1 ++ 2;
  `;
  const summaries = inferTypes(source);
  
  const concatBinding = summaries.find((entry) => entry.name === "concat");
  const xBinding = summaries.find((entry) => entry.name === "x");
  
  assertEquals(concatBinding?.type, "T -> U -> T");
  assertEquals(xBinding?.type, "Int");
});

Deno.test("infer: infers complex expression with multiple operators", () => {
  const source = `
    let add = (a: Int, b: Int) => { a };
    let mul = (a: Int, b: Int) => { a };
    infixl 6 + = add;
    infixl 7 * = mul;
    let result = 2 + 3 * 4;
  `;
  const summaries = inferTypes(source);
  
  const resultBinding = summaries.find((entry) => entry.name === "result");
  assertEquals(resultBinding?.type, "Int");
});

Deno.test("infer: type checks operator arguments", () => {
  const source = `
    type MyBool = MyTrue | MyFalse;
    let add = (a: Int, b: Int) => { a };
    infixl 6 + = add;
    let result = MyTrue + MyFalse;
  `;
  
  assertThrows(
    () => inferTypes(source),
    InferError
  );
});

Deno.test("infer: handles operator with function return type", () => {
  const source = `
    let makeAdder = (a: Int, b: Int) => {
      (c: Int) => { c }
    };
    infixl 6 ++ = makeAdder;
    let f = 5 ++ 3;
  `;
  const summaries = inferTypes(source);
  
  const fBinding = summaries.find((entry) => entry.name === "f");
  assertEquals(fBinding?.type, "Int -> Int");
});

// ============================================================================
// RUNTIME EVALUATION TESTS
// ============================================================================

function evaluateSource(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  
  const intBinScheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: { kind: "func", from: { kind: "int" }, to: { kind: "int" } },
    },
  };

  const initialEnv = new Map<string, TypeScheme>([
    ["nativeAdd", intBinScheme],
    ["nativeSub", intBinScheme],
    ["nativeMul", intBinScheme],
    ["nativeDiv", intBinScheme],
  ]);

  const initialBindings = new Map<string, RuntimeValue>([
    ["nativeAdd", native2("nativeAdd", (a, b) => a + b)],
    ["nativeSub", native2("nativeSub", (a, b) => a - b)],
    ["nativeMul", native2("nativeMul", (a, b) => a * b)],
    ["nativeDiv", native2("nativeDiv", (a, b) => Math.trunc(a / b))],
  ]);

  inferProgram(program, { initialEnv, registerPrelude: false });
  return evaluateProgram(program, { initialBindings });
}

function native2(name: string, impl: (a: number, b: number) => number): NativeFunctionValue {
  return {
    kind: "native",
    name,
    arity: 2,
    collectedArgs: [],
    impl: (args) => ({ kind: "int", value: impl(expectInt(args[0]), expectInt(args[1])) }),
  };
}

function expectInt(value: RuntimeValue): number {
  if (value.kind !== "int") {
    throw new Error(`Expected int, got ${value.kind}`);
  }
  return value.value;
}

Deno.test("eval: evaluates simple binary expression", () => {
  const source = `
    let add = (a, b) => { nativeAdd(a, b) };
    infixl 6 + = add;
    let result = 5 + 3;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    assertEquals(resultValue.value.value, 8);
  }
});

Deno.test("eval: evaluates expression with precedence", () => {
  const source = `
    let add = (a, b) => { nativeAdd(a, b) };
    let mul = (a, b) => { nativeMul(a, b) };
    infixl 6 + = add;
    infixl 7 * = mul;
    let result = 2 + 3 * 4;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    // Should evaluate as 2 + (3 * 4) = 2 + 12 = 14
    assertEquals(resultValue.value.value, 14);
  }
});

Deno.test("eval: evaluates left associative operators", () => {
  const source = `
    let sub = (a, b) => { nativeSub(a, b) };
    infixl 6 - = sub;
    let result = 10 - 3 - 2;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    // Should evaluate as (10 - 3) - 2 = 7 - 2 = 5
    assertEquals(resultValue.value.value, 5);
  }
});

Deno.test("eval: evaluates right associative operators", () => {
  const source = `
    let sub = (a, b) => { nativeSub(a, b) };
    infixr 6 - = sub;
    let result = 10 - 3 - 2;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    // Should evaluate as 10 - (3 - 2) = 10 - 1 = 9
    assertEquals(resultValue.value.value, 9);
  }
});

Deno.test("eval: evaluates complex expression", () => {
  const source = `
    let add = (a, b) => { nativeAdd(a, b) };
    let sub = (a, b) => { nativeSub(a, b) };
    let mul = (a, b) => { nativeMul(a, b) };
    infixl 6 + = add;
    infixl 6 - = sub;
    infixl 7 * = mul;
    let result = 10 * 2 + 5 - 3;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    // Should evaluate as ((10 * 2) + 5) - 3 = (20 + 5) - 3 = 25 - 3 = 22
    assertEquals(resultValue.value.value, 22);
  }
});

Deno.test("eval: evaluates custom operator", () => {
  const source = `
    let concat = (a, b) => { nativeAdd(a, b) };
    infixr 5 ++ = concat;
    let result = 1 ++ 2;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    assertEquals(resultValue.value.value, 3);
  }
});

Deno.test("eval: operators work with variables", () => {
  const source = `
    let add = (a, b) => { nativeAdd(a, b) };
    let mul = (a, b) => { nativeMul(a, b) };
    infixl 6 + = add;
    infixl 7 * = mul;
    let x = 5;
    let y = 3;
    let result = x * y + 2;
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    // Should evaluate as (5 * 3) + 2 = 15 + 2 = 17
    assertEquals(resultValue.value.value, 17);
  }
});

Deno.test("eval: operators work in function bodies", () => {
  const source = `
    let add = (a, b) => { nativeAdd(a, b) };
    infixl 6 + = add;
    let addThree = (x) => { x + 3 };
    let result = addThree(5);
  `;
  const evalResult = evaluateSource(source);
  
  const resultValue = evalResult.summaries.find((s) => s.name === "result");
  assertEquals(resultValue?.value.kind, "int");
  if (resultValue?.value.kind === "int") {
    assertEquals(resultValue.value.value, 8);
  }
});
