import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { FormatContext } from "./fixtures/format/format_context.ts";

Deno.test("writeLine applies indentation", () => {
  const ctx = new FormatContext({ indentSize: 2 });
  ctx.writeLine("let demo = {");
  ctx.withIndent(() => {
    ctx.writeLine("call();");
  });
  ctx.writeLine("};");

  const expected = "let demo = {\n  call();\n};\n";
  assertEquals(ctx.toString(), expected);
});

Deno.test("write composes inline fragments", () => {
  const ctx = new FormatContext({ indentSize: 4 });
  ctx.write("let value = ");
  ctx.write("compute()");
  ctx.writeLine(";");

  assertEquals(ctx.toString(), "let value = compute();\n");
});

Deno.test("writeRaw preserves provided indentation", () => {
  const ctx = new FormatContext({ indentSize: 2 });
  ctx.writeLine("{");
  ctx.withIndent(() => {
    ctx.writeRaw("line 1\n  line 2\n");
  });
  ctx.write("}");

  const expected = "{\nline 1\n  line 2\n}";
  assertEquals(ctx.toString(), expected);
});

Deno.test("withIndent restores indentation after errors", () => {
  const ctx = new FormatContext({ indentSize: 2 });

  assertThrows(
    () => ctx.withIndent(() => {
      throw new Error("boom");
    }),
    Error,
    "boom",
  );

  ctx.writeLine("after");
  assertEquals(ctx.toString(), "after\n");
});
