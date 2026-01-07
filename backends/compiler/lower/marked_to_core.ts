import type {
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
import type { Literal } from "../../../src/ast.ts";
import { cloneType, type Type, unknownType } from "../../../src/types.ts";
import type {
  CoreDataExpr,
  CoreExpr,
  CoreLetExpr,
  CoreLetRecExpr,
  CoreLiteral,
  CoreLiteralExpr,
  CoreMatchCase,
  CorePattern,
  CorePrimOp,
  CoreValueBinding,
} from "../ir/core.ts";

export class CoreLoweringError extends Error {
  constructor(message: string, public readonly nodeId?: number) {
    super(message);
    // Don't set this.name - causes issues in Nova
    // this.name = "CoreLoweringError";
  }
}

interface LoweringState {
  tempIndex: number;
  readonly resolvedTypes: Map<number, Type>;
  readonly bundleArms: Map<string, MMatchArm[]>;
  readonly recordDefaultExprs: Map<string, Map<string, MExpr>>;
}

const UNKNOWN_PROVENANCE = "core.lowering.unresolved_type";

export function lowerProgramToValues(
  program: MProgram,
  resolvedTypes: Map<number, Type>,
  recordDefaultExprs: Map<string, Map<string, MExpr>> = new Map(),
): CoreValueBinding[] {
  const state: LoweringState = {
    tempIndex: 0,
    resolvedTypes,
    bundleArms: new Map(),
    recordDefaultExprs,
  };
  const values: CoreValueBinding[] = [];
  for (const declaration of program.declarations) {
    if (declaration.kind === "let") {
      values.push(lowerTopLevelLet(declaration, state));
    } else if (declaration.kind === "infix") {
      // Lower infix declaration to a value binding that aliases the implementation
      const opName = `__op_${declaration.node.operator}`;
      const implName = declaration.node.implementation;
      const type = resolveNodeType(state, declaration.node.id);
      values.push({
        name: opName,
        value: {
          kind: "var",
          name: implName,
          type,
          origin: declaration.node.id,
        },
        exported: Boolean(declaration.node.export),
        origin: declaration.node.id,
      });
    } else if (declaration.kind === "prefix") {
      // Lower prefix declaration to a value binding that aliases the implementation
      const opName = `__prefix_${declaration.node.operator}`;
      const implName = declaration.node.implementation;
      const type = resolveNodeType(state, declaration.node.id);
      values.push({
        name: opName,
        value: {
          kind: "var",
          name: implName,
          type,
          origin: declaration.node.id,
        },
        exported: Boolean(declaration.node.export),
        origin: declaration.node.id,
      });
    }
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
  const value = lowerBlockExpr(decl.body, state);

  // Store bundle arms if this is a bundle literal assignment
  if (decl.body.result && decl.body.result.kind === "match_bundle_literal") {
    const expandedArms = expandBundleArms(decl.body.result.bundle.arms, state);
    state.bundleArms.set(decl.name, expandedArms);
  }

  return value;
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
        statement.declaration.isMutable,
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
    } else if (statement.kind === "pattern_let_statement") {
      const initializer = lowerExpr(statement.initializer, state);
      const tempName = freshTemp(state, "__pattern");
      const matchExpr: CoreExpr = {
        kind: "match",
        scrutinee: {
          kind: "var",
          name: tempName,
          type: resolveNodeType(
            state,
            statement.initializer.id,
            statement.initializer.type,
          ),
        },
        cases: [
          {
            pattern: lowerPattern(statement.pattern, state),
            body: current,
          },
        ],
        type: blockType,
        origin: statement.id,
        span: statement.span,
      };
      current = createLetExpression(
        tempName,
        initializer,
        matchExpr,
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
        origin: expr.id,
        span: expr.span,
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
      return lowerMatchFnExpr(expr, state);
    case "match_bundle_literal":
      return lowerMatchBundleLiteralExpr(expr, state);
    // Hazel-style: Lower marked expressions as best-effort
    // These have type errors but we compile anyway and let them fail at runtime
    case "mark_free_var":
      // Reference to undefined variable - will be a runtime error
      return {
        kind: "var",
        name: expr.name,
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "mark_not_function":
      // Calling non-function - lower as a call anyway, will fail at runtime
      return {
        kind: "call",
        callee: lowerExpr(expr.callee, state),
        args: expr.args.map((arg) => lowerExpr(arg, state)),
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "mark_occurs_check":
    case "mark_inconsistent":
      // Type mismatch - lower the subject expression
      return lowerExpr(expr.subject, state);
    case "hole":
      // User hole - compile as a runtime error placeholder
      return {
        kind: "literal",
        literal: { kind: "unit" },
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "enum_literal":
      // Enum literal like .static - emit as-is for raw mode
      return {
        kind: "enum_literal",
        name: expr.name,
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "panic":
      // Panic("message") - lower to a prim call
      return {
        kind: "prim",
        op: "panic",
        args: [lowerExpr(expr.message, state)],
        type: resolveNodeType(state, expr.id, expr.type),
      };
    case "mark_unfillable_hole":
      // Conflicted hole - lower the subject if available
      return lowerExpr(expr.subject, state);
    case "mark_unsupported_expr":
      // Non-exhaustive matches and other unsupported expressions
      // These should ideally be caught earlier, but provide a graceful fallback
      throw new CoreLoweringError(
        `Unsupported expression kind: ${expr.exprKind}`,
        expr.id,
      );
    case "mark_type_expr_unknown":
    case "mark_type_expr_arity":
    case "mark_type_expr_unsupported":
      throw new CoreLoweringError(
        `Cannot lower type expression with errors (kind: '${expr.kind}')`,
        expr.id,
      );
    default:
      const _exhaustive: never = expr;
      void _exhaustive;
      throw new CoreLoweringError(
        "Unsupported expression kind",
        (expr as any).id,
      );
  }
}

function lowerMatchExpr(
  scrutinee: MExpr,
  bundle: MMatchBundle,
  expr: MExpr,
  state: LoweringState,
): CoreExpr {
  const loweredScrutinee = lowerExpr(scrutinee, state);
  const expandedArms = expandBundleArms(bundle.arms, state);
  const cases: CoreMatchCase[] = expandedArms.map((arm) =>
    lowerMatchArm(arm, state)
  );
  const effectRowCoverage = bundle.effectRowCoverage
    ? {
      row: bundle.effectRowCoverage.row,
      coveredConstructors: [
        ...bundle.effectRowCoverage.coveredConstructors,
      ],
      coversTail: bundle.effectRowCoverage.coversTail,
      missingConstructors: [
        ...bundle.effectRowCoverage.missingConstructors,
      ],
      dischargesResult: bundle.dischargesResult ?? false,
    }
    : undefined;
  return {
    kind: "match",
    scrutinee: loweredScrutinee,
    cases,
    type: resolveNodeType(state, expr.id, expr.type),
    origin: expr.id,
    span: expr.span,
    effectRowCoverage: effectRowCoverage,
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
    guard: arm.guard ? lowerExpr(arm.guard, state) : undefined,
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
    case "pinned":
      return {
        kind: "pinned",
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
      if (
        resolved.kind !== "constructor" &&
        pattern.name !== "Null" &&
        pattern.name !== "NonNull"
      ) {
        throw new CoreLoweringError(
          `Constructor pattern '${pattern.name}' missing type information`,
          pattern.id,
        );
      }
      const typeName = resolved.kind === "constructor"
        ? resolved.name
        : "__mem_nullability";
      return {
        kind: "constructor",
        typeName,
        constructor: pattern.name,
        fields: pattern.args.map((arg) => lowerPattern(arg, state)),
        type: resolved,
      };
    }
    case "all_errors": {
      const resolved = resolveNodeType(state, pattern.id, pattern.type);
      if (resolved.kind !== "constructor" || resolved.name !== "Result") {
        throw new CoreLoweringError(
          "`AllErrors` pattern requires a Result scrutinee",
          pattern.id,
        );
      }
      return {
        kind: "all_errors",
        resultTypeName: resolved.name,
        type: resolved,
      };
    }
    case "mark_pattern":
      // Hazel-style: Pattern has an error but we compile anyway
      // Lower as a wildcard pattern - will match anything at runtime
      return {
        kind: "wildcard",
        type: resolveNodeType(state, pattern.id, pattern.type),
      };
    default:
      const _exhaustive: never = pattern;
      void _exhaustive;
      throw new CoreLoweringError(
        "Unsupported pattern kind",
        (pattern as any).id,
      );
  }
}

function lowerRecordProjection(
  expr: MRecordProjectionExpr,
  state: LoweringState,
): CoreExpr {
  const target = lowerExpr(expr.target, state);
  // Encode capitalize flag by prefixing field name with ^
  const fieldName = expr.capitalize ? `^${expr.field}` : expr.field;
  return {
    kind: "prim",
    op: "record_get",
    args: [
      target,
      createStringLiteralExpr(fieldName),
    ],
    type: resolveNodeType(state, expr.id, expr.type),
  };
}

function lowerRecordLiteral(
  expr: MRecordLiteralExpr,
  state: LoweringState,
): CoreExpr {
  const resolvedType = resolveNodeType(state, expr.id, expr.type);
  const recordName = resolvedType.kind === "constructor"
    ? resolvedType.name
    : null;
  const defaults = recordName
    ? state.recordDefaultExprs.get(recordName)
    : undefined;

  const provided = new Map<string, CoreExpr>();
  for (const field of expr.fields) {
    provided.set(field.name, lowerExpr(field.value, state));
  }

  // Handle spread: get all fields from spread that aren't explicitly provided
  let spreadExpr: CoreExpr | undefined;
  let spreadFields: string[] = [];
  if (expr.spread) {
    spreadExpr = lowerExpr(expr.spread, state);
    const spreadType = spreadExpr.type;
    if (spreadType.kind === "constructor" && recordName) {
      const recordInfo = state.adtEnv.get(recordName);
      if (recordInfo?.recordFields) {
        spreadFields = Array.from(recordInfo.recordFields.keys()).filter(
          (name) => !provided.has(name),
        );
      }
    } else if (spreadType.kind === "record") {
      spreadFields = Array.from(spreadType.fields.keys()).filter(
        (name) => !provided.has(name),
      );
    }
  }

  const fields: { name: string; value: CoreExpr }[] = [];

  // Add explicitly provided fields
  for (const field of expr.fields) {
    const value = provided.get(field.name);
    if (value) {
      fields.push({ name: field.name, value });
    }
  }

  // Add fields from spread that aren't overridden
  if (spreadExpr && spreadFields.length > 0) {
    for (const fieldName of spreadFields) {
      // Create a record projection to get the field from spread
      const fieldType = resolvedType.kind === "constructor"
        ? getFieldTypeFromRecord(state, recordName!, fieldName) ?? resolvedType
        : (resolvedType.kind === "record"
          ? (resolvedType.fields.get(fieldName) ?? resolvedType)
          : resolvedType);
      fields.push({
        name: fieldName,
        value: {
          kind: "prim",
          op: "record_get",
          args: [spreadExpr, createStringLiteralExpr(fieldName)],
          type: fieldType,
        },
      });
    }
  }

  // Add default values for remaining missing fields
  if (defaults) {
    for (const [name, defaultExpr] of defaults.entries()) {
      if (provided.has(name) || spreadFields.includes(name)) continue;
      const value = lowerDefaultFieldValue(defaultExpr, provided, state);
      fields.push({ name, value });
    }
  }

  return {
    kind: "record",
    fields,
    type: resolvedType,
  };
}

function getFieldTypeFromRecord(
  state: LoweringState,
  recordName: string,
  fieldName: string,
): Type | null {
  const recordInfo = state.adtEnv.get(recordName);
  if (!recordInfo?.alias || recordInfo.alias.kind !== "record") {
    return null;
  }
  return recordInfo.alias.fields.get(fieldName) ?? null;
}

function lowerDefaultFieldValue(
  expr: MExpr,
  provided: Map<string, CoreExpr>,
  state: LoweringState,
): CoreExpr {
  let current = lowerExpr(expr, state);
  const resultType = current.type;
  for (const [name, value] of provided.entries()) {
    current = createLetExpression(name, value, current, false, resultType);
  }
  return current;
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
  if (operator === "&") {
    return "address_of";
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
      throw new CoreLoweringError(
        "Unsupported literal kind",
        (literal as any).id,
      );
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
  isMutable?: boolean,
): CoreLetExpr {
  return {
    kind: "let",
    binding: {
      name,
      value,
      isRecursive,
      isMutable,
    },
    body,
    type: resultType,
  };
}

function lowerMatchBundleLiteralExpr(
  expr: any,
  state: LoweringState,
): CoreExpr {
  // match_bundle_literal represents a function that takes one argument and matches it
  // Store the expanded arms for potential bundle references
  const expandedArms = expandBundleArms(expr.bundle.arms, state);
  // For anonymous bundles, we don't store them since they can't be referenced
  // Only named bundles (assigned to variables) can be referenced

  const paramName = freshTemp(state, "__bundle_arg");
  const matchExpr: CoreExpr = {
    kind: "match",
    scrutinee: {
      kind: "var",
      name: paramName,
      type: unknownType({
        kind: "incomplete",
        reason: "match_bundle_scrutinee",
      }),
    },
    cases: expandedArms.map((arm) => lowerMatchArm(arm, state)),
    type: resolveNodeType(state, expr.id, expr.type),
    // Note: removing effectRowCoverage for bundle literals as they don't have coverage info
  };
  return {
    kind: "lambda",
    params: [paramName],
    body: matchExpr,
    type: resolveNodeType(state, expr.id, expr.type),
  };
}

function expandBundleArms(
  arms: readonly MMatchArm[],
  state: LoweringState,
): MMatchArm[] {
  const expanded: MMatchArm[] = [];
  for (const arm of arms) {
    if (arm.kind === "match_bundle_reference") {
      const referencedArms = state.bundleArms.get(arm.name);
      if (referencedArms) {
        expanded.push(...referencedArms);
      } else {
        // Bundle not found - this should be an error, but for now ignore
      }
    } else {
      expanded.push(arm);
    }
  }
  return expanded;
}

function lowerMatchFnExpr(expr: any, state: LoweringState): CoreExpr {
  // match_fn should have been rewritten by canonicalize pass, but if it reaches here,
  // lower it as a lambda that applies the match
  const paramNames = extractParameterNames(expr.parameters, state);
  if (paramNames.length !== 1) {
    throw new CoreLoweringError(
      `match_fn lowering expects exactly one parameter, got ${paramNames.length}`,
      expr.id,
    );
  }
  const paramName = paramNames[0];
  const expandedArms = expandBundleArms(expr.bundle.arms, state);
  const matchExpr: CoreExpr = {
    kind: "match",
    scrutinee: {
      kind: "var",
      name: paramName,
      type: unknownType({ kind: "incomplete", reason: "match_fn_scrutinee" }),
    },
    cases: expandedArms.map((arm: MMatchArm) => lowerMatchArm(arm, state)),
    type: resolveNodeType(state, expr.id, expr.type),
  };
  return {
    kind: "lambda",
    params: [paramName],
    body: matchExpr,
    type: resolveNodeType(state, expr.id, expr.type),
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
