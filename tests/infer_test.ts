import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram, type InferResult } from "../src/layer1/infer.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { lowerTupleParameters } from "../src/lower_tuple_params.ts";
import { formatScheme } from "../src/type_printer.ts";
import type { NodeId, Program } from "../src/ast.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std/assert/mod.ts";
import { assert } from "https://deno.land/std/assert/mod.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

type PreludeContext = ReturnType<typeof freshPreludeTypeEnv>;

function parseProgramWithPrelude(source: string): {
  program: Program;
  context: PreludeContext;
} {
  const context = freshPreludeTypeEnv();
  const tokens = lex(source);
  const program = parseSurfaceProgram(
    tokens,
    source,
    false,
    context.initialOperators,
    context.initialPrefixOperators,
  );
  return { program, context };
}

function inferProgramWithPrelude(
  program: Program,
  context?: PreludeContext,
): InferResult {
  const ctx = context ?? freshPreludeTypeEnv();
  return inferProgram(program, {
    initialEnv: ctx.initialEnv,
    initialAdtEnv: ctx.initialAdtEnv,
    registerPrelude: false,
  });
}

function inferTypes(source: string) {
  const { program, context } = parseProgramWithPrelude(source);
  return inferProgramWithPrelude(program, context);
}

function analyzeSource(source: string) {
  const { program, context } = parseProgramWithPrelude(source);
  return analyzeProgram(program, {
    initialEnv: context.initialEnv,
    initialAdtEnv: context.initialAdtEnv,
    registerPrelude: false,
  });
}

function collectNodeIds(program: any): NodeId[] {
  const ids: NodeId[] = [];
  const seen = new Set<NodeId>();

  function visit(node: any): void {
    if (node && typeof node === "object" && "id" in node) {
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
        } else if (value && typeof value === "object") {
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const binding = summaries.find((entry) => entry.name === "mapOption");
  if (!binding) {
    throw new Error("expected mapOption binding");
  }
  assertEquals(binding.type, "(T -> U) -> Option<T> -> Option<U>");
});

Deno.test("arrow return annotation constrains inferred type", () => {
  const source = `
    type Direction = L | R;
    record Operation { direction: Direction, distance: Int };

    let produce = (dir: Direction): Operation => {
      { direction: dir, distance: 0 }
    };
  `;
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const binding = summaries.find((entry) => entry.name === "produce");
  assertExists(binding);
  assertEquals(
    binding?.type,
    "Direction -> { direction: Direction, distance: Int }",
  );
});

Deno.test("arrow return annotation mismatch reports error", () => {
  const source = `
    let bad = (flag: Bool): Int => {
      true
    };
  `;
  const analysis = analyzeSource(source);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assert(
    reasons.includes("type_mismatch"),
    `expected type_mismatch, got ${JSON.stringify(reasons)}`,
  );
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
  const analysis = analyzeSource(source);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assert(
    reasons.includes("non_exhaustive_match"),
    `expected non_exhaustive_match diagnostic, got ${JSON.stringify(reasons)}`,
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const idBinding = summaries.find((entry) => entry.name === "id");
  const threeBinding = summaries.find((entry) => entry.name === "three");
  if (!idBinding || !threeBinding) {
    throw new Error("expected id and three bindings");
  }
  assertEquals(idBinding.type, "Int -> Int");
  assertEquals(threeBinding.type, "Unit -> Int");
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const dup = summaries.find((entry) => entry.name === "dup");
  if (!dup) {
    throw new Error("expected dup binding");
  }
  assertEquals(dup.type, "T -> (T, T)");
  const use = summaries.find((entry) => entry.name === "use");
  if (!use) {
    throw new Error("expected use binding");
  }
  assertEquals(use.type, "Unit -> ((Int, Int), (Bool, Bool))");
});

Deno.test("block let generalization allows multiple instantiations", () => {
  const source = `
    let useId = () => {
      let id = (x) => { x };
      (id(1), id(true))
    };
  `;
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const binding = summaries.find((entry) => entry.name === "useId");
  if (!binding) {
    throw new Error("expected useId binding");
  }
  assertEquals(binding.type, "Unit -> (Int, Bool)");
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
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
  // Should not throw, but produce unknown types or marks
  const result = inferTypes(source);
  const marks = Array.from(result.marks.values());
  const occurs = marks.find((mark) => mark.kind === "mark_occurs_check");
  assertExists(occurs);
  if (occurs?.kind !== "mark_occurs_check") {
    throw new Error("expected mark_occurs_check");
  }
  assertEquals(occurs.subject.kind, "identifier");
  assertEquals(
    occurs.subject.kind === "identifier" ? occurs.subject.name : undefined,
    "loop",
  );
  assertEquals(occurs.left.kind, "var");
  assertEquals(occurs.right.kind, "func");
});

Deno.test("constructor arity mismatch fails", () => {
  const source = `
    type Pair<A, B> = Pair<A, B>;
    let bad = () => {
      Pair(1)
    };
  `;
  const result = inferTypes(source);

  const marks = Array.from(result.marks.values());
  const notFunctionMark = marks.find((mark) =>
    mark.kind === "mark_not_function"
  );
  assertExists(notFunctionMark);
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
  const result = inferTypes(source);

  // Find mark_pattern in the marked program
  function findMarkPattern(node: any): any {
    if (node && typeof node === "object") {
      if (
        node.kind === "mark_pattern" &&
        node.data?.issue === "duplicate_variable"
      ) {
        return node;
      }
      for (const key in node) {
        const found = findMarkPattern(node[key]);
        if (found) return found;
      }
    }
    return null;
  }

  const mark = findMarkPattern(result.markedProgram);
  assertExists(mark);
  assertEquals(mark.data.name, "x");
});

Deno.test("rejects annotation mismatches", () => {
  const source = `
    let tricky: Bool = (x: Int) => {
      x
    };
  `;
  // Should not throw
  const result = inferTypes(source);
  const marks = Array.from(result.marks.values());
  const inconsistent = marks.find((mark) => mark.kind === "mark_inconsistent");
  assertExists(inconsistent);
  if (inconsistent?.kind !== "mark_inconsistent") {
    throw new Error("expected mark_inconsistent");
  }
  assertEquals(inconsistent.subject.kind, "identifier");
  assertEquals(
    inconsistent.subject.kind === "identifier"
      ? inconsistent.subject.name
      : undefined,
    "x",
  );
  assertEquals(inconsistent.expected.kind, "bool");
  assertEquals(inconsistent.actual.kind, "func");
});

Deno.test("supports list prelude constructors", () => {
  const source = `
    let singleton = () => {
      Link(1, Empty)
    };
    let two = () => {
      Link(true, Empty)
    };
  `;
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const singleton = summaries.find((entry) => entry.name === "singleton");
  const two = summaries.find((entry) => entry.name === "two");
  if (!singleton || !two) {
    throw new Error("expected singleton and two bindings");
  }
  assertEquals(singleton.type, "Unit -> List<Int>");
  assertEquals(two.type, "Unit -> List<Bool>");
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
  const result = inferTypes(source);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  const convert = summaries.find((entry) => entry.name === "toBoolean");
  const value = summaries.find((entry) => entry.name === "value");
  if (!convert || !value) {
    throw new Error("expected toBoolean and value bindings");
  }
  assertEquals(convert.type, "Unit -> Option<T> -> Bool");
  assertEquals(value.type, "Unit -> Bool");
});

Deno.test("type constructor name collisions produce invalid member mark", () => {
  const source = `
type Dup = First | First;
`;
  const { program, context } = parseProgramWithPrelude(source);
  const result = inferProgramWithPrelude(program, context);

  const marks = result.markedProgram.declarations.filter((decl) =>
    decl.kind === "mark_type_decl_invalid_member"
  );
  assertEquals(marks.length, 1);
  const mark = marks[0];
  if (mark.kind !== "mark_type_decl_invalid_member") {
    throw new Error("expected mark_type_decl_invalid_member");
  }
  assertEquals(mark.declaration.name, "Dup");
  assertEquals(mark.member.kind, "constructor");
  if (mark.member.kind === "constructor") {
    assertEquals(mark.member.name, "First");
  }
});

Deno.test("let annotation arity errors surface mark_type_expr_arity", () => {
  const source = `
let bad: Int<Int> = () => {
  0
};
`;
  const { program, context } = parseProgramWithPrelude(source);
  const result = inferProgramWithPrelude(program, context);

  const letDecl = result.markedProgram.declarations.find((decl) =>
    decl.kind === "let"
  );
  assertExists(letDecl);
  if (letDecl?.kind !== "let") {
    throw new Error("expected let declaration");
  }

  assertExists(letDecl.annotation);
  if (!letDecl.annotation) {
    throw new Error("expected annotation");
  }
  assertEquals(letDecl.annotation.kind, "mark_type_expr_arity");
});

Deno.test("infer handles duplicate type declarations with mark", () => {
  const source = `
type MyType = First;
type MyType = Second;
`;
  const { program, context } = parseProgramWithPrelude(source);
  const result = inferProgramWithPrelude(program, context);

  assertEquals(result.markedProgram.declarations.length, 2);
  const mark = result.markedProgram.declarations.find((decl) =>
    decl.kind === "mark_type_decl_duplicate"
  );
  assertExists(mark);
  if (mark?.kind !== "mark_type_decl_duplicate") {
    throw new Error("expected mark_type_decl_duplicate");
  }
  assertEquals(mark.declaration.name, "MyType");
  assertEquals(mark.duplicate.name, "MyType");
});

Deno.test("lowering preserves and allocates node IDs correctly", () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
    };
  `;
  const { program, context } = parseProgramWithPrelude(source);

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
    assertEquals(
      idsAfter.includes(originalId),
      true,
      `Original ID ${originalId} should be preserved ${idsAfter}`,
    );
  }

  // New IDs should be strictly increasing and greater than existing ones
  const maxOriginalId = Math.max(...idsBefore);
  const newIds = idsAfter.filter((id) => !idsBefore.includes(id));
  for (const newId of newIds) {
    assertEquals(
      newId > maxOriginalId,
      true,
      `New ID ${newId} should be greater than max original ID ${maxOriginalId}`,
    );
  }

  // Verify the function still has the expected type
  const result = inferProgramWithPrelude(program, context);
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "swap", type: "(T, U) -> (U, T)" });
});

Deno.test("inference completes successfully with ID-annotated AST", () => {
  const source = `
    let identity = (x) => {
      x
    };
  `;
  const { program, context } = parseProgramWithPrelude(source);

  // Run inference
  const result = inferProgramWithPrelude(program, context);

  // Verify the function has the expected type
  const summaries = result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0], { name: "identity", type: "T -> T" });

  // Verify that the marked program was created
  assertEquals(result.markedProgram.declarations.length, 1);
});
