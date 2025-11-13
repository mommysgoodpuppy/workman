import type {
  ArrowFunctionExpr,
  BlockExpr,
  BlockStatement,
  ConstructorAlias,
  Expr,
  IdentifierExpr,
  InfixDeclaration,
  LetDeclaration,
  LetStatement,
  Literal,
  MatchArm,
  MatchBundle,
  MatchBundleLiteralExpr,
  MatchPatternArm,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  SourceSpan,
  TypeDeclaration,
} from "./ast.ts";
import { lowerTupleParameters } from "./lower_tuple_params.ts";
import {
  bindValue,
  type BoolValue,
  type ClosureValue,
  createEnvironment,
  type DataValue,
  type Environment,
  hasBinding,
  type IntValue,
  lookupValue,
  type NativeFunctionValue,
  type RuntimeValue,
  UNIT_VALUE,
  type updateValue,
} from "./value.ts";
import { RuntimeError } from "./error.ts";
import { formatRuntimeValue } from "./value_printer.ts";

// Module-level variable to store source text for error reporting
let currentSource: string | undefined;

export interface EvalOptions {
  sourceName?: string;
  source?: string;
  onPrint?: (text: string) => void;
  initialBindings?: Map<string, RuntimeValue>;
}

export interface EvalSummary {
  name: string;
  value: RuntimeValue;
}

export interface EvalResult {
  env: Environment;
  summaries: EvalSummary[];
}

export function evaluateProgram(
  program: Program,
  options: EvalOptions = {},
): EvalResult {
  lowerTupleParameters(program);
  currentSource = options.source;
  const globalEnv = createEnvironment(null);
  registerPreludeRuntime(globalEnv, options);

  if (options.initialBindings) {
    for (const [name, value] of options.initialBindings.entries()) {
      bindValue(globalEnv, name, value);
    }
  }

  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeConstructorsRuntime(globalEnv, decl);
    }
  }

  const summaries: EvalSummary[] = [];

  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const value = evaluateLetDeclaration(globalEnv, decl);
      summaries.push({ name: decl.name, value });
    } else if (decl.kind === "infix") {
      evaluateInfixDeclaration(globalEnv, decl);
    } else if (decl.kind === "prefix") {
      evaluatePrefixDeclaration(globalEnv, decl);
    }
  }

  // Auto-execute main function if it exists
  if (hasBinding(globalEnv, "main")) {
    const mainValue = lookupValue(globalEnv, "main");
    // Call main with no arguments
    applyValue(mainValue, [], undefined);
  }

  return { env: globalEnv, summaries };
}

function evaluateInfixDeclaration(
  env: Environment,
  decl: InfixDeclaration,
): void {
  // Register the operator's implementation function in the environment
  // with a special name so binary expressions can look it up
  const opFuncName = `__op_${decl.operator}`;

  // Look up the actual implementation function
  const implValue = lookupValue(env, decl.implementation);

  // Register it under the operator name
  bindValue(env, opFuncName, implValue);
}

function evaluatePrefixDeclaration(
  env: Environment,
  decl: PrefixDeclaration,
): void {
  // Register the prefix operator's implementation function
  const opFuncName = `__prefix_${decl.operator}`;

  // Look up the actual implementation function
  const implValue = lookupValue(env, decl.implementation);

  // Register it under the operator name
  bindValue(env, opFuncName, implValue);
}

function evaluateLetDeclaration(
  env: Environment,
  decl: LetDeclaration,
): RuntimeValue {
  if (decl.isRecursive) {
    const bindings = evaluateRecursiveBindings(env, [
      decl,
      ...(decl.mutualBindings ?? []),
    ]);
    return bindings.get(decl.name)!;
  }

  const value = decl.parameters.length === 0
    ? evaluateBlock(env, decl.body)
    : createClosure(env, decl, env);

  bindValue(env, decl.name, value);
  return value;
}

function createClosure(
  _env: Environment,
  decl: LetDeclaration,
  closureEnv: Environment,
): ClosureValue {
  return {
    kind: "closure",
    parameters: decl.parameters,
    body: decl.body,
    env: closureEnv,
  };
}

function evaluateBlock(env: Environment, block: BlockExpr): RuntimeValue {
  const scope = createEnvironment(env);

  for (const statement of block.statements) {
    evaluateBlockStatement(scope, statement);
  }

  if (block.result) {
    return evaluateExpr(scope, block.result);
  }

  return UNIT_VALUE;
}

function evaluateBlockStatement(
  env: Environment,
  statement: BlockStatement,
): void {
  const kind = statement.kind;
  const span = statement.span;
  switch (kind) {
    case "let_statement":
      evaluateLetStatement(env, statement);
      break;
    case "expr_statement":
      evaluateExpr(env, statement.expression);
      break;
    default:
      assertUnreachable(
        statement,
        `Unsupported block statement '${kind}'`,
        span,
      );
  }
}

function evaluateLetStatement(env: Environment, statement: LetStatement): void {
  const { declaration } = statement;
  if (declaration.isRecursive) {
    evaluateRecursiveBindings(env, [
      declaration,
      ...(declaration.mutualBindings ?? []),
    ]);
    return;
  }

  const value = declaration.parameters.length === 0
    ? evaluateBlock(env, declaration.body)
    : createClosure(env, declaration, env);

  bindValue(env, declaration.name, value);
}

function evaluateExpr(env: Environment, expr: Expr): RuntimeValue {
  const kind = expr.kind;
  const span = expr.span;
  switch (kind) {
    case "identifier":
      return evaluateIdentifier(env, expr);
    case "literal":
      return literalToRuntime(expr.literal);
    case "constructor":
      return evaluateConstructorExpr(env, expr);
    case "tuple": {
      const elements = expr.elements.map((element) =>
        evaluateExpr(env, element)
      );
      return { kind: "tuple", elements };
    }
    case "record_literal":
      return evaluateRecordLiteral(env, expr);
    case "record_projection":
      return evaluateRecordProjection(env, expr);
    case "call":
      return evaluateCallExpr(env, expr);
    case "arrow":
      return {
        kind: "closure",
        parameters: expr.parameters,
        body: expr.body,
        env,
      };
    case "block":
      return evaluateBlock(env, expr);
    case "match":
      return evaluateMatchExpr(env, expr.scrutinee, expr.bundle, expr.span);
    case "match_fn":
      return evaluateMatchFunction(
        env,
        expr.parameters,
        expr.bundle,
        expr.span,
      );
    case "match_bundle_literal":
      return evaluateMatchBundleLiteral(env, expr);
    case "binary": {
      // Binary operators are desugared to function calls
      // e.g., `a + b` becomes `add(a, b)` where `add` is the implementation function
      const left = evaluateExpr(env, expr.left);
      const right = evaluateExpr(env, expr.right);

      // Look up the operator's implementation function
      const opFuncName = `__op_${expr.operator}`;
      const opFunc = lookupValue(env, opFuncName);

      // Apply the function to both arguments
      return applyValue(opFunc, [left, right], expr.span);
    }
    case "unary": {
      // Unary operators are desugared to function calls
      // e.g., `!x` becomes `not(x)` where `not` is the implementation function
      const operand = evaluateExpr(env, expr.operand);

      // Look up the prefix operator's implementation function
      const opFuncName = `__prefix_${expr.operator}`;
      const opFunc = lookupValue(env, opFuncName);

      // Apply the function to the operand
      return applyValue(opFunc, [operand], expr.span);
    }
    default:
      assertUnreachable(expr, `Unsupported expression kind '${kind}'`, span);
  }
}

function evaluateIdentifier(
  env: Environment,
  expr: IdentifierExpr,
): RuntimeValue {
  try {
    return lookupValue(env, expr.name);
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw new RuntimeError(error.message, expr.span, currentSource);
    }
    throw error;
  }
}

function evaluateConstructorExpr(
  env: Environment,
  expr: Expr & { kind: "constructor" },
): RuntimeValue {
  let callee: RuntimeValue;
  try {
    callee = lookupValue(env, expr.name);
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw new RuntimeError(error.message, expr.span, currentSource);
    }
    throw error;
  }
  const args = expr.args.map((arg) => evaluateExpr(env, arg));
  return applyValue(callee, args, expr.span);
}

function evaluateRecordLiteral(
  env: Environment,
  expr: Expr & { kind: "record_literal" },
): RuntimeValue {
  const fields = new Map<string, RuntimeValue>();
  for (const field of expr.fields) {
    if (fields.has(field.name)) {
      throw new RuntimeError(
        `Duplicate field '${field.name}' in record literal`,
        field.span,
        currentSource,
      );
    }
    const value = evaluateExpr(env, field.value);
    fields.set(field.name, value);
  }
  return { kind: "record", fields };
}

function evaluateRecordProjection(
  env: Environment,
  expr: Expr & { kind: "record_projection" },
): RuntimeValue {
  const rawTarget = evaluateExpr(env, expr.target);
  const targetInfo = unwrapResultForCall(rawTarget);
  if (targetInfo.shortCircuit) {
    return targetInfo.shortCircuit;
  }
  const target = targetInfo.value;
  if (target.kind !== "record") {
    throw new RuntimeError(
      `Attempted to project '${expr.field}' from a non-record value`,
      expr.span,
      currentSource,
    );
  }
  if (!target.fields.has(expr.field)) {
    throw new RuntimeError(
      `Record is missing field '${expr.field}'`,
      expr.span,
      currentSource,
    );
  }
  const fieldValue = target.fields.get(expr.field)!;
  if (targetInfo.infected) {
    return wrapResultValue(fieldValue);
  }
  return fieldValue;
}

function evaluateCallExpr(
  env: Environment,
  expr: Expr & { kind: "call" },
): RuntimeValue {
  const callee = evaluateExpr(env, expr.callee);
  const args = expr.arguments.map((argument) => evaluateExpr(env, argument));
  return applyValue(callee, args, expr.span);
}

function applyValue(
  target: RuntimeValue,
  args: RuntimeValue[],
  span: SourceSpan | undefined,
): RuntimeValue {
  if (args.length === 0) {
    return target;
  }

  const calleeInfo = unwrapResultForCall(target);
  if (calleeInfo.shortCircuit) {
    return calleeInfo.shortCircuit;
  }
  let callable = calleeInfo.value;
  let infected = calleeInfo.infected;

  const processedArgs: RuntimeValue[] = [];
  for (const arg of args) {
    const argInfo = unwrapResultForCall(arg);
    if (argInfo.shortCircuit) {
      return argInfo.shortCircuit;
    }
    if (argInfo.infected) {
      infected = true;
    }
    processedArgs.push(argInfo.value);
  }

  let result: RuntimeValue;
  switch (callable.kind) {
    case "closure":
      result = callClosure(callable, processedArgs, span);
      break;
    case "native":
      result = callNative(callable, processedArgs, span);
      break;
    default:
      throw new RuntimeError(
        "Attempted to call a non-function value",
        span,
        currentSource,
      );
  }

  if (infected) {
    return wrapResultValue(result);
  }
  return result;
}

interface ResultUnwrapInfo {
  value: RuntimeValue;
  infected: boolean;
  shortCircuit?: RuntimeValue;
}

function unwrapResultForCall(value: RuntimeValue): ResultUnwrapInfo {
  if (value.kind === "data") {
    if (value.constructor === "Err") {
      return { value, infected: true, shortCircuit: value };
    }
    if (value.constructor === "Ok") {
      const payload = value.fields[0] ?? UNIT_VALUE;
      return { value: payload, infected: true };
    }
  }
  return { value, infected: false };
}

function wrapResultValue(value: RuntimeValue): RuntimeValue {
  if (
    value.kind === "data" &&
    (value.constructor === "Ok" || value.constructor === "Err")
  ) {
    return value;
  }
  return {
    kind: "data",
    constructor: "Ok",
    fields: [value],
  };
}

function callClosure(
  closure: ClosureValue,
  args: RuntimeValue[],
  span: SourceSpan | undefined,
): RuntimeValue {
  if (args.length !== closure.parameters.length) {
    throw new RuntimeError(
      `Non-exhaustive patterns at runtime (expected ${closure.parameters.length} argument(s) but received ${args.length})`,
      span,
      currentSource,
    );
  }

  const frame = createEnvironment(closure.env);
  for (let index = 0; index < closure.parameters.length; index += 1) {
    const param = closure.parameters[index];
    const value = args[index];
    const paramName = param.name;
    if (!paramName) {
      throw new RuntimeError(
        "Internal error: missing parameter name after tuple lowering",
        param.span,
        currentSource,
      );
    }
    bindValue(frame, paramName, value);
  }

  return evaluateBlock(frame, closure.body);
}

function callNative(
  nativeFn: NativeFunctionValue,
  args: RuntimeValue[],
  span: SourceSpan | undefined,
): RuntimeValue {
  const collected = [...nativeFn.collectedArgs, ...args];
  if (collected.length > nativeFn.arity) {
    throw new RuntimeError(
      `Native function '${nativeFn.name}' expected ${nativeFn.arity} argument(s) but received ${collected.length}`,
      span,
      currentSource,
    );
  }

  if (collected.length === nativeFn.arity) {
    return nativeFn.impl(collected, span);
  }

  return {
    ...nativeFn,
    collectedArgs: collected,
  };
}

function literalToRuntime(literal: Literal): RuntimeValue {
  const span = literal.span;
  const kind = literal.kind;
  switch (kind) {
    case "int":
      return { kind: "int", value: literal.value };
    case "bool":
      return { kind: "bool", value: literal.value };
    case "char":
      return { kind: "char", value: literal.value.charCodeAt(0) };
    case "string":
      return { kind: "string", value: literal.value };
    case "unit":
      return UNIT_VALUE;
    default:
      assertUnreachable(literal, "Unsupported literal", span);
  }
}

function registerTypeConstructorsRuntime(
  env: Environment,
  decl: TypeDeclaration,
): void {
  for (const member of decl.members) {
    if (member.kind !== "constructor") {
      continue;
    }
    const value = createConstructorValue(member);
    bindValue(env, member.name, value);
  }
}

function registerPreludeRuntime(env: Environment, options: EvalOptions): void {
  bindCmpIntNative(env, "nativeCmpInt");
  bindCharEqNative(env, "nativeCharEq");
  bindPrintNative(env, "nativePrint", options.onPrint);
  bindStrFromLiteralNative(env, "nativeStrFromLiteral");
  bindIntBinaryNative(env, "nativeAdd", (a, b) => a + b);
  bindIntBinaryNative(env, "nativeSub", (a, b) => a - b);
  bindIntBinaryNative(env, "nativeMul", (a, b) => a * b);
  bindIntBinaryNative(env, "nativeDiv", (a, b, span) => {
    if (b === 0) {
      throw new RuntimeError("Division by zero", span, currentSource);
    }
    return Math.trunc(a / b);
  });
}

function createConstructorValue(ctor: ConstructorAlias): RuntimeValue {
  const arity = ctor.typeArgs.length;
  if (arity === 0) {
    return {
      kind: "data",
      constructor: ctor.name,
      fields: [],
    } satisfies DataValue;
  }
  return createNativeFunction(ctor.name, arity, (args) => ({
    kind: "data",
    constructor: ctor.name,
    fields: args,
  } satisfies DataValue));
}

function createNativeFunction(
  name: string,
  arity: number,
  impl: NativeFunctionValue["impl"],
): NativeFunctionValue {
  return {
    kind: "native",
    name,
    arity,
    collectedArgs: [],
    impl,
  };
}

function bindIntBinaryNative(
  env: Environment,
  name: string,
  impl: (left: number, right: number, span: SourceSpan | undefined) => number,
): void {
  if (hasBinding(env, name)) {
    return;
  }
  const native = createNativeFunction(name, 2, (args, span) => {
    const left = expectInt(args[0], span, name);
    const right = expectInt(args[1], span, name);
    return { kind: "int", value: impl(left, right, span) } satisfies IntValue;
  });
  bindValue(env, name, native);
}

function bindNativeAlias(
  env: Environment,
  alias: string,
  target: string,
): void {
  if (hasBinding(env, alias) || !hasBinding(env, target)) {
    return;
  }
  const value = lookupValue(env, target);
  bindValue(env, alias, value);
}

function createOrderingValue(name: "LT" | "EQ" | "GT"): DataValue {
  return { kind: "data", constructor: name, fields: [] } satisfies DataValue;
}

function bindCmpIntNative(env: Environment, name: string): void {
  if (hasBinding(env, name)) {
    return;
  }
  const lt = createOrderingValue("LT");
  const eq = createOrderingValue("EQ");
  const gt = createOrderingValue("GT");
  const native = createNativeFunction(name, 2, (args, span) => {
    const left = expectInt(args[0], span, name);
    const right = expectInt(args[1], span, name);
    if (left < right) {
      return lt;
    }
    if (left > right) {
      return gt;
    }
    return eq;
  });
  bindValue(env, name, native);
}

function bindStrFromLiteralNative(env: Environment, name: string): void {
  if (hasBinding(env, name)) {
    return;
  }
  const native = createNativeFunction(name, 1, (args, span) => {
    const str = expectString(args[0], span, name);
    // Convert string to list of character codes
    let result: RuntimeValue = {
      kind: "data",
      constructor: "Empty",
      fields: [],
    };
    for (let i = str.length - 1; i >= 0; i--) {
      const charCode: RuntimeValue = { kind: "int", value: str.charCodeAt(i) };
      result = {
        kind: "data",
        constructor: "Link",
        fields: [charCode, result],
      };
    }
    return result;
  });
  bindValue(env, name, native);
}

function bindCharEqNative(env: Environment, name: string): void {
  if (hasBinding(env, name)) {
    return;
  }
  const native = createNativeFunction(name, 2, (args, span) => {
    const left = expectChar(args[0], span, name);
    const right = expectChar(args[1], span, name);
    return { kind: "bool", value: left === right } satisfies BoolValue;
  });
  bindValue(env, name, native);
}

function bindPrintNative(
  env: Environment,
  name: string,
  onPrint?: (text: string) => void,
): void {
  if (hasBinding(env, name)) {
    return;
  }
  const native = createNativeFunction(name, 1, (args) => {
    const value = args[0];
    const text = formatRuntimeValue(value);
    if (onPrint) {
      onPrint(text);
    } else {
      console.log(text);
    }
    return UNIT_VALUE;
  });
  bindValue(env, name, native);
}

function evaluateRecursiveBindings(
  env: Environment,
  bindings: LetDeclaration[],
): Map<string, RuntimeValue> {
  const frame = createEnvironment(env);

  for (const binding of bindings) {
    bindValue(frame, binding.name, UNIT_VALUE);
  }

  const results = new Map<string, RuntimeValue>();

  for (const binding of bindings) {
    if (binding.parameters.length === 0) {
      throw new RuntimeError(
        "Recursive let bindings must define at least one parameter",
        binding.span,
        currentSource,
      );
    }

    const value = createClosure(env, binding, frame);
    bindValue(frame, binding.name, value);
    results.set(binding.name, value);
  }

  for (const [name, value] of results.entries()) {
    bindValue(env, name, value);
  }

  return results;
}

function evaluateMatchExpr(
  env: Environment,
  scrutineeExpr: Expr,
  bundle: MatchBundle,
  span: SourceSpan,
): RuntimeValue {
  const scrutinee = evaluateExpr(env, scrutineeExpr);
  return applyMatchBundle(env, bundle, scrutinee, span);
}

function evaluateMatchFunction(
  env: Environment,
  parameters: Expr[],
  bundle: MatchBundle,
  span: SourceSpan,
): RuntimeValue {
  if (parameters.length !== 1) {
    throw new RuntimeError(
      "Match functions currently support exactly one argument",
      span,
      currentSource,
    );
  }

  const closureEnv = env;
  return createNativeFunction("match_fn", 1, ([arg]) => {
    return applyMatchBundle(closureEnv, bundle, arg, span);
  });
}

function evaluateMatchBundleLiteral(
  env: Environment,
  expr: MatchBundleLiteralExpr,
): RuntimeValue {
  const bundle = expr.bundle;
  const native = createNativeFunction(
    "match_bundle",
    1,
    ([arg], span) => applyMatchBundle(env, bundle, arg, span),
  );
  native.matchBundleInfo = { bundle, env };
  return native;
}

function applyMatchBundle(
  env: Environment,
  bundle: MatchBundle,
  scrutinee: RuntimeValue,
  span: SourceSpan | undefined,
): RuntimeValue {
  const arms = expandMatchArms(env, bundle.arms);
  for (const arm of arms) {
    const bindings = matchPattern(env, scrutinee, arm.pattern);
    if (!bindings) {
      continue;
    }
    const scope = createEnvironment(env);
    for (const [name, value] of bindings.entries()) {
      bindValue(scope, name, value);
    }
    return evaluateExpr(scope, arm.body);
  }
  const errorSpan = span ?? bundle.span;
  throw new RuntimeError(
    "Non-exhaustive patterns at runtime",
    errorSpan,
    currentSource,
  );
}

function expandMatchArms(env: Environment, arms: MatchArm[]): MatchPatternArm[] {
  const result: MatchPatternArm[] = [];
  for (const arm of arms) {
    if (arm.kind === "match_bundle_reference") {
      const referenced = lookupValue(env, arm.name);
      if (referenced.kind !== "native" || !referenced.matchBundleInfo) {
        throw new RuntimeError(`'${arm.name}' is not a match bundle`, arm.span, currentSource);
      }
      const { bundle, env: bundleEnv } = referenced.matchBundleInfo;
      const expanded = expandMatchArms(bundleEnv, bundle.arms);
      result.push(...expanded);
      continue;
    }
    result.push(arm);
  }
  return result;
}

function matchPattern(
  env: Environment,
  value: RuntimeValue,
  pattern: Pattern,
): Map<string, RuntimeValue> | null {
  const kind = pattern.kind;
  const span = pattern.span;
  switch (kind) {
    case "wildcard":
      return new Map();
    case "variable": {
      const map = new Map<string, RuntimeValue>();
      map.set(pattern.name, value);
      return map;
    }
    case "literal":
      return matchLiteralPattern(value, pattern.literal);
    case "tuple":
      return matchTuplePattern(env, value, pattern.elements, pattern.span);
    case "constructor":
      return matchConstructorPattern(env, value, pattern, pattern.span);
    default:
      assertUnreachable(pattern, `Unsupported pattern kind '${kind}'`, span);
  }
}

function matchLiteralPattern(
  value: RuntimeValue,
  literal: Literal,
): Map<string, RuntimeValue> | null {
  switch (literal.kind) {
    case "int":
      return isIntValue(value, literal.value) ? new Map() : null;
    case "bool":
      return isBoolValue(value, literal.value) ? new Map() : null;
    case "char":
      return value.kind === "char" &&
          value.value === literal.value.charCodeAt(0)
        ? new Map()
        : null;
    case "unit":
      return value.kind === "unit" ? new Map() : null;
    case "string":
      return value.kind === "string" && value.value === literal.value
        ? new Map()
        : null;
    default:
      return null;
  }
}

function matchTuplePattern(
  env: Environment,
  value: RuntimeValue,
  elements: Pattern[],
  span: SourceSpan,
): Map<string, RuntimeValue> | null {
  if (value.kind !== "tuple") {
    return null;
  }
  if (value.elements.length !== elements.length) {
    throw new RuntimeError("Tuple pattern arity mismatch", span, currentSource);
  }
  const bindings = new Map<string, RuntimeValue>();
  for (let i = 0; i < elements.length; i += 1) {
    const match = matchPattern(env, value.elements[i], elements[i]);
    if (!match) {
      return null;
    }
    mergeBindings(bindings, match, elements[i].span);
  }
  return bindings;
}

function matchConstructorPattern(
  env: Environment,
  value: RuntimeValue,
  pattern: Pattern & { kind: "constructor" },
  span: SourceSpan,
): Map<string, RuntimeValue> | null {
  if (value.kind === "native") {
    const applied = applyValue(value, [], span);
    return matchConstructorPattern(env, applied, pattern, span);
  }

  if (value.kind !== "data" || value.constructor !== pattern.name) {
    return null;
  }

  if (value.fields.length !== pattern.args.length) {
    throw new RuntimeError(
      "Constructor pattern arity mismatch",
      span,
      currentSource,
    );
  }

  const bindings = new Map<string, RuntimeValue>();
  for (let i = 0; i < pattern.args.length; i += 1) {
    const match = matchPattern(env, value.fields[i], pattern.args[i]);
    if (!match) {
      return null;
    }
    mergeBindings(bindings, match, pattern.args[i].span);
  }
  return bindings;
}

function mergeBindings(
  target: Map<string, RuntimeValue>,
  source: Map<string, RuntimeValue>,
  span: SourceSpan,
): void {
  for (const [key, value] of source.entries()) {
    if (target.has(key)) {
      throw new RuntimeError(
        `Duplicate variable '${key}' in pattern`,
        span,
        currentSource,
      );
    }
    target.set(key, value);
  }
}

function isIntValue(value: RuntimeValue, expected: number): value is IntValue {
  return value.kind === "int" && value.value === expected;
}

function isBoolValue(
  value: RuntimeValue,
  expected: boolean,
): value is BoolValue {
  return value.kind === "bool" && value.value === expected;
}

function assertUnreachable(
  _value: never,
  message: string,
  span?: SourceSpan,
): never {
  throw new RuntimeError(message, span, currentSource);
}

function expectInt(
  value: RuntimeValue,
  span: SourceSpan | undefined,
  primitiveName: string,
): number {
  if (value.kind !== "int") {
    throw new RuntimeError(
      `Primitive '${primitiveName}' expected an Int argument`,
      span,
      currentSource,
    );
  }
  return value.value;
}

function expectChar(
  value: RuntimeValue,
  span: SourceSpan | undefined,
  primitiveName: string,
): number {
  if (value.kind !== "char") {
    throw new RuntimeError(
      `Primitive '${primitiveName}' expected a Char argument`,
      span,
      currentSource,
    );
  }
  return value.value;
}

function expectString(
  value: RuntimeValue,
  span: SourceSpan | undefined,
  primitiveName: string,
): string {
  if (value.kind !== "string") {
    throw new RuntimeError(
      `Primitive '${primitiveName}' expected a String argument`,
      span,
      currentSource,
    );
  }
  return value.value;
}
