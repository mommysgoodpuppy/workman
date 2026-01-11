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
import { Pty } from "@sigma/pty-ffi";
import { writeAll } from "@std/io/write-all";

const WORKMAN_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const RAW_LIVE_TAIL_LIMIT = 8_192;
const DIAGNOSTIC_TAIL_MAX_LINES = 200;
const DIAGNOSTIC_TAIL_MAX_CHARS = 24_576;
const PROGRESS_LINE_PATTERN =
  /^\s*(\[\d+\]\s+Compile Build Script|├─|\└─|\│|\s+Target\.|Build Summary|run\s*$|workman diagnostics:?)/i;

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

async function runZigBuildWithPty(
  args: string[],
  cwd: string,
): Promise<{
  exitCode: number;
  output: string;
  rawLiveOutput: string;
  liveContentPossiblyLost: boolean;
}> {
  const pty = new Pty("zig", { args, cwd });
  if (typeof pty.setPollingInterval === "function") {
    pty.setPollingInterval(1);
  }
  const stopResizeSync = syncPtySizeToStdout(pty);
  const encoder = new TextEncoder();
  const display = new PtyDisplay();
  const preLiveChunks: string[] = [];
  const rawLiveChunks: string[] = [];
  let rawLiveLength = 0;
  let preLiveReplayed = false;
  let liveContentPossiblyLost = false;
  let combinedOutput = "";
  try {
    for await (const chunk of pty.readable) {
      if (chunk.length === 0) continue;
      combinedOutput += chunk;
      const sanitized = sanitizeDisplayChunk(chunk);
      const wasLive = display.isLiveMode();
      if (!wasLive) {
        preLiveChunks.push(sanitized);
      }
      const inLiveMode = display.isLiveMode();
      await display.append(inLiveMode ? chunk : sanitized);
      if (inLiveMode) {
        if (DESTRUCTIVE_ANSI_PATTERN.test(chunk)) {
          liveContentPossiblyLost = true;
        }
        rawLiveChunks.push(chunk);
        rawLiveLength += chunk.length;
        while (
          rawLiveLength > RAW_LIVE_TAIL_LIMIT && rawLiveChunks.length > 1
        ) {
          const removed = rawLiveChunks.shift()!;
          rawLiveLength -= removed.length;
        }
        if (!preLiveReplayed && preLiveChunks.length > 0) {
          await writeAll(Deno.stdout, encoder.encode(preLiveChunks.join("")));
          preLiveChunks.length = 0;
          preLiveReplayed = true;
        }
      }
    }
    await display.finish();
  } finally {
    stopResizeSync?.();
    pty.close();
  }
  return {
    exitCode: pty.exitCode ?? 0,
    output: combinedOutput,
    rawLiveOutput: rawLiveChunks.join(""),
    liveContentPossiblyLost,
  };
}

class PtyDisplay {
  #encoder = new TextEncoder();
  #currentLine = "";
  #lastVisibleLength = 0;
  #emptyLineRun = 0;
  #liveMode = false;

  async append(text: string): Promise<void> {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\r") {
        if (!this.#liveMode) {
          await this.#ensureLiveMode();
        }
        await this.#renderCurrent(false);
        this.#currentLine = "";
      } else if (char === "\n") {
        await this.#renderCurrent(true);
        this.#currentLine = "";
      } else {
        this.#currentLine += char;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.#currentLine.length > 0) {
      await this.#renderCurrent(true);
      this.#currentLine = "";
    }
  }

  isLiveMode(): boolean {
    return this.#liveMode;
  }

  async #ensureLiveMode(): Promise<void> {
    if (this.#liveMode) return;
    this.#liveMode = true;
    if (this.#currentLine.length > 0) {
      await this.#write(`${this.#currentLine}\n`);
      this.#currentLine = "";
    }
    await this.#write("\n");
    this.#lastVisibleLength = 0;
    this.#emptyLineRun = 0;
  }

  async #renderCurrent(newline: boolean): Promise<void> {
    const { visibleLength, hasVisibleChars } = getVisibleMetrics(
      this.#currentLine,
    );
    const isVisiblyEmpty = !hasVisibleChars;
    if (isVisiblyEmpty && !newline) {
      return;
    }
    if (newline) {
      if (isVisiblyEmpty) {
        if (this.#emptyLineRun > 0) {
          return;
        }
        this.#emptyLineRun += 1;
        await this.#write("\n");
        this.#lastVisibleLength = 0;
        return;
      }
      this.#emptyLineRun = 0;
      await this.#write(`${this.#currentLine}\n`);
      this.#lastVisibleLength = 0;
    } else {
      this.#emptyLineRun = 0;
      const padding = this.#lastVisibleLength > visibleLength
        ? " ".repeat(this.#lastVisibleLength - visibleLength)
        : "";
      await this.#write(`\r${this.#currentLine}${padding}`);
      this.#lastVisibleLength = visibleLength;
    }
  }

  async #write(text: string): Promise<void> {
    if (text.length === 0) return;
    await writeAll(Deno.stdout, this.#encoder.encode(text));
  }
}

const ANSI_PATTERN = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const DESTRUCTIVE_ANSI_PATTERN = /\x1B\[[0-9;?]*[JKHhfABCD]/g;

function getVisibleMetrics(text: string): {
  visibleLength: number;
  hasVisibleChars: boolean;
} {
  const stripped = text.replace(ANSI_PATTERN, "");
  const trimmed = stripped.trim();
  return {
    visibleLength: stripped.length,
    hasVisibleChars: trimmed.length > 0,
  };
}

function sanitizeDisplayChunk(text: string): string {
  return text.replace(DESTRUCTIVE_ANSI_PATTERN, "");
}

function extractDiagnosticTail(raw: string): string {
  const sanitized = sanitizeDisplayChunk(raw);
  const lines = sanitized.split(/\r?\n/);
  const important: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (!capturing) {
      const trimmed = line.trim();
      if (
        trimmed.includes("error:") ||
        trimmed.toLowerCase().includes("workman diagnostics") ||
        trimmed.toLowerCase().includes("build summary") ||
        trimmed.toLowerCase().includes("zig build failed")
      ) {
        capturing = true;
      } else {
        continue;
      }
    }
    if (capturing) {
      if (PROGRESS_LINE_PATTERN.test(line)) {
        continue;
      }
      if (important.length === 0 || important[important.length - 1] !== line) {
        important.push(line);
      }
    }
  }
  const limitedLines = important.slice(-DIAGNOSTIC_TAIL_MAX_LINES);
  let tail = limitedLines.join("\n");
  if (tail.length > DIAGNOSTIC_TAIL_MAX_CHARS) {
    tail = tail.slice(tail.length - DIAGNOSTIC_TAIL_MAX_CHARS);
    const firstNewline = tail.indexOf("\n");
    if (firstNewline !== -1) {
      tail = tail.slice(firstNewline + 1);
    }
  }
  return tail.replace(/\s+$/, "");
}

function syncPtySizeToStdout(pty: Pty): (() => void) | undefined {
  if (typeof Deno.consoleSize !== "function") return undefined;

  const applySize = () => {
    try {
      const { columns, rows } = Deno.consoleSize();
      if (Number.isFinite(columns) && Number.isFinite(rows)) {
        pty.resize({ cols: columns, rows });
      }
    } catch {
      // stdout might not be a TTY; ignore
    }
  };

  applySize();

  if (
    typeof Deno.addSignalListener === "function" &&
    typeof Deno.removeSignalListener === "function" &&
    Deno.build.os !== "windows"
  ) {
    const handler = () => applySize();
    Deno.addSignalListener("SIGWINCH", handler);
    return () => {
      try {
        Deno.removeSignalListener("SIGWINCH", handler);
      } catch {
        // ignore cleanup errors
      }
    };
  }

  return undefined;
}

export type CompileBackend = "js" | "zig";

export interface CompileArgs {
  entryPath: string;
  outDir?: string;
  backend: CompileBackend;
  force: boolean;
  debug: boolean;
  traceOptions: TraceOptions;
  rebuild: boolean;
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
  let rebuild = false;
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
    if (arg === "--rebuild") {
      rebuild = true;
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
      "Usage: wm compile <file.wm> [--out-dir <dir>] [--backend <js|zig>] [--force] [--debug] [--rebuild]",
    );
  }

  return {
    entryPath: entryPath ?? "",
    outDir,
    backend: backend ?? "zig",
    force,
    debug,
    traceOptions,
    rebuild,
  };
}

export async function compileToDirectory(
  entryPath: string,
  outDir?: string,
  backend: CompileBackend = "zig",
  force = false,
  debug = false,
  traceOptions: TraceOptions = DEFAULT_TRACE_OPTIONS,
  rebuild = false,
): Promise<void> {
  if (!entryPath.endsWith(".wm")) {
    throw new Error("Expected a .wm entry file");
  }

  const resolvedEntry = resolve(entryPath);
  const resolvedOutDir = resolve(outDir ?? "dist");

  // Handle rebuild logic
  if (rebuild && backend === "zig") {
    // Delete fresh cache directory if it exists
    const freshCacheDir = resolve(resolvedOutDir, ".zig-cache-fresh");
    try {
      await Deno.remove(freshCacheDir, { recursive: true });
    } catch {
      // Directory doesn't exist, that's fine
    }
  }

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
      rebuild,
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
  let rebuild = false;
  let buildDirPath: string | undefined;
  const remainingArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--rebuild") {
      rebuild = true;
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

  // Handle rebuild logic
  if (rebuild) {
    // Delete fresh cache directory if it exists
    const freshCacheDir = resolve(buildDir, ".zig-cache-fresh");
    try {
      await Deno.remove(freshCacheDir, { recursive: true });
    } catch {
      // Directory doesn't exist, that's fine
    }
  }

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
    rebuild,
  });

  // Compile any referenced .wm source files to .zig
  const zigFilesToFormat = new Set<string>([buildZigPath]);
  for (const file of emitResult.moduleFiles.values()) {
    if (file.endsWith(".zig")) {
      zigFilesToFormat.add(file);
    }
  }
  for (const wmPath of emitResult.wmSourcePaths) {
    const absoluteWmPath = resolve(buildDir, wmPath);
    const zigOutputPath = resolve(buildDir, wmPath.slice(0, -3) + ".zig");
    const relativeWmPath = relative(buildDir, absoluteWmPath);
    const relativeZigPath = relative(buildDir, zigOutputPath);

    console.log(`Compiling ${relativeWmPath} to ${relativeZigPath} ...`);

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

    const sourceEmitResult = await emitZigModuleGraph(sourceCompileResult.coreGraph, {
      outDir: buildDir,
      commonRoot: buildDir,
      emitRuntime: false,
      emitRootMain: false,
      traceOptions,
      rebuild,
    });

    zigFilesToFormat.add(zigOutputPath);
    for (const file of sourceEmitResult.moduleFiles.values()) {
      if (file.endsWith(".zig")) {
        zigFilesToFormat.add(file);
      }
    }
  }

  // Run zig fmt on all generated .zig files
  const zigFilesList = Array.from(zigFilesToFormat);
  await runZigFmt(zigFilesList);
  await generateWmSourceMaps(zigFilesList);

  console.log("Running zig build...");

  // Pass through any additional args to zig build (excluding the directory argument if it was used)
  const zigArgs = rebuild
    ? ["build", "--cache-dir", resolve(buildDir, ".zig-cache-fresh"), "-fno-incremental", "--color", "on", ...remainingArgs]
    : ["build", "--color", "on", ...remainingArgs];
  const {
    exitCode,
    output,
    rawLiveOutput,
    liveContentPossiblyLost,
  } = await runZigBuildWithPty(
    zigArgs,
    buildDir,
  );
  if (exitCode !== 0) {
    // never actually true
    const liveContentPossiblyLost = false;
    if (liveContentPossiblyLost) {
      const diagnosticTail = extractDiagnosticTail(rawLiveOutput);
      if (diagnosticTail.length > 0) {
        const failureEncoder = new TextEncoder();
        await writeAll(
          Deno.stdout,
          failureEncoder.encode(`\n${diagnosticTail}\n`),
        );
      }
    }
    await reportWorkmanDiagnosticsForZig(output, buildDir);
    throw new Error(`zig build failed with exit code ${exitCode}`);
  }
}
