export type TokenKind =
  | "identifier"
  | "constructor"
  | "number"
  | "bool"
  | "char"
  | "string"
  | "keyword"
  | "symbol"
  | "operator"
  | "comment"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

export const keywords = new Set([
  "let",
  "rec",
  "and",
  "type",
  "record",
  "match",
  "import",
  "export",
  "from",
  "as",
  "infix",
  "infixl",
  "infixr",
  "prefix",
]);

// Symbols sorted by length (longest first) to ensure correct matching
export const symbols = [
  "=>",
  "->",
  "..",
  ".",
  "=",
  "|",
  ":",
  ",",
  ";",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "<",
  ">",
  "_",
];

// Operator symbols that can be used in custom infix operators
// Note: <, > are now included for comparison operators
// Note: = is included for operators like == and !=, but single = is a symbol
export const operatorChars = new Set([
  "+", "-", "*", "/", "%",
  "=", "!",
  "<", ">",
  "&", "^", "~",
  "@", "#", "$",
  "?",
]);

// Multi-character operators need to be checked in order of length
export const multiCharOperators = [
  "<=", ">=",  // Check these before < and >
  "==", "!=",
  "&&", "||",
  "++", "--",
  "**", "//",
];
