import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph as emitJsModuleGraph } from "../backends/compiler/js/graph_emitter.ts";
import { emitModuleGraph as emitZigModuleGraph } from "../backends/compiler/zig/graph_emitter.ts";
import { elaborateCarrierOpsGraph } from "../backends/compiler/passes/elaborate_carriers.ts";
import { dirname, fromFileUrl, IO, relative, resolve } from "../src/io.ts";
import { createDefaultForeignTypeConfig } from "../src/foreign_types/c_header_provider.ts";
import {
  applyTraceFlag,
  DEFAULT_TRACE_OPTIONS,
  type TraceOptions,
} from "./trace_options.ts";
import {
  generateWmSourceMaps,
  reportWorkmanDiagnosticsForZig,
} from "./zig_diagnostics.ts";

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
  force: boolean;
  debug: boolean;
  traceOptions: TraceOptions;
}

export function parseCompileArgs(
  args: string[],
  allowEmpty = false,
  baseTraceOptions: TraceOptions = DEFAULT_TRACE_OPTIONS,
): CompileArgs {
  let entryPath: string | undefined;
  let outDir: string | undefined;
  let backend: CompileBackend | undefined;
  let force = false;
  let debug = false;
  const traceOptions: TraceOptions = { ...baseTraceOptions };

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
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (applyTraceFlag(arg, traceOptions)) {
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
      "Usage: wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>] [--force] [--debug]",
    );
  }

  return {
    entryPath: entryPath ?? "",
    outDir,
    backend: backend ?? "zig",
    force,
    debug,
    traceOptions,
  };
}

export async function compileToDirectory(
  entryPath: string,
  outDir?: string,
  backend: CompileBackend = "zig",
  force = false,
  debug = false,
  traceOptions: TraceOptions = DEFAULT_TRACE_OPTIONS,
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
      foreignTypes: createDefaultForeignTypeConfig(resolvedEntry),
    },
    lowering: {
      showAllErrors: true,
    },
  });

  let hasErrors = false;
  for (const artifact of compileResult.modules.values()) {
    const layer3 = artifact.analysis.layer3;
    if (
      layer3.diagnostics.solver.length > 0 ||
      layer3.diagnostics.conflicts.length > 0
    ) {
      hasErrors = true;
    }
  }

  if (hasErrors && !force) {
    // Errors are already printed by lowerAnalyzedModule/showAllErrors
    throw new Error(
      "Compilation failed due to type errors. Use --force to compile anyway.",
    );
  }
  if (hasErrors) {
    console.warn("Compilation continued despite type errors (--force used).");
  }

  // Save IR to file if --debug flag is set
  if (debug) {
    await IO.ensureDir(resolvedOutDir);
    const irPath = resolve(resolvedOutDir, "debug_ir.json");
    const elaboratedPath = resolve(resolvedOutDir, "debug_ir_elaborated.json");
    const elaboratedGraph = elaborateCarrierOpsGraph(compileResult.coreGraph);
    // Convert ReadonlyMap to plain object for JSON serialization
    const serializableGraph = {
      entry: compileResult.coreGraph.entry,
      order: compileResult.coreGraph.order,
      modules: Object.fromEntries(compileResult.coreGraph.modules),
      prelude: compileResult.coreGraph.prelude,
    };
    const serializableElaborated = {
      entry: elaboratedGraph.entry,
      order: elaboratedGraph.order,
      modules: Object.fromEntries(elaboratedGraph.modules),
      prelude: elaboratedGraph.prelude,
    };
    const irJson = JSON.stringify(serializableGraph, null, 2);
    const elaboratedJson = JSON.stringify(serializableElaborated, null, 2);
    await Deno.writeTextFile(irPath, irJson);
    await Deno.writeTextFile(elaboratedPath, elaboratedJson);
    const irRelative = relative(IO.cwd(), irPath);
    const elaboratedRelative = relative(IO.cwd(), elaboratedPath);
    console.log(`IR saved to: ${irRelative}`);
    console.log(`Elaborated IR saved to: ${elaboratedRelative}`);
  }

  const emitResult = backend === "zig"
    ? await emitZigModuleGraph(compileResult.coreGraph, {
      outDir: resolvedOutDir,
      traceOptions,
    })
    : await emitJsModuleGraph(compileResult.coreGraph, {
      outDir: resolvedOutDir,
    });

  // Run zig fmt on all emitted .zig files
  if (backend === "zig") {
    const zigResult = emitResult as Awaited<ReturnType<typeof emitZigModuleGraph>>;
    const zigFiles = [...zigResult.moduleFiles.values()].filter((f) =>
      f.endsWith(".zig")
    );
    if (zigResult.runtimePath?.endsWith(".zig")) {
      zigFiles.push(zigResult.runtimePath);
    }
    if (zigResult.rootPath?.endsWith(".zig")) {
      zigFiles.push(zigResult.rootPath);
    }
    await runZigFmt(zigFiles);
    await generateWmSourceMaps(zigFiles);
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
  if (backend === "zig") {
    const zigResult = emitResult as Awaited<ReturnType<typeof emitZigModuleGraph>>;
    if (zigResult.rootPath) {
      const rootRelative = relative(IO.cwd(), zigResult.rootPath);
      console.log(`Root module: ${rootRelative}`);
    }
  }
}

/**
 * Handle 'wm build' command - like 'zig build' but for workman.
 * Auto-detects build.wm in cwd, compiles to build.zig, then runs zig build.
 */
export async function runBuildCommand(
  args: string[],
  traceOptions: TraceOptions = DEFAULT_TRACE_OPTIONS,
): Promise<void> {
  // Parse force flag and optional directory from args
  let force = false;
  let buildDirPath: string | undefined;
  const remainingArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (applyTraceFlag(arg, traceOptions)) {
      // Trace flags are handled by the caller
    } else if (!arg.startsWith("-") && !buildDirPath) {
      // Check if this looks like a directory path (ends with separator or exists and contains build.wm)
      const looksLikeDir = arg.endsWith("/") || arg.endsWith("\\");
      if (looksLikeDir) {
        buildDirPath = arg;
      } else {
        // Check if it's a directory that exists and contains build.wm
        try {
          const testPath = resolve(arg);
          const stat = await Deno.stat(testPath);
          if (stat.isDirectory) {
            const testBuildWmPath = resolve(testPath, "build.wm");
            try {
              await Deno.stat(testBuildWmPath);
              buildDirPath = arg;
            } catch {
              // Not a directory with build.wm, treat as zig build arg
              remainingArgs.push(arg);
            }
          } else {
            // Not a directory, treat as zig build arg
            remainingArgs.push(arg);
          }
        } catch {
          // Path doesn't exist, treat as zig build arg
          remainingArgs.push(arg);
        }
      }
    } else {
      remainingArgs.push(arg);
    }
  }

  // Determine build.wm path - either in specified directory or current directory
  let buildWmPath: string;
  if (buildDirPath) {
    buildWmPath = resolve(buildDirPath, "build.wm");
  } else {
    buildWmPath = resolve("build.wm");
  }

  // Check if build.wm exists
  try {
    await Deno.stat(buildWmPath);
  } catch {
    const searchPath = buildDirPath ? `directory '${buildDirPath}'` : "current directory";
    throw new Error(`No build.wm found in ${searchPath}`);
  }

  const buildDir = dirname(buildWmPath);
  const buildZigPath = resolve(buildDir, "build.zig");

  // Compile build.wm to build.zig
  console.log("Compiling build.wm to build.zig...");
  const compileResult = await compileWorkmanGraph(buildWmPath, {
    loader: {
      stdRoots: [resolve(WORKMAN_ROOT, "std")],
      preludeModule: "std/prelude",
      foreignTypes: createDefaultForeignTypeConfig(buildWmPath),
    },
    lowering: {
      showAllErrors: true,
    },
  });

  // Check for type errors
  let hasErrors = false;
  for (const artifact of compileResult.modules.values()) {
    const layer3 = artifact.analysis.layer3;
    if (
      layer3.diagnostics.solver.length > 0 ||
      layer3.diagnostics.conflicts.length > 0
    ) {
      hasErrors = true;
    }
  }

  if (hasErrors && !force) {
    // Errors are already printed by lowerAnalyzedModule/showAllErrors
    throw new Error(
      "Compilation failed due to type errors. Use --force to compile anyway.",
    );
  }
  if (hasErrors) {
    console.warn("Compilation continued despite type errors (--force used).");
  }

  // Emit to the build directory (will create build.zig from build.wm)
  // Use buildDir as commonRoot so build.wm emits directly as build.zig
  const emitResult = await emitZigModuleGraph(compileResult.coreGraph, {
    outDir: buildDir,
    commonRoot: buildDir,
    emitRuntime: false,
    emitRootMain: false,
    traceOptions,
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
        foreignTypes: createDefaultForeignTypeConfig(absoluteWmPath),
      },
      lowering: {
        showAllErrors: true,
      },
    });

    // Check for type errors in source files
    let sourceHasErrors = false;
    for (const artifact of sourceCompileResult.modules.values()) {
      const layer3 = artifact.analysis.layer3;
      if (
        layer3.diagnostics.solver.length > 0 ||
        layer3.diagnostics.conflicts.length > 0
      ) {
        sourceHasErrors = true;
      }
    }

    if (sourceHasErrors && !force) {
      // Errors are already printed by lowerAnalyzedModule/showAllErrors
      throw new Error(
        "Compilation failed due to type errors. Use --force to compile anyway.",
      );
    }
    if (sourceHasErrors) {
      console.warn("Compilation continued despite type errors (--force used).");
    }

    await emitZigModuleGraph(sourceCompileResult.coreGraph, {
      outDir: buildDir,
      commonRoot: buildDir,
      emitRuntime: false,
      emitRootMain: false,
      traceOptions,
    });

    zigFilesToFormat.push(zigOutputPath);
  }

  // Run zig fmt on all generated .zig files
  await runZigFmt(zigFilesToFormat);
  await generateWmSourceMaps(zigFilesToFormat);

  console.log("Running zig build...");

  // Pass through any additional args to zig build (excluding the directory argument if it was used)
  const zigArgs = ["build", "--color", "on", ...remainingArgs];
  const command = new Deno.Command("zig", {
    args: zigArgs,
    cwd: buildDir,
    stdout: "inherit",
    stderr: "piped",
  });

  const result = await command.output();
  if (!result.success) {
    if (result.stderr.length > 0) {
      await Deno.stderr.write(result.stderr);
    }
    const stderrText = new TextDecoder().decode(result.stderr);
    await reportWorkmanDiagnosticsForZig(stderrText, buildDir);
    throw new Error(`zig build failed with exit code ${result.code}`);
  }
}

