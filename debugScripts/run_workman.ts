import { parse } from "std/flags/mod.ts";
import { basename, resolve, toFileUrl } from "std/path/mod.ts";

import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { emitModuleGraph } from "../backends/compiler/js/graph_emitter.ts";

const flags = parse(Deno.args, {
  string: ["fn", "outDir", "extension", "runtime", "args"],
  boolean: ["keep", "emitOnly", "help"],
  default: {
    fn: "main",
    extension: ".mjs",
  },
});

if (flags.help || flags._.length === 0) {
  printUsage();
  Deno.exit(flags.help ? 0 : 1);
}

const entryPath = resolve(String(flags._[0]));
const keepFlag = Boolean(flags.keep || flags.outDir);

const outDir = flags.outDir
  ? resolve(String(flags.outDir))
  : await Deno.makeTempDir({ prefix: "workman-js-" });

let keepOutput = keepFlag;

try {
  const { coreGraph } = await compileWorkmanGraph(entryPath);
  const runtimeOptions = resolveRuntimeOptions(flags.runtime);
  const emitResult = await emitModuleGraph(coreGraph, {
    outDir,
    extension: String(flags.extension),
    ...runtimeOptions,
  });

  if (flags.emitOnly) {
    console.error(`Emitted modules to ${outDir}`);
    keepOutput = true;
  } else {
    const moduleUrl = toFileUrl(emitResult.entryPath).href;
    const mod = await import(moduleUrl);
    const fnName = String(flags.fn);
    const target = mod[fnName];
    if (typeof target !== "function") {
      throw new Error(`Export '${fnName}' is not a callable function on the emitted entry module.`);
    }

    const args = parseArgs(flags.args);
    const result = await target(...args);
    printResult(result);
  }
} finally {
  if (!keepOutput && !flags.outDir) {
    await Deno.remove(outDir, { recursive: true });
  }
}

function parseArgs(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (typeof value === "string" && value.length === 0) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [parsed];
    } catch (error) {
      throw new Error(`Failed to parse --args JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Array.isArray(value) ? value : [value];
}

function resolveRuntimeOptions(
  runtimeFlag: unknown,
): Pick<
  Parameters<typeof emitModuleGraph>[1],
  "runtimeFileName" | "runtimeSourcePath"
> | Record<string, never> {
  if (!runtimeFlag) return {};
  if (typeof runtimeFlag !== "string") {
    throw new Error("--runtime expects a file path string");
  }
  const sourcePath = resolve(runtimeFlag);
  const fileName = basename(sourcePath);
  return {
    runtimeSourcePath: sourcePath,
    runtimeFileName: fileName,
  };
}

function printResult(value: unknown): void {
  if (typeof value === "object") {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

function printUsage(): void {
  console.log(`Usage: deno run -A debugScripts/run_workman.ts <entry.wm> [options]

Options:
  --fn <name>        Name of the exported function to invoke (default: main).
  --args <json>      JSON array (or single JSON value) to pass as arguments.
  --outDir <path>    Directory to write emitted JS files. Defaults to a temp dir.
  --extension <ext>  File extension for emitted modules (default: .mjs).
  --keep             Preserve the output directory when using the temp default.
  --emitOnly         Emit modules but skip executing the exported function.
  --help             Show this message.
`);
}
