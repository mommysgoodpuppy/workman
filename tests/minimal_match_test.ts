import { inferProgram } from "../src/infer.ts";
import { formatScheme } from "../src/type_printer.ts";
import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { parseSurfaceProgram } from "../src/parser.ts";
import { lex } from "../src/lexer.ts";

function inferTypes(source: string) {
  const tokens = lex(source);
  const program = parseSurfaceProgram(tokens);
  const result = inferProgram(program, { resetCounter: true });
  return result.summaries.map(({ name, scheme }) => ({
    name,
    type: formatScheme(scheme),
  }));
}

Deno.test("minimal failing case", () => {
  const source = `
    let genericBundle = match {
      0 => { (_) => { "zero" } }
    };

    let user = (f) => {
      f(10)
    };

    let result = user(genericBundle(0));
  `;

  const summaries = inferTypes(source);
  const genericBundleBinding = summaries.find((entry) => entry.name === "genericBundle");

  assertEquals(genericBundleBinding?.type, "Int -> Int -> String");
});
