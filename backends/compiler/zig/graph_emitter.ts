import {
  common,
  dirname,
  extname,
  IO,
  join,
  relative,
  resolve,
} from "../../../src/io.ts";
import type { TraceOptions } from "../../../src/trace_options.ts";

import type { SourceSpan } from "../../../src/ast.ts";
import type { CoreModule, CoreModuleGraph } from "../ir/core.ts";
import { elaborateCarrierOpsGraph } from "../passes/elaborate_carriers.ts";
import { emitModule } from "./emitter.ts";
import { emitRawModule } from "./raw_emitter.ts";

export interface EmitGraphOptions {
  readonly outDir: string;
  readonly extension?: string;
  readonly runtimeFileName?: string;
  readonly runtimeSourcePath?: string;
  readonly invokeEntrypoint?: boolean;
  /** If false, skip emitting runtime.zig */
  readonly emitRuntime?: boolean;
  /** If false, skip emitting main.zig wrapper */
  readonly emitRootMain?: boolean;
  /** If set, use this as the common root instead of computing from module paths */
  readonly commonRoot?: string;
  /** Trace configuration propagated to entry module runtime */
  readonly traceOptions?: TraceOptions;
}

export interface EmitGraphResult {
  readonly moduleFiles: ReadonlyMap<string, string>;
  readonly runtimePath?: string;
  readonly entryPath: string;
  readonly rootPath?: string;
  /** .wm source file paths found in raw mode modules (relative paths as written) */
  readonly wmSourcePaths: readonly string[];
}

export async function emitModuleGraph(
  graph: CoreModuleGraph,
  options: EmitGraphOptions,
): Promise<EmitGraphResult> {
  const elaboratedGraph = elaborateCarrierOpsGraph(graph);
  const outDir = resolve(options.outDir);
  //console.log(`emitModuleGraph: outDir=${outDir}`);
  const extension = options.extension ?? ".zig";
  const runtimeFileName = options.runtimeFileName ?? "runtime.zig";
  const runtimeSourcePath = options.runtimeSourcePath ??
    filePathFromModule(import.meta, "./runtime.zig");

  const modules = Array.from(elaboratedGraph.modules.values());

  const sourceOffsets = new Map<string, number[]>();
  const sourceTexts = new Map<string, string>();
  await Promise.all(modules.map(async (mod) => {
    // Only read .wm files for source info
    if (mod.path.endsWith(".wm")) {
      try {
        const text = await IO.readTextFile(mod.path);
        sourceTexts.set(mod.path, text);
        sourceOffsets.set(mod.path, computeLineOffsets(text));
      } catch (e: any) {
        // console.error("Failed to read source for debug info:", mod.path, e.message);
      }
    }
  }));

  let commonRoot: string;
  if (options.commonRoot) {
    commonRoot = resolve(options.commonRoot);
  } else {
    const absoluteModulePaths = modules.map((module) => resolve(module.path));
    commonRoot = common(absoluteModulePaths) ?? resolve(".");
  }
  const preludePath = elaboratedGraph.prelude;
  const preludeModule = preludePath
    ? elaboratedGraph.modules.get(preludePath)
    : undefined;
  const preludeValueExports = preludeModule
    ? preludeModule.exports
      .filter((exp) => exp.kind === "value")
      .map((exp) => exp.exported)
    : [];
  const preludeOutputPath = preludeModule
    ? computeOutputPath(preludeModule, commonRoot, outDir, extension)
    : undefined;

  // Calculate transitive dependencies of prelude to avoid cycles
  const preludeDependencies = new Set<string>();
  if (preludeModule) {
    const queue = [preludeModule];
    const visited = new Set<string>();
    visited.add(preludeModule.path);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const imp of current.imports) {
        // Resolve import path
        let targetPath = imp.source;
        if (targetPath.startsWith(".")) {
          targetPath = join(dirname(current.path), targetPath);
        }
        targetPath = resolve(targetPath);

        // Handle .zig imports being mapped to .wm modules case if needed,
        // essentially we just need to find the Key in graph.modules
        // The graph keys are usually absolute paths.

        let targetModule = elaboratedGraph.modules.get(targetPath);
        // Try with .wm extension if not found (common pattern)
        if (!targetModule && !targetPath.endsWith(".wm")) {
          targetModule = elaboratedGraph.modules.get(targetPath + ".wm");
        }

        if (targetModule && !visited.has(targetModule.path)) {
          visited.add(targetModule.path);
          preludeDependencies.add(targetModule.path);
          queue.push(targetModule);
        }
      }
    }
  }

  const entryModule = elaboratedGraph.modules.get(elaboratedGraph.entry);
  if (!entryModule) {
    throw new Error(`Entry module '${elaboratedGraph.entry}' not found in graph`);
  }
  const forcedEntryExports =
    entryModule.values.some((binding) => binding.name === "main")
      ? ["main"]
      : [];

  const moduleFiles = new Map<string, string>();
  const copiedFiles = new Set<string>();
  const collectedWmPaths = new Set<string>();

  for (const module of modules) {
    // Copy Zig imports
    for (const imp of module.imports) {
      if (imp.source.endsWith(".zig")) {
        const absoluteSource = resolve(imp.source);
        const destPath = computeOutputPathForFile(
          absoluteSource,
          commonRoot,
          outDir,
        );

        if (!copiedFiles.has(absoluteSource)) {
          const content = await IO.readTextFile(absoluteSource);
          await writeTextFile(destPath, content);
          copiedFiles.add(absoluteSource);
        }

        // Update import source to point to the copied file
        (imp as { source: string }).source = destPath;
        (imp as any).isNative = true;
      } else {
        // Workman module - point to where it will be emitted
        const importedModule = elaboratedGraph.modules.get(imp.source);
        if (importedModule) {
          const destPath = computeOutputPath(
            importedModule,
            commonRoot,
            outDir,
            extension,
          );
          (imp as { source: string }).source = destPath;
          (imp as any).isNative = false;
        }
      }
    }

    const outputPath = computeOutputPath(
      module,
      commonRoot,
      outDir,
      extension,
    );
    //console.log(`emitModuleGraph: outputPath=${outputPath}`);
    const runtimeSpecifier = makeModuleSpecifier(
      outputPath,
      join(outDir, runtimeFileName),
    );
    const shouldInjectPrelude = Boolean(
      preludeModule &&
        preludeOutputPath &&
        preludeValueExports.length > 0 &&
        shouldModuleImportPrelude(module, preludePath, preludeDependencies),
    );
    const preludeImport = shouldInjectPrelude
      ? {
        specifier: makeModuleSpecifier(outputPath, preludeOutputPath!),
        names: preludeValueExports,
      }
      : undefined;

    // Use raw emitter for raw mode modules, runtime emitter otherwise
    let code: string;
    if (module.mode === "raw") {
      const rawResult = emitRawModule(module, elaboratedGraph, {
        extension,
        baseDir: dirname(outputPath),
      });
      code = rawResult.code;
      for (const wmPath of rawResult.wmSourcePaths) {
        collectedWmPaths.add(wmPath);
      }
    } else {
      code = emitModule(module, elaboratedGraph, {
        extension,
        runtimeModule: runtimeSpecifier,
        baseDir: dirname(outputPath),
        preludeModule: preludeImport,
        invokeEntrypoint: options.invokeEntrypoint ?? false,
        forcedValueExports: module.path === entryModule.path
          ? forcedEntryExports
          : undefined,
        traceOptions: module.path === entryModule.path
          ? options.traceOptions
          : undefined,
        getSourceLocation: (span: SourceSpan) => {
          const offsets = sourceOffsets.get(module.path);
          if (!offsets) return undefined;
          const loc = getLineCol(span, offsets, module.path);
          const text = sourceTexts.get(module.path);
          if (text) {
             const startOp = offsets[loc.line - 1] ?? 0;
             const endOp = offsets[loc.line]; // undefined if last
             const lineStr = text.slice(startOp, endOp ? endOp - 1 : undefined);
             return { ...loc, lineText: lineStr.replace(/\r$/, "") };
          }
          return loc;
        },
      });
    }
    await writeTextFile(outputPath, code);
    moduleFiles.set(module.path, outputPath);
  }

  const shouldEmitRuntime = options.emitRuntime ?? true;
  const shouldEmitRootMain = options.emitRootMain ?? true;

  let runtimeTargetPath: string | undefined;
  if (shouldEmitRuntime) {
    runtimeTargetPath = join(outDir, runtimeFileName);
    const runtimeCode = await IO.readTextFile(runtimeSourcePath);
    await writeTextFile(runtimeTargetPath, runtimeCode);
  }

  const entryOutputPath = computeOutputPath(
    entryModule,
    commonRoot,
    outDir,
    extension,
  );
  let rootMainPath: string | undefined;
  if (shouldEmitRootMain) {
    rootMainPath = join(outDir, "main.zig");
    const rootMainCode = buildRootMain(entryOutputPath, outDir, entryModule);
    await writeTextFile(rootMainPath, rootMainCode);
  }

  return {
    moduleFiles,
    runtimePath: runtimeTargetPath,
    entryPath: entryOutputPath,
    rootPath: rootMainPath,
    wmSourcePaths: Array.from(collectedWmPaths),
  };
}

function computeOutputPath(
  module: CoreModule,
  commonRoot: string,
  outDir: string,
  extension: string,
): string {
  const absolutePath = resolve(module.path);
  const relativePath = normalizeSlashes(relative(commonRoot, absolutePath));
  const rebasedPath = rebaseIfOutsideRoot(relativePath, absolutePath);
  const currentExt = extname(rebasedPath);
  const withoutExt = currentExt.length > 0
    ? rebasedPath.slice(0, rebasedPath.length - currentExt.length)
    : rebasedPath;
  return join(outDir, `${withoutExt}${extension}`);
}

function computeOutputPathForFile(
  absolutePath: string,
  commonRoot: string,
  outDir: string,
): string {
  const relativePath = normalizeSlashes(relative(commonRoot, absolutePath));
  const rebasedPath = rebaseIfOutsideRoot(relativePath, absolutePath);
  return join(outDir, rebasedPath);
}

function rebaseIfOutsideRoot(
  relativePath: string,
  absolutePath: string,
): string {
  if (relativePath === ".." || relativePath.startsWith("../")) {
    const sanitized = sanitizeAbsolutePath(absolutePath);
    return normalizeSlashes(join(".wm-cache", sanitized));
  }
  return relativePath;
}

function sanitizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/:/g, "_");
  return normalized.replace(/^\/+/, "");
}

function makeModuleSpecifier(fromPath: string, toPath: string): string {
  let spec = normalizeSlashes(relative(dirname(fromPath), toPath));
  if (!spec.startsWith(".")) {
    spec = `./${spec}`;
  }
  return spec;
}

async function writeTextFile(path: string, contents: string): Promise<void> {
  await IO.ensureDir(dirname(path));
  await IO.writeTextFile(path, contents);
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function shouldModuleImportPrelude(
  module: CoreModule,
  preludePath?: string,
  preludeDependencies?: Set<string>,
): boolean {
  if (!preludePath) return false;
  if (module.core) return false;

  const normalizedPath = normalizeSlashes(module.path).toLowerCase();
  const normalizedPrelude = normalizeSlashes(preludePath).toLowerCase();

  if (normalizedPath === normalizedPrelude) {
    return false;
  }

  // If this module is a dependency of the prelude, it cannot import the prelude.
  if (preludeDependencies && preludeDependencies.has(module.path)) {
    return false;
  }

  return true;
}

function filePathFromModule(meta: ImportMeta, specifier: string): string {
  const url = new URL(specifier, meta.url);
  if (url.protocol !== "file:") {
    throw new Error(`Unsupported runtime source protocol: ${url.protocol}`);
  }
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

function buildRootMain(
  entryOutputPath: string,
  outDir: string,
  entryModule: CoreModule,
): string {
  const entryImport = normalizeSlashes(relative(outDir, entryOutputPath));
  const hasMain = entryModule.values.some((binding) => binding.name === "main");
  const lines: string[] = [];
  lines.push("// Generated by Workman compiler (Zig)");
  lines.push('pub const runtime = @import("./runtime.zig");');
  lines.push("const Value = runtime.Value;");
  lines.push(`const entry = @import("${entryImport}");`);
  lines.push("pub fn main() void {");
  if (hasMain) {
    lines.push("  entry.__wm_init();");
    lines.push('  _ = runtime.call(entry.main, &[_]Value{}, "");');
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function computeLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function getLineCol(span: SourceSpan, offsets: number[], file: string) {
  let low = 0, high = offsets.length - 1;
  let line = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= span.start) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const column = span.start - offsets[line] + 1;
  return { line: line + 1, column, file };
}
