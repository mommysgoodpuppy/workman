// Debug test to see generated code

import { compile } from "../src/compile.ts";

const source = `
  type Option<a> = Some<a> | None;
  
  export let unwrapOr = (opt, fallback) => {
    match(opt) {
      Some(x) => { x },
      None => { fallback }
    }
  };
`;

const result = compile(source);
console.log("=== GENERATED JAVASCRIPT ===");
console.log(result.js);
console.log("=== END ===");

if (result.errors) {
  console.log("ERRORS:", result.errors);
}
