import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph as emitJsModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { emitModuleGraph as emitZigModuleGraph } from "../backends/compiler/zig/graph_emitter.ts";
import { IO, relative, resolve } from "../src/io.ts";

async function runZigFmt(files: string[]): Promise<void> {
  if (files.length === 0) return;
  const command = new Deno.Command("zig", {
    args: ["fmt", ...files],
    stdout: "null",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.warn(`zig fmt warning: ${stderr}`);
  }
}

export type CompileBackend = "js" | "zig";

export interface CompileArgs {
  entryPath: string;
  outDir?: string;
  backend: CompileBackend;
}

export function parseCompileArgs(args: string[]): CompileArgs {
  let entryPath: string | undefined;
  let outDir: string | undefined;
  let backend: CompileBackend | undefined;

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
    if (arg === "--backend" || arg === "-b") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --backend");
      }
      if (value !== "js" && value !== "zig") {
        throw new Error(`Unknown backend '${value}' (expected 'js' or 'zig')`);
      }
      backend = value;
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
    throw new Error(
      "Usage: wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>]",
    );
  }

  return { entryPath, outDir, backend: backend ?? "zig" };
}

export async function compileToDirectory(
  entryPath: string,
  outDir?: string,
  backend: CompileBackend = "zig",
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

  const emitResult = backend === "zig"
    ? await emitZigModuleGraph(compileResult.coreGraph, {
      outDir: resolvedOutDir,
    })
    : await emitJsModuleGraph(compileResult.coreGraph, {
      outDir: resolvedOutDir,
    });

  // Run zig fmt on all emitted .zig files
  if (backend === "zig") {
    const zigFiles = [...emitResult.moduleFiles.values()].filter((f) =>
      f.endsWith(".zig")
    );
    if (emitResult.runtimePath.endsWith(".zig")) {
      zigFiles.push(emitResult.runtimePath);
    }
    if ("rootPath" in emitResult && emitResult.rootPath.endsWith(".zig")) {
      zigFiles.push(emitResult.rootPath);
    }
    await runZigFmt(zigFiles);
  }

  console.log(
    `Emitted ${emitResult.moduleFiles.size} module(s) to ${resolvedOutDir}`,
  );
  const entryRelative = relative(IO.cwd(), emitResult.entryPath);
  const runtimeRelative = relative(IO.cwd(), emitResult.runtimePath);
  console.log(`Entry module: ${entryRelative}`);
  console.log(`Runtime module: ${runtimeRelative}`);
  if ("rootPath" in emitResult) {
    const rootRelative = relative(IO.cwd(), emitResult.rootPath);
    console.log(`Root module: ${rootRelative}`);
  }
}
