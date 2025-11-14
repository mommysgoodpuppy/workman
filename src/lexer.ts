import {
  keywords,
  multiCharOperators,
  operatorChars,
  symbols,
  type Token,
} from "./token.ts";
import { unexpectedCharError, unterminatedStringError } from "./error.ts";
/* Bootstrapped lexer helpers - commented out to avoid circular dependencies in bundled code
import {
  isAlpha as isAlphawm,
  isAlphaNumeric as isAlphaNumericwm,
  isDigit as isDigitwm,
  isUppercase as isUppercasewm,
  isWhitespace as isWhitespacewm,
} from "../boot/src/lexer.mjs";
*/

export function lex(source: string, sourceName?: string): Token[] {
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
      const commentStart = index;
      index += 2;
      let value = "";
      while (index < length && source[index] !== "\n") {
        value += source[index];
        index++;
      }
      tokens.push({
        kind: "comment",
        value: value.trim(),
        start: commentStart,
        end: index,
      });
      continue;
    }

    // Handle negative numbers: - followed immediately by digit
    if (char === "-" && index + 1 < length && isDigit(source[index + 1])) {
      // Check if this could be a negative number (not subtraction)
      // It's a negative number if:
      // - It's at the start, OR
      // - Previous non-whitespace token is not a number, identifier, or closing paren/bracket
      const canBeNegative = tokens.length === 0 || (() => {
        const lastToken = tokens[tokens.length - 1];
        return lastToken.kind !== "number" &&
          lastToken.kind !== "identifier" &&
          lastToken.kind !== "constructor" &&
          lastToken.value !== ")" &&
          lastToken.value !== "]";
      })();

      if (canBeNegative) {
        let value = char;
        index++;
        while (index < length && isDigit(source[index])) {
          value += source[index++];
        }
        tokens.push({
          kind: "number",
          value,
          start,
          end: index,
        });
        continue;
      }
    }

    if (isDigit(char)) {
      let value = char;
      index++;
      while (index < length && isDigit(source[index])) {
        value += source[index++];
      }
      tokens.push({
        kind: "number",
        value,
        start,
        end: index,
      });
      continue;
    }

    if (char === "'") {
      const { value, nextIndex } = readCharLiteral(source, index);
      tokens.push({
        kind: "char",
        value,
        start,
        end: nextIndex,
      });
      index = nextIndex;
      continue;
    }

    if (char === '"') {
      const { value, nextIndex } = readStringLiteral(source, index);
      tokens.push({
        kind: "string",
        value,
        start,
        end: nextIndex,
      });
      index = nextIndex;
      continue;
    }

    if (char === "_") {
      tokens.push({
        kind: "symbol",
        value: "_",
        start,
        end: start + 1,
      });
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
        tokens.push({
          kind: "bool",
          value: lower,
          start,
          end: index,
        });
        continue;
      }
      if (keywords.has(lower)) {
        tokens.push({
          kind: "keyword",
          value: lower,
          start,
          end: index,
        });
        continue;
      }
      const kind = isUppercase(value[0]) ? "constructor" : "identifier";
      tokens.push({ kind: kind, value, start, end: index });
      continue;
    }

    if (char === "-" && source[index + 1] === ">") {
      tokens.push({
        kind: "symbol",
        value: "->",
        start,
        end: index + 2,
      });
      index += 2;
      continue;
    }

    // Try to match multi-character operators first (before symbols)
    // This handles cases like == which starts with = (a symbol)
    const operatorMatch = matchOperator(source, index);
    if (operatorMatch) {
      tokens.push({
        kind: "operator",
        value: operatorMatch.value,
        start,
        end: operatorMatch.end,
      });
      index = operatorMatch.end;
      continue;
    }

    // Try to match symbols
    const match = matchSymbol(source, index);
    if (match) {
      tokens.push({
        kind: "symbol",
        value: match.value,
        start,
        end: match.end,
      });
      index = match.end;
      continue;
    }

    throw unexpectedCharError(char, index, source);
  }

  tokens.push({
    kind: "eof",
    value: "",
    start: length,
    end: length,
  });
  return tokens;
}

function matchSymbol(
  source: string,
  index: number,
): { value: string; end: number } | null {
  for (const symbol of symbols) {
    const end = index + symbol.length;
    if (source.slice(index, end) === symbol) {
      return { value: symbol, end };
    }
  }
  return null;
}

function matchOperator(
  source: string,
  index: number,
): { value: string; end: number } | null {
  // First try multi-character operators (sorted by length, longest first)
  for (const op of multiCharOperators) {
    const end = index + op.length;
    if (source.slice(index, end) === op) {
      return { value: op, end };
    }
  }

  // Then try single character operators (but not if they're also symbols)
  const char = source[index];
  if (operatorChars.has(char)) {
    // Don't match single-character operators that are also symbols
    // (like = which is a symbol, but == is an operator)
    if (symbols.includes(char)) {
      return null;
    }

    let value = char;
    let end = index + 1;

    return { value, end };
  }

  return null;
}

function isWhitespace(char: string): boolean {
  /* return isWhitespacewm(char); */
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isDigit(char: string): boolean {
  /* return isDigitwm(char); */
  return char >= "0" && char <= "9";
}

function isAlpha(char: string): boolean {
  /* return isAlphawm(char); */
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isAlphaNumeric(char: string): boolean {
  /* return isAlphaNumericwm(char); */
  // Don't call isAlpha to avoid potential issues - inline the check
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") || char === "'";
}

function isUppercase(char: string): boolean {
  /* return isUppercasewm(char); */
  return char >= "A" && char <= "Z";
}

function readCharLiteral(
  source: string,
  start: number,
): { value: string; nextIndex: number } {
  let index = start + 1;
  const length = source.length;

  if (index >= length) {
    throw unterminatedStringError(start, source);
  }

  const char = source[index];

  // Handle escape sequences
  if (char === "\\") {
    if (index + 1 >= length) {
      throw unterminatedStringError(start, source);
    }
    const escape = source[index + 1];
    let value: string;
    switch (escape) {
      case "'":
        value = "'";
        break;
      case "\\":
        value = "\\";
        break;
      case "n":
        value = "\n";
        break;
      case "r":
        value = "\r";
        break;
      case "t":
        value = "\t";
        break;
      case "0":
        value = "\0";
        break;
      default:
        value = escape;
        break;
    }
    index += 2;
    if (index >= length || source[index] !== "'") {
      throw unterminatedStringError(start, source);
    }
    return { value, nextIndex: index + 1 };
  }

  // Regular character
  if (char === "\n" || char === "'") {
    throw unterminatedStringError(start, source);
  }

  index++;
  if (index >= length || source[index] !== "'") {
    throw unterminatedStringError(start, source);
  }

  return { value: char, nextIndex: index + 1 };
}

function readStringLiteral(
  source: string,
  start: number,
): { value: string; nextIndex: number } {
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
        throw unterminatedStringError(start, source);
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
      throw unterminatedStringError(start, source);
    }
    value += char;
    index++;
  }

  throw unterminatedStringError(start, source);
}
