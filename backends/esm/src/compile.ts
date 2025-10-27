// Main compilation pipeline: Workman source → ESM JavaScript

import { lex } from "../../../src/lexer.ts";
import { parseSurfaceProgram } from "../../../src/parser.ts";
import { inferProgram } from "../../../src/infer.ts";
import { lowerToCore } from "./lower_to_core.ts";
import { lowerToMir } from "./lower_to_mir.ts";
import { generateESM } from "./codegen.ts";
import { buildModuleGraph } from "./module_resolver.ts";
import { compileModuleGraph } from "./module_compiler.ts";
import type { ModuleResolverOptions } from "./module_resolver.ts";

export interface CompileOptions {
  sourceName?: string;
  // Module compilation options
  useModules?: boolean;
  stdRoots?: string[];
  preludeModule?: string;
}

export interface CompileResult {
  js: string;
  errors?: string[];
}

/**
 * Compile Workman source code to ESM JavaScript (single file)
 */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  try {
    // Lexing
    const tokens = lex(source, options.sourceName);

    // Parsing
    const program = parseSurfaceProgram(tokens, source);

    // Type inference
    const inferResult = inferProgram(program);

    // Lower to Core IR
    const core = lowerToCore(program, inferResult);

    // Lower to MIR
    const mir = lowerToMir(core);

    // Generate JavaScript
    const js = generateESM(mir);

    return { js };
  } catch (error) {
    return {
      js: "",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Compile a Workman file to JavaScript (single file)
 */
export async function compileFile(inputPath: string, outputPath?: string): Promise<CompileResult> {
  const source = await Deno.readTextFile(inputPath);
  const result = compile(source, { sourceName: inputPath });

  if (outputPath && !result.errors) {
    await Deno.writeTextFile(outputPath, result.js);
  }

  return result;
}

/**
 * Compile a Workman project with modules
 */
export async function compileProject(
  entryPath: string,
  options: CompileOptions = {}
): Promise<{ modules: Map<string, { path: string; js: string }>; errors?: string[] }> {
  try {
    const resolverOptions: ModuleResolverOptions = {
      stdRoots: options.stdRoots,
      preludeModule: options.preludeModule,
    };

    // Build module graph
    const graph = await buildModuleGraph(entryPath, resolverOptions);

    // Compile all modules
    const result = compileModuleGraph(graph);

    if (result.errors) {
      return { modules: new Map(), errors: result.errors };
    }

    // Convert to output format
    const modules = new Map<string, { path: string; js: string }>();
    for (const [path, compiled] of result.modules) {
      modules.set(path, {
        path: compiled.jsPath,
        js: compiled.jsCode,
      });
    }

    return { modules };
  } catch (error) {
    return {
      modules: new Map(),
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Compile a Workman project and write all output files
 */
export async function compileProjectToFiles(
  entryPath: string,
  options: CompileOptions = {}
): Promise<{ errors?: string[] }> {
  const result = await compileProject(entryPath, options);

  if (result.errors) {
    return { errors: result.errors };
  }

  // Write all compiled modules
  for (const [_, module] of result.modules) {
    await Deno.writeTextFile(module.path, module.js);
  }

  return {};
}
