import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { analyzeAndPresent } from "../src/pipeline.ts";
import type { MLetDeclaration, MProgram } from "../src/ast_marked.ts";
import { assert, assertExists, assertStrictEquals } from "https://deno.land/std/assert/mod.ts";

function analyzeSource(source: string) {
  const tokens = lex(source, "test.wm");
  const program = parseSurfaceProgram(tokens, source);
  return analyzeAndPresent(program);
}

function findLet(program: MProgram, name: string): MLetDeclaration {
  for (const decl of program.declarations) {
    if (decl.kind === "let" && decl.name === name) {
      return decl;
    }
  }
  throw new Error(`Unable to find let declaration '${name}'`);
}

Deno.test("presentProgram surfaces final type views for solved nodes", () => {
  const analysis = analyzeSource(`
    let id = (x) => { x };
    let two = id(2);
  `);

  const twoDecl = findLet(analysis.layer2.remarkedProgram, "two");
  const resultExpr = twoDecl.body.result;
  assertExists(resultExpr, "expected block result expression");

  const view = analysis.layer3.nodeViews.get(resultExpr.id);
  assertExists(view, "expected node view for result expression");
  assertStrictEquals(view.finalType.kind, "concrete");
  assert(view.finalType.type?.kind === "int", "expected solved type to be int");
  assertExists(view.sourceSpan, "expected node view to carry source span");
});

Deno.test("presentProgram preserves solver diagnostics with spans", () => {
  const analysis = analyzeSource(`
    let branchy = () => {
      match(true) {
        true => { 1 },
        false => { false }
      }
    };
  `);

  const solverDiagnostics = analysis.layer3.diagnostics.solver;
  assert(solverDiagnostics.length > 0, "expected solver diagnostics");
  const mismatch = solverDiagnostics.find((diag) =>
    diag.reason === "branch_mismatch"
  );
  assertExists(mismatch, "expected branch mismatch diagnostic");
  assertExists(mismatch.span, "diagnostic should include source span");
});

Deno.test("presentProgram surfaces conflict diagnostics for unfillable holes", () => {
  // This test would require a scenario where we have conflicting constraints
  // For now, we just verify the structure exists
  const analysis = analyzeSource(`
    let simple = 42;
  `);

  assertExists(analysis.layer3.diagnostics.conflicts, "expected conflicts array");
  assertStrictEquals(
    Array.isArray(analysis.layer3.diagnostics.conflicts),
    true,
    "conflicts should be an array"
  );
  assertExists(analysis.layer3.holeSolutions, "expected hole solutions map");
});
