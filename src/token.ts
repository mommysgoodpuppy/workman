export type TokenKind =
  | "identifier"
  | "constructor"
  | "number"
  | "bool"
  | "string"
  | "keyword"
  | "symbol"
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
  "match",
  "import",
  "export",
  "from",
  "as",
]);

export const symbols = new Set([
  "=>",
  "->",
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
  "..",
  "_",
  "*",
]);
