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
        case Some(x) => Some(f(x)),
        case None => None
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
        case Some(x) => x
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
        case Pair(x, _) => x
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

Deno.test("rejects duplicate pattern bindings", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let bad = (pair) => {
      match(pair) {
        case Pair(x, x) => x
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
          case Some(_) => true,
          case None => false
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
