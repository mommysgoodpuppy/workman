import { Token, keywords, symbols } from "./token.ts";

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let index = 0;

  while (index < length) {
    const start = index;
    const char = source[index];

    if (isWhitespace(char)) {
      index++;
      continue;
    }

    if (char === "-" && source[index + 1] === "-") {
      index += 2;
      while (index < length && source[index] !== "\n") {
        index++;
      }
      continue;
    }

    if (isDigit(char)) {
      let value = char;
      index++;
      while (index < length && isDigit(source[index])) {
        value += source[index++];
      }
      tokens.push({ kind: "number", value, start, end: index });
      continue;
    }

    if (char === '"') {
      const { value, nextIndex } = readStringLiteral(source, index);
      tokens.push({ kind: "string", value, start, end: nextIndex });
      index = nextIndex;
      continue;
    }

    if (char === "_") {
      tokens.push({ kind: "symbol", value: "_", start, end: start + 1 });
      index++;
      continue;
    }

    if (isAlpha(char)) {
      let value = char;
      index++;
      while (index < length && isAlphaNumeric(source[index])) {
        value += source[index++];
      }
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "false") {
        tokens.push({ kind: "bool", value: lower, start, end: index });
        continue;
      }
      if (keywords.has(lower)) {
        tokens.push({ kind: "keyword", value: lower, start, end: index });
        continue;
      }
      const kind = isUppercase(value[0]) ? "constructor" : "identifier";
      tokens.push({ kind, value, start, end: index });
      continue;
    }

    if (char === "-" && source[index + 1] === ">") {
      tokens.push({ kind: "symbol", value: "->", start, end: index + 2 });
      index += 2;
      continue;
    }

    const match = matchSymbol(source, index);
    if (match) {
      tokens.push({ kind: "symbol", value: match.value, start, end: match.end });
      index = match.end;
      continue;
    }

    throw new Error(`Unexpected character '${char}' at position ${index}`);
  }

  tokens.push({ kind: "eof", value: "", start: length, end: length });
  return tokens;
}

function matchSymbol(source: string, index: number): { value: string; end: number } | null {
  for (const symbol of symbols) {
    const end = index + symbol.length;
    if (source.slice(index, end) === symbol) {
      return { value: symbol, end };
    }
  }
  return null;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isAlpha(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isAlphaNumeric(char: string): boolean {
  return isAlpha(char) || isDigit(char) || char === "'";
}

function isUppercase(char: string): boolean {
  return char >= "A" && char <= "Z";
}

function readStringLiteral(source: string, start: number): { value: string; nextIndex: number } {
  let index = start + 1;
  let value = "";
  const length = source.length;

  while (index < length) {
    const char = source[index];
    if (char === '"') {
      return { value, nextIndex: index + 1 };
    }
    if (char === "\\") {
      if (index + 1 >= length) {
        throw new Error("Unterminated string literal");
      }
      const escape = source[index + 1];
      switch (escape) {
        case '"':
          value += '"';
          break;
        case "\\":
          value += "\\";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        default:
          value += escape;
          break;
      }
      index += 2;
      continue;
    }
    if (char === "\n") {
      throw new Error("Unterminated string literal");
    }
    value += char;
    index++;
  }

  throw new Error("Unterminated string literal");
}
