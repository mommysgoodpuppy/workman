import {
  common,
  dirname,
  extname,
  IO,
  join,
  relative,
  resolve,
} from "../../../src/io.ts";
import { isStdCoreModule } from "../../../src/module_loader.ts";

import type { CoreModule, CoreModuleGraph } from "../ir/core.ts";
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
  const outDir = resolve(options.outDir);
  //console.log(`emitModuleGraph: outDir=${outDir}`);
  const extension = options.extension ?? ".zig";
  const runtimeFileName = options.runtimeFileName ?? "runtime.zig";
  const runtimeSourcePath = options.runtimeSourcePath ??
    filePathFromModule(import.meta, "./runtime.zig");

  const modules = Array.from(graph.modules.values());
  let commonRoot: string;
  if (options.commonRoot) {
    commonRoot = resolve(options.commonRoot);
  } else {
    const absoluteModulePaths = modules.map((module) => resolve(module.path));
    commonRoot = common(absoluteModulePaths) ?? resolve(".");
  }
  const preludePath = graph.prelude;
  const preludeModule = preludePath
    ? graph.modules.get(preludePath)
    : undefined;
  const preludeValueExports = preludeModule
    ? preludeModule.exports
      .filter((exp) => exp.kind === "value")
      .map((exp) => exp.exported)
    : [];
  const preludeOutputPath = preludeModule
    ? computeOutputPath(preludeModule, commonRoot, outDir, extension)
    : undefined;

  const entryModule = graph.modules.get(graph.entry);
  if (!entryModule) {
    throw new Error(`Entry module '${graph.entry}' not found in graph`);
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
        const importedModule = graph.modules.get(imp.source);
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
        shouldModuleImportPrelude(module.path, preludePath),
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
      const rawResult = emitRawModule(module, graph, {
        extension,
        baseDir: dirname(outputPath),
      });
      code = rawResult.code;
      for (const wmPath of rawResult.wmSourcePaths) {
        collectedWmPaths.add(wmPath);
      }
    } else {
      code = emitModule(module, graph, {
        extension,
        runtimeModule: runtimeSpecifier,
        baseDir: dirname(outputPath),
        preludeModule: preludeImport,
        invokeEntrypoint: options.invokeEntrypoint ?? false,
        forcedValueExports: module.path === entryModule.path
          ? forcedEntryExports
          : undefined,
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
  modulePath: string,
  preludePath?: string,
): boolean {
  if (!preludePath) return false;
  if (
    normalizeSlashes(modulePath).toLowerCase() ===
      normalizeSlashes(preludePath).toLowerCase()
  ) {
    return false;
  }
  return !isStdCoreModule(modulePath);
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
    lines.push("  _ = runtime.call(entry.main, &[_]Value{});");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
