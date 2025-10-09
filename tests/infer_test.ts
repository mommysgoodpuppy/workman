import { lex } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { inferProgram, InferError } from "../src/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";

function inferTypes(source: string) {
  const tokens = lex(source);
  const program = parse(tokens);
  const result = inferProgram(program);
  return result.summaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) }));
}

Deno.test("infers polymorphic identity function", () => {
  const source = `let id = fn x -> x;`;
  const summaries = inferTypes(source);
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "id", type: "'a -> 'a" });
});

Deno.test("infers constructors and ADT match", () => {
  const source = `
    type Option a = None | Some a;
    let mapOption = fn f -> fn opt -> match opt with
      | Some x -> Some (f x)
      | None -> None;
  `;
  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "mapOption");
  if (!binding) {
    throw new Error("expected mapOption binding");
  }
  assertEquals(binding.type, "('a -> 'b) -> Option<'a> -> Option<'b>");
});

Deno.test("rejects non-exhaustive match", () => {
  const source = `
    type Option a = None | Some a;
    let bad = fn opt -> match opt with
      | Some x -> x;
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Non-exhaustive patterns",
  );
});

Deno.test("supports annotated let bindings", () => {
  const source = `
    let id : Int -> Int = fn x -> x;
    let three = id 3;
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
    type Pair a b = Pair a b;
    let fst = fn pair -> match pair with
      | Pair x _ -> x;
  `;
  const summaries = inferTypes(source);
  const binding = summaries.find((entry) => entry.name === "fst");
  if (!binding) {
    throw new Error("expected fst binding");
  }
  assertEquals(binding.type, "Pair<'a, 'b> -> 'a");
});

Deno.test("rejects duplicate pattern bindings", () => {
  const source = `
    type Pair a b = Pair a b;
    let bad = fn pair -> match pair with
      | Pair x x -> x;
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
    "Duplicate variable",
  );
});

Deno.test("rejects annotation mismatches", () => {
  const source = `
    let tricky : Int -> Bool = fn x -> x;
  `;
  assertThrows(
    () => inferTypes(source),
    InferError,
  );
});

Deno.test("supports list prelude constructors", () => {
  const source = `
    let singleton = Cons 1 Nil;
    let two = Cons true Nil;
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
    type Option a = None | Some a;
    let toBoolean = match with
      | Some _ -> true
      | None -> false;
    let value = toBoolean (Some 42);
  `;
  const summaries = inferTypes(source);
  const convert = summaries.find((entry) => entry.name === "toBoolean");
  const value = summaries.find((entry) => entry.name === "value");
  if (!convert || !value) {
    throw new Error("expected toBoolean and value bindings");
  }
  assertEquals(convert.type, "Option<'a> -> Bool");
  assertEquals(value.type, "Bool");
});
