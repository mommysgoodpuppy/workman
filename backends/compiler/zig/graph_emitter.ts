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

export interface EmitGraphOptions {
  readonly outDir: string;
  readonly extension?: string;
  readonly runtimeFileName?: string;
  readonly runtimeSourcePath?: string;
  readonly invokeEntrypoint?: boolean;
}

export interface EmitGraphResult {
  readonly moduleFiles: ReadonlyMap<string, string>;
  readonly runtimePath: string;
  readonly entryPath: string;
  readonly rootPath: string;
}

export async function emitModuleGraph(
  graph: CoreModuleGraph,
  options: EmitGraphOptions,
): Promise<EmitGraphResult> {
  const outDir = resolve(options.outDir);
  const extension = options.extension ?? ".zig";
  const runtimeFileName = options.runtimeFileName ?? "runtime.zig";
  const runtimeSourcePath = options.runtimeSourcePath ??
    filePathFromModule(import.meta, "./runtime.zig");

  const modules = Array.from(graph.modules.values());
  const absoluteModulePaths = modules.map((module) => resolve(module.path));
  let commonRoot = common(absoluteModulePaths);
  if (!commonRoot || commonRoot.length === 0) {
    commonRoot = resolve(".");
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
  const forcedEntryExports = entryModule.values.some((binding) =>
    binding.name === "main"
  )
    ? ["main"]
    : [];

  const moduleFiles = new Map<string, string>();
  for (const module of modules) {
    const outputPath = computeOutputPath(
      module,
      commonRoot,
      outDir,
      extension,
    );
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
    const code = emitModule(module, graph, {
      extension,
      runtimeModule: runtimeSpecifier,
      baseDir: dirname(outputPath),
      preludeModule: preludeImport,
      invokeEntrypoint: options.invokeEntrypoint ?? false,
      forcedValueExports: module.path === entryModule.path
        ? forcedEntryExports
        : undefined,
    });
    await writeTextFile(outputPath, code);
    moduleFiles.set(module.path, outputPath);
  }

  const runtimeTargetPath = join(outDir, runtimeFileName);
  const runtimeCode = await IO.readTextFile(runtimeSourcePath);
  await writeTextFile(runtimeTargetPath, runtimeCode);

  const entryOutputPath = computeOutputPath(
    entryModule,
    commonRoot,
    outDir,
    extension,
  );
  const rootMainPath = join(outDir, "main.zig");
  const rootMainCode = buildRootMain(entryOutputPath, outDir, entryModule);
  await writeTextFile(rootMainPath, rootMainCode);

  return {
    moduleFiles,
    runtimePath: runtimeTargetPath,
    entryPath: entryOutputPath,
    rootPath: rootMainPath,
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
  const currentExt = extname(relativePath);
  const withoutExt = currentExt.length > 0
    ? relativePath.slice(0, relativePath.length - currentExt.length)
    : relativePath;
  return join(outDir, `${withoutExt}${extension}`);
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
  lines.push('const runtime = @import("./runtime.zig");');
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
