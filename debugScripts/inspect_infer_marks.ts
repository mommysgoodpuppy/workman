import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { inferProgram } from "../src/layer1infer.ts";

const TEST_PRELUDE_SOURCE = `
  type List<T> = Nil | Cons<T, List<T>>;
  type Ordering = LT | EQ | GT;
`;

async function main() {
  const [sourcePath] = Deno.args;
  if (!sourcePath) {
    console.error("Usage: deno run -A debugScripts/inspect_infer_marks.ts <source.wm>");
    Deno.exit(1);
  }

  const sourceText = await Deno.readTextFile(sourcePath);
  const tokens = lex(`${TEST_PRELUDE_SOURCE}\n${sourceText}`);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program);

  const summary = {
    summaries: result.summaries.map(({ name, scheme }) => ({
      name,
      type: scheme,
    })),
    marks: Array.from(result.marks.values()),
    markedProgram: result.markedProgram,
  };

  console.log(JSON.stringify(summary, (_key, value) => {
    if (value instanceof Map) {
      return {
        dataType: "Map",
        value: Array.from(value.entries()),
      };
    }
    return value;
  }, 2));
}

if (import.meta.main) {
  await main();
}
