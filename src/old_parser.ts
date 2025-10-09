import {
  ConstructorDecl,
  Expr,
  LetDeclaration,
  Pattern,
  Program,
  SourceSpan,
  TopLevel,
  TypeDeclaration,
  TypeExpr,
} from "./ast.ts";
import { Token } from "./token.ts";

export class ParseError extends Error {
  constructor(message: string, readonly token: Token) {
    super(`${message} at position ${token.start}`);
    this.name = "ParseError";
  }
}

export function parse(tokens: Token[]): Program {
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const declarations: TopLevel[] = [];
    while (!this.isEOF()) {
      declarations.push(this.parseTopLevel());
      this.matchSymbol(";");
    }
    return { declarations };
  }

  private parseTopLevel(): TopLevel {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === "type") {
      return this.parseTypeDeclaration();
    }
    if (token.kind === "keyword" && token.value === "let") {
      return this.parseLetDeclaration();
    }
    throw this.error("Expected top-level declaration");
  }

  private parseTypeDeclaration(): TypeDeclaration {
    const typeToken = this.expectKeyword("type");
    const nameToken = this.expectTypeName();

    const parameters: string[] = [];
    while (this.peek().kind === "identifier") {
      parameters.push(this.consume().value);
    }

    this.expectSymbol("=");

    const constructors: ConstructorDecl[] = [];
    constructors.push(this.parseConstructorDecl());
    while (this.matchSymbol("|")) {
      constructors.push(this.parseConstructorDecl());
    }

    const endToken = this.previous();
    return {
      kind: "type",
      name: nameToken.value,
      parameters,
      constructors,
      span: this.createSpan(typeToken, endToken),
    };
  }

  private parseLetDeclaration(): LetDeclaration {
    const letToken = this.expectKeyword("let");
    const nameToken = this.expectIdentifier();

    let annotation: TypeExpr | undefined;
    if (this.matchSymbol(":")) {
      annotation = this.parseTypeExpr();
    }

    this.expectSymbol("=");
    const value = this.parseExpression();
    return {
      kind: "let",
      name: nameToken.value,
      value,
      annotation,
      span: this.spanFromPositions(letToken.start, value.span.end),
    };
  }

  private parseExpression(): Expr {
    return this.parseMatchExpression();
  }

  private parseMatchExpression(): Expr {
    if (this.matchKeyword("match")) {
      const matchToken = this.previous();
      let value: Expr | undefined;
      if (this.checkKeyword("with")) {
        this.consume();
      } else {
        value = this.parseExpression();
        this.expectKeyword("with");
      }
      const cases = this.parseMatchArms();
      return {
        kind: "match",
        value,
        cases,
        span: this.spanFromPositions(matchToken.start, cases[cases.length - 1].body.span.end),
      };
    }
    return this.parseLambda();
  }

  private parseMatchArms() {
    const cases = [] as { pattern: Pattern; body: Expr }[];
    if (!this.matchSymbol("|")) {
      throw this.error("Expected '|' to start match arm");
    }
    do {
      const pattern = this.parsePattern();
      this.expectSymbol("->");
      const body = this.parseExpression();
      cases.push({ pattern, body });
      this.matchSymbol(";");
    } while (this.matchSymbol("|"));
    return cases;
  }

  private parseLambda(): Expr {
    if (this.matchKeyword("fn")) {
      const fnToken = this.previous();
      const paramToken = this.expectIdentifier();
      this.expectSymbol("->");
      const body = this.parseExpression();
      return {
        kind: "lambda",
        param: paramToken.value,
        body,
        span: this.spanFromPositions(fnToken.start, body.span.end),
      };
    }
    return this.parseLetInExpression();
  }

  private parseLetInExpression(): Expr {
    if (this.matchKeyword("let")) {
      const letToken = this.previous();
      const nameToken = this.expectIdentifier();
      this.expectSymbol("=");
      const value = this.parseExpression();
      this.expectKeyword("in");
      const body = this.parseExpression();
      return {
        kind: "let",
        name: nameToken.value,
        value,
        body,
        span: this.spanFromPositions(letToken.start, body.span.end),
      } as Expr;
    }
    return this.parseApplication();
  }

  private parseApplication(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      const next = this.peek();
      if (this.isExpressionStart(next)) {
        const argument = this.parsePrimary();
        expr = {
          kind: "apply",
          fn: expr,
          argument,
          span: this.mergeSpans(expr.span, argument.span),
        };
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token.kind === "identifier") {
      const ident = this.consume();
      return { kind: "var", name: ident.value, span: this.createSpan(ident, ident) };
    }
    if (token.kind === "constructor") {
      const ctor = this.consume();
      const args: Expr[] = [];
      while (this.isExpressionStart(this.peek())) {
        args.push(this.parsePrimary());
      }
      return {
        kind: "constructor",
        name: ctor.value,
        args,
        span: this.spanFromPositions(
          ctor.start,
          args.length > 0 ? args[args.length - 1].span.end : ctor.end,
        ),
      };
    }
    if (token.kind === "number") {
      const num = this.consume();
      return {
        kind: "literal",
        literal: {
          kind: "int",
          value: Number(num.value),
          span: this.createSpan(num, num),
        },
        span: this.createSpan(num, num),
      };
    }
    if (token.kind === "bool") {
      const bool = this.consume();
      return {
        kind: "literal",
        literal: {
          kind: "bool",
          value: bool.value === "true",
          span: this.createSpan(bool, bool),
        },
        span: this.createSpan(bool, bool),
      };
    }
    if (this.matchSymbol("()")) {
      const unit = this.previous();
      return {
        kind: "literal",
        literal: { kind: "unit", span: this.createSpan(unit, unit) },
        span: this.createSpan(unit, unit),
      };
    }
    if (this.matchSymbol("(")) {
      const open = this.previous();
      const elements: Expr[] = [];
      elements.push(this.parseExpression());
      while (this.matchSymbol(",")) {
        elements.push(this.parseExpression());
      }
      const close = this.expectSymbol(")");
      if (elements.length === 1) {
        const single = elements[0];
        return { ...single, span: this.createSpan(open, close) };
      }
      return {
        kind: "tuple",
        elements,
        span: this.createSpan(open, close),
      };
    }
    throw this.error("Expected expression");
  }

  private isExpressionStart(token: Token): boolean {
    if (token.kind === "identifier" || token.kind === "constructor") {
      return true;
    }
    if (token.kind === "number" || token.kind === "bool") {
      return true;
    }
    if (token.kind === "symbol") {
      return token.value === "(" || token.value === "()";
    }
    return false;
  }

  private parsePattern(): Pattern {
    return this.parsePatternAtom();
  }

  private parsePatternAtom(): Pattern {
    if (this.matchSymbol("_")) {
      const underscore = this.previous();
      return { kind: "wildcard", span: this.createSpan(underscore, underscore) };
    }

    const token = this.peek();
    if (token.kind === "identifier") {
      const ident = this.consume();
      return {
        kind: "variable",
        name: ident.value,
        span: this.createSpan(ident, ident),
      };
    }

    if (token.kind === "number") {
      const num = this.consume();
      const literal = {
        kind: "int" as const,
        value: Number(num.value),
        span: this.createSpan(num, num),
      };
      return {
        kind: "literal",
        literal,
        span: literal.span,
      };
    }

    if (token.kind === "bool") {
      const bool = this.consume();
      const literal = {
        kind: "bool" as const,
        value: bool.value === "true",
        span: this.createSpan(bool, bool),
      };
      return {
        kind: "literal",
        literal,
        span: literal.span,
      };
    }

    if (this.matchSymbol("()")) {
      const unit = this.previous();
      const literal = { kind: "unit" as const, span: this.createSpan(unit, unit) };
      return { kind: "literal", literal, span: literal.span };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      const args: Pattern[] = [];
      while (this.isPatternStart(this.peek())) {
        args.push(this.parsePatternAtom());
      }
      return {
        kind: "constructor",
        name: ctor.value,
        args,
        span: this.spanFromPositions(
          ctor.start,
          args.length > 0 ? args[args.length - 1].span.end : ctor.end,
        ),
      };
    }

    if (this.matchSymbol("(")) {
      const open = this.previous();
      const elements: Pattern[] = [];
      elements.push(this.parsePattern());
      while (this.matchSymbol(",")) {
        elements.push(this.parsePattern());
      }
      const close = this.expectSymbol(")");
      if (elements.length === 1) {
        const single = elements[0];
        return { ...single, span: this.spanFromPositions(open.start, close.end) };
      }
      return {
        kind: "tuple",
        elements,
        span: this.createSpan(open, close),
      };
    }

    throw this.error("Expected pattern");
  }

  private isPatternStart(token: Token): boolean {
    if (token.kind === "identifier" || token.kind === "constructor") {
      return true;
    }
    if (token.kind === "number" || token.kind === "bool") {
      return true;
    }
    if (token.kind === "symbol") {
      return token.value === "(" || token.value === "()" || token.value === "_";
    }
    return false;
  }

  private parseTypeExpr(): TypeExpr {
    return this.parseFunctionType();
  }

  private parseConstructorDecl(): ConstructorDecl {
    const nameToken = this.expectConstructor();
    const args: TypeExpr[] = [];
    while (this.isTypeExprStart(this.peek())) {
      args.push(this.parseTypeAtom());
    }
    return {
      kind: "constructor",
      name: nameToken.value,
      args,
      span: this.spanFromPositions(
        nameToken.start,
        args.length > 0 ? args[args.length - 1].span.end : nameToken.end,
      ),
    };
  }

  private parseFunctionType(): TypeExpr {
    const from = this.parseTypeAtom();
    if (this.matchSymbol("->")) {
      const to = this.parseFunctionType();
      return {
        kind: "func",
        from,
        to,
        span: this.mergeSpans(from.span, to.span),
      };
    }
    return from;
  }

  private parseTypeAtom(): TypeExpr {
    const token = this.peek();

    if (this.matchSymbol("()")) {
      const unit = this.previous();
      return { kind: "unit", span: this.createSpan(unit, unit) };
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      return { kind: "var", name: ident.value, span: this.createSpan(ident, ident) };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      if (this.isPrimitiveType(ctor.value)) {
        return {
          kind: "constructor",
          name: ctor.value,
          args: [],
          span: this.createSpan(ctor, ctor),
        };
      }
      const args: TypeExpr[] = [];
      while (this.isTypeExprStart(this.peek())) {
        args.push(this.parseTypeAtom());
      }
      return {
        kind: "constructor",
        name: ctor.value,
        args,
        span: this.spanFromPositions(
          ctor.start,
          args.length > 0 ? args[args.length - 1].span.end : ctor.end,
        ),
      };
    }

    if (this.matchSymbol("(")) {
      const open = this.previous();
      const elements: TypeExpr[] = [];
      elements.push(this.parseTypeExpr());
      while (this.matchSymbol(",")) {
        elements.push(this.parseTypeExpr());
      }
      const close = this.expectSymbol(")");

      if (elements.length === 1) {
        const single = elements[0];
        return {
          ...single,
          span: this.spanFromPositions(open.start, close.end),
        };
      }

      return {
        kind: "tuple",
        elements,
        span: this.createSpan(open, close),
      };
    }

    throw this.error("Expected type expression");
  }

  private isTypeExprStart(token: Token): boolean {
    if (token.kind === "identifier" || token.kind === "constructor") {
      return true;
    }
    if (token.kind === "symbol") {
      return token.value === "(" || token.value === "()";
    }
    return false;
  }

  private isPrimitiveType(name: string): boolean {
    return name === "Int" || name === "Bool" || name === "Unit";
  }

  private consume(): Token {
    if (this.isEOF()) {
      throw this.error("Unexpected end of input", this.peek(-1));
    }
    return this.tokens[this.index++];
  }

  private expectKeyword(expected: string): Token {
    const token = this.consume();
    if (token.kind !== "keyword" || token.value !== expected) {
      throw this.error(`Expected keyword '${expected}'`, token);
    }
    return token;
  }

  private expectSymbol(expected: string): Token {
    const token = this.consume();
    if (token.kind !== "symbol" || token.value !== expected) {
      throw this.error(`Expected symbol '${expected}'`, token);
    }
    return token;
  }

  private expectIdentifier(): Token {
    const token = this.consume();
    if (token.kind !== "identifier") {
      throw this.error("Expected identifier", token);
    }
    return token;
  }

  private expectConstructor(): Token {
    const token = this.consume();
    if (token.kind !== "constructor") {
      throw this.error("Expected constructor name", token);
    }
    return token;
  }

  private expectTypeName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw this.error("Expected type name", token);
  }

  private matchKeyword(value: string): boolean {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private checkKeyword(value: string): boolean {
    const token = this.peek();
    return token.kind === "keyword" && token.value === value;
  }

  private matchSymbol(value: string): boolean {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private peek(offset = 0): Token {
    const index = this.index + offset;
    if (index < 0) {
      return this.tokens[0];
    }
    if (index >= this.tokens.length) {
      return this.tokens[this.tokens.length - 1];
    }
    return this.tokens[index];
  }

  private isEOF(): boolean {
    return this.peek().kind === "eof";
  }

  private previous(): Token {
    const index = this.index - 1;
    return this.tokens[index >= 0 ? index : 0];
  }

  private createSpan(start: Token, end: Token): SourceSpan {
    return { start: start.start, end: end.end };
  }

  private mergeSpans(a: SourceSpan, b: SourceSpan): SourceSpan {
    return {
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
    };
  }

  private spanFromPositions(start: number, end: number): SourceSpan {
    return { start, end };
  }

  private error(message: string, token: Token = this.peek()): ParseError {
    return new ParseError(message, token);
  }
}
