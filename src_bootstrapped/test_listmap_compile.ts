import { compileProject } from "../backends/esm/src/compile.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

const result = await compileProject(resolve(Deno.cwd(), "src_bootstrapped/test_listmap.wm"), {
  stdRoots: [resolve(Deno.cwd(), "std")],
  preludeModule: "std/prelude",
});

if (result.errors) {
  console.error("❌ Failed:");
  for (const error of result.errors) {
    console.error("  ", error);
  }
} else {
  console.log("✅ Success!");
}
