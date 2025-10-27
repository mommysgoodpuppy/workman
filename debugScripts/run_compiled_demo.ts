import { compileProject } from "../backends/esm/src/compile.ts";
import { formatWorkmanError } from "../src/error.ts";
import { dirname, join, relative, resolve } from "std/path/mod.ts";

async function main(): Promise<void> {
  const [entryArg, maxLogsArg] = Deno.args;
  const entryPath = resolve(Deno.cwd(), entryArg ?? "examples/endless_showcase.wm");
  const maxLogs = maxLogsArg ? Number(maxLogsArg) : 12;

  const result = await compileProject(entryPath, {
    stdRoots: [resolve(Deno.cwd(), "std")],
    preludeModule: "std/prelude",
  });

  if (result.errors) {
    console.error("Compilation failed:\n");
    for (const message of result.errors) {
      console.error(formatWorkmanError(message));
      console.error("");
    }
    Deno.exit(1);
  }

  const entryModule = result.modules.get(entryPath);
  if (!entryModule) {
    console.error(`Entry module '${entryPath}' missing from compilation result.`);
    Deno.exit(1);
  }

  const tempDir = await Deno.makeTempDir({ prefix: "workman-compiled-" });

  try {
    for (const module of result.modules.values()) {
      const relJsPath = relative(Deno.cwd(), module.jsPath);
      const outputPath = join(tempDir, relJsPath);
      await Deno.mkdir(dirname(outputPath), { recursive: true });
      await Deno.writeTextFile(outputPath, module.jsCode);
    }

    const entryRel = relative(Deno.cwd(), entryModule.jsPath).replaceAll("\\", "/");
    const entryOutput = join(tempDir, entryRel);
    const moduleUrl = `file://${entryOutput.replaceAll("\\", "/")}`;

    const imported = await import(moduleUrl);
    if (typeof imported.main !== "function") {
      console.error(`Compiled module at ${moduleUrl} does not export a 'main' function.`);
      Deno.exit(1);
    }

    const originalLog = console.log;
    let logCount = 0;
    console.log = (...args: unknown[]) => {
      logCount += 1;
      originalLog(...args);
      if (logCount >= maxLogs) {
        throw new Error(`demo stop after ${maxLogs} logs`);
      }
    };

    try {
      imported.main();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("demo stop after")) {
        originalLog(`[demo intentionally stopped] ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      console.log = originalLog;
      originalLog(`Total logs observed: ${logCount}`);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

await main();
