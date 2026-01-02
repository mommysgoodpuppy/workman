import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph as emitJsModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { emitModuleGraph as emitZigModuleGraph } from "../backends/compiler/zig/graph_emitter.ts";
import { IO, relative, resolve, dirname, fromFileUrl } from "../src/io.ts";

const WORKMAN_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

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

export function parseCompileArgs(args: string[], allowEmpty = false): CompileArgs {
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

  if (!entryPath && !allowEmpty) {
    throw new Error(
      "Usage: wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>]",
    );
  }

  return { entryPath: entryPath ?? "", outDir, backend: backend ?? "zig" };
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
      stdRoots: [resolve(WORKMAN_ROOT, "std")],
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
    if (emitResult.runtimePath?.endsWith(".zig")) {
      zigFiles.push(emitResult.runtimePath);
    }
    if (emitResult.rootPath?.endsWith(".zig")) {
      zigFiles.push(emitResult.rootPath);
    }
    await runZigFmt(zigFiles);
  }

  console.log(
    `Emitted ${emitResult.moduleFiles.size} module(s) to ${resolvedOutDir}`,
  );
  const entryRelative = relative(IO.cwd(), emitResult.entryPath);
  console.log(`Entry module: ${entryRelative}`);
  if (emitResult.runtimePath) {
    const runtimeRelative = relative(IO.cwd(), emitResult.runtimePath);
    console.log(`Runtime module: ${runtimeRelative}`);
  }
  if (emitResult.rootPath) {
    const rootRelative = relative(IO.cwd(), emitResult.rootPath);
    console.log(`Root module: ${rootRelative}`);
  }
}

/**
 * Handle 'wm build' command - like 'zig build' but for workman.
 * Auto-detects build.wm in cwd, compiles to build.zig, then runs zig build.
 */
export async function runBuildCommand(args: string[]): Promise<void> {
  const buildWmPath = resolve("build.wm");
  
  // Check if build.wm exists
  try {
    await Deno.stat(buildWmPath);
  } catch {
    throw new Error("No build.wm found in current directory");
  }

  const buildDir = dirname(buildWmPath);
  const buildZigPath = resolve(buildDir, "build.zig");

  // Compile build.wm to build.zig
  console.log("Compiling build.wm to build.zig...");
  const compileResult = await compileWorkmanGraph(buildWmPath, {
    loader: {
      stdRoots: [resolve(WORKMAN_ROOT, "std")],
      preludeModule: "std/prelude",
    },
  });

  // Emit to the build directory (will create build.zig from build.wm)
  // Use buildDir as commonRoot so build.wm emits directly as build.zig
  const emitResult = await emitZigModuleGraph(compileResult.coreGraph, {
    outDir: buildDir,
    commonRoot: buildDir,
    emitRuntime: false,
    emitRootMain: false,
  });

  // Compile any referenced .wm source files to .zig
  const zigFilesToFormat = [buildZigPath];
  for (const wmPath of emitResult.wmSourcePaths) {
    const absoluteWmPath = resolve(buildDir, wmPath);
    const zigOutputPath = resolve(buildDir, wmPath.slice(0, -3) + ".zig");
    
    console.log(`Compiling ${wmPath} to ${wmPath.slice(0, -3)}.zig...`);
    
    const sourceCompileResult = await compileWorkmanGraph(absoluteWmPath, {
      loader: {
        stdRoots: [resolve(WORKMAN_ROOT, "std")],
        preludeModule: "std/prelude",
      },
    });
    
    await emitZigModuleGraph(sourceCompileResult.coreGraph, {
      outDir: buildDir,
      commonRoot: buildDir,
      emitRuntime: false,
      emitRootMain: false,
    });
    
    zigFilesToFormat.push(zigOutputPath);
  }

  // Run zig fmt on all generated .zig files
  await runZigFmt(zigFilesToFormat);

  console.log("Running zig build...");
  
  // Pass through any additional args to zig build
  const zigArgs = ["build", ...args];
  const command = new Deno.Command("zig", {
    args: zigArgs,
    cwd: buildDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  
  const result = await command.output();
  if (!result.success) {
    throw new Error(`zig build failed with exit code ${result.code}`);
  }
}
