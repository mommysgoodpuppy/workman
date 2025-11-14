import {
  common,
  dirname,
  extname,
  IO,
  join,
  relative,
  resolve,
} from "../../../src/io.ts";

import type { CoreModule, CoreModuleGraph } from "../ir/core.ts";
import { emitModule } from "./emitter.ts";

export interface EmitGraphOptions {
  readonly outDir: string;
  readonly extension?: string;
  readonly runtimeFileName?: string;
  readonly runtimeSourcePath?: string;
}

export interface EmitGraphResult {
  readonly moduleFiles: ReadonlyMap<string, string>;
  readonly runtimePath: string;
  readonly entryPath: string;
}

export async function emitModuleGraph(
  graph: CoreModuleGraph,
  options: EmitGraphOptions,
): Promise<EmitGraphResult> {
  const outDir = resolve(options.outDir);
  const extension = options.extension ?? ".mjs";
  const runtimeFileName = options.runtimeFileName ?? "runtime.mjs";
  const runtimeSourcePath = options.runtimeSourcePath ??
    filePathFromModule(import.meta, "./runtime.mjs");

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
  const forcedEntryExports = entryModule.values.map((binding) => binding.name);

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
      forcedValueExports: module.path === entryModule.path
        ? forcedEntryExports
        : undefined,
      preludeModule: preludeImport,
    });
    await writeTextFile(outputPath, code);
    moduleFiles.set(module.path, outputPath);
  }

  const runtimeTargetPath = join(outDir, runtimeFileName);
  const runtimeCode = await IO.readTextFile(runtimeSourcePath);
  await writeTextFile(runtimeTargetPath, runtimeCode);

  return {
    moduleFiles,
    runtimePath: runtimeTargetPath,
    entryPath: moduleFiles.get(entryModule.path) ?? (() => {
      throw new Error(
        `Entry module '${entryModule.path}' missing from output map`,
      );
    })(),
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

function isStdCoreModule(path: string): boolean {
  const normalized = normalizeSlashes(path);
  if (normalized.includes("/std/core/")) {
    return true;
  }
  return normalized.endsWith("/std/list/core.wm") ||
    normalized.endsWith("/std/option/core.wm") ||
    normalized.endsWith("/std/result/core.wm") ||
    normalized.endsWith("/std/hole/core.wm");
}

function filePathFromModule(meta: ImportMeta, specifier: string): string {
  const url = new URL(specifier, meta.url);
  if (url.protocol !== "file:") {
    throw new Error(`Unsupported runtime source protocol: ${url.protocol}`);
  }
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}
