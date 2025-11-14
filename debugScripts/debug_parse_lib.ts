import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";

async function main() {
  const path = new URL(
    "../tests/fixtures/module_loader/basic/lib.wm",
    import.meta.url,
  );
  const source = await Deno.readTextFile(path);
  console.log("SOURCE:\n" + source);
  const tokens = lex(source);
  console.log("TOKENS:");
  for (const t of tokens) {
    console.log(`${t.kind} '${t.value}' [${t.start}, ${t.end}]`);
  }
  try {
    const program = parseSurfaceProgram(tokens);
    console.log("PARSED PROGRAM:", JSON.stringify(program, null, 2));
  } catch (error) {
    console.error("PARSE ERROR:", error);
  }
}

main();
