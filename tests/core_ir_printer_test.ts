import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import {
  type CoreExpr,
  type CoreModule,
  type CoreModuleGraph,
  type CoreValueBinding,
  formatCoreExpr,
  formatCoreGraph,
  formatCoreModule,
} from "../backends/compiler/ir/core.ts";
import type { Type } from "../src/types.ts";

const INT: Type = { kind: "int" };
const BOOL: Type = { kind: "bool" };

function literalInt(value: number): CoreExpr {
  return {
    kind: "literal",
    literal: { kind: "int", value },
    type: INT,
  };
}

function varExpr(name: string, type: Type): CoreExpr {
  return {
    kind: "var",
    name,
    type,
  };
}

Deno.test("formatCoreExpr renders nested constructs with types", () => {
  const expr: CoreExpr = {
    kind: "let",
    type: INT,
    binding: {
      name: "total",
      isRecursive: false,
      value: literalInt(41),
    },
    body: {
      kind: "prim",
      op: "int_add",
      args: [
        varExpr("total", INT),
        {
          kind: "prim",
          op: "int_mul",
          args: [literalInt(2), literalInt(3)],
          type: INT,
        },
      ],
      type: INT,
    },
  };

  const rendered = formatCoreExpr(expr);
  assertEquals(
    rendered,
    [
      "let total : Int",
      "  literal 41 : Int",
      "in : Int",
      "  prim int_add : Int",
      "    var total : Int",
      "    prim int_mul : Int",
      "      literal 2 : Int",
      "      literal 3 : Int",
    ].join("\n"),
  );
});

Deno.test("formatCoreModule renders module metadata and declarations", () => {
  const mainValue: CoreValueBinding = {
    name: "main",
    exported: true,
    value: {
      kind: "lambda",
      params: ["flag"],
      body: {
        kind: "if",
        condition: varExpr("flag", BOOL),
        thenBranch: literalInt(1),
        elseBranch: literalInt(0),
        type: INT,
      },
      type: {
        kind: "func",
        from: BOOL,
        to: INT,
      },
    },
  };

  const module: CoreModule = {
    path: "/app/main.wm",
    imports: [
      {
        source: "./option.wm",
        specifiers: [
          { kind: "value", imported: "Option", local: "Option" },
          { kind: "value", imported: "Some", local: "importSome" },
        ],
      },
    ],
    typeDeclarations: [
      {
        name: "Option",
        constructors: [
          { name: "None", arity: 0, exported: true },
          { name: "Some", arity: 1, exported: true },
        ],
        exported: true,
      },
    ],
    values: [mainValue],
    exports: [
      { kind: "value", local: "main", exported: "main" },
      { kind: "constructor", typeName: "Option", ctor: "Some", exported: "Some" },
    ],
  };

  const rendered = formatCoreModule(module);
  assertEquals(
    rendered,
    [
      "module /app/main.wm",
      "  imports:",
      "    from ./option.wm import { Option, Some as importSome }",
      "  types:",
      "    Option (exported): None (exported), Some/1 (exported)",
      "  values:",
      "    main (exported) =",
      "      lambda (flag) : (Bool -> Int) {",
      "        if : Int",
      "          cond:",
      "            var flag : Bool",
      "          then:",
      "            literal 1 : Int",
      "          else:",
      "            literal 0 : Int",
      "      }",
      "  exports:",
      "    main",
      "    Option.Some as Some",
    ].join("\n"),
  );
});

Deno.test("formatCoreGraph renders module ordering and boundaries", () => {
  const module: CoreModule = {
    path: "/app/main.wm",
    imports: [],
    typeDeclarations: [],
    values: [
      {
        name: "value",
        exported: false,
        value: literalInt(5),
      },
    ],
    exports: [],
  };

  const graph: CoreModuleGraph = {
    entry: "/app/main.wm",
    order: ["/app/main.wm"],
    modules: new Map([[module.path, module]]),
  };

  const rendered = formatCoreGraph(graph);
  assertEquals(
    rendered,
    [
      "entry: /app/main.wm",
      "order: /app/main.wm",
      "----------------------------------------",
      "module /app/main.wm",
      "  values:",
      "    value =",
      "      literal 5 : Int",
      "----------------------------------------",
    ].join("\n"),
  );
});
