#!/usr/bin/env -S deno run -A
// Compile Workman to JavaScript

import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { compileToJS } from "../src/codegen_js.ts";

function printUsage() {
  console.log(`
Usage: deno run -A tools/compile_js.ts <input.wm> [output.js]

Compiles a Workman file to JavaScript.

Options:
  input.wm    - Workman source file
  output.js   - Output JavaScript file (optional, prints to stdout if omitted)

Example:
  deno run -A tools/compile_js.ts src/utils.wm src/utils.js
  `);
}

async function main() {
  const args = Deno.args;
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    Deno.exit(0);
  }
  
  const inputPath = args[0];
  const outputPath = args[1];
  
  try {
    // Read and parse the Workman file
    console.error(`Compiling ${inputPath}...`);
    const source = await Deno.readTextFile(inputPath);
    const tokens = lex(source);
    const program = parseSurfaceProgram(tokens, source);
    
    console.error(`Parsed ${program.declarations.length} declarations`);
    
    // Compile to JavaScript
    const jsCode = compileToJS(program, { module: "esm" });
    
    // Output
    if (outputPath) {
      await Deno.writeTextFile(outputPath, jsCode);
      console.error(`✓ Compiled to ${outputPath}`);
    } else {
      console.log(jsCode);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(error.stack);
    Deno.exit(1);
  }
}

main();
