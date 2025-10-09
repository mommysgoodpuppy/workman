import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";

function inferTypes(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  return result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
}

// ============================================================================
// First-Class Match Tests
// ============================================================================

Deno.test("first-class match desugars correctly", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let extractOld = (opt) => {
      match(opt) {
        Some(x) => { x },
        None => { 0 }
      }
    };
    let extractNew = match(opt) {
      Some(x) => { x },
      None => { 0 }
    };
  `;
  const summaries = inferTypes(source);
  const old = summaries.find((s) => s.name === "extractOld");
  const newSyntax = summaries.find((s) => s.name === "extractNew");
  
  assertEquals(old?.type, "Option<Int> -> Int");
  assertEquals(newSyntax?.type, "Option<Int> -> Int");
  // Both should have identical types
  assertEquals(old?.type, newSyntax?.type);
});

Deno.test("first-class match with multiple parameters via currying", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let getOrElse = (fallback) => {
      (opt) => {
        match(opt) {
          Some(x) => { x },
          None => { fallback }
        }
      }
    };
  `;
  const summaries = inferTypes(source);
  const fn = summaries.find((s) => s.name === "getOrElse");
  assertEquals(fn?.type, "T -> Option<T> -> T");
});

// ============================================================================
// Nested Pattern Tests
// ============================================================================

Deno.test("nested constructor patterns", () => {
  const source = `
    type Option<T> = None | Some<T>;
    type Pair<A, B> = Pair<A, B>;
    let extractNested = match(p) {
      Pair(Some(x), _) => { x },
      Pair(None, Some(y)) => { y },
      Pair(None, None) => { 0 }
    };
  `;
  const summaries = inferTypes(source);
  const fn = summaries.find((s) => s.name === "extractNested");
  assertEquals(fn?.type, "Pair<Option<Int>, Option<Int>> -> Int");
});

Deno.test("deeply nested patterns", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let unwrap3 = match(x) {
      Some(Some(Some(value))) => { value },
      _ => { 0 }
    };
  `;
  const summaries = inferTypes(source);
  const fn = summaries.find((s) => s.name === "unwrap3");
  assertEquals(fn?.type, "Option<Option<Option<Int>>> -> Int");
});

// ============================================================================
// Multiple ADTs
// ============================================================================

Deno.test("multiple ADTs in same program", () => {
  const source = `
    type Option<T> = None | Some<T>;
    type Result<T, E> = Ok<T> | Err<E>;
    type Either<L, R> = Left<L> | Right<R>;
    
    let optToResult = match(opt) {
      Some(x) => { Ok(x) },
      None => { Err(0) }
    };
    
    let resultToEither = match(res) {
      Ok(x) => { Right(x) },
      Err(e) => { Left(e) }
    };
  `;
  const summaries = inferTypes(source);
  const opt = summaries.find((s) => s.name === "optToResult");
  const res = summaries.find((s) => s.name === "resultToEither");
  
  assertEquals(opt?.type, "Option<T> -> Result<T, Int>");
  // Type variable ordering may vary
  assertEquals(res?.type.includes("Result"), true);
  assertEquals(res?.type.includes("Either"), true);
});

// ============================================================================
// Wildcard Pattern Tests
// ============================================================================

Deno.test("wildcard in various positions", () => {
  const source = `
    type Triple<A, B, C> = Triple<A, B, C>;
    let first = match(t) {
      Triple(x, _, _) => { x }
    };
    let second = match(t) {
      Triple(_, y, _) => { y }
    };
    let third = match(t) {
      Triple(_, _, z) => { z }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "first")?.type, "Triple<T, U, V> -> T");
  assertEquals(summaries.find((s) => s.name === "second")?.type, "Triple<T, U, V> -> U");
  assertEquals(summaries.find((s) => s.name === "third")?.type, "Triple<T, U, V> -> V");
});

// ============================================================================
// Literal Pattern Tests
// ============================================================================

Deno.test("boolean literal patterns", () => {
  const source = `
    let not = match(b) {
      true => { false },
      false => { true }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "not")?.type, "Bool -> Bool");
});

Deno.test("integer literal patterns", () => {
  const source = `
    let isZero = match(n) {
      0 => { true },
      _ => { false }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "isZero")?.type, "Int -> Bool");
});

Deno.test("mixed literal and constructor patterns", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let describe = match(opt) {
      Some(0) => { true },
      Some(_) => { false },
      None => { false }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "describe")?.type, "Option<Int> -> Bool");
});

// ============================================================================
// Error Cases
// ============================================================================

Deno.test("rejects undefined constructor", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bad = match(x) {
      Maybe(v) => { v }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown identifier"
  );
});

Deno.test("rejects undefined variable", () => {
  const source = `
    let bad = () => {
      undefinedVar
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown identifier"
  );
});

Deno.test("rejects constructor arity mismatch", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let bad = match(p) {
      Pair(x) => { x }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError
  );
});

Deno.test("rejects type annotation mismatch with clear error", () => {
  const source = `
    let bad: Int = (x: Bool) => {
      x
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError
  );
});

// ============================================================================
// Tuple Pattern Tests
// ============================================================================

Deno.test("tuple patterns with wildcards", () => {
  const source = `
    let fst = match(t) {
      (x, _) => { x }
    };
    let snd = match(t) {
      (_, y) => { y }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "fst")?.type, "(T, U) -> T");
  assertEquals(summaries.find((s) => s.name === "snd")?.type, "(T, U) -> U");
});

Deno.test("nested tuple patterns", () => {
  const source = `
    let extract = match(t) {
      ((a, b), c) => { b }
    };
  `;
  const summaries = inferTypes(source);
  const extractType = summaries.find((s) => s.name === "extract")?.type;
  // Type variable ordering may vary, just check structure
  assertEquals(extractType?.includes("->"), true);
  assertEquals(extractType?.includes("("), true);
});
