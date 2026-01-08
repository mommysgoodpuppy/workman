import type { Token } from "./token.ts";
import type { SourceSpan } from "./ast.ts";

/**
 * Base error class for all Workman language errors.
 * Provides utilities for formatting error messages with source context.
 */
export abstract class WorkmanError extends Error {
  abstract readonly errorType: string;

  constructor(message: string) {
    super(message);
    // Don't use this.constructor.name - causes issues in Nova
    // this.name = this.constructor.name;
  }

  /**
   * Format the error with optional source context
   */
  format(source?: string): string {
    return this.message;
  }
}

/**
 * Lexer errors - issues during tokenization
 */
export class LexError extends WorkmanError {
  readonly errorType = "Lexical Error";

  constructor(
    message: string,
    readonly position: number,
    readonly source?: string,
    readonly filename?: string,
  ) {
    super(message);
  }

  override format(source?: string): string {
    const src = source ?? this.source;
    if (!src) {
      return `${this.errorType}: ${this.message}`;
    }

    const location = getLineAndColumn(src, this.position);
    const context = getSourceContext(src, this.position, 1);

    return formatError({
      errorType: this.errorType,
      message: this.message,
      location,
      context,
      filename: this.filename,
    });
  }
}

/**
 * Parser errors - issues during parsing
 */
export class ParseError extends WorkmanError {
  readonly errorType = "Parse Error";

  constructor(
    message: string,
    readonly token: Token,
    readonly source?: string,
    readonly filename?: string,
  ) {
    super(message);
  }

  override format(source?: string): string {
    const src = source ?? this.source;
    if (!src) {
      return `${this.errorType}: ${this.message} at position ${this.token.start}`;
    }

    const location = getLineAndColumn(src, this.token.start);
    const context = getSourceContext(
      src,
      this.token.start,
      this.token.end - this.token.start,
    );

    return formatError({
      errorType: this.errorType,
      message: this.message,
      location,
      context,
      hint: getParseErrorHint(this.message, this.token),
      filename: this.filename,
    });
  }
}

/**
 * Type inference errors - issues during type checking
 */
export class InferError extends WorkmanError {
  readonly errorType = "Type Error";

  constructor(
    message: string,
    readonly span?: SourceSpan,
    readonly source?: string,
    readonly filename?: string,
  ) {
    super(message);
  }

  override format(source?: string): string {
    const src = source ?? this.source;
    if (!src || !this.span) {
      return `${this.errorType}: ${this.message}`;
    }

    const location = getLineAndColumn(src, this.span.start);
    const context = getSourceContext(
      src,
      this.span.start,
      this.span.end - this.span.start,
    );

    return formatError({
      errorType: this.errorType,
      message: this.message,
      location,
      context,
      hint: getTypeErrorHint(this.message),
      filename: this.filename,
    });
  }
}

/**
 * Module loader errors - issues during module resolution and loading
 */
export class ModuleError extends WorkmanError {
  readonly errorType = "Module Error";

  constructor(
    message: string,
    readonly modulePath?: string,
  ) {
    super(message);
  }

  override format(): string {
    if (this.modulePath) {
      return `${this.errorType} in '${this.modulePath}':\n  ${this.message}`;
    }
    return `${this.errorType}: ${this.message}`;
  }
}

/**
 * Runtime evaluation errors
 */
export class RuntimeError extends WorkmanError {
  readonly errorType = "Runtime Error";

  constructor(
    message: string,
    readonly span?: SourceSpan,
    readonly source?: string,
    readonly filename?: string,
  ) {
    super(message);
  }

  override format(source?: string): string {
    const src = source ?? this.source;
    if (!src || !this.span) {
      return `${this.errorType}: ${this.message}`;
    }

    const location = getLineAndColumn(src, this.span.start);
    const context = getSourceContext(
      src,
      this.span.start,
      this.span.end - this.span.start,
    );

    return formatError({
      errorType: this.errorType,
      message: this.message,
      location,
      context,
      filename: this.filename,
    });
  }
}

// ============================================================================
// Error Formatting Utilities
// ============================================================================

interface Location {
  line: number;
  column: number;
}

interface SourceContext {
  beforeLines: string[];
  errorLine: string;
  afterLines: string[];
  startColumn: number;
  length: number;
}

interface ErrorFormatOptions {
  errorType: string;
  message: string;
  location: Location;
  context?: SourceContext;
  hint?: string;
  filename?: string;
}

function formatError(options: ErrorFormatOptions): string {
  const { errorType, message, location, context, hint, filename } = options;

  const locationStr = filename
    ? `${filename}:${location.line}:${location.column}`
    : `line ${location.line}, column ${location.column}`;

  let output = `${errorType} at ${locationStr}:\n`;
  output += `  ${message}\n`;

  if (context) {
    output += "\n";

    // Show lines before
    for (const line of context.beforeLines) {
      output += `  ${line}\n`;
    }

    // Show error line
    output += `  ${context.errorLine}\n`;

    // Show error indicator
    const padding = " ".repeat(context.startColumn + 2); // +2 for "  " prefix
    const underline = "^".repeat(Math.max(1, context.length));
    output += `${padding}${underline}\n`;

    // Show lines after
    for (const line of context.afterLines) {
      output += `  ${line}\n`;
    }
  }

  if (hint) {
    output += `\nHint: ${hint}`;
  }

  return output;
}

function getLineAndColumn(source: string, position: number): Location {
  let line = 1;
  let column = 1;

  for (let i = 0; i < position && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function getSourceContext(
  source: string,
  start: number,
  length: number,
): SourceContext {
  const lines = source.split("\n");
  const location = getLineAndColumn(source, start);
  const lineIndex = location.line - 1;

  const beforeLines: string[] = [];
  const afterLines: string[] = [];

  // Get 1 line before
  if (lineIndex > 0) {
    beforeLines.push(lines[lineIndex - 1]);
  }

  const errorLine = lines[lineIndex] ?? "";

  // Get 1 line after
  if (lineIndex + 1 < lines.length) {
    afterLines.push(lines[lineIndex + 1]);
  }

  return {
    beforeLines,
    errorLine,
    afterLines,
    startColumn: location.column - 1,
    length: Math.min(length, errorLine.length - (location.column - 1)),
  };
}

// ============================================================================
// Error Formatting Helpers
// ============================================================================

export function formatWorkmanError(
  error: unknown,
  sourceOverride?: string,
): string {
  if (error instanceof WorkmanError) {
    return error.format(sourceOverride);
  }

  if (error instanceof AggregateError) {
    const header = error.message
      ? `${error.name}: ${error.message}`
      : error.name;
    if (error.errors.length === 0) {
      return header;
    }

    const formattedErrors = error.errors
      .map((inner) => formatWorkmanError(inner, sourceOverride))
      .join("\n\n");

    return `${header}\n${formattedErrors}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ============================================================================
// Error Hints
// ============================================================================

function getParseErrorHint(message: string, token: Token): string | undefined {
  // Expected identifier
  if (message.includes("Expected identifier")) {
    if (token.kind === "keyword") {
      return `'${token.value}' is a reserved keyword and cannot be used as an identifier`;
    }
    if (token.kind === "constructor") {
      return "Identifiers must start with a lowercase letter";
    }
    if (token.kind === "symbol") {
      return "An identifier (variable name) is required here";
    }
  }

  // Expected symbol
  if (message.includes("Expected symbol")) {
    const match = message.match(/Expected symbol '(.+?)'/);
    if (match) {
      const expected = match[1];
      if (expected === ";") {
        return "Statements must be terminated with a semicolon";
      }
      if (expected === "{" || expected === "}") {
        return "Block expressions must be enclosed in curly braces";
      }
      if (expected === "(" || expected === ")") {
        return "Check for matching parentheses";
      }
    }
  }

  // Expected keyword
  if (message.includes("Expected keyword")) {
    const match = message.match(/Expected keyword '(.+?)'/);
    if (match) {
      const expected = match[1];
      return `The '${expected}' keyword is required here`;
    }
  }

  // Unexpected keyword
  if (message.includes("Unexpected keyword")) {
    return "This keyword cannot be used in this context";
  }

  // Match errors
  if (message.includes("Match")) {
    if (message.includes("scrutinee")) {
      return "Match expressions require an expression to match against";
    }
    if (message.includes("block expression")) {
      return "Match arm bodies must be wrapped in { }";
    }
  }

  return undefined;
}

function getTypeErrorHint(message: string): string | undefined {
  // Type mismatch
  if (message.includes("Type mismatch") || message.includes("cannot unify")) {
    return "The types of these expressions are incompatible";
  }

  // Unknown identifier
  if (message.includes("Unknown identifier")) {
    return "This variable is not defined in the current scope";
  }

  // Unknown type
  if (message.includes("Unknown type")) {
    return "This type has not been defined or imported";
  }

  // Non-exhaustive patterns
  if (message.includes("Non-exhaustive patterns")) {
    return "Add more match arms or use a wildcard pattern (_) to handle all cases";
  }

  // Constructor not fully applied
  if (message.includes("not fully applied")) {
    return "This constructor or function needs more arguments";
  }

  // Occurs check
  if (message.includes("Occurs check")) {
    return "This would create an infinite type";
  }

  // Duplicate variable
  if (message.includes("Duplicate variable")) {
    return "Each variable can only be bound once in a pattern";
  }

  return undefined;
}

// ============================================================================
// Error Creation Helpers
// ============================================================================

/**
 * Create a lexer error for an unexpected character
 */
export function unexpectedCharError(
  char: string,
  position: number,
  source?: string,
  filename?: string,
): LexError {
  const displayChar = char === "\n"
    ? "\\n"
    : char === "\r"
    ? "\\r"
    : char === "\t"
    ? "\\t"
    : char;
  return new LexError(
    `Unexpected character '${displayChar}'`,
    position,
    source,
    filename,
  );
}

/**
 * Create a lexer error for an unterminated string
 */
export function unterminatedStringError(
  position: number,
  source?: string,
  filename?: string,
): LexError {
  return new LexError(
    "Unterminated string literal - missing closing quote",
    position,
    source,
    filename,
  );
}

/**
 * Create a parser error for an expected token
 */
export function expectedTokenError(
  expected: string,
  token: Token,
  source?: string,
  filename?: string,
): ParseError {
  const got = token.kind === "eof"
    ? "end of file"
    : `${token.kind} '${token.value}'`;

  return new ParseError(
    `Expected ${expected}, but got ${got}`,
    token,
    source,
    filename,
  );
}

/**
 * Create a parser error for an unexpected token
 */
export function unexpectedTokenError(
  message: string,
  token: Token,
  source?: string,
  filename?: string,
): ParseError {
  return new ParseError(message, token, source, filename);
}

/**
 * Create a type error
 */
export function typeError(
  message: string,
  span?: SourceSpan,
  source?: string,
  filename?: string,
): InferError {
  return new InferError(message, span, source, filename);
}

/**
 * Create a module error
 */
export function moduleError(message: string, modulePath?: string): ModuleError {
  return new ModuleError(message, modulePath);
}
