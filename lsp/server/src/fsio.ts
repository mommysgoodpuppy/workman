import {
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  toFileUrl,
} from "std/path/mod.ts";
import { resolve } from "std/path/resolve.ts";
import type { WorkmanLanguageServer } from "./server.ts";
type LspServerContext = WorkmanLanguageServer;

export function uriToFsPath(uri: string): string {
  try {
    if (uri.startsWith("file:")) {
      const fsPath = fromFileUrl(uri);
      // Normalize the path the same way the module loader does (resolveEntryPath)
      const normalized = isAbsolute(fsPath) ? fsPath : resolve(fsPath);
      return ensureWmExtension(normalized);
    }
  } catch {
    // Ignore errors
  }
  // Fallback: assume it's a normal path and normalize it
  const normalized = isAbsolute(uri) ? uri : resolve(uri);
  return ensureWmExtension(normalized);
}

export function pathToUri(fsPath: string): string {
  try {
    const normalized = isAbsolute(fsPath) ? fsPath : resolve(fsPath);
    return toFileUrl(normalized).href;
  } catch {
    const normalized = isAbsolute(fsPath) ? fsPath : resolve(fsPath);
    const unixish = normalized.replace(/\\/g, "/");
    if (unixish.startsWith("/")) {
      return `file://${unixish}`;
    }
    return `file:///${unixish}`;
  }
}

export function ensureWmExtension(path: string): string {
  if (path.endsWith(".wm")) {
    return path;
  }
  return `${path}.wm`;
}

export function computeStdRoots(ctx: LspServerContext, entryPath: string): string[] {
  const roots = new Set<string>();
  if (ctx.initStdRoots && ctx.initStdRoots.length > 0) {
    for (const r of ctx.initStdRoots) {
      if (isAbsolute(r)) {
        roots.add(r);
      } else {
        for (const ws of ctx.workspaceRoots) {
          roots.add(join(ws, r));
        }
        roots.add(join(dirname(entryPath), r));
      }
    }
  }
  for (const root of ctx.workspaceRoots) {
    roots.add(join(root, "std"));
  }
  let dir = dirname(entryPath);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "std");
    try {
      const stat = Deno.statSync(candidate);
      if (stat.isDirectory) {
        roots.add(candidate);
        break;
      }
    } catch {
      // ignore
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const arr = Array.from(roots);
  ctx.log(`[LSP] stdRoots => ${arr.join(", ")}`);
  return arr.length > 0 ? arr : [join(dirname(entryPath), "std")];
}
