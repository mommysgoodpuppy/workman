import { IO } from "./src/io.ts";
import { startRepl } from "./tools/repl.ts";
import { runFormatter } from "./tools/fmt.ts";
import { WorkmanError } from "./src/error.ts";
import { HELP_TEXT } from "./cli/help.ts";
import {
  compileToDirectory,
  parseCompileArgs,
  runBuildCommand,
} from "./cli/compile.ts";
import { runProgramCommand } from "./cli/run_command.ts";
import {
  applyTraceFlag,
  DEFAULT_TRACE_OPTIONS,
  type TraceOptions,
} from "./cli/trace_options.ts";
import { startWorkmanLanguageServer } from "./lsp/server/src/server.ts";

export {
  runFile,
  type RunOptions,
  type RunResult,
  type TypeSummary,
  type ValueSummary,
} from "./cli/run_file.ts";

async function runCli(): Promise<void> {
  let debugMode = false;
  const args: string[] = [];
  const globalTrace: TraceOptions = { ...DEFAULT_TRACE_OPTIONS };
  
  // Find the command (first non-flag argument, or --help/-h)
  const command = IO.args.find((arg) => 
    arg === "--help" || arg === "-h" || (!arg.startsWith("-") && arg !== "")
  );
  const isCompileOrBuild = command === "compile" || command === "build";
  
  for (const arg of IO.args) {
    // Only consume --debug globally for run commands, not for compile/build
    if (arg === "--debug" && !isCompileOrBuild) {
      debugMode = true;
      continue;
    }
    if (applyTraceFlag(arg, globalTrace)) {
      continue;
    }
    args.push(arg);
  }

  if (args.length === 0) {
    await startRepl();
    IO.exit(0);
  }

  const actualCommand = args[0];

  if (actualCommand === "--help" || actualCommand === "-h") {
    console.log(HELP_TEXT);
    IO.exit(0);
  }

  if (actualCommand === "fmt") {
    await runFormatter(args.slice(1));
    IO.exit(0);
  }

  if (actualCommand === "lsp") {
    await startWorkmanLanguageServer();
    IO.exit(0);
  }

  if (actualCommand === "compile") {
    try {
      const {
        entryPath,
        outDir,
        backend,
        force,
        debug,
        traceOptions,
      } = parseCompileArgs(args.slice(1), false, globalTrace);
      await compileToDirectory(entryPath, outDir, backend, force, debug, traceOptions);
    } catch (error) {
      handleCliError(error);
      IO.exit(1);
    }
    IO.exit(0);
  }

  if (actualCommand === "build") {
    try {
      // 'wm build' works like 'zig build' - auto-detects build.wm
      await runBuildCommand(args.slice(1), globalTrace);
    } catch (error) {
      handleCliError(error);
      IO.exit(1);
    }
    IO.exit(0);
  }

  await runProgramCommand(args, debugMode, globalTrace);
}

function handleCliError(error: unknown): void {
  if (error instanceof WorkmanError) {
    console.error(error.format());
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await runCli();
}
