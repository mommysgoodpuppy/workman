import { loadPreludeEnvironment } from "../src/module_loader.ts";
import {
  cloneTypeInfo,
  cloneTypeScheme,
  type TypeInfo,
  type TypeScheme,
} from "../src/types.ts";
import type { OperatorInfo } from "../src/parser.ts";
import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { toFileUrl } from "std/path/mod.ts";
import { formatScheme } from "../src/type_printer.ts";

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

/**
 * Format a value from compiled JavaScript code for display.
 * Compiled values are native JS objects/values, not interpreter RuntimeValue objects.
 */
function formatCompiledValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Void";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (typeof value === "function") {
    return "<function>";
  }

  // Handle ADT constructors - they have a __tag property
  if (typeof value === "object" && value !== null) {
    const obj = value as { __tag?: string; [key: string]: unknown };
    if (obj.__tag) {
      const tag = obj.__tag;
      const fields = Object.entries(obj)
        .filter(([k]) => k !== "__tag")
        .map(([_, v]) => formatCompiledValue(v));

      if (fields.length === 0) {
        return tag;
      }
      return `${tag} ${fields.join(" ")}`;
    }
  }

  return String(value);
}

/**
 * Compile and execute a Workman module using the compiler backend.
 * Returns types and values similar to runEntryPath but using compiled JS.
 */
export async function runCompiledEntryPath(
  entryPath: string,
): Promise<{
  types: Array<{ name: string; type: string }>;
  values: Array<{ name: string; value: string }>;
  runtimeLogs: string[];
}> {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Compile the Workman code to JavaScript
    const { coreGraph, modules } = await compileWorkmanGraph(entryPath);

    // Get the entry module artifacts
    const entryModule = modules.get(coreGraph.entry);
    if (!entryModule) {
      throw new Error(`Entry module '${coreGraph.entry}' not found`);
    }

    // Check for diagnostics
    if (entryModule.analysis.layer2.diagnostics.length > 0) {
      console.log("Diagnostics in runCompiledEntryPath:", entryModule.analysis.layer2.diagnostics);
    }

    // Emit JavaScript files
    const result = await emitModuleGraph(coreGraph, { outDir: tmpDir });

    // Import and execute the compiled entry module
    const entryUrl = toFileUrl(result.entryPath).href;
    const mod = await import(entryUrl);

    // Extract types from layer3 (which has resolved types)
    const types: Array<{ name: string; type: string }> = [];
    for (const summary of entryModule.analysis.layer3.summaries) {
      const typeStr = formatScheme(summary.scheme);
      types.push({
        name: summary.name,
        type: typeStr,
      });
    }

    // Extract values from the compiled module
    const values: Array<{ name: string; value: string }> = [];
    for (const summary of entryModule.analysis.layer3.summaries) {
      const runtimeValue = mod[summary.name];
      if (runtimeValue !== undefined) {
        // For compiled code, values are native JS - need to convert to string
        // Functions should be called if they take Unit
        let displayValue = runtimeValue;
        if (typeof runtimeValue === "function") {
          // Check if it's a Unit -> T function by trying to call it with undefined
          try {
            displayValue = runtimeValue(undefined);
          } catch {
            displayValue = runtimeValue;
          }
        }
        values.push({
          name: summary.name,
          value: formatCompiledValue(displayValue),
        });
      }
    }

    return {
      types,
      values,
      runtimeLogs: [], // Compiled code doesn't capture print statements yet
    };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}
