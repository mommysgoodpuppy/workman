import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/layer1infer.ts";
import { lowerTupleParameters } from "../src/lower_tuple_params.ts";
import { formatScheme } from "../src/type_printer.ts";
import { NodeId, Program } from "../src/ast.ts";
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

function collectNodeIds(program: any): NodeId[] {
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

Deno.test("infers polymorphic identity function", () => {
  const source = `
    let id = (x) => {
      x
    };
  `;
  const summaries = inferTypes(source);
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "id", type: "T -> T" });
});

Deno.test("infers constructors and ADT match", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let mapOption = (f, opt) => {
      match(opt) {
        Some(x) => { Some(f(x)) },
        None => { None }
      }
    };
  `;
  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "mapOption");
  if (!binding) {
    throw new Error("expected mapOption binding");
  }
  assertEquals(binding.type, "(T -> U) -> Option<T> -> Option<U>");
});

Deno.test("rejects non-exhaustive match", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let bad = (opt) => {
      match(opt) {
        Some(x) => { x }
      }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Non-exhaustive patterns",
  );
});

Deno.test("supports annotated let bindings", () => {
  const source = `
    let id = (x: Int) => {
      x
    };
    let three = () => {
      id(3)
    };
  `;
  const summaries = inferTypes(source);
  const idBinding = summaries.find((entry) => entry.name === "id");
  const threeBinding = summaries.find((entry) => entry.name === "three");
  if (!idBinding || !threeBinding) {
    throw new Error("expected id and three bindings");
  }
  assertEquals(idBinding.type, "Int -> Int");
  assertEquals(threeBinding.type, "Int");
});

Deno.test("infers tuple pattern matches", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let fst = (pair) => {
      match(pair) {
        Pair(x, _) => { x }
      }
    };
  `;
  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "fst");
  if (!binding) {
    throw new Error("expected fst binding");
  }
  assertEquals(binding.type, "Pair<T, U> -> T");
});

Deno.test("infers tuple parameter destructuring", () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
    };
  `;
  const summaries = inferTypes(source);
  const swap = summaries.find((entry) => entry.name === "swap");
  if (!swap) {
    throw new Error("expected swap binding");
  }
  assertEquals(swap.type, "(T, U) -> (U, T)");
});

Deno.test("infers tuple literal types", () => {
  const source = `
    let pair = {
      (1, true)
    };
  `;
  const summaries = inferTypes(source);
  const pair = summaries.find((entry) => entry.name === "pair");
  if (!pair) {
    throw new Error("expected pair binding");
  }
  assertEquals(pair.type, "(Int, Bool)");
});

Deno.test("generalizes tuple-producing functions", () => {
  const source = `
    let dup = (x) => {
      (x, x)
    };
    let use = () => {
      let ints = dup(1);
      let bools = dup(true);
      (ints, bools)
    };
  `;
  const summaries = inferTypes(source);
  const dup = summaries.find((entry) => entry.name === "dup");
  if (!dup) {
    throw new Error("expected dup binding");
  }
  assertEquals(dup.type, "T -> (T, T)");
  const use = summaries.find((entry) => entry.name === "use");
  if (!use) {
    throw new Error("expected use binding");
  }
  assertEquals(use.type, "((Int, Int), (Bool, Bool))");
});

Deno.test("block let generalization allows multiple instantiations", () => {
  const source = `
    let useId = () => {
      let id = (x) => { x };
      (id(1), id(true))
    };
  `;
  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "useId");
  if (!binding) {
    throw new Error("expected useId binding");
  }
  assertEquals(binding.type, "(Int, Bool)");
});

Deno.test("type annotation reuses named variables", () => {
  const source = `
    let choose = (a: T, b: T) => {
      match(true) {
        true => { a },
        false => { b }
      }
    };
  `;
  const summaries = inferTypes(source);
  const choose = summaries.find((entry) => entry.name === "choose");
  if (!choose) {
    throw new Error("expected choose binding");
  }
  assertEquals(choose.type, "T -> T -> T");
});

Deno.test("occurs check triggers on ill-typed recursion", () => {
  const source = `
    let rec loop = match(x) {
      _ => { loop(loop) }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Occurs check failed",
  );
});

Deno.test("constructor arity mismatch fails", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let bad = () => {
      Pair(1)
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "not fully applied",
  );
});

Deno.test("rejects duplicate pattern bindings", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let bad = (pair) => {
      match(pair) {
        Pair(x, x) => { x }
      }
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Duplicate variable",
  );
});

Deno.test("rejects annotation mismatches", () => {
  const source = `
    let tricky: Bool = (x: Int) => {
      x
    };
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
  );
});

Deno.test("supports list prelude constructors", () => {
  const source = `
    let singleton = () => {
      Cons(1, Nil)
    };
    let two = () => {
      Cons(true, Nil)
    };
  `;
  const summaries = inferTypes(source);
  const singleton = summaries.find((entry) => entry.name === "singleton");
  const two = summaries.find((entry) => entry.name === "two");
  if (!singleton || !two) {
    throw new Error("expected singleton and two bindings");
  }
  assertEquals(singleton.type, "List<Int>");
  assertEquals(two.type, "List<Bool>");
});

Deno.test("first-class match builds pattern functions", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let toBoolean = () => {
      (value) => {
        match(value) {
          Some(_) => { true },
          None => { false }
        }
      }
    };
    let value = () => {
      toBoolean()(Some(42))
    };
  `;
  const summaries = inferTypes(source);
  const convert = summaries.find((entry) => entry.name === "toBoolean");
  const value = summaries.find((entry) => entry.name === "value");
  if (!convert || !value) {
    throw new Error("expected toBoolean and value bindings");
  }
  assertEquals(convert.type, "Option<T> -> Bool");
  assertEquals(value.type, "Bool");
});

Deno.test("lowering preserves and allocates node IDs correctly", () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  // Collect IDs before lowering
  const idsBefore = collectNodeIds(program);

  // Apply lowering
  lowerTupleParameters(program);

  // Collect IDs after lowering
  const idsAfter = collectNodeIds(program);

  // Should have more IDs after lowering (synthetic nodes created)
  assertEquals(idsAfter.length > idsBefore.length, true);

  // Original IDs should be preserved (may be in different order due to new nodes)
  for (const originalId of idsBefore) {
    assertEquals(idsAfter.includes(originalId), true, `Original ID ${originalId} should be preserved ${idsAfter}`);
  }

  // New IDs should be strictly increasing and greater than existing ones
  const maxOriginalId = Math.max(...idsBefore);
  const newIds = idsAfter.filter(id => !idsBefore.includes(id));
  for (const newId of newIds) {
    assertEquals(newId > maxOriginalId, true, `New ID ${newId} should be greater than max original ID ${maxOriginalId}`);
  }

  // Verify the function still has the expected type
  const result = inferProgram(program);
  const summaries = result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "swap", type: "(T, U) -> (U, T)" });
});

Deno.test("inference completes successfully with ID-annotated AST", () => {
  const source = `
    let identity = (x) => {
      x
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);

  // Run inference
  const result = inferProgram(program);

  // Verify the function has the expected type
  const summaries = result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "identity", type: "T -> T" });

  // Verify that the marked program was created
  assertEquals(result.markedProgram.declarations.length, 1);
});
