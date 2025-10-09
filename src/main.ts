import { runFile } from "./runner.ts";
import { ParseError } from "./parser.ts";
import { InferError } from "./infer.ts";

if (import.meta.main) {
  if (Deno.args.length === 0) {
    console.error("Usage: workman <file.wm> [...file.wm]");
    Deno.exit(1);
  }

  let hadError = false;

  for (const path of Deno.args) {
    if (!path.endsWith(".wm")) {
      console.error(`Skipping '${path}': expected a .wm source file.`);
      hadError = true;
      continue;
    }

    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch (error) {
      console.error(`Failed to read '${path}': ${error instanceof Error ? error.message : String(error)}`);
      hadError = true;
      continue;
    }

    console.log(`\n# ${path}`);

    try {
      const result = runFile(source, { sourceName: path });
      if (result.types.length === 0) {
        console.log("(no top-level let bindings)");
      } else {
        for (const { name, type } of result.types) {
          console.log(`${name} : ${type}`);
        }
      }
    } catch (error) {
      hadError = true;
      if (error instanceof ParseError) {
        const { line, column } = positionToLineColumn(source, error.token.start);
        console.error(`Parse error (${path}:${line}:${column}): ${error.message}`);
      } else if (error instanceof InferError) {
        console.error(`Type error in '${path}': ${error.message}`);
      } else {
        console.error(`Unexpected error in '${path}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (hadError) {
    Deno.exit(1);
  }
}

function positionToLineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
