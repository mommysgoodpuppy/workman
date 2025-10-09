export type TokenKind =
  | "identifier"
  | "constructor"
  | "number"
  | "bool"
  | "keyword"
  | "symbol"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

export const keywords = new Set([
  "let",
  "type",
  "match",
  "case",
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
  "_",
]);
