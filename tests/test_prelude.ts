import { loadPreludeEnvironment } from "../src/module_loader.ts";
import {
  cloneTypeScheme,
  cloneTypeInfo,
  type TypeScheme,
  type TypeInfo,
} from "../src/types.ts";
import type { OperatorInfo } from "../src/parser.ts";

const preludeData = await loadPreludeEnvironment();

function cloneSchemeMap(
  source: Map<string, TypeScheme>,
): Map<string, TypeScheme> {
  const clone = new Map<string, TypeScheme>();
  for (const [key, scheme] of source.entries()) {
    clone.set(key, cloneTypeScheme(scheme));
  }
  return clone;
}

function cloneTypeInfoMap(
  source: Map<string, TypeInfo>,
): Map<string, TypeInfo> {
  const clone = new Map<string, TypeInfo>();
  for (const [key, info] of source.entries()) {
    clone.set(key, cloneTypeInfo(info));
  }
  return clone;
}

export function freshPreludeTypeEnv(): {
  initialEnv: Map<string, TypeScheme>;
  initialAdtEnv: Map<string, TypeInfo>;
  initialOperators: Map<string, OperatorInfo>;
  initialPrefixOperators: Set<string>;
} {
  return {
    initialEnv: cloneSchemeMap(preludeData.env),
    initialAdtEnv: cloneTypeInfoMap(preludeData.adtEnv),
    initialOperators: new Map(preludeData.operators),
    initialPrefixOperators: new Set(preludeData.prefixOperators),
  };
}
