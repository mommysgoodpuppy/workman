import type {
  Literal,
  MBinaryExpr,
  MBlockExpr,
  MBlockStatement,
  MExpr,
  MLetDeclaration,
  MMatchArm,
  MMatchBundle,
  MMatchPatternArm,
  MParameter,
  MPattern,
  MProgram,
  MRecordLiteralExpr,
  MRecordProjectionExpr,
  MUnaryExpr,
} from "../../../src/ast_marked.ts";
import { cloneType, type Type, unknownType } from "../../../src/types.ts";
import {
  type CoreDataExpr,
  type CoreExpr,
  type CoreLetExpr,
  type CoreLetRecExpr,
  type CoreLiteral,
  type CoreLiteralExpr,
  type CoreMatchCase,
  type CorePattern,
  type CorePrimOp,
  type CoreValueBinding,
} from "../ir/core.ts";

export class CoreLoweringError extends Error {
  constructor(message: string, public readonly nodeId?: number) {
    super(message);
    this.name = "CoreLoweringError";
  }
}

interface LoweringState {
  tempIndex: number;
  readonly resolvedTypes: Map<number, Type>;
}

const UNKNOWN_PROVENANCE = "core.lowering.unresolved_type";

export function lowerProgramToValues(
  program: MProgram,
  resolvedTypes: Map<number, Type>,
): CoreValueBinding[] {
  const state: LoweringState = { tempIndex: 0, resolvedTypes };
  const values: CoreValueBinding[] = [];
  for (const declaration of program.declarations) {
    if (declaration.kind !== "let") continue;
    values.push(lowerTopLevelLet(declaration, state));
  }
  return values;
}

function lowerTopLevelLet(
  decl: MLetDeclaration,
  state: LoweringState,
): CoreValueBinding {
  const value = lowerLetBindingValue(decl, state);
  return {
    name: decl.name,
    value,
    exported: Boolean(decl.export),
    origin: decl.id,
  };
}

function lowerLetBindingValue(
  decl: MLetDeclaration,
  state: LoweringState,
): CoreExpr {
  const cluster = [decl, ...(decl.mutualBindings ?? [])];
  if (cluster.length > 1 || decl.isRecursive) {
    return lowerRecursiveCluster(decl, cluster, state);
  }
  if (decl.parameters.length > 0 || decl.isArrowSyntax) {
    return lowerFunctionValue(decl, state);
  }
  return lowerBlockExpr(decl.body, state);
}

function lowerRecursiveCluster(
  target: MLetDeclaration,
  cluster: MLetDeclaration[],
  state: LoweringState,
): CoreLetRecExpr {
  const bindings = cluster.map((binding) => {
    if (!(binding.parameters.length > 0 || binding.isArrowSyntax)) {
      throw new CoreLoweringError(
        `Recursive binding '${binding.name}' must have parameters`,
        binding.id,
      );
    }
    const lambda = lowerFunctionValue(binding, state);
    if (lambda.kind !== "lambda") {
      throw new CoreLoweringError(
        `Expected lambda for recursive binding '${binding.name}'`,
        binding.id,
      );
    }
    return {
      name: binding.name,
      value: lambda,
    };
  });

  const targetType = resolveNodeType(state, target.id, target.type);
  const body: CoreExpr = {
    kind: "var",
    name: target.name,
    type: targetType,
  };

  return {
    kind: "let_rec",
    bindings,
    body,
    type: body.type,
  };
}

function lowerFunctionValue(
  decl: MLetDeclaration,
  state: LoweringState,
): CoreExpr {
  const lambdaType = resolveNodeType(state, decl.id, decl.type);
  const paramNames = extractParameterNames(decl.parameters, state);
  const loweredBody = lowerBlockExpr(decl.body, state);
  return {
    kind: "lambda",
    params: paramNames,
    body: loweredBody,
    type: lambdaType,
  };
}

function extractParameterNames(
  parameters: readonly MParameter[],
  state: LoweringState,
): string[] {
  const names: string[] = [];
  for (const parameter of parameters) {
    switch (parameter.pattern.kind) {
      case "variable":
        names.push(parameter.pattern.name);
        break;
      case "wildcard":
        names.push(freshTemp(state, "__param"));
        break;
      default:
        throw new CoreLoweringError(
          `Unsupported parameter pattern '${parameter.pattern.kind}'`,
          parameter.id,
        );
    }
  }
  return names;
}

function lowerBlockExpr(block: MBlockExpr, state: LoweringState): CoreExpr {
  const blockType = resolveNodeType(state, block.id, block.type);
  const resultExpr = block.result
    ? lowerExpr(block.result, state)
    : createUnitLiteral(blockType);

  let current: CoreExpr = resultExpr;

  for (let index = block.statements.length - 1; index >= 0; index -= 1) {
    const statement = block.statements[index];
    if (statement.kind === "let_statement") {
      const bindingExpr = lowerLetBindingValue(statement.declaration, state);
      current = createLetExpression(
        statement.declaration.name,
        bindingExpr,
        current,
        statement.declaration.isRecursive,
        blockType,
      );
    } else if (statement.kind === "expr_statement") {
      const expr = lowerExpr(statement.expression, state);
      current = createLetExpression(
        freshTemp(state, "__stmt"),
        expr,
        current,
        false,
        blockType,
      );
    } else {
      const _exhaustive: never = statement;
      void _exhaustive;
    }
  }

  return current;
}

function lowerExpr(expr: MExpr, state: LoweringState): CoreExpr {
  switch (expr.kind) {
    case "identifier":
      return {
        kind: "var",
        name: expr.name,
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "literal":
      return {
        kind: "literal",
        literal: lowerLiteral(expr.literal),
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: expr.elements.map((element) => lowerExpr(element, state)),
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "record_literal":
      return lowerRecordLiteral(expr, state);
    case "constructor":
      return lowerConstructorExpr(expr, state);
    case "call":
      return {
        kind: "call",
        callee: lowerExpr(expr.callee, state),
        args: expr.arguments.map((argument) => lowerExpr(argument, state)),
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "arrow":
      return {
        kind: "lambda",
        params: extractParameterNames(expr.parameters, state),
        body: lowerBlockExpr(expr.body, state),
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "block":
      return lowerBlockExpr(expr, state);
    case "record_projection":
      return lowerRecordProjection(expr, state);
    case "binary":
      return lowerBinaryExpr(expr, state);
    case "unary":
      return lowerUnaryExpr(expr, state);
    case "match":
      return lowerMatchExpr(expr.scrutinee, expr.bundle, expr, state);
    case "match_fn":
    case "match_bundle_literal":
      throw new CoreLoweringError(
        `Lowering for '${expr.kind}' expressions is not implemented`,
        expr.id,
      );
    case "mark_free_var":
    case "mark_not_function":
    case "mark_occurs_check":
    case "mark_inconsistent":
    case "mark_unsupported_expr":
    case "mark_type_expr_unknown":
    case "mark_type_expr_arity":
    case "mark_type_expr_unsupported":
      throw new CoreLoweringError(
        `Cannot lower expression with diagnostics (kind: '${expr.kind}')`,
        expr.id,
      );
    default:
      const _exhaustive: never = expr;
      void _exhaustive;
      throw new CoreLoweringError("Unsupported expression kind", expr.id);
  }
}

function lowerMatchExpr(
  scrutinee: MExpr,
  bundle: MMatchBundle,
  expr: MExpr,
  state: LoweringState,
): CoreExpr {
  const loweredScrutinee = lowerExpr(scrutinee, state);
  const cases: CoreMatchCase[] = bundle.arms.map((arm) =>
    lowerMatchArm(arm, state)
  );
  return {
    kind: "match",
    scrutinee: loweredScrutinee,
    cases,
    type: resolveNodeType(state, expr.id, expr.type),
  };
}

function lowerMatchArm(arm: MMatchArm, state: LoweringState): CoreMatchCase {
  if (arm.kind !== "match_pattern") {
    throw new CoreLoweringError(
      "Match bundle references are not supported in Core lowering yet",
      arm.id,
    );
  }
  return lowerPatternArm(arm, state);
}

function lowerPatternArm(
  arm: MMatchPatternArm,
  state: LoweringState,
): CoreMatchCase {
  return {
    pattern: lowerPattern(arm.pattern, state),
    body: lowerExpr(arm.body, state),
  };
}

function lowerPattern(pattern: MPattern, state: LoweringState): CorePattern {
  switch (pattern.kind) {
    case "wildcard":
      return {
        kind: "wildcard",
        type: resolveNodeType(state, pattern.id, pattern.type),
      };
    case "variable":
      return {
        kind: "binding",
        name: pattern.name,
        type: resolveNodeType(state, pattern.id, pattern.type),
      };
    case "literal":
      return {
        kind: "literal",
        literal: lowerLiteral(pattern.literal),
        type: resolveNodeType(state, pattern.id, pattern.type),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: pattern.elements.map((element) =>
          lowerPattern(element, state)
        ),
        type: resolveNodeType(state, pattern.id, pattern.type),
      };
    case "constructor": {
      const resolved = resolveNodeType(state, pattern.id, pattern.type);
      if (resolved.kind !== "constructor") {
        throw new CoreLoweringError(
          `Constructor pattern '${pattern.name}' missing type information`,
          pattern.id,
        );
      }
      return {
        kind: "constructor",
        typeName: resolved.name,
        constructor: pattern.name,
        fields: pattern.args.map((arg) => lowerPattern(arg, state)),
        type: resolved,
      };
    }
    case "mark_pattern":
      throw new CoreLoweringError(
        `Cannot lower match pattern diagnostic '${pattern.reason}'`,
        pattern.id,
      );
    default:
      const _exhaustive: never = pattern;
      void _exhaustive;
      throw new CoreLoweringError("Unsupported pattern kind", pattern.id);
  }
}

function lowerRecordProjection(
  expr: MRecordProjectionExpr,
  state: LoweringState,
): CoreExpr {
  const target = lowerExpr(expr.target, state);
  return {
    kind: "prim",
    op: "record_get",
    args: [
      target,
      createStringLiteralExpr(expr.field),
    ],
    type: resolveNodeType(state, expr.id, expr.type),
  };
}

function lowerRecordLiteral(
  expr: MRecordLiteralExpr,
  state: LoweringState,
): CoreExpr {
  return {
    kind: "record",
    fields: expr.fields.map((field) => ({
      name: field.name,
      value: lowerExpr(field.value, state),
    })),
    type: resolveNodeType(state, expr.id, expr.type),
  };
}

function lowerBinaryExpr(expr: MBinaryExpr, state: LoweringState): CoreExpr {
  const left = lowerExpr(expr.left, state);
  const right = lowerExpr(expr.right, state);
  const resultType = resolveNodeType(state, expr.id, expr.type);
  const primOp = mapBinaryPrimOp(expr.operator, left.type, right.type);
  if (primOp) {
    return {
      kind: "prim",
      op: primOp,
      args: [left, right],
      type: resultType,
    };
  }
  return {
    kind: "call",
    callee: {
      kind: "var",
      name: `__op_${expr.operator}`,
      type: makeBinaryFunctionType(left.type, right.type, resultType),
    },
    args: [left, right],
    type: resultType,
  };
}

function lowerUnaryExpr(expr: MUnaryExpr, state: LoweringState): CoreExpr {
  const operand = lowerExpr(expr.operand, state);
  const resultType = resolveNodeType(state, expr.id, expr.type);
  const primOp = mapUnaryPrimOp(expr.operator, operand.type);
  if (primOp) {
    return {
      kind: "prim",
      op: primOp,
      args: [operand],
      type: resultType,
    };
  }
  return {
    kind: "call",
    callee: {
      kind: "var",
      name: `__prefix_${expr.operator}`,
      type: makeFunctionType(operand.type, resultType),
    },
    args: [operand],
    type: resultType,
  };
}

function mapBinaryPrimOp(
  operator: string,
  leftType: Type,
  rightType: Type,
): CorePrimOp | undefined {
  if (isIntType(leftType) && isIntType(rightType)) {
    switch (operator) {
      case "+":
        return "int_add";
      case "-":
        return "int_sub";
      case "*":
        return "int_mul";
      case "/":
        return "int_div";
      case "==":
        return "int_eq";
      case "!=":
        return "int_ne";
      case "<":
        return "int_lt";
      case "<=":
        return "int_le";
      case ">":
        return "int_gt";
      case ">=":
        return "int_ge";
      default:
        return undefined;
    }
  }
  if (isBoolType(leftType) && isBoolType(rightType)) {
    switch (operator) {
      case "&&":
        return "bool_and";
      case "||":
        return "bool_or";
      default:
        return undefined;
    }
  }
  if (isCharType(leftType) && isCharType(rightType)) {
    if (operator === "==") {
      return "char_eq";
    }
  }
  return undefined;
}

function mapUnaryPrimOp(
  operator: string,
  operandType: Type,
): CorePrimOp | undefined {
  if (operator === "!" && isBoolType(operandType)) {
    return "bool_not";
  }
  return undefined;
}

function isIntType(type: Type): boolean {
  return type.kind === "int";
}

function isBoolType(type: Type): boolean {
  return type.kind === "bool";
}

function isCharType(type: Type): boolean {
  return type.kind === "char";
}

function makeFunctionType(from: Type, to: Type): Type {
  return {
    kind: "func",
    from: cloneType(from),
    to: cloneType(to),
  };
}

function makeBinaryFunctionType(
  left: Type,
  right: Type,
  result: Type,
): Type {
  return {
    kind: "func",
    from: cloneType(left),
    to: makeFunctionType(right, result),
  };
}

function createStringLiteralExpr(value: string): CoreLiteralExpr {
  return {
    kind: "literal",
    literal: { kind: "string", value },
    type: { kind: "string" },
  };
}

function lowerConstructorExpr(
  expr: Extract<MExpr, { kind: "constructor" }>,
  state: LoweringState,
): CoreDataExpr {
  const resolved = resolveNodeType(state, expr.id, expr.type);
  if (resolved.kind !== "constructor") {
    throw new CoreLoweringError(
      `Constructor expression '${expr.name}' is missing resolved type information`,
      expr.id,
    );
  }
  return {
    kind: "data",
    typeName: resolved.name,
    constructor: expr.name,
    fields: expr.args.map((arg) => lowerExpr(arg, state)),
    type: resolved,
  };
}

function lowerLiteral(literal: Literal): CoreLiteral {
  switch (literal.kind) {
    case "unit":
      return { kind: "unit" };
    case "int":
      return { kind: "int", value: literal.value };
    case "bool":
      return { kind: "bool", value: literal.value };
    case "char": {
      const codePoint = literal.value.codePointAt(0);
      if (codePoint === undefined) {
        throw new CoreLoweringError(
          "Encountered empty character literal",
          literal.id,
        );
      }
      return { kind: "char", value: codePoint };
    }
    case "string":
      return { kind: "string", value: literal.value };
    default:
      const _exhaustive: never = literal;
      void _exhaustive;
      throw new CoreLoweringError("Unsupported literal kind", literal.id);
  }
}

function createUnitLiteral(type: Type): CoreLiteralExpr {
  return {
    kind: "literal",
    literal: { kind: "unit" },
    type,
  };
}

function createLetExpression(
  name: string,
  value: CoreExpr,
  body: CoreExpr,
  isRecursive: boolean,
  resultType: Type,
): CoreLetExpr {
  return {
    kind: "let",
    binding: {
      name,
      value,
      isRecursive,
    },
    body,
    type: resultType,
  };
}

function freshTemp(state: LoweringState, prefix: string): string {
  const index = state.tempIndex++;
  return `${prefix}_${index}`;
}

function resolveNodeType(
  state: LoweringState,
  nodeId: number,
  fallback?: Type,
): Type {
  const resolved = state.resolvedTypes.get(nodeId);
  if (resolved) {
    return resolved;
  }
  if (fallback) {
    return fallback;
  }
  return unknownType({ kind: "incomplete", reason: UNKNOWN_PROVENANCE });
}
