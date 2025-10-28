import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/layer1infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";

const TEST_PRELUDE_SOURCE = `
  type List<T> = Nil | Cons<T, List<T>>;
  type Ordering = LT | EQ | GT;
`;

function inferTypes(source: string) {
  const tokens = lex(`${TEST_PRELUDE_SOURCE}\n${source}`);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  return result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
}

// ============================================================================
// Shadowing Tests (Should already work)
// ============================================================================

Deno.test("shadowing in nested blocks", () => {
  const source = `
    let x = () => { 5 };
    let y = () => {
      let x = () => { 10 };
      x()
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "x")?.type, "Int");
  assertEquals(summaries.find((s) => s.name === "y")?.type, "Int");
});

Deno.test("shadowing in match arms", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let x = () => { 5 };
    let test = match(opt) {
      Some(x) => { x },
      None => { 0 }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "test")?.type, "Option<Int> -> Int");
});

Deno.test("shadowing parameters", () => {
  const source = `
    let outer = (x) => {
      let inner = (x) => {
        x
      };
      inner(10)
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "outer")?.type, "T -> Int");
});

// ============================================================================
// Recursive Let Tests (TODO: Implement)
// ============================================================================

Deno.test("simple recursive function", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let rec unwrap = match(opt) {
      Some(x) => { x },
      None => { unwrap(None) }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "unwrap")?.type, "Option<T> -> T");
});

Deno.test("recursive with curried function", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let rec findFirst = (predicate) => {
      (list) => {
        match(list) {
          Cons(x, rest) => { predicate(x) },
          Nil => { None }
        }
      }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "findFirst")?.type, "(T -> Option<U>) -> List<T> -> Option<U>");
});

Deno.test("recursive map over list", () => {
  const source = `
    let rec map = (f) => {
      (list) => {
        match(list) {
          Cons(x, rest) => { Cons(f(x), map(f)(rest)) },
          Nil => { Nil }
        }
      }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "map")?.type, "(T -> U) -> List<T> -> List<U>");
});

// ============================================================================
// Mutual Recursion Tests (TODO: Implement)
// ============================================================================

Deno.test("mutually recursive even/odd", () => {
  const source = `
    let rec isEven = match(n) {
      0 => { true },
      _ => { isOdd(0) }
    }
    and isOdd = match(n) {
      0 => { false },
      _ => { isEven(0) }
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "isEven")?.type, "Int -> Bool");
  assertEquals(summaries.find((s) => s.name === "isOdd")?.type, "Int -> Bool");
});

Deno.test("mutually recursive tree traversal", () => {
  const source = `
    type Tree<T> = Leaf<T> | Node<Tree<T>, Tree<T>>;
    type Option<T> = None | Some<T>;
    
    let rec findLeaf = match(tree) {
      Leaf(x) => { Some(x) },
      Node(left, right) => { searchBranches(left, right) }
    }
    and searchBranches = (left, right) => {
      findLeaf(left)
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.find((s) => s.name === "findLeaf")?.type, "Tree<T> -> Option<T>");
  // Type variable ordering may vary
  const searchType = summaries.find((s) => s.name === "searchBranches")?.type;
  assertEquals(searchType?.includes("Tree"), true);
  assertEquals(searchType?.includes("Option"), true);
});

// ============================================================================
// Error Cases
// ============================================================================

Deno.test("rejects non-recursive function calling itself", () => {
  const source = `
    let bad = match(n) {
      0 => { 1 },
      _ => { bad(0) }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown identifier"
  );
});

Deno.test("rejects type mismatch in recursive call", () => {
  const source = `
    let rec bad = match(n) {
      0 => { true },
      _ => { bad(true) }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError
  );
});

Deno.test("rejects mutual recursion without 'and'", () => {
  const source = `
    let rec isEven = match(n) {
      0 => { true },
      _ => { isOdd(0) }
    };
    let rec isOdd = match(n) {
      0 => { false },
      _ => { isEven(0) }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Unknown identifier"
  );
});
