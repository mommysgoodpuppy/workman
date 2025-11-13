import type {
  BlockExpr,
  MatchBundle,
  Parameter,
  SourceSpan,
} from "@workman/ast.ts";

export type RuntimeValue =
  | IntValue
  | BoolValue
  | CharValue
  | StringValue
  | UnitValue
  | TupleValue
  | RecordValue
  | DataValue
  | ClosureValue
  | NativeFunctionValue;

export interface IntValue {
  kind: "int";
  value: number;
}

export interface BoolValue {
  kind: "bool";
  value: boolean;
}

export interface CharValue {
  kind: "char";
  value: number; // Unicode code point
}

export interface StringValue {
  kind: "string";
  value: string;
}

export interface UnitValue {
  kind: "unit";
}

export interface TupleValue {
  kind: "tuple";
  elements: RuntimeValue[];
}

export interface RecordValue {
  kind: "record";
  fields: Map<string, RuntimeValue>;
}

export interface DataValue {
  kind: "data";
  constructor: string;
  fields: RuntimeValue[];
}

export interface ClosureValue {
  kind: "closure";
  parameters: Parameter[];
  body: BlockExpr;
  env: Environment;
}

export interface NativeFunctionValue {
  kind: "native";
  name: string;
  arity: number;
  collectedArgs: RuntimeValue[];
  impl: (args: RuntimeValue[], span: SourceSpan | undefined) => RuntimeValue;
  matchBundleInfo?: {
    bundle: MatchBundle;
    env: Environment;
  };
}

export interface Environment {
  readonly parent: Environment | null;
  readonly bindings: Map<string, RuntimeValue>;
}

export function createEnvironment(
  parent: Environment | null = null,
): Environment {
  return {
    parent,
    bindings: new Map(),
  };
}

export function bindValue(
  env: Environment,
  name: string,
  value: RuntimeValue,
): void {
  env.bindings.set(name, value);
}

export function updateValue(
  env: Environment,
  name: string,
  value: RuntimeValue,
): boolean {
  if (env.bindings.has(name)) {
    env.bindings.set(name, value);
    return true;
  }
  if (env.parent) {
    return updateValue(env.parent, name, value);
  }
  return false;
}

export function lookupValue(env: Environment, name: string): RuntimeValue {
  if (env.bindings.has(name)) {
    return env.bindings.get(name)!;
  }
  if (env.parent) {
    return lookupValue(env.parent, name);
  }
  throw new RuntimeError(`Unknown identifier '${name}'`);
}

export function hasBinding(env: Environment, name: string): boolean {
  if (env.bindings.has(name)) {
    return true;
  }
  if (env.parent) {
    return hasBinding(env.parent, name);
  }
  return false;
}

export class RuntimeError extends Error {
  constructor(message: string, public readonly span?: SourceSpan) {
    super(message);
    this.name = "RuntimeError";
  }
}

export const UNIT_VALUE: UnitValue = Object.freeze({ kind: "unit" });
