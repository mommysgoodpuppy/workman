// Test script to compile value_printer.wm

import { compileFile } from "../backends/esm/src/compile.ts";

const inputPath = "src_bootstrapped/value_printer.wm";
const outputPath = "src_bootstrapped/value_printer.js";

console.log("Compiling value_printer.wm...");

const result = await compileFile(inputPath, outputPath);

if (result.errors) {
  console.error("❌ Compilation failed:");
  for (const error of result.errors) {
    console.error("  ", error);
  }
  console.error("\nFull error details:");
  console.error(JSON.stringify(result.errors, null, 2));
  Deno.exit(1);
} else {
  console.log("✅ Compilation successful!");
  console.log(`Output written to: ${outputPath}`);
  console.log("\n=== Generated JavaScript ===");
  console.log(result.js.slice(0, 500) + "...");
}
