import type { NodeId } from "../src/ast.ts";
import type { MLetDeclaration, MProgram } from "../src/ast_marked.ts";
import {
  solveConstraints,
  type ConstraintDiagnosticReason,
  type SolveInput,
} from "../src/layer2/mod.ts";
import type { Type } from "../src/types.ts";
import type { ConstraintStub, UnknownInfo, HoleId } from "../src/layer1/context.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { assert, assertStrictEquals } from "https://deno.land/std/assert/mod.ts";

const EMPTY_PROGRAM: MProgram = {
  imports: [],
  reexports: [],
  declarations: [],
};

function mkUnknownInfo(id: HoleId): UnknownInfo {
  return {
    id,
    provenance: { kind: "expr_hole", id },
    category: "local_conflict",
    relatedNodes: [],
    origin: { kind: "expr", nodeId: id, span: { start: 0, end: 0 } },
  };
}

function collectReasons(reasons: ConstraintDiagnosticReason[], expected: ConstraintDiagnosticReason): void {
  assertStrictEquals(
    reasons.includes(expected),
    true,
    `expected diagnostics to include ${expected}, got ${JSON.stringify(reasons)}`,
  );
}

const TEST_PRELUDE_SOURCE = `
  type List<T> = Nil | Cons<T, List<T>>;
  type Ordering = LT | EQ | GT;
`;

function analyzeSource(source: string) {
  const tokens = lex(`${TEST_PRELUDE_SOURCE}\n${source}`);
  const program = parseSurfaceProgram(tokens);
  return analyzeProgram(program);
}

function findLetDeclaration(program: MProgram, name: string): MLetDeclaration | undefined {
  for (const decl of program.declarations) {
    if (decl.kind === "let" && decl.name === name) {
      return decl;
    }
  }
  return undefined;
}

Deno.test("solver surfaces not_function diagnostic when call callee is non-function", () => {
  const stubs: ConstraintStub[] = [
    { kind: "call", origin: 1, callee: 2, argument: 3, result: 4, index: 0 },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [2, { kind: "int" }],
    [3, { kind: "int" }],
    [4, { kind: "int" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
  };

  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "not_function");
});

Deno.test("solver detects branch mismatch diagnostics", () => {
  const stubs: ConstraintStub[] = [
    {
      kind: "branch_join",
      origin: 10,
      scrutinee: null,
      branches: [11, 12],
    },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [10, { kind: "var", id: 0 }],
    [11, { kind: "int" }],
    [12, { kind: "bool" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
  };

  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "branch_mismatch");
});

Deno.test("solver resolves unknown hole via annotation constraint", () => {
  const holeId: HoleId = 20;
  const stubs: ConstraintStub[] = [
    {
      kind: "annotation",
      origin: 21,
      annotation: 22,
      value: holeId,
      subject: null,
    },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [holeId, { kind: "var", id: 0 }],
    [22, { kind: "int" }],
  ]);
  const holes = new Map([[holeId, mkUnknownInfo(holeId)]]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes,
    nodeTypeById,
  };

  const result = solveConstraints(input);
  const holeSolution = result.solutions.get(holeId);
  assertStrictEquals(holeSolution?.state, "solved");
  assertStrictEquals(holeSolution?.type?.kind, "int");
});

Deno.test("analyzeProgram surfaces branch mismatch diagnostic", () => {
  const analysis = analyzeSource(`
    let branchy = () => {
      match(true) {
        true => { 1 },
        false => { false }
      }
    };
  `);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "branch_mismatch");
});

Deno.test("solver remarking resolves call result types", () => {
  const analysis = analyzeSource(`
    let id = (x) => { x };
    let two = id(2);
  `);
  const resolvedProgram = analysis.layer2.remarkedProgram;
  const layer2Two = findLetDeclaration(resolvedProgram, "two");
  assert(layer2Two, "expected `two` declaration after solving");
  const resultExpr = layer2Two.body.result;
  assert(resultExpr, "expected block result for `two`");
  assertStrictEquals(resultExpr.type.kind, "int");

  const resolvedType = analysis.layer2.resolvedNodeTypes.get(resultExpr.id);
  assert(
    resolvedType && resolvedType.kind === "int",
    "expected resolved node type to be Int",
  );
});
