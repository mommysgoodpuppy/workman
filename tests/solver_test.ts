import type { NodeId } from "../src/ast.ts";
import type { MLetDeclaration, MProgram } from "../src/ast_marked.ts";
import {
  type ConstraintDiagnosticReason,
  solveConstraints,
  type SolveInput,
} from "../src/layer2/mod.ts";
import type { Type } from "../src/types.ts";
import { unknownType } from "../src/types.ts";
import type {
  ConstraintStub,
  HoleId,
  UnknownInfo,
} from "../src/layer1/context.ts";
import { analyzeProgram } from "../src/pipeline.ts";
import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import {
  assert,
  assertStrictEquals,
} from "https://deno.land/std/assert/mod.ts";
import { freshPreludeTypeEnv } from "./test_prelude.ts";

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

function collectReasons(
  reasons: ConstraintDiagnosticReason[],
  expected: ConstraintDiagnosticReason,
): void {
  assertStrictEquals(
    reasons.includes(expected),
    true,
    `expected diagnostics to include ${expected}, got ${
      JSON.stringify(reasons)
    }`,
  );
}

function analyzeSource(source: string) {
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
  return analyzeProgram(program, {
    initialEnv,
    initialAdtEnv,
    registerPrelude: false,
  });
}

function findLetDeclaration(
  program: MProgram,
  name: string,
): MLetDeclaration | undefined {
  for (const decl of program.declarations) {
    if (decl.kind === "let" && decl.name === name) {
      return decl;
    }
  }
  return undefined;
}

Deno.test("solver surfaces not_function diagnostic when call callee is non-function", () => {
  const stubs: ConstraintStub[] = [
    {
      kind: "call",
      origin: 1,
      callee: 2,
      argument: 3,
      result: 4,
      resultType: { kind: "int" },
      index: 0,
    },
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
    layer1Diagnostics: [],
    summaries: [],
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
    layer1Diagnostics: [],
    summaries: [],
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
    layer1Diagnostics: [],
    summaries: [],
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

Deno.test("analyzeProgram surfaces not_function diagnostic for non-callable callee", () => {
  const analysis = analyzeSource(`
    let notFunction = 42;
    let callNonFunction = notFunction(true);
  `);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "not_function");
});

Deno.test("analyzeProgram surfaces not_boolean diagnostic for boolean operators", () => {
  const analysis = analyzeSource(`
    let boolAnd = (lhs, rhs) => { rhs };
    infixl 3 && = boolAnd;
    let booleanMismatch = true && 0;
  `);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "not_boolean");
});

Deno.test("analyzeProgram surfaces duplicate_record_field diagnostic", () => {
  const analysis = analyzeSource(`
    let dup = {
      foo: 1,
      foo: 2,
    };
  `);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "duplicate_record_field");
});

Deno.test("solver surfaces missing_field diagnostic when record lacks requested field", () => {
  const targetId: NodeId = 210;
  const resultId: NodeId = 211;
  const stubs: ConstraintStub[] = [
    {
      kind: "has_field",
      origin: 212,
      target: targetId,
      field: "bar",
      result: resultId,
    },
  ];
  const nodeTypeById = new Map<NodeId, Type>([
    [
      targetId,
      {
        kind: "record",
        fields: new Map<string, Type>([["foo", { kind: "int" }]]),
      },
    ],
    [resultId, { kind: "int" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "missing_field");
});

Deno.test("solver surfaces not_record diagnostic when projecting field from non-record", () => {
  const targetId: NodeId = 220;
  const resultId: NodeId = 221;
  const stubs: ConstraintStub[] = [
    {
      kind: "has_field",
      origin: 222,
      target: targetId,
      field: "foo",
      result: resultId,
    },
  ];
  const nodeTypeById = new Map<NodeId, Type>([
    [targetId, { kind: "int" }],
    [resultId, { kind: "int" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "not_record");
});

Deno.test("solver surfaces occurs_cycle diagnostic for recursive annotation", () => {
  const annotationId: NodeId = 230;
  const valueId: NodeId = 231;
  const stubs: ConstraintStub[] = [
    {
      kind: "annotation",
      origin: 232,
      annotation: annotationId,
      value: valueId,
      subject: null,
    },
  ];
  const cycleVar: Type = { kind: "var", id: 42 };
  const nodeTypeById = new Map<NodeId, Type>([
    [annotationId, cycleVar],
    [
      valueId,
      {
        kind: "func",
        from: { kind: "var", id: 42 },
        to: { kind: "int" },
      },
    ],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "occurs_cycle");
});

Deno.test("solver surfaces type_mismatch diagnostic when annotation disagrees with value type", () => {
  const annotationId: NodeId = 240;
  const valueId: NodeId = 241;
  const stubs: ConstraintStub[] = [
    {
      kind: "annotation",
      origin: 242,
      annotation: annotationId,
      value: valueId,
      subject: null,
    },
  ];
  const nodeTypeById = new Map<NodeId, Type>([
    [annotationId, { kind: "int" }],
    [valueId, { kind: "bool" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "type_mismatch");
});

Deno.test("solver surfaces arity_mismatch diagnostic when constructor arity conflicts", () => {
  const annotationId: NodeId = 250;
  const valueId: NodeId = 251;
  const stubs: ConstraintStub[] = [
    {
      kind: "annotation",
      origin: 252,
      annotation: annotationId,
      value: valueId,
      subject: null,
    },
  ];
  const nodeTypeById = new Map<NodeId, Type>([
    [
      annotationId,
      {
        kind: "constructor",
        name: "Option",
        args: [{ kind: "int" }],
      },
    ],
    [
      valueId,
      {
        kind: "constructor",
        name: "Option",
        args: [{ kind: "int" }, { kind: "bool" }],
      },
    ],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "arity_mismatch");
});

Deno.test("solver surfaces not_numeric diagnostic when numeric operands are non-numeric", () => {
  const leftId: NodeId = 260;
  const rightId: NodeId = 261;
  const resultId: NodeId = 262;
  const stubs: ConstraintStub[] = [
    {
      kind: "numeric",
      origin: 263,
      operator: "+",
      operands: [leftId, rightId],
      result: resultId,
    },
  ];
  const nodeTypeById = new Map<NodeId, Type>([
    [leftId, { kind: "bool" }],
    [rightId, { kind: "int" }],
    [resultId, { kind: "int" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map(),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const reasons = result.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "not_numeric");
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

Deno.test("analyzeProgram forwards layer1 diagnostics into solver result", () => {
  const analysis = analyzeSource(`
    let usesFreeVar = () => { missingName };
  `);
  const reasons = analysis.layer2.diagnostics.map((diag) => diag.reason);
  collectReasons(reasons, "free_variable");
});

Deno.test("analyzeProgram does not report numeric/boolean errors for equality checks", () => {
  const analysis = analyzeSource(`
    let isEqual = 5 == 5;
  `);
  assertStrictEquals(
    analysis.layer2.diagnostics.length,
    0,
    `expected no diagnostics, got ${
      JSON.stringify(analysis.layer2.diagnostics)
    }`,
  );
});

Deno.test("solver detects conflicts when unknown has incompatible constraints", () => {
  const holeId: HoleId = 100;
  const stubs: ConstraintStub[] = [
    {
      kind: "annotation",
      origin: 1,
      annotation: 2,
      value: holeId,
      subject: null,
    },
    {
      kind: "annotation",
      origin: 3,
      annotation: 4,
      value: holeId,
      subject: null,
    },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [holeId, unknownType({ kind: "expr_hole", id: holeId })],
    [2, { kind: "int" }],
    [4, { kind: "bool" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map([[holeId, mkUnknownInfo(holeId)]]),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  assertStrictEquals(result.conflicts.length, 1, "expected one conflict");
  assertStrictEquals(result.conflicts[0].holeId, holeId);
  assertStrictEquals(result.conflicts[0].reason, "type_mismatch");
  assertStrictEquals(result.conflicts[0].types.length, 2);
});

Deno.test("solver builds partial solution when constraints are compatible", () => {
  const holeId: HoleId = 200;
  const stubs: ConstraintStub[] = [
    {
      kind: "numeric",
      origin: 1,
      operator: "+",
      operands: [holeId, 3],
      result: 4,
    },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [holeId, unknownType({ kind: "expr_hole", id: holeId })],
    [3, { kind: "int" }],
    [4, { kind: "int" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map([[holeId, mkUnknownInfo(holeId)]]),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const solution = result.solutions.get(holeId);
  assert(solution, "expected solution for hole");
  assertStrictEquals(solution.state, "partial", "expected partial solution");
  assert(solution.partial, "expected partial type info");
  assertStrictEquals(solution.partial.known?.kind, "int");
});

Deno.test("solver marks hole as conflicted when solution state is conflicted", () => {
  const holeId: HoleId = 300;
  const stubs: ConstraintStub[] = [
    {
      kind: "numeric",
      origin: 1,
      operator: "+",
      operands: [holeId, 2],
      result: 3,
    },
    {
      kind: "boolean",
      origin: 4,
      operator: "&&",
      operands: [holeId, 5],
      result: 6,
    },
  ];
  const nodeTypeById: Map<NodeId, Type> = new Map([
    [holeId, unknownType({ kind: "expr_hole", id: holeId })],
    [2, { kind: "int" }],
    [3, { kind: "int" }],
    [5, { kind: "bool" }],
    [6, { kind: "bool" }],
  ]);

  const input: SolveInput = {
    markedProgram: EMPTY_PROGRAM,
    constraintStubs: stubs,
    holes: new Map([[holeId, mkUnknownInfo(holeId)]]),
    nodeTypeById,
    layer1Diagnostics: [],
    summaries: [],
  };
  const result = solveConstraints(input);
  const solution = result.solutions.get(holeId);
  assert(solution, "expected solution for hole");
  assertStrictEquals(solution.state, "conflicted", "expected conflicted state");
  assert(
    solution.conflicts && solution.conflicts.length > 0,
    "expected conflicts",
  );
});
