import {
  dirname,
  join,
  resolve,
  IO,
} from "../io.ts";
import {
  type Type,
  type TypeInfo,
  type TypeScheme,
  unknownType,
} from "../types.ts";
import type {
  ForeignTypeConfig,
  ForeignTypeProvider,
  ForeignTypeRequest,
  ForeignTypeResult,
} from "../module_loader.ts";

const DEFAULT_CACHE_DIR = resolve("dist_zig", "__wm_cache", "c_headers");

export interface ZigCHeaderProviderOptions {
  zigPath?: string;
  cacheDir?: string;
}

interface ExtractedTypeDesc {
  kind: string;
  name?: string;
  bits?: number;
  signed?: boolean;
  child?: ExtractedTypeDesc;
}

interface ExtractedField {
  name: string;
  type: ExtractedTypeDesc;
}

interface ExtractedStruct {
  kind: "struct";
  name: string;
  fields: ExtractedField[];
  opaque: boolean;
}

interface ExtractedEnum {
  kind: "enum";
  name: string;
  tags: string[];
  backing?: ExtractedTypeDesc;
}

interface ExtractedAlias {
  kind: "alias";
  name: string;
  target: ExtractedTypeDesc;
}

interface ExtractedFn {
  name: string;
  params: ExtractedTypeDesc[];
  return: ExtractedTypeDesc | null;
}

interface ExtractedValue {
  name: string;
  type: ExtractedTypeDesc;
}

interface ExtractedResult {
  types: Array<ExtractedStruct | ExtractedEnum | ExtractedAlias>;
  fns: ExtractedFn[];
  values: ExtractedValue[];
}

export function createDefaultForeignTypeConfig(
  entryPath: string,
): ForeignTypeConfig {
  const buildWmPath = findNearestBuildWm(entryPath);
  const cacheDir = resolveCacheDir(entryPath);
  const zigPath = resolveZigPath();
  const useWinSdk = getEnv("WM_C_HEADER_USE_WINSDK") === "1";
  const includeDirs = [
    ...readEnvList("WM_C_HEADER_INCLUDE_DIRS"),
    ...(useWinSdk ? defaultMsvcIncludeDirs() : []),
    ...(useWinSdk ? defaultWindowsSdkIncludeDirs() : []),
  ];
  const defines = [
    ...readEnvList("WM_C_HEADER_DEFINES"),
  ];
  return {
    provider: createZigCHeaderProvider({ cacheDir, zigPath, useWinSdk }),
    buildWmPath,
    includeDirs,
    defines,
  };
}

export function createZigCHeaderProvider(
  options: ZigCHeaderProviderOptions & { useWinSdk?: boolean } = {},
): ForeignTypeProvider {
  const zigPath = options.zigPath ?? "zig";
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const useWinSdk = options.useWinSdk ?? false;
  return async (request: ForeignTypeRequest): Promise<ForeignTypeResult> => {
    if (!request.rawMode) {
      return { values: new Map(), types: new Map() };
    }
    const symbols = request.specifiers.map((spec) => spec.imported);
    try {
      const cacheKey = await hashKey({
        schemaVersion: 2,
        headerPath: request.headerPath,
        includeDirs: request.includeDirs,
        defines: request.defines,
        symbols,
      });
      const cacheFile = join(cacheDir, `${cacheKey}.json`);
      const cached = await readCache(cacheFile);
      const extracted = cached ?? await runZigExtractor({
        zigPath,
        cacheDir,
        cacheFile,
        headerPath: request.headerPath,
        includeDirs: request.includeDirs,
        defines: request.defines,
        symbols,
        useWinSdk,
      });
      return mapExtractedResult(extracted);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[c_header] failed for ${request.headerPath}: ${detail}`,
      );
      return {
        values: new Map(),
        types: new Map(),
        diagnostics: [{ message: "c_header provider failed", detail }],
      };
    }
  };
}

async function runZigExtractor(options: {
  zigPath: string;
  cacheDir: string;
  cacheFile: string;
  headerPath: string;
  includeDirs: string[];
  defines: string[];
  symbols: string[];
  useWinSdk: boolean;
}): Promise<ExtractedResult> {
  await ensureDir(options.cacheDir);
  const source = await buildZigSource(options.headerPath, options.symbols);
  const zigPath = join(options.cacheDir, `extract_${basename(options.cacheFile)}.zig`);
  await IO.writeTextFile(zigPath, source);
  const result = await runZig(
    options.zigPath,
    zigPath,
    options.includeDirs,
    options.defines,
    options.useWinSdk,
  );
  await IO.writeTextFile(options.cacheFile, result);
  return JSON.parse(result) as ExtractedResult;
}

async function buildZigSource(
  headerPath: string,
  symbols: string[],
): Promise<string> {
  const templatePath = filePathFromModule(
    import.meta,
    "./zig/c_header_extract.zig",
  );
  const template = await IO.readTextFile(templatePath);
  const escapedHeader = escapeZigString(headerPath);
  const symbolLines = symbols.map((name) =>
    `  "${escapeZigString(name)}",`
  ).join("\n");
  return template
    .replaceAll("{{HEADER}}", escapedHeader)
    .replaceAll("{{SYMBOLS}}", symbolLines);
}

async function runZig(
  zigPath: string,
  sourcePath: string,
  includeDirs: string[],
  defines: string[],
  useWinSdk: boolean,
): Promise<string> {
  const args: string[] = ["run"];
  if (isWindowsRuntime()) {
    args.push("-target", detectWindowsTarget(useWinSdk));
    args.push("-lc");
  }
  for (const include of includeDirs) {
    args.push(`-I${include}`);
  }
  for (const define of defines) {
    args.push(`-D${define}`);
  }
  args.push(sourcePath);
  const command = new Deno.Command(zigPath, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`zig failed: ${stderr.trim()}`);
  }
  return new TextDecoder().decode(output.stdout);
}

function mapExtractedResult(extracted: ExtractedResult): ForeignTypeResult {
  const values = new Map<string, TypeScheme>();
  const types = new Map<string, TypeInfo>();

  for (const entry of extracted.types) {
    if (entry.kind === "struct") {
      types.set(entry.name, buildStructInfo(entry, types));
    } else if (entry.kind === "enum") {
      types.set(entry.name, buildEnumInfo(entry));
    }
  }

  for (const entry of extracted.types) {
    if (entry.kind === "alias") {
      const target = mapTypeDesc(entry.target, types);
      types.set(entry.name, {
        name: entry.name,
        parameters: [],
        constructors: [],
        alias: target,
        isAlias: true,
      });
    }
  }

  for (const entry of extracted.types) {
    if (!values.has(entry.name)) {
      if (entry.kind === "alias") {
        values.set(entry.name, {
          quantifiers: [],
          type: mapTypeDesc(entry.target, types),
        });
      } else {
        values.set(entry.name, {
          quantifiers: [],
          type: { kind: "constructor", name: entry.name, args: [] },
        });
      }
    }
  }

  const mapDesc = (desc: ExtractedTypeDesc): Type => mapTypeDesc(desc, types);

  for (const fn of extracted.fns) {
    const params = fn.params.map(mapDesc);
    const returnType = fn.return ? mapDesc(fn.return) : { kind: "unit" };
    values.set(fn.name, {
      quantifiers: [],
      type: makeFunctionType(params, returnType),
    });
  }

  for (const value of extracted.values) {
    values.set(value.name, {
      quantifiers: [],
      type: mapDesc(value.type),
    });
  }

  return { values, types };
}

function buildStructInfo(
  entry: ExtractedStruct,
  types: Map<string, TypeInfo>,
): TypeInfo {
  const fields = new Map<string, Type>();
  const recordFields = new Map<string, number>();
  entry.fields.forEach((field, index) => {
    fields.set(field.name, mapTypeDesc(field.type, types));
    recordFields.set(field.name, index);
  });
  return {
    name: entry.name,
    parameters: [],
    constructors: [],
    alias: entry.opaque ? undefined : { kind: "record", fields },
    recordFields: entry.opaque ? undefined : recordFields,
  };
}

function buildEnumInfo(entry: ExtractedEnum): TypeInfo {
  return {
    name: entry.name,
    parameters: [],
    constructors: [],
  };
}

function mapTypeDesc(
  desc: ExtractedTypeDesc,
  types: Map<string, TypeInfo>,
): Type {
  switch (desc.kind) {
    case "void":
      return { kind: "unit" };
    case "bool":
      return { kind: "bool" };
    case "int":
      return mapIntType(desc, types);
    case "float":
      return mapFloatType(desc, types);
    case "pointer":
      return {
        kind: "constructor",
        name: "Ptr",
        args: [desc.child ? mapTypeDesc(desc.child, types) : unknownForeignType()],
      };
    case "optional":
      return {
        kind: "constructor",
        name: "Optional",
        args: [desc.child ? mapTypeDesc(desc.child, types) : unknownForeignType()],
      };
    case "named":
      return mapNamedType(normalizeCImportName(desc.name ?? "Unknown"), types);
    case "array":
      return {
        kind: "constructor",
        name: "Ptr",
        args: [desc.child ? mapTypeDesc(desc.child, types) : unknownForeignType()],
      };
    case "unknown": {
      if (desc.name) {
        const name = normalizeCImportName(desc.name);
        if (name === "anyopaque") {
          return mapNamedType(name, types);
        }
      }
      return unknownForeignType();
    }
    default:
      return unknownForeignType();
  }
}

function mapIntType(desc: ExtractedTypeDesc, types: Map<string, TypeInfo>): Type {
  if (desc.name) {
    return mapNamedType(desc.name, types);
  }
  const bits = desc.bits ?? 32;
  const signed = desc.signed ?? true;
  const name = signed ? `i${bits}` : `u${bits}`;
  return mapNamedType(name, types);
}

function mapFloatType(desc: ExtractedTypeDesc, types: Map<string, TypeInfo>): Type {
  if (desc.name) {
    return mapNamedType(desc.name, types);
  }
  const bits = desc.bits ?? 32;
  return mapNamedType(`f${bits}`, types);
}

function mapNamedType(
  name: string,
  types: Map<string, TypeInfo>,
): Type {
  if (name.startsWith("_")) {
    const stripped = name.replace(/^_+/, "");
    if (types.has(stripped)) {
      name = stripped;
    }
  }
  switch (name) {
    case "bool":
      return { kind: "bool" };
    case "void":
      return { kind: "unit" };
    case "anyopaque":
      return { kind: "constructor", name: "Null", args: [] };
    default:
      return buildNamedConstructorType(name, types);
  }
}

function normalizeCImportName(name: string): string {
  if (!name.startsWith("cimport.")) {
    return name;
  }
  const suffix = name.slice("cimport.".length);
  if (suffix.startsWith("struct_")) {
    return suffix.slice("struct_".length);
  }
  if (suffix.startsWith("enum_")) {
    return suffix.slice("enum_".length);
  }
  return suffix;
}

function buildNamedConstructorType(
  name: string,
  types: Map<string, TypeInfo>,
): Type {
  const info = types.get(name);
  if (!info || info.parameters.length === 0) {
    return { kind: "constructor", name, args: [] };
  }
  const args: Type[] = Array(info.parameters.length).fill(unknownForeignType());
  return { kind: "constructor", name, args };
}

function makeFunctionType(params: Type[], result: Type): Type {
  if (params.length === 0) {
    return { kind: "func", from: { kind: "unit" }, to: result };
  }
  return params.reduceRight<Type>(
    (acc, param) => ({ kind: "func", from: param, to: acc }),
    result,
  );
}

function unknownForeignType(): Type {
  return unknownType({
    kind: "incomplete",
    reason: "c_header.unsupported_type",
  });
}

function findNearestBuildWm(entryPath: string): string | undefined {
  let current = dirname(resolve(entryPath));
  while (true) {
    const candidate = join(current, "build.wm");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveCacheDir(entryPath: string): string {
  const root = findProjectRoot(entryPath) ?? IO.cwd();
  return join(root, "dist_zig", "__wm_cache", "c_headers");
}

function resolveZigPath(): string {
  const envPath = getEnv("WM_ZIG_PATH") ?? getEnv("ZIG") ?? getEnv("ZIG_PATH");
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const home = getEnv("USERPROFILE") ?? getEnv("HOME");
  if (home) {
    const zigName = isWindowsRuntime() ? "zig.exe" : "zig";
    const zvmCandidate = join(home, ".zvm", "bin", zigName);
    if (existsSync(zvmCandidate)) {
      return zvmCandidate;
    }
  }
  return "zig";
}

function getEnv(key: string): string | undefined {
  if (typeof Deno !== "undefined") {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isWindowsRuntime(): boolean {
  if (typeof Deno !== "undefined") {
    return Deno.build.os === "windows";
  }
  return false;
}

function readEnvList(key: string): string[] {
  const value = getEnv(key);
  if (!value) return [];
  return value.split(";").map((part) => part.trim()).filter((part) => part);
}

function defaultWindowsSdkIncludeDirs(): string[] {
  if (!isWindowsRuntime()) return [];

  const sdkDir = getEnv("WindowsSdkDir") ?? getEnv("WindowsSDKDir");
  const sdkVersionRaw = getEnv("WindowsSDKVersion") ?? getEnv("WindowsSdkVersion");
  const sdkVersion = sdkVersionRaw?.replace(/[/\\]+$/, "");
  if (sdkDir && sdkVersion) {
    return collectWindowsSdkIncludeDirs(join(sdkDir, "Include", sdkVersion));
  }

  const roots = [
    "C:/Program Files (x86)/Windows Kits/10/Include",
    "C:/Program Files/Windows Kits/10/Include",
  ];
  for (const root of roots) {
    const version = findLatestWindowsSdkVersion(root);
    if (version) {
      return collectWindowsSdkIncludeDirs(join(root, version));
    }
  }
  return [];
}

function defaultMsvcIncludeDirs(): string[] {
  if (!isWindowsRuntime()) return [];

  const vcTools = getEnv("VCToolsInstallDir");
  if (vcTools) {
    const candidate = join(vcTools, "include");
    if (existsSync(candidate)) {
      return [candidate];
    }
  }

  const vcInstall = getEnv("VCINSTALLDIR");
  if (vcInstall) {
    const candidate = join(vcInstall, "Tools", "MSVC");
    const version = findLatestWindowsSdkVersion(candidate);
    if (version) {
      const includeDir = join(candidate, version, "include");
      if (existsSync(includeDir)) {
        return [includeDir];
      }
    }
  }

  const roots = [
    "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2019/Community/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2019/Professional/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2019/Enterprise/VC/Tools/MSVC",
    "C:/Program Files/Microsoft Visual Studio/2019/BuildTools/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Community/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Professional/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/Enterprise/VC/Tools/MSVC",
    "C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/VC/Tools/MSVC",
  ];

  for (const root of roots) {
    const version = findLatestWindowsSdkVersion(root);
    if (!version) continue;
    const includeDir = join(root, version, "include");
    if (existsSync(includeDir)) {
      return [includeDir];
    }
  }

  return [];
}

function collectWindowsSdkIncludeDirs(baseDir: string): string[] {
  const dirs = ["um", "shared", "ucrt", "winrt"];
  const result: string[] = [];
  for (const dir of dirs) {
    const full = join(baseDir, dir);
    if (existsSync(full)) {
      result.push(full);
    }
  }
  return result;
}

function detectWindowsTarget(useWinSdk: boolean): string {
  if (!isWindowsRuntime()) return "native";
  const override = getEnv("WM_C_HEADER_TARGET");
  if (override) return override;
  const arch = (getEnv("PROCESSOR_ARCHITECTURE") ??
    getEnv("PROCESSOR_ARCHITEW6432") ?? "").toLowerCase();
  const abi = useWinSdk ? "msvc" : "gnu";
  if (arch.includes("arm64")) return `aarch64-windows-${abi}`;
  if (arch.includes("arm")) return `arm-windows-${abi}`;
  if (arch.includes("86")) return `x86-windows-${abi}`;
  return `x86_64-windows-${abi}`;
}

function findLatestWindowsSdkVersion(root: string): string | undefined {
  const entries = listDirNames(root);
  if (entries.length === 0) return undefined;
  const versions = entries.filter((name) => /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(name));
  const candidates = versions.length > 0 ? versions : entries;
  if (candidates.length === 0) return undefined;
  candidates.sort(compareWindowsSdkVersions);
  return candidates[candidates.length - 1];
}

function compareWindowsSdkVersions(a: string, b: string): number {
  const aParts = a.split(".").map((v) => parseInt(v, 10));
  const bParts = b.split(".").map((v) => parseInt(v, 10));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function listDirNames(path: string): string[] {
  try {
    if (typeof Deno !== "undefined") {
      const entries: string[] = [];
      for (const entry of Deno.readDirSync(path)) {
        if (entry.isDirectory) entries.push(entry.name);
      }
      return entries;
    }
  } catch {
    // ignore
  }
  return [];
}

function findProjectRoot(entryPath: string): string | undefined {
  let current = dirname(resolve(entryPath));
  while (true) {
    if (
      existsSync(join(current, ".git")) ||
      existsSync(join(current, "deno.json")) ||
      existsSync(join(current, "wm.ts"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function existsSync(path: string): boolean {
  try {
    IO.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function escapeZigString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

async function ensureDir(path: string): Promise<void> {
  try {
    await IO.ensureDir(path);
  } catch {
    // ignore
  }
}

async function readCache(path: string): Promise<ExtractedResult | null> {
  try {
    const text = await IO.readTextFile(path);
    return JSON.parse(text) as ExtractedResult;
  } catch {
    return null;
  }
}

async function hashKey(value: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function filePathFromModule(meta: ImportMeta, specifier: string): string {
  const url = new URL(specifier, meta.url);
  if (url.protocol !== "file:") {
    throw new Error(`Unsupported runtime source protocol: ${url.protocol}`);
  }
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}
