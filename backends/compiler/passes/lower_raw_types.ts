import type {
  CoreCarrierMatchExpr,
  CoreExpr,
  CoreMatchCase,
  CoreModule,
  CoreModuleGraph,
  CorePattern,
} from "../ir/core.ts";
import type { Type } from "../../../src/types.ts";
import { createEffectRow } from "../../../src/types.ts";

const RAW_PTR_TYPES = new Set<string>(["Ptr", "ManyPtr"]);

export function lowerRawTypesGraph(graph: CoreModuleGraph): CoreModuleGraph {
  const modules = new Map<string, CoreModule>();
  for (const [path, module] of graph.modules.entries()) {
    modules.set(path, lowerRawTypesModule(module));
  }
  return { ...graph, modules };
}

export function lowerRawTypesModule(module: CoreModule): CoreModule {
  if (module.mode !== "raw") {
    return module;
  }
  const values = module.values.map((binding) => ({
    ...binding,
    value: lowerExpr(binding.value),
  }));
  return { ...module, values };
}

function lowerExpr(expr: CoreExpr): CoreExpr {
  const type = lowerRawType(expr.type);
  switch (expr.kind) {
    case "literal":
    case "var":
    case "enum_literal":
      return { ...expr, type };
    case "tuple":
      return {
        ...expr,
        type,
        elements: expr.elements.map((el) => lowerExpr(el)),
      };
    case "record":
      return {
        ...expr,
        type,
        fields: expr.fields.map((field) => ({
          ...field,
          value: lowerExpr(field.value),
        })),
      };
    case "tuple_get":
      return {
        ...expr,
        type,
        target: lowerExpr(expr.target),
      };
    case "data":
      return {
        ...expr,
        type,
        fields: expr.fields.map((field) => lowerExpr(field)),
      };
    case "lambda":
      return {
        ...expr,
        type,
        body: lowerExpr(expr.body),
      };
    case "call":
      return {
        ...expr,
        type,
        callee: lowerExpr(expr.callee),
        args: expr.args.map((arg) => lowerExpr(arg)),
      };
    case "let":
      return {
        ...expr,
        type,
        binding: {
          ...expr.binding,
          value: lowerExpr(expr.binding.value),
        },
        body: lowerExpr(expr.body),
      };
    case "let_rec":
      return {
        ...expr,
        type,
        bindings: expr.bindings.map((binding) => ({
          ...binding,
          value: lowerExpr(binding.value) as CoreExpr & { kind: "lambda" },
        })),
        body: lowerExpr(expr.body),
      };
    case "if":
      return {
        ...expr,
        type,
        condition: lowerExpr(expr.condition),
        thenBranch: lowerExpr(expr.thenBranch),
        elseBranch: lowerExpr(expr.elseBranch),
      };
    case "prim":
      return {
        ...expr,
        type,
        args: expr.args.map((arg) => lowerExpr(arg)),
      };
    case "match":
      return {
        ...expr,
        type,
        scrutinee: lowerExpr(expr.scrutinee),
        cases: expr.cases.map((kase) => lowerMatchCase(kase)),
        fallback: expr.fallback ? lowerExpr(expr.fallback) : undefined,
      };
    case "carrier_unwrap":
    case "carrier_wrap":
      return {
        ...expr,
        type,
        target: lowerExpr(expr.target),
      };
    case "coerce":
      return {
        ...expr,
        type,
        fromType: lowerRawType(expr.fromType),
        toType: lowerRawType(expr.toType),
        expr: lowerExpr(expr.expr),
      };
    case "carrier_match": {
      const lowered: CoreCarrierMatchExpr = {
        ...expr,
        type,
        scrutinee: lowerExpr(expr.scrutinee),
        cases: expr.cases.map((kase) => lowerMatchCase(kase)),
        fallback: expr.fallback ? lowerExpr(expr.fallback) : undefined,
      };
      return lowered;
    }
  }
}

function lowerMatchCase(kase: CoreMatchCase): CoreMatchCase {
  return {
    ...kase,
    pattern: lowerPattern(kase.pattern),
    body: lowerExpr(kase.body),
    guard: kase.guard ? lowerExpr(kase.guard) : undefined,
  };
}

function lowerPattern(pattern: CorePattern): CorePattern {
  const type = lowerRawType(pattern.type);
  switch (pattern.kind) {
    case "binding":
    case "literal":
    case "wildcard":
    case "pinned":
    case "all_errors":
      return { ...pattern, type };
    case "tuple":
      return {
        ...pattern,
        type,
        elements: pattern.elements.map((el) => lowerPattern(el)),
      };
    case "constructor":
      return {
        ...pattern,
        type,
        fields: pattern.fields.map((field) => lowerPattern(field)),
      };
  }
}

function lowerRawType(type: Type): Type {
  switch (type.kind) {
    case "var":
    case "int":
    case "bool":
    case "char":
    case "string":
    case "unit":
      return type;
    case "func":
      return {
        kind: "func",
        from: lowerRawType(type.from),
        to: lowerRawType(type.to),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((el) => lowerRawType(el)),
      };
    case "array":
      return {
        kind: "array",
        length: type.length,
        element: lowerRawType(type.element),
      };
    case "record": {
      const fields = new Map<string, Type>();
      for (const [name, fieldType] of type.fields.entries()) {
        fields.set(name, lowerRawType(fieldType));
      }
      return { kind: "record", fields };
    }
    case "effect_row": {
      const cases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        cases.set(label, payload ? lowerRawType(payload) : null);
      }
      return {
        kind: "effect_row",
        cases,
        tail: type.tail ? lowerRawType(type.tail) : type.tail,
      };
    }
    case "constructor": {
      const loweredArgs = type.args.map((arg) => lowerRawType(arg));
      if (RAW_PTR_TYPES.has(type.name)) {
        const base = loweredArgs[0] ?? type.args[0];
        const state = loweredArgs[1];
        const normalizedState = state && state.kind === "effect_row"
          ? state
          : createEffectRow();
        return {
          kind: "constructor",
          name: type.name,
          args: [base, normalizedState],
        };
      }
      return {
        kind: "constructor",
        name: type.name,
        args: loweredArgs,
      };
    }
  }
}
