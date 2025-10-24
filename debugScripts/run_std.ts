import { runEntryPath } from "../src/module_loader.ts";
const [target] = Deno.args;
const result = await runEntryPath(target);
console.log(JSON.stringify(result, null, 2));

