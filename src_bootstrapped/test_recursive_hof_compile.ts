import { compileProject } from "../backends/esm/src/compile.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

console.log("Testing recursive function through higher-order function...\n");

const result = await compileProject(resolve(Deno.cwd(), "src_bootstrapped/test_recursive_hof.wm"), {
  stdRoots: [resolve(Deno.cwd(), "std")],
  preludeModule: "std/prelude",
});

if (result.errors) {
  console.error("❌ Failed:");
  for (const error of result.errors) {
    console.error("  ", error);
  }
  Deno.exit(1);
} else {
  console.log("✅ Success! The fix works!");
}
