// Deno IO Shim for Workman
// Provides file system, console, and environment access

// Helper to convert Workman List (string) to JS string
function workmanToJsString(wstr) {
  if (!wstr || typeof wstr !== "object" || wstr.type !== "List") {
    return wstr; // Already a JS string or other type
  }
  const chars = [];
  let current = wstr;
  while (current.tag === "Link") {
    chars.push(String.fromCharCode(current._0));
    current = current._1;
  }
  return chars.join("");
}

// Helper to convert JS string to Workman List (string)
function jsToWorkmanString(str) {
  if (typeof str !== "string") {
    return str; // Not a string
  }
  let result = { tag: "Empty", type: "List" };
  // Build list in reverse
  for (let i = str.length - 1; i >= 0; i--) {
    result = {
      tag: "Link",
      type: "List",
      _0: str.charCodeAt(i),
      _1: result,
    };
  }
  return result;
}

// File System Operations
export async function readTextFile(path) {
  const content = await Deno.readTextFile(workmanToJsString(path));
  return jsToWorkmanString(content);
}

export async function writeTextFile(path, contents) {
  await Deno.writeTextFile(workmanToJsString(path), workmanToJsString(contents));
}

export async function appendTextFile(path, contents) {
  await Deno.writeTextFile(workmanToJsString(path), workmanToJsString(contents), { append: true });
}

export async function fileExists(path) {
  try {
    await Deno.stat(workmanToJsString(path));
    return true;
  } catch {
    return false;
  }
}

export async function readDir(path) {
  const entries = [];
  for await (const entry of Deno.readDir(workmanToJsString(path))) {
    entries.push({
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
    });
  }
  return entries;
}

export async function mkdir(path) {
  await Deno.mkdir(workmanToJsString(path), { recursive: true });
}

export async function remove(path) {
  await Deno.remove(workmanToJsString(path), { recursive: true });
}

// Console Operations
export function log(message) {
  // Convert Workman List (string) to JS string
  if (message && typeof message === "object" && message.type === "List") {
    const chars = [];
    let current = message;
    while (current.tag === "Link") {
      chars.push(String.fromCharCode(current._0));
      current = current._1;
    }
    console.log(chars.join(""));
  } else {
    console.log(message);
  }
}

export function error(message) {
  console.error(message);
}

export function warn(message) {
  console.warn(message);
}

// Environment
export function getEnv(key) {
  return Deno.env.get(key) || null;
}

export function setEnv(key, value) {
  Deno.env.set(key, value);
}

export function cwd() {
  return jsToWorkmanString(Deno.cwd());
}

export function args() {
  return Deno.args;
}

// Process
export function exit(code) {
  Deno.exit(code);
}

// HTTP Fetch
export async function fetch(url) {
  const response = await globalThis.fetch(url);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: text,
  };
}

// JSON
export function jsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function jsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

// Date/Time
export function now() {
  return Date.now();
}

export function dateToString(timestamp) {
  return new Date(timestamp).toISOString();
}
