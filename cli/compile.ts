import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { IO, relative, resolve } from "../src/io.ts";

export interface CompileArgs {
  entryPath: string;
  outDir?: string;
}

export function parseCompileArgs(args: string[]): CompileArgs {
  let entryPath: string | undefined;
  let outDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out-dir" || arg === "-o") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --out-dir");
      }
      outDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown compile option '${arg}'`);
    }
    if (entryPath) {
      throw new Error("Multiple entry paths provided to compile");
    }
    entryPath = arg;
  }

  if (!entryPath) {
    throw new Error("Usage: wm compile <file.wm> [--out-dir <dir>]");
  }

  return { entryPath, outDir };
}

export async function compileToDirectory(
  entryPath: string,
  outDir?: string,
): Promise<void> {
  if (!entryPath.endsWith(".wm")) {
    throw new Error("Expected a .wm entry file");
  }

  const resolvedEntry = resolve(entryPath);
  const resolvedOutDir = resolve(outDir ?? "dist");

  const compileResult = await compileWorkmanGraph(resolvedEntry, {
    loader: {
      stdRoots: [resolve("std")],
      preludeModule: "std/prelude",
    },
  });

  const emitResult = await emitModuleGraph(compileResult.coreGraph, {
    outDir: resolvedOutDir,
  });

  console.log(
    `Emitted ${emitResult.moduleFiles.size} module(s) to ${resolvedOutDir}`,
  );
  const entryRelative = relative(IO.cwd(), emitResult.entryPath);
  const runtimeRelative = relative(IO.cwd(), emitResult.runtimePath);
  console.log(`Entry module: ${entryRelative}`);
  console.log(`Runtime module: ${runtimeRelative}`);
}
