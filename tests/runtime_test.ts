import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { nonExhaustiveMatch } from "../backends/compiler/js/runtime.mjs";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1/infer.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import {
  assert,
  assertEquals,
  assertExists,
  fail,
} from "https://deno.land/std/assert/mod.ts";
import { toFileUrl } from "std/path/mod.ts";

async function evaluateSource(source: string) {
  const tmpFile = await Deno.makeTempFile({ suffix: ".wm" });
  try {
    await Deno.writeTextFile(tmpFile, source);
    const { coreGraph, modules } = await compileWorkmanGraph(tmpFile);
    const artifact = modules.get(coreGraph.entry);
    if (!artifact) {
      throw new Error("Failed to locate entry module artifact");
    }
    if (
      artifact.analysis.layer2.diagnostics.length > 0 ||
      artifact.analysis.layer3.diagnostics.solver.length > 0 ||
      artifact.analysis.layer3.diagnostics.conflicts.length > 0 ||
      artifact.analysis.layer3.diagnostics.flow.length > 0
    ) {
      throw new Error("Type errors detected when evaluating source");
    }
    const tmpDir = await Deno.makeTempDir({ prefix: "runtime-test-" });
    try {
      const emitResult = await emitModuleGraph(coreGraph, {
        outDir: tmpDir,
        invokeEntrypoint: false,
      });
      const moduleUrl = toFileUrl(emitResult.entryPath).href;
      const moduleExports = await import(moduleUrl) as Record<string, unknown>;
      return { artifact, moduleExports };
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  } finally {
    await Deno.remove(tmpFile);
  }
}

Deno.test("evaluates non-recursive let-binding", async () => {
  const source = `
    let identity = (x) => {
      x
    };
  `;
  const { artifact, moduleExports } = await evaluateSource(source);
  assertEquals(artifact.analysis.layer3.summaries.length, 1);
  assertEquals(typeof moduleExports.identity, "function");
});

Deno.test("supports recursive factorial", async () => {
  const source = `
    let rec fact = (n) => {
      match(n) {
        0 => { 1 },
        _ => { mul(n, fact(sub(n, 1))) }
      }
    };
    let five = {
      fact(5)
    };
  `;
  const { moduleExports } = await evaluateSource(source);
  const five = moduleExports.five;
  assertEquals(typeof five, "number");
  assertEquals(five, 120);
});

Deno.test("throws on constructor arity mismatch", () => {
  const source = `
    type Option<T> = None | Some<T>;
    let fail = {
      Some()
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);
  const notFunction = Array.from(result.marks.values()).find((mark) =>
    mark.kind === "mark_not_function"
  );
  assertExists(
    notFunction,
    "expected mark_not_function for constructor arity mismatch",
  );
});

Deno.test("throws on non-exhaustive runtime match", () => {
  const source = `
    let check = match(b) => {
      true => { false }
    };
  `;
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const analysis = analyzeProgram(program);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  assert(
    reasons.includes("non_exhaustive_match"),
    `expected non_exhaustive_match diagnostic, got ${JSON.stringify(reasons)}`,
  );
});

Deno.test("nonExhaustiveMatch helper includes metadata", () => {
  try {
    nonExhaustiveMatch(
      { tag: "Link", type: "List", _0: 76, _1: { tag: "Empty", type: "List" } },
      { nodeId: 42, patterns: ["L", "R"] },
    );
    fail("nonExhaustiveMatch should throw");
  } catch (error) {
    assert(error instanceof Error, "expected an Error to be thrown");
    assert(
      error.message.includes("nodeId 42"),
      `expected message to mention nodeId 42, got '${error.message}'`,
    );
    const metadata = (error as { workmanMetadata?: unknown }).workmanMetadata as
      | { nodeId?: number; patterns?: string[] }
      | undefined;
    assertExists(metadata, "expected metadata to be attached to the error");
    assertEquals(metadata?.nodeId, 42);
    assertEquals(metadata?.patterns, ["L", "R"]);
  }
});

Deno.test("evaluates tuple parameter destructuring", async () => {
  const source = `
    let swap = ((a, b)) => {
      (b, a)
    };
    let result = {
      swap((1, 2))
    };
  `;
  const { moduleExports } = await evaluateSource(source);
  const value = moduleExports.result;
  if (!Array.isArray(value)) {
    throw new Error("expected tuple array result");
  }
  assertEquals(value[0], 2);
  assertEquals(value[1], 1);
});

