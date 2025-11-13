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

// Helper to create Result types
function Ok(value) {
  return { tag: "Ok", type: "Result", _0: value };
}

function Err(error) {
  return { tag: "Err", type: "Result", _0: error };
}

// Helper to create FsError variants
function NotFound() {
  return { tag: "NotFound", type: "FsError" };
}

function PermissionDenied() {
  return { tag: "PermissionDenied", type: "FsError" };
}

function IoError() {
  return { tag: "IoError", type: "FsError" };
}

// File System Operations (Synchronous versions for simplicity)
export function readTextFile(path) {
  try {
    const content = Deno.readTextFileSync(workmanToJsString(path));
    return Ok(jsToWorkmanString(content));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Err(NotFound());
    } else if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
}

export function writeTextFile(path, contents) {
  try {
    Deno.writeTextFileSync(workmanToJsString(path), workmanToJsString(contents));
    return Ok({ tag: "Unit", type: "Unit" });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Err(NotFound());
    } else if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
}

export function appendTextFile(path, contents) {
  try {
    Deno.writeTextFileSync(workmanToJsString(path), workmanToJsString(contents), { append: true });
    return Ok({ tag: "Unit", type: "Unit" });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Err(NotFound());
    } else if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
}

export function fileExists(path) {
  try {
    Deno.statSync(workmanToJsString(path));
    return Ok(true);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Ok(false);
    } else {
      return Err(IoError());
    }
  }
}

export function readDir(path) {
  try {
    const entries = [];
    for (const entry of Deno.readDirSync(workmanToJsString(path))) {
      entries.push({
        tag: "DirEntry",
        type: "Record",
        name: jsToWorkmanString(entry.name),
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
      });
    }
    // Convert to Workman List
    let result = { tag: "Empty", type: "List" };
    for (let i = entries.length - 1; i >= 0; i--) {
      result = {
        tag: "Link",
        type: "List",
        _0: entries[i],
        _1: result,
      };
    }
    return Ok(result);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Err(NotFound());
    } else if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
}

export function mkdir(path) {
  try {
    Deno.mkdirSync(workmanToJsString(path), { recursive: true });
    return Ok({ tag: "Unit", type: "Unit" });
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
}

export function remove(path) {
  try {
    Deno.removeSync(workmanToJsString(path), { recursive: true });
    return Ok({ tag: "Unit", type: "Unit" });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Err(NotFound());
    } else if (e instanceof Deno.errors.PermissionDenied) {
      return Err(PermissionDenied());
    } else {
      return Err(IoError());
    }
  }
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
  try {
    return Ok(jsToWorkmanString(Deno.cwd()));
  } catch (e) {
    return Err(IoError());
  }
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
