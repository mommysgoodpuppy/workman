import {
  dirname,
  join,
  resolve,
  IO,
  isNotFoundError,
} from "../io.ts";
import {
  type Type,
  type TypeInfo,
  type TypeScheme,
  createEffectRow,
  freshTypeVar,
  freeTypeVars,
  unknownType,
} from "../types.ts";
import type {
  ForeignTypeConfig,
  ForeignTypeProvider,
  ForeignTypeRequest,
  ForeignTypeResult,
} from "../module_loader.ts";

const DEFAULT_CACHE_DIR = resolve("dist_zig", "__wm_cache", "c_headers");
const zigEnvCache = new Map<string, { libDir?: string; target?: string } | null>();

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
  length?: number;
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
  const buildWmIncludeDirs = buildWmPath
    ? extractIncludePathsFromBuildWm(buildWmPath)
    : [];
  const includeDirs = dedupePaths([
    ...buildWmIncludeDirs,
    ...readEnvList("WM_C_HEADER_INCLUDE_DIRS"),
    ...getZigNativeIncludeDirs(zigPath),
  ]);
  const defines = [
    ...readEnvList("WM_C_HEADER_DEFINES"),
  ];
  return {
    provider: createZigCHeaderProvider({ cacheDir, zigPath }),
    buildWmPath,
    includeDirs,
    defines,
  };
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function getZigNativeIncludeDirs(zigPath: string): string[] {
  const env = readZigEnv(zigPath);
  if (!env?.libDir) return [];
  const includeRoot = join(env.libDir, "libc", "include");
  const candidates = new Set<string>(["any-windows-any"]);
  if (env.target && env.target.includes("windows")) {
    const arch = parseZigTargetArch(env.target);
    if (arch) {
      candidates.add(`${arch}-windows-gnu`);
      candidates.add(`${arch}-windows-any`);
      candidates.add(`${arch}-windows-msvc`);
    }
  }
  const resolved: string[] = [];
  for (const name of candidates) {
    const dir = join(includeRoot, name);
    if (pathExists(dir)) {
      resolved.push(dir);
    }
  }
  return resolved;
}

function parseZigTargetArch(target: string): string | null {
  const idx = target.indexOf("-windows");
  if (idx <= 0) return null;
  return target.slice(0, idx);
}

function readZigEnv(
  zigPath: string,
): { libDir?: string; target?: string } | null {
  const cached = zigEnvCache.get(zigPath);
  if (cached !== undefined) return cached;
  try {
    const command = new Deno.Command(zigPath, {
      args: ["env"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = command.outputSync();
    if (!output.success) {
      zigEnvCache.set(zigPath, null);
      return null;
    }
    const text = new TextDecoder().decode(output.stdout);
    const libDir = text.match(/\.lib_dir\s*=\s*"([^"]+)"/)?.[1];
    const target = text.match(/\.target\s*=\s*"([^"]+)"/)?.[1];
    const result = { libDir, target };
    zigEnvCache.set(zigPath, result);
    return result;
  } catch {
    zigEnvCache.set(zigPath, null);
    return null;
  }
}

function pathExists(path: string): boolean {
  try {
    IO.statSync(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    return false;
  }
}

export function createZigCHeaderProvider(
  options: ZigCHeaderProviderOptions = {},
): ForeignTypeProvider {
  const zigPath = options.zigPath ?? "zig";
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  return async (request: ForeignTypeRequest): Promise<ForeignTypeResult> => {
    if (!request.rawMode) {
      return { values: new Map(), types: new Map() };
    }
    const symbols = request.specifiers.map((spec) => spec.imported);
    try {
      const cacheKey = await hashKey({
        schemaVersion: 5,
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
): Promise<string> {
  const args: string[] = ["run"];
  if (isWindowsRuntime()) {
    args.push("-target", detectWindowsTarget());
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
        const target = mapTypeDesc(entry.target, types, { position: "value" });
        values.set(entry.name, { quantifiers: [], type: target });
      } else {
        values.set(entry.name, {
          quantifiers: [],
          type: { kind: "constructor", name: entry.name, args: [] },
        });
      }
    }
  }

  const mapDesc = (
    desc: ExtractedTypeDesc,
    position?: "param" | "return" | "field" | "value",
  ): Type => mapTypeDesc(desc, types, { position });

  for (const fn of extracted.fns) {
    const params = fn.params.map((param) => mapDesc(param, "param"));
    const returnType: Type = fn.return
      ? mapDesc(fn.return, "return")
      : { kind: "unit" };
    const fnType = makeFunctionType(params, returnType);
    // Quantify over all free type variables so each call gets fresh instantiation
    const quantifiers = Array.from(freeTypeVars(fnType));
    values.set(fn.name, {
      quantifiers,
      type: fnType,
    });
  }

  for (const value of extracted.values) {
    values.set(value.name, {
      quantifiers: [],
      type: mapDesc(value.type, "value"),
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
    fields.set(field.name, mapTypeDesc(field.type, types, { position: "field" }));
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
  options: { position?: "param" | "return" | "field" | "value" } = {},
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
        args: [
          desc.child
            ? mapTypeDesc(desc.child, types, { position: options.position })
            : unknownForeignType(),
          freshTypeVar(),
        ],
      };
    case "optional":
      if (desc.child?.kind === "pointer") {
        const childType = mapTypeDesc(desc.child, types, {
          position: options.position,
        });
        if (
          childType.kind === "constructor" && childType.name === "Ptr" &&
          childType.args.length >= 1
        ) {
          if (options.position === "param") {
            return childType;
          }
          const tail = childType.args[1] ?? freshTypeVar();
          const state = createEffectRow([["Null", null]], tail);
          return {
            kind: "constructor",
            name: "Ptr",
            args: [childType.args[0], state],
          };
        }
      }
      return {
        kind: "constructor",
        name: "Optional",
        args: [
          desc.child
            ? mapTypeDesc(desc.child, types, { position: options.position })
            : unknownForeignType(),
        ],
      };
    case "named":
      return mapNamedType(normalizeCImportName(desc.name ?? "Unknown"), types);
    case "array":
      return {
        kind: "array",
        length: desc.length ?? 0,
        element: desc.child
          ? mapTypeDesc(desc.child, types, { position: options.position })
          : unknownForeignType(),
      };
    case "unknown": {
      if (desc.name) {
        const name = normalizeCImportName(desc.name);
        if (name === "anyopaque") {
          return mapNamedType(name, types);
        }
        // Treat opaque C types (structs/unions we don't have full info for) as named types
        // rather than unknown holes - this gives better type inference for pointers to opaque types
        if (desc.name.startsWith("cimport.struct_") || desc.name.startsWith("cimport.union_")) {
          return { kind: "constructor", name, args: [] };
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
  name = normalizeZigPrimitiveName(name);
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
    case "Void":
      return { kind: "unit" };
    case "anyopaque":
    case "Anyopaque":
      return { kind: "constructor", name: "Anyopaque", args: [] };
    default:
      return buildNamedConstructorType(name, types);
  }
}

function normalizeZigPrimitiveName(name: string): string {
  switch (name) {
    case "i8":
      return "I8";
    case "i16":
      return "I16";
    case "i32":
      return "I32";
    case "i64":
      return "I64";
    case "i128":
      return "I128";
    case "isize":
      return "Isize";
    case "u8":
      return "U8";
    case "u16":
      return "U16";
    case "u32":
      return "U32";
    case "u64":
      return "U64";
    case "u128":
      return "U128";
    case "usize":
      return "Usize";
    case "f16":
      return "F16";
    case "f32":
      return "F32";
    case "f64":
      return "F64";
    case "f128":
      return "F128";
    case "void":
      return "Void";
    case "noreturn":
      return "NoReturn";
    case "anyerror":
      return "Anyerror";
    case "comptime_int":
      return "ComptimeInt";
    case "comptime_float":
      return "ComptimeFloat";
    case "c_short":
      return "CShort";
    case "c_ushort":
      return "CUShort";
    case "c_int":
      return "CInt";
    case "c_uint":
      return "CUInt";
    case "c_long":
      return "CLong";
    case "c_ulong":
      return "CULong";
    case "c_longlong":
      return "CLongLong";
    case "c_ulonglong":
      return "CULongLong";
    case "c_char":
      return "CChar";
    default:
      return name;
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

/**
 * Parse build.wm to extract include paths from addIncludePath(b.path("...")) calls.
 * Returns absolute paths resolved relative to the build.wm directory.
 */
function extractIncludePathsFromBuildWm(buildWmPath: string): string[] {
  try {
    const source = IO.readTextFileSync(buildWmPath);
    const buildDir = dirname(resolve(buildWmPath));
    const includePaths: string[] = [];
    
    // Match patterns like: addIncludePath(b.path("sdl3-mingw/include"))
    // or: .addIncludePath(b.path("path/to/include"))
    const pattern = /\.?addIncludePath\s*\(\s*b\.path\s*\(\s*["']([^"']+)["']\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const relativePath = match[1];
      const absolutePath = resolve(buildDir, relativePath);
      if (existsSync(absolutePath)) {
        includePaths.push(absolutePath);
      }
    }
    
    return includePaths;
  } catch {
    return [];
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

function detectWindowsTarget(): string {
  if (!isWindowsRuntime()) return "native";
  const override = getEnv("WM_C_HEADER_TARGET");
  if (override) return override;
  const arch = (getEnv("PROCESSOR_ARCHITECTURE") ??
    getEnv("PROCESSOR_ARCHITEW6432") ?? "").toLowerCase();
  if (arch.includes("arm64")) return "aarch64-windows-gnu";
  if (arch.includes("arm")) return "arm-windows-gnu";
  if (arch.includes("86")) return "x86-windows-gnu";
  return "x86_64-windows-gnu";
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
