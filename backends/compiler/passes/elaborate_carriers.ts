import type {
  CoreCarrierMatchExpr,
  CoreExpr,
  CoreMatchCase,
  CoreModule,
  CoreModuleGraph,
  CorePattern,
  CorePrimOp,
} from "../ir/core.ts";
import { cloneType, unknownType } from "../../../src/types.ts";

interface ElaborateState {
  counter: number;
  usedNames: Set<string>;
}

interface CarrierContext {
  carriers: Set<string>;
  state: ElaborateState;
}

interface CarrierBinding {
  carrierType: string;
  scrutinee: CoreExpr;
  bindingName: string;
  bindingType: CoreExpr["type"];
}

export function elaborateCarrierOpsGraph(
  graph: CoreModuleGraph,
): CoreModuleGraph {
  const carriers = collectCarrierTypes(graph);
  const modules = new Map<string, CoreModule>();
  for (const [path, module] of graph.modules.entries()) {
    modules.set(
      path,
      elaborateCarrierOpsModule(module, carriers),
    );
  }
  return { ...graph, modules };
}

export function elaborateCarrierOpsModule(
  module: CoreModule,
  carriers: Set<string>,
): CoreModule {
  if (module.mode === "raw") {
    return module;
  }
  const state = createState(module);
  const ctx: CarrierContext = { carriers, state };
  const values = module.values.map((binding) => ({
    ...binding,
    value: elaborateExpr(binding.value, ctx),
  }));
  return { ...module, values };
}

function createState(module: CoreModule): ElaborateState {
  const usedNames = new Set<string>();
  for (const binding of module.values) {
    usedNames.add(binding.name);
    collectBindingNames(binding.value, usedNames);
  }
  return { counter: 0, usedNames };
}

function freshName(ctx: CarrierContext, prefix: string): string {
  let name = `${prefix}${ctx.state.counter++}`;
  while (ctx.state.usedNames.has(name)) {
    name = `${prefix}${ctx.state.counter++}`;
  }
  ctx.state.usedNames.add(name);
  return name;
}

function collectBindingNames(expr: CoreExpr, used: Set<string>): void {
  switch (expr.kind) {
    case "lambda":
      expr.params.forEach((name) => used.add(name));
      collectBindingNames(expr.body, used);
      return;
    case "let":
      used.add(expr.binding.name);
      collectBindingNames(expr.binding.value, used);
      collectBindingNames(expr.body, used);
      return;
    case "let_rec":
      expr.bindings.forEach((binding) => used.add(binding.name));
      expr.bindings.forEach((binding) => collectBindingNames(binding.value, used));
      collectBindingNames(expr.body, used);
      return;
    case "match":
    case "carrier_match":
      collectBindingNames(expr.scrutinee, used);
      expr.cases.forEach((kase) => {
        collectPatternNames(kase.pattern, used);
        collectBindingNames(kase.body, used);
        if (kase.guard) collectBindingNames(kase.guard, used);
      });
      if (expr.fallback) collectBindingNames(expr.fallback, used);
      return;
    case "call":
      collectBindingNames(expr.callee, used);
      expr.args.forEach((arg) => collectBindingNames(arg, used));
      return;
    case "tuple":
      expr.elements.forEach((el) => collectBindingNames(el, used));
      return;
    case "record":
      expr.fields.forEach((field) => collectBindingNames(field.value, used));
      return;
    case "tuple_get":
      collectBindingNames(expr.target, used);
      return;
    case "data":
      expr.fields.forEach((field) => collectBindingNames(field, used));
      return;
    case "if":
      collectBindingNames(expr.condition, used);
      collectBindingNames(expr.thenBranch, used);
      collectBindingNames(expr.elseBranch, used);
      return;
    case "prim":
      expr.args.forEach((arg) => collectBindingNames(arg, used));
      return;
    case "carrier_unwrap":
    case "carrier_wrap":
      collectBindingNames(expr.target, used);
      return;
    case "literal":
    case "var":
    case "enum_literal":
      return;
  }
}

function collectPatternNames(pattern: CorePattern, used: Set<string>): void {
  switch (pattern.kind) {
    case "binding":
      used.add(pattern.name);
      return;
    case "tuple":
      pattern.elements.forEach((el) => collectPatternNames(el, used));
      return;
    case "constructor":
      pattern.fields.forEach((field) => collectPatternNames(field, used));
      return;
    case "wildcard":
    case "literal":
    case "pinned":
    case "all_errors":
      return;
  }
}

function elaborateExpr(expr: CoreExpr, ctx: CarrierContext): CoreExpr {
  switch (expr.kind) {
    case "literal":
    case "var":
    case "enum_literal":
      return expr;
    case "tuple":
      return {
        ...expr,
        elements: expr.elements.map((el) => elaborateExpr(el, ctx)),
      };
    case "record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: elaborateExpr(field.value, ctx),
        })),
      };
    case "tuple_get": {
      const target = elaborateExpr(expr.target, ctx);
      if (!isCarrierType(target.type, ctx.carriers)) {
        return { ...expr, target };
      }
      const binding = freshName(ctx, "__carrier_val_");
      const valueType = getCarrierValueType(target.type);
      const body: CoreExpr = {
        kind: "tuple_get",
        target: makeVar(binding, valueType, expr),
        index: expr.index,
        type: expr.type,
        origin: expr.origin,
        span: expr.span,
      };
      return makeCarrierMatch(
        getCarrierTypeName(target.type),
        target,
        binding,
        valueType,
        body,
        expr,
      );
    }
    case "data":
      return {
        ...expr,
        fields: expr.fields.map((field) => elaborateExpr(field, ctx)),
      };
    case "lambda":
      return {
        ...expr,
        body: elaborateExpr(expr.body, ctx),
      };
    case "call":
      return elaborateCall(expr, ctx);
    case "let":
      return {
        ...expr,
        binding: {
          ...expr.binding,
          value: elaborateExpr(expr.binding.value, ctx),
        },
        body: elaborateExpr(expr.body, ctx),
      };
    case "let_rec":
      return {
        ...expr,
        bindings: expr.bindings.map((binding) => ({
          ...binding,
          value: elaborateExpr(binding.value, ctx) as CoreExpr & {
            kind: "lambda";
          },
        })),
        body: elaborateExpr(expr.body, ctx),
      };
    case "if": {
      const condition = elaborateExpr(expr.condition, ctx);
      const thenBranch = elaborateExpr(expr.thenBranch, ctx);
      const elseBranch = elaborateExpr(expr.elseBranch, ctx);
      if (!isCarrierType(condition.type, ctx.carriers)) {
        return { ...expr, condition, thenBranch, elseBranch };
      }
      const binding = freshName(ctx, "__carrier_cond_");
      const valueType = getCarrierValueType(condition.type);
      const body: CoreExpr = {
        kind: "if",
        condition: makeVar(binding, valueType, expr),
        thenBranch,
        elseBranch,
        type: expr.type,
        origin: expr.origin,
        span: expr.span,
      };
      return makeCarrierMatch(
        getCarrierTypeName(condition.type),
        condition,
        binding,
        valueType,
        body,
        expr,
      );
    }
    case "prim":
      return elaboratePrim(expr.op, expr.args, expr, ctx);
    case "match":
      return elaborateMatch(expr, ctx);
    case "carrier_unwrap":
    case "carrier_wrap":
      return {
        ...expr,
        target: elaborateExpr(expr.target, ctx),
      };
    case "carrier_match":
      return {
        ...expr,
        scrutinee: elaborateExpr(expr.scrutinee, ctx),
        cases: expr.cases.map((kase) => ({
          ...kase,
          body: elaborateExpr(kase.body, ctx),
          guard: kase.guard ? elaborateExpr(kase.guard, ctx) : undefined,
        })),
        fallback: expr.fallback ? elaborateExpr(expr.fallback, ctx) : undefined,
      };
  }
}

function elaborateCall(
  expr: CoreExpr & { kind: "call" },
  ctx: CarrierContext,
): CoreExpr {
  const callee = elaborateExpr(expr.callee, ctx);
  const args = expr.args.map((arg) => elaborateExpr(arg, ctx));
  const calleeParamType = isCarrierType(callee.type, ctx.carriers)
    ? getCarrierValueType(callee.type)
    : callee.type;
  const paramTypes = collectCallParamTypes(calleeParamType, args.length);

  const bindings: CarrierBinding[] = [];
  let calleeExpr: CoreExpr = callee;
  if (isCarrierType(callee.type, ctx.carriers)) {
    const bindingName = freshName(ctx, "__carrier_callee_");
    const valueType = getCarrierValueType(callee.type);
    bindings.push({
      carrierType: getCarrierTypeName(callee.type),
      scrutinee: callee,
      bindingName,
      bindingType: valueType,
    });
    calleeExpr = makeVar(bindingName, valueType, callee);
  }

  const argExprs = args.map((arg, index) => {
    if (!isCarrierType(arg.type, ctx.carriers)) {
      return arg;
    }
    const paramType = paramTypes[index];
    if (paramType && isCarrierType(paramType, ctx.carriers)) {
      return arg;
    }
    const bindingName = freshName(ctx, "__carrier_arg_");
    const valueType = getCarrierValueType(arg.type);
    bindings.push({
      carrierType: getCarrierTypeName(arg.type),
      scrutinee: arg,
      bindingName,
      bindingType: valueType,
    });
    return makeVar(bindingName, valueType, arg);
  });

  const baseCall: CoreExpr = {
    ...expr,
    callee: calleeExpr,
    args: argExprs,
  };

  return applyCarrierBindings(bindings, baseCall, expr);
}

function elaborateMatch(
  expr: CoreExpr & { kind: "match" },
  ctx: CarrierContext,
): CoreExpr {
  const scrutinee = elaborateExpr(expr.scrutinee, ctx);
  const cases = expr.cases.map((kase) => ({
    ...kase,
    body: elaborateExpr(kase.body, ctx),
    guard: kase.guard ? elaborateExpr(kase.guard, ctx) : undefined,
  }));
  const fallback = expr.fallback ? elaborateExpr(expr.fallback, ctx) : undefined;

  if (!isCarrierType(scrutinee.type, ctx.carriers)) {
    return { ...expr, scrutinee, cases, fallback };
  }

  const carrierTypeName = getCarrierTypeName(scrutinee.type);
  const carrierMatch = expr.carrierMatch;
  const dischargedCarrier = expr.dischargedCarrier;
  const handlesCarrier = carrierMatch && carrierMatch.typeName === carrierTypeName;
  const dischargesCarrier = dischargedCarrier &&
    dischargedCarrier.typeName === carrierTypeName;

  if (handlesCarrier || dischargesCarrier) {
    return { ...expr, scrutinee, cases, fallback };
  }

  const binding = freshName(ctx, "__carrier_match_");
  const valueType = getCarrierValueType(scrutinee.type);
  const matchExpr: CoreExpr = {
    ...expr,
    scrutinee: makeVar(binding, valueType, expr),
    cases,
    fallback,
  };
  return makeCarrierMatch(
    carrierTypeName,
    scrutinee,
    binding,
    valueType,
    matchExpr,
    expr,
  );
}

function elaboratePrim(
  op: CorePrimOp,
  args: readonly CoreExpr[],
  expr: CoreExpr & { kind: "prim" },
  ctx: CarrierContext,
): CoreExpr {
  const loweredArgs = args.map((arg) => elaborateExpr(arg, ctx));

  if (op === "record_get") {
    const target = loweredArgs[0];
    if (!target || !isCarrierType(target.type, ctx.carriers)) {
      return { ...expr, args: loweredArgs };
    }
    const binding = freshName(ctx, "__carrier_record_");
    const valueType = getCarrierValueType(target.type);
    const body: CoreExpr = {
      ...expr,
      args: [makeVar(binding, valueType, expr), loweredArgs[1]],
    };
    return makeCarrierMatch(
      getCarrierTypeName(target.type),
      target,
      binding,
      valueType,
      body,
      expr,
    );
  }

  const bindings: CarrierBinding[] = [];
  const rewrittenArgs = loweredArgs.map((arg) => {
    if (!isCarrierType(arg.type, ctx.carriers)) {
      return arg;
    }
    const bindingName = freshName(ctx, "__carrier_arg_");
    const valueType = getCarrierValueType(arg.type);
    bindings.push({
      carrierType: getCarrierTypeName(arg.type),
      scrutinee: arg,
      bindingName,
      bindingType: valueType,
    });
    return makeVar(bindingName, valueType, arg);
  });

  const basePrim: CoreExpr = {
    ...expr,
    args: rewrittenArgs,
  };

  return applyCarrierBindings(bindings, basePrim, expr);
}

function applyCarrierBindings(
  bindings: CarrierBinding[],
  body: CoreExpr,
  meta: CoreExpr,
): CoreExpr {
  let current = body;
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const binding = bindings[i];
    current = makeCarrierMatch(
      binding.carrierType,
      binding.scrutinee,
      binding.bindingName,
      binding.bindingType,
      current,
      meta,
    );
  }
  return current;
}

function makeVar(name: string, type: CoreExpr["type"], meta: CoreExpr): CoreExpr {
  return {
    kind: "var",
    name,
    type,
    origin: meta.origin,
    span: meta.span,
  };
}

function makeCarrierMatch(
  carrierType: string,
  scrutinee: CoreExpr,
  bindingName: string,
  bindingType: CoreExpr["type"],
  body: CoreExpr,
  meta: CoreExpr,
): CoreCarrierMatchExpr {
  const caseBody: CoreMatchCase = {
    pattern: {
      kind: "binding",
      name: bindingName,
      type: bindingType,
      origin: meta.origin,
      span: meta.span,
    },
    body,
  };
  return {
    kind: "carrier_match",
    carrierType,
    scrutinee,
    cases: [caseBody],
    type: body.type,
    origin: meta.origin,
    span: meta.span,
  };
}

function getCarrierTypeName(type: CoreExpr["type"]): string {
  if (type.kind === "constructor") {
    return type.name;
  }
  return "UnknownCarrier";
}

function getCarrierValueType(type: CoreExpr["type"]): CoreExpr["type"] {
  if (type.kind === "constructor" && type.args.length > 0) {
    return cloneType(type.args[0]);
  }
  return unknownType({
    kind: "incomplete",
    reason: "carrier_value_type_missing",
  });
}

function collectCallParamTypes(type: CoreExpr["type"], count: number): CoreExpr["type"][] {
  const params: CoreExpr["type"][] = [];
  let current = type;
  while (current.kind === "func" && params.length < count) {
    params.push(current.from);
    current = current.to;
  }
  return params;
}

function isCarrierType(type: CoreExpr["type"], carriers: Set<string>): boolean {
  return type.kind === "constructor" && carriers.has(type.name);
}

function collectCarrierTypes(graph: CoreModuleGraph): Set<string> {
  const carriers = new Set<string>();
  for (const module of graph.modules.values()) {
    for (const decl of module.typeDeclarations) {
      if (decl.infectious) {
        carriers.add(decl.name);
      }
    }
  }
  return carriers;
}
