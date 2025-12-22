import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std/assert/mod.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

function inferTypes(source: string) {
  const {
    initialEnv,
    initialAdtEnv,
    initialOperators,
    initialPrefixOperators,
  } = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    initialOperators,
    initialPrefixOperators,
  );
  const result = inferProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
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
  assertEquals(summaries.find((s) => s.name === "x")?.type, "Unit -> Int");
  assertEquals(summaries.find((s) => s.name === "y")?.type, "Unit -> Int");
});

Deno.test("shadowing in match arms", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let x = () => { 5 };
    let test = match(opt) => {
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
    let rec unwrap = match(opt) => {
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
          Link(x, rest) => { predicate(x) },
          Empty => { None }
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
          Link(x, rest) => { Link(f(x), map(f)(rest)) },
          Empty => { Empty }
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
    let rec isEven = match(n) => {
      0 => { true },
      _ => { isOdd(0) }
    }
    and isOdd = match(n) => {
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
    
    let rec findLeaf = match(tree) => {
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

Deno.test("rejects self-reference without rec keyword", () => {
  const source = `
    let bad = match(n) => {
      0 => { 1 },
      _ => { bad(0) }
    };
  `;
  const {
    initialEnv,
    initialAdtEnv,
    initialOperators,
    initialPrefixOperators,
  } = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    initialOperators,
    initialPrefixOperators,
  );
  const result = inferProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
  const marks = Array.from(result.marks.values());
  const freeVar = marks.find((mark) =>
    mark.kind === "mark_free_var" && mark.name === "bad"
  );
  assertExists(freeVar, "expected free variable mark for self call");
  
  // Check that we get a free_variable diagnostic
  const freeVarDiag = result.layer1Diagnostics.find((diag) =>
    diag.reason === "free_variable" && diag.details.name === "bad"
  );
  assertExists(freeVarDiag, "expected free_variable diagnostic for bad");
});

Deno.test("rejects calling a non-function value", () => {
  const source = `
    let notAFunction = 42;
    let result = notAFunction(10);
  `;
  const {
    initialEnv,
    initialAdtEnv,
    initialOperators,
    initialPrefixOperators,
  } = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    initialOperators,
    initialPrefixOperators,
  );
  const result = inferProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
  const marks = Array.from(result.marks.values());
  const notFunction = marks.find((mark) => mark.kind === "mark_not_function");
  assertExists(notFunction, "expected not_function mark for notAFunction(10)");
});

Deno.test("rejects type mismatch in recursive call", () => {
  const source = `
    let rec bad = match(n) => {
      0 => { true },
      _ => { bad(n) }
    };
    let res = bad(true);
  `;
  const {
    initialEnv,
    initialAdtEnv,
    initialOperators,
    initialPrefixOperators,
  } = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    initialOperators,
    initialPrefixOperators,
  );
  const result = inferProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
  const inconsistent = Array.from(result.marks.values()).find((mark) =>
    mark.kind === "mark_inconsistent"
  );
  assertExists(inconsistent, "expected mark_inconsistent for bad(true)");
  if (inconsistent?.kind === "mark_inconsistent") {
    assertEquals(inconsistent.actual.kind, "bool");
  }
});

Deno.test("rejects mutual recursion without 'and'", () => {
  const source = `
    let rec isEven = match(n) => {
      0 => { true },
      _ => { isOdd(0) }
    };
    let rec isOdd = match(n) => {
      0 => { false },
      _ => { isEven(0) }
    };
  `;
  const {
    initialEnv,
    initialAdtEnv,
    initialOperators,
    initialPrefixOperators,
  } = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    initialOperators,
    initialPrefixOperators,
  );
  const result = inferProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
  const marks = Array.from(result.marks.values());
  const freeVar = marks.find((mark) =>
    mark.kind === "mark_free_var" && mark.name === "isOdd"
  );
  assertExists(freeVar, "expected free variable mark for isOdd");
  
  // Check that we get a free_variable diagnostic for isOdd
  const freeVarDiag = result.layer1Diagnostics.find((diag) =>
    diag.reason === "free_variable" && diag.details.name === "isOdd"
  );
  assertExists(freeVarDiag, "expected free_variable diagnostic for isOdd");
});


