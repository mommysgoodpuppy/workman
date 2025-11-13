/**
 * IO Abstraction Layer
 *
 * Provides a runtime-agnostic interface for file system and process operations.
 * Automatically detects whether running on Deno or Andromeda and uses the appropriate APIs.
 */

// Global type declarations for runtime detection
declare const Bun: {
  argv: string[];
  file(path: string): {
    text(): Promise<string>;
    exists(): Promise<boolean>;
  };
  write(path: string, data: string): Promise<number>;
  cwd(): string;
  version: string;
};

declare const process: {
  exit(code: number): never;
  cwd(): string;
};

declare function require(module: string): unknown;

// Define Andromeda API types
interface AndromedaFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modified: Date;
  created: Date;
  accessed: Date;
}

interface AndromedaEnv {
  get(key: string): string | undefined;
}

interface AndromedaAPI {
  args: string[];
  readTextFileSync(path: string): string;
  readTextFile(path: string): Promise<string>;
  writeTextFileSync(path: string, data: string): void;
  writeTextFile(path: string, data: string): Promise<void>;
  statSync(path: string): AndromedaFileInfo;
  exists(path: string): boolean;
  mkdirSync(path: string): void;
  mkdirAllSync(path: string): void;
  remove(path: string): void;
  removeSync(path: string): void;
  env: AndromedaEnv;
}

// Runtime detection
const isDeno = typeof Deno !== "undefined";
const isAndromeda =
  typeof (globalThis as { Andromeda?: unknown }).Andromeda !== "undefined";
const isBun = typeof Bun !== "undefined";

// Cached Bun imports (to avoid repeated dynamic imports)
let bunFSSync: typeof import("node:fs") | null = null;
let bunOS: typeof import("node:os") | null = null;
let bunPath: typeof import("node:path") | null = null;

function getBunFSSync() {
  if (!bunFSSync) bunFSSync = require("node:fs") as typeof import("node:fs");
  return bunFSSync;
}

function getBunOS() {
  if (!bunOS) bunOS = require("node:os") as typeof import("node:os");
  return bunOS;
}

function getBunPath() {
  if (!bunPath) bunPath = require("node:path") as typeof import("node:path");
  return bunPath;
}

// Helper to access Andromeda API
function getAndromeda(): AndromedaAPI {
  return (globalThis as unknown as { Andromeda: AndromedaAPI }).Andromeda;
}

export interface FileSystemError {
  name: string;
  message: string;
}

export class NotFoundError extends Error implements FileSystemError {
  override name = "NotFound";

  constructor(message: string) {
    super(message);
  }
}

export interface StatInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
}

export interface MakeTempDirOptions {
  prefix?: string;
  dir?: string;
}

export interface RemoveOptions {
  recursive?: boolean;
}

/**
 * IO API interface
 */
export interface IOApi {
  // Process
  args: string[];
  exit(code: number): never;
  cwd(): string;

  // File system - async
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  stat(path: string): Promise<StatInfo>;
  makeTempDir(options?: MakeTempDirOptions): Promise<string>;
  remove(path: string, options?: RemoveOptions): Promise<void>;

  // File system - sync
  statSync(path: string): StatInfo;

  // Errors
  errors: {
    NotFound: typeof NotFoundError;
  };

  // Directory operations
  ensureDir(path: string): Promise<void>;
}

/**
 * Deno implementation
 */
const denoIO: IOApi = {
  args: isDeno ? Deno.args : [],
  exit: (code: number) => {
    if (isDeno) Deno.exit(code);
    throw new Error(`Process exit requested with code ${code}`);
  },
  cwd: () => {
    if (isDeno) return Deno.cwd();
    throw new Error("cwd() not available");
  },

  readTextFile: async (path: string) => {
    if (isDeno) return await Deno.readTextFile(path);
    throw new Error("readTextFile not implemented for current runtime");
  },

  writeTextFile: async (path: string, data: string) => {
    if (isDeno) return await Deno.writeTextFile(path, data);
    throw new Error("writeTextFile not implemented for current runtime");
  },

  stat: async (path: string) => {
    if (isDeno) {
      const info = await Deno.stat(path);
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        isSymlink: info.isSymlink,
        size: info.size,
        mtime: info.mtime,
        atime: info.atime,
        birthtime: info.birthtime,
      };
    }
    throw new Error("stat not implemented for current runtime");
  },

  makeTempDir: async (options?: MakeTempDirOptions) => {
    if (isDeno) return await Deno.makeTempDir(options);
    throw new Error("makeTempDir not implemented for current runtime");
  },

  remove: async (path: string, options?: RemoveOptions) => {
    if (isDeno) return await Deno.remove(path, options);
    throw new Error("remove not implemented for current runtime");
  },

  statSync: (path: string) => {
    if (isDeno) {
      const info = Deno.statSync(path);
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        isSymlink: info.isSymlink,
        size: info.size,
        mtime: info.mtime,
        atime: info.atime,
        birthtime: info.birthtime,
      };
    }
    throw new Error("statSync not implemented for current runtime");
  },

  errors: {
    NotFound: NotFoundError,
  },

  ensureDir: async (path: string) => {
    if (isDeno) {
      // Manually create directory recursively for Deno
      // (avoids std/fs import that causes Nova VM issues)
      try {
        await Deno.mkdir(path, { recursive: true });
      } catch (e) {
        // Ignore if already exists
        const error = e as Error;
        if (!error.message?.includes("already exists")) {
          throw e;
        }
      }
    } else {
      throw new Error("ensureDir not implemented for current runtime");
    }
  },
};

/**
 * Bun implementation
 */
const bunIO: IOApi = {
  args: isBun ? Bun.argv.slice(2) : [],
  exit: (code: number) => {
    if (isBun) process.exit(code);
    throw new Error(`Process exit requested with code ${code}`);
  },
  cwd: () => {
    if (isBun) return process.cwd();
    throw new Error("cwd() not available");
  },

  readTextFile: async (path: string) => {
    if (isBun) {
      const file = Bun.file(path);
      return await file.text();
    }
    throw new Error("readTextFile not implemented for current runtime");
  },

  writeTextFile: async (path: string, data: string) => {
    if (isBun) {
      await Bun.write(path, data);
      return;
    }
    throw new Error("writeTextFile not implemented for current runtime");
  },

  stat: async (path: string) => {
    if (isBun) {
      const fs = getBunFSSync();
      const info = fs.statSync(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymlink: info.isSymbolicLink(),
        size: info.size,
        mtime: info.mtime,
        atime: info.atime,
        birthtime: info.birthtime,
      };
    }
    throw new Error("stat not implemented for current runtime");
  },

  makeTempDir: async (options?: MakeTempDirOptions) => {
    if (isBun) {
      const fs = getBunFSSync();
      const os = getBunOS();
      const path = getBunPath();
      const tmpDir = options?.dir || os.tmpdir();
      const prefix = options?.prefix || "workman-";
      const tempPath = fs.mkdtempSync(path.join(tmpDir, prefix));
      return tempPath;
    }
    throw new Error("makeTempDir not implemented for current runtime");
  },

  remove: async (path: string, options?: RemoveOptions) => {
    if (isBun) {
      const fs = getBunFSSync();
      fs.rmSync(path, { recursive: options?.recursive });
      return;
    }
    throw new Error("remove not implemented for current runtime");
  },

  statSync: (path: string) => {
    if (isBun) {
      const fs = getBunFSSync();
      const info = fs.statSync(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymlink: info.isSymbolicLink(),
        size: info.size,
        mtime: info.mtime,
        atime: info.atime,
        birthtime: info.birthtime,
      };
    }
    throw new Error("statSync not implemented for current runtime");
  },

  errors: {
    NotFound: NotFoundError,
  },

  ensureDir: async (path: string) => {
    if (isBun) {
      const fs = getBunFSSync();
      try {
        fs.mkdirSync(path, { recursive: true });
      } catch (e) {
        const error = e as Error & { code?: string };
        if (error.code !== "EEXIST") {
          throw e;
        }
      }
    } else {
      throw new Error("ensureDir not implemented for current runtime");
    }
  },
};

/**
 * Andromeda implementation
 */
const andromedaIO: IOApi = {
  args: isAndromeda ? getAndromeda().args : [],
  exit: (code: number) => {
    if (isAndromeda) {
      // Andromeda doesn't have exit(), throw an error that will terminate
      throw new Error(`[EXIT ${code}]`);
    }
    throw new Error(`Process exit requested with code ${code}`);
  },
  cwd: () => {
    if (isAndromeda) {
      // Andromeda doesn't have cwd() - we need to use a workaround
      // Get current directory from environment or use a platform-specific default
      const andromeda = getAndromeda();
      // Try to get PWD environment variable (Unix) or CD (Windows)
      const pwd = andromeda.env.get("PWD") || andromeda.env.get("CD");
      if (pwd) {
        return pwd;
      }
      // Fallback: assume we're running from the directory where the script is
      // For bundled scripts, this will be "." which we'll handle specially in resolve()
      return ".";
    }
    throw new Error("cwd() not implemented for Andromeda");
  },

  readTextFile: (path: string) => {
    if (isAndromeda) {
      // Andromeda has both sync and async versions
      return getAndromeda().readTextFile(path);
    }
    return Promise.reject(
      new Error("readTextFile not implemented for Andromeda"),
    );
  },

  writeTextFile: (path: string, data: string) => {
    if (isAndromeda) {
      // Andromeda has both sync and async versions
      return getAndromeda().writeTextFile(path, data);
    }
    return Promise.reject(
      new Error("writeTextFile not implemented for Andromeda"),
    );
  },

  stat: (path: string) => {
    if (isAndromeda) {
      // Andromeda.statSync returns FileInfo
      const info = getAndromeda().statSync(path);
      return Promise.resolve({
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        isSymlink: false, // Andromeda doesn't expose symlink info
        size: info.size,
        mtime: info.modified,
        atime: info.accessed,
        birthtime: info.created,
      });
    }
    return Promise.reject(new Error("stat not implemented for Andromeda"));
  },

  makeTempDir: (options?: MakeTempDirOptions) => {
    if (isAndromeda) {
      // Andromeda doesn't have makeTempDir, create manually
      const andromeda = getAndromeda();
      const tmpDir = andromeda.env.get("TEMP") ||
        andromeda.env.get("TMP") ||
        andromeda.env.get("TMPDIR") ||
        "/tmp";
      const prefix = options?.prefix || "workman-";
      const randomId = crypto.randomUUID();
      const tempPath = `${tmpDir}/${prefix}${randomId}`;
      andromeda.mkdirAllSync(tempPath); // Use mkdirAllSync for recursive creation
      return Promise.resolve(tempPath);
    }
    return Promise.reject(
      new Error("makeTempDir not implemented for Andromeda"),
    );
  },

  remove: (path: string, _options?: RemoveOptions) => {
    if (isAndromeda) {
      // Andromeda.remove() handles both files and directories recursively
      getAndromeda().remove(path);
      return Promise.resolve();
    }
    return Promise.reject(new Error("remove not implemented for Andromeda"));
  },

  statSync: (path: string) => {
    if (isAndromeda) {
      const info = getAndromeda().statSync(path);
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        isSymlink: false, // Andromeda doesn't expose symlink info
        size: info.size,
        mtime: info.modified,
        atime: info.accessed,
        birthtime: info.created,
      };
    }
    throw new Error("statSync not implemented for Andromeda");
  },

  errors: {
    NotFound: NotFoundError,
  },

  ensureDir: (path: string) => {
    if (isAndromeda) {
      // Use mkdirAllSync for recursive directory creation
      try {
        getAndromeda().mkdirAllSync(path);
      } catch (e) {
        // Ignore error if directory already exists
        const error = e as Error;
        if (!error.message?.includes("already exists")) {
          throw e;
        }
      }
      return Promise.resolve();
    }
    return Promise.reject(new Error("ensureDir not implemented for Andromeda"));
  },
};

/**
 * Export the appropriate IO implementation based on runtime
 */
export const IO: IOApi = isDeno
  ? denoIO
  : isBun
  ? bunIO
  : isAndromeda
  ? andromedaIO
  : denoIO;

/**
 * Utility function to check if an error is a NotFound error
 */
export function isNotFoundError(error: unknown): boolean {
  if (isDeno && error instanceof Deno.errors.NotFound) {
    return true;
  }
  if (error instanceof NotFoundError) {
    return true;
  }
  return false;
}

/**
 * Path utilities - polyfilled for cross-runtime compatibility
 */

/**
 * Normalize path separators to forward slashes
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Resolve a path to an absolute path
 */
export function resolve(...paths: string[]): string {
  // If no paths provided, return cwd
  if (paths.length === 0) {
    return IO.cwd();
  }

  // Join all paths
  let result = paths.join("/");
  result = normalizePath(result);

  const isAbsolutePath = result.startsWith("/") || /^[a-zA-Z]:/.test(result);

  // If not absolute, resolve against cwd
  if (!isAbsolutePath) {
    const cwd = IO.cwd();
    // Special handling when cwd is "." (common in Andromeda)
    if (cwd !== ".") {
      result = normalizePath(cwd + "/" + result);
    }
    // For Andromeda, keep paths relative when cwd is "."
  }

  // Normalize . and ..
  const parts = result.split("/").filter((p) => p && p !== ".");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  // For absolute paths with drive letter
  if (/^[a-zA-Z]:/.test(result)) {
    return resolved.join("/");
  }

  // For Andromeda-style relative paths (when cwd is ".")
  if (IO.cwd() === "." && !result.startsWith("/")) {
    return resolved.join("/");
  }

  return "/" + resolved.join("/");
}

/**
 * Get relative path from `from` to `to`
 */
export function relative(from: string, to: string): string {
  const fromParts = normalizePath(from).split("/").filter((p) => p);
  const toParts = normalizePath(to).split("/").filter((p) => p);

  // Find common prefix
  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  // Build relative path
  const upCount = fromParts.length - commonLength;
  const ups = Array(upCount).fill("..").join("/");
  const downs = toParts.slice(commonLength).join("/");

  if (ups && downs) {
    return ups + "/" + downs;
  }
  return ups || downs || ".";
}

/**
 * Convert a file path to a file:// URL
 */
export function toFileUrl(path: string): URL {
  let normalized = normalizePath(path);

  // Ensure absolute path
  if (!normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized)) {
    normalized = "/" + normalized;
  }

  // Handle Windows drive letters (C: -> /C:)
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = "/" + normalized;
  }

  // Encode special characters but preserve /
  const encoded = normalized.split("/").map((part) => encodeURIComponent(part))
    .join("/");

  return new URL("file://" + encoded);
}

/**
 * Get the directory name of a path
 */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  if (lastSlash === 0) return "/";
  return normalized.substring(0, lastSlash);
}

/**
 * Get the extension of a path
 */
export function extname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  const lastDot = normalized.lastIndexOf(".");

  if (lastDot === -1 || lastDot < lastSlash) return "";
  return normalized.substring(lastDot);
}

/**
 * Check if a path is absolute
 */
export function isAbsolute(path: string): boolean {
  // Windows: C:\ or C:/ or UNC \\server\share
  // Unix: /
  return path.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(path) ||
    path.startsWith("\\\\");
}

/**
 * Join path segments
 */
export function join(...paths: string[]): string {
  // Filter out empty strings
  const parts = paths.filter((p) => p);
  if (parts.length === 0) return ".";

  // Join and normalize
  let joined = parts.join("/");
  joined = normalizePath(joined);

  // Normalize . and ..
  const segments = joined.split("/").filter((p) => p);
  const result: string[] = [];

  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      result.pop();
    } else {
      result.push(segment);
    }
  }

  if (result.length === 0) return ".";

  // Preserve leading / for absolute paths
  if (joined.startsWith("/")) {
    return "/" + result.join("/");
  }

  return result.join("/");
}

/**
 * Get the common path of multiple paths
 */
export function common(paths: string[], _sep = "/"): string {
  if (paths.length === 0) return ".";
  if (paths.length === 1) return dirname(paths[0]);

  const normalized = paths.map(normalizePath);
  const parts = normalized.map((p) => p.split("/").filter((s) => s));

  // Find common prefix
  const minLength = Math.min(...parts.map((p) => p.length));
  let commonLength = 0;

  for (let i = 0; i < minLength; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) {
      commonLength++;
    } else {
      break;
    }
  }

  if (commonLength === 0) return ".";

  const commonParts = parts[0].slice(0, commonLength);
  const result = commonParts.join("/");

  // Preserve leading / for absolute paths
  if (normalized[0].startsWith("/")) {
    return "/" + result;
  }

  return result || ".";
}
