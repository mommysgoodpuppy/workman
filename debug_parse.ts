import { lex } from "./src/lexer.ts";
import { parseSurfaceProgram } from "./src/parser.ts";

const source = `
    let id = (x: Int) => {
      x
    };
    let three = () => {
      id(3)
    };
  `;

console.log("Source length:", source.length);
console.log("Position 59:", source[59], "char code:", source.charCodeAt(59));
console.log("Context around 59:", JSON.stringify(source.substring(55, 65)));

const tokens = lex(source);
console.log("\nTokens:");
tokens.forEach((token, i) => {
  console.log(`${i}: ${token.kind} "${token.value}" [${token.start}-${token.end}]`);
});

const tokenAt59 = tokens.find(t => t.start <= 59 && t.end > 59);
console.log("\nToken at position 59:", tokenAt59);

console.log("\nTrying to parse...");
try {
  const program = parseSurfaceProgram(tokens);
  console.log("Success!", JSON.stringify(program, null, 2));
} catch (e) {
  console.error("Parse error:", e.message);
}
