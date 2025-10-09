import { Token } from "./token.ts";
import type {
  BlockExpr,
  BlockStatement,
  Expr,
  LetDeclaration,
  MatchArm,
  Parameter,
  Program,
  TopLevel,
  TypeAliasMember,
  TypeDeclaration,
  TypeExpr,
  TypeParameter,
} from "./ast.ts";
import type { Pattern, SourceSpan } from "./ast.ts";

export class ParseError extends Error {
  constructor(message: string, readonly token: Token) {
    super(`${message} at position ${token.start}`);
    this.name = "SurfaceParseError";
  }
}

export function parseSurfaceProgram(tokens: Token[]): Program {
  const parser = new SurfaceParser(tokens);
  return parser.parseProgram();
}

class SurfaceParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const declarations: TopLevel[] = [];
    while (!this.isEOF()) {
      declarations.push(this.parseTopLevel());
      if (!this.isEOF()) {
        this.expectSymbol(";");
      }
    }
    return { declarations };
  }

  private parseTopLevel(): TopLevel {
    const token = this.peek();
    if (token.kind === "keyword") {
      switch (token.value) {
        case "let":
          return this.parseLetDeclaration();
        case "type":
          return this.parseTypeDeclaration();
        default:
          throw this.error(`Unexpected keyword '${token.value}' at top-level`, token);
      }
    }
    throw this.error("Expected top-level declaration");
  }

  private parseLetDeclaration(): LetDeclaration {
    const letToken = this.expectKeyword("let");
    const nameToken = this.expectIdentifier();
    const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
    this.expectSymbol("=");
    const initializer = this.parseExpression();
    
    // Handle first-class match: match(x) { ... } desugars to (x) => { match(x) { ... } }
    if (initializer.kind === "match") {
      const scrutinee = initializer.scrutinee;
      // Extract parameter name from scrutinee (must be a simple identifier)
      if (scrutinee.kind !== "identifier") {
        throw this.error("First-class match scrutinee must be a simple parameter name", this.previous());
      }
      const paramName = scrutinee.name;
      const parameters: Parameter[] = [{
        kind: "parameter",
        name: paramName,
        annotation: undefined,
        span: scrutinee.span,
      }];
      const body: BlockExpr = {
        kind: "block",
        statements: [],
        result: initializer,
        span: initializer.span,
      };
      return {
        kind: "let",
        name: nameToken.value,
        parameters,
        annotation,
        body,
        span: this.spanFrom(letToken.start, body.span.end),
      };
    }
    
    if (initializer.kind !== "arrow") {
      throw this.error("Let declarations must be assigned an arrow function or first-class match", this.previous());
    }
    const { parameters, body } = initializer;
    return {
      kind: "let",
      name: nameToken.value,
      parameters,
      annotation,
      body,
      span: this.spanFrom(letToken.start, body.span.end),
    };
  }

  private parseParameterList(): Parameter[] {
    this.expectSymbol("(");
    const params: Parameter[] = [];
    if (!this.checkSymbol(")")) {
      do {
        const nameToken = this.expectIdentifier();
        let end = nameToken.end;
        const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
        if (annotation) {
          end = annotation.span.end;
        }
        params.push({
          kind: "parameter",
          name: nameToken.value,
          annotation,
          span: this.spanFrom(nameToken.start, end),
        });
      } while (this.matchSymbol(","));
    }
    this.expectSymbol(")");
    return params;
  }

  private parseBlockExpr(): BlockExpr {
    const open = this.expectSymbol("{");
    const statements: BlockStatement[] = [];
    let result: Expr | undefined;

    while (!this.checkSymbol("}")) {
      if (this.checkKeyword("let")) {
        const declaration = this.parseLetDeclaration();
        statements.push({
          kind: "let_statement",
          declaration,
          span: declaration.span,
        });
        this.expectSymbol(";");
        continue;
      }

      const expression = this.parseExpression();
      if (this.matchSymbol(";")) {
        statements.push({
          kind: "expr_statement",
          expression,
          span: expression.span,
        });
        continue;
      }
      result = expression;
      break;
    }

    const close = this.expectSymbol("}");
    const span = this.spanFrom(open.start, close.end);
    return { kind: "block", statements, result, span };
  }

  private parseTypeDeclaration(): TypeDeclaration {
    const typeToken = this.expectKeyword("type");
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
    this.expectSymbol("=");
    const members = this.parseTypeAliasMembers();
    const endToken = this.previous();
    return {
      kind: "type",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(typeToken.start, endToken.end),
    };
  }

  private parseTypeParameters(): TypeParameter[] {
    const params: TypeParameter[] = [];
    if (!this.checkSymbol(">")) {
      do {
        const ident = this.expectTypeParamName();
        params.push({ name: ident.value, span: this.createSpan(ident, ident) });
      } while (this.matchSymbol(","));
    }
    this.expectSymbol(">");
    return params;
  }

  private parseTypeAliasMembers(): TypeAliasMember[] {
    const members: TypeAliasMember[] = [];
    members.push(this.parseTypeAliasMember());
    while (this.matchSymbol("|")) {
      members.push(this.parseTypeAliasMember());
    }
    return members;
  }

  private parseTypeAliasMember(): TypeAliasMember {
    const token = this.peek();
    if (token.kind === "constructor") {
      const ctor = this.consume();
      const typeArgs = this.matchSymbol("<") ? this.parseTypeArguments() : [];
      return {
        kind: "constructor",
        name: ctor.value,
        typeArgs,
        span: this.spanFrom(ctor.start, typeArgs.length > 0 ? typeArgs[typeArgs.length - 1].span.end : ctor.end),
      };
    }
    const type = this.parseTypeExpr();
    return { kind: "alias", type, span: type.span };
  }

  private parseTypeArguments(): TypeExpr[] {
    const args: TypeExpr[] = [];
    if (!this.checkSymbol(">")) {
      do {
        args.push(this.parseTypeExpr());
      } while (this.matchSymbol(","));
    }
    this.expectSymbol(">");
    return args;
  }

  private parseExpression(): Expr {
    return this.parseMatchExpression();
  }

  private parseMatchExpression(): Expr {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === "match") {
      const matchToken = this.expectKeyword("match");
      this.expectSymbol("(");

      const args: Expr[] = [];
      if (!this.checkSymbol(")")) {
        args.push(this.parseExpression());
        if (this.matchSymbol(",")) {
          throw this.error("Only a single match argument is supported in this version");
        }
      }
      this.expectSymbol(")");

      if (args.length === 0) {
        throw this.error("Match requires a scrutinee expression");
      }

      if (this.matchSymbol("=>")) {
        const { arms, span } = this.parseMatchBlock();
        return {
          kind: "match_fn",
          parameters: args,
          arms,
          span: this.spanFrom(matchToken.start, span.end),
        };
      }

      const { arms, span } = this.parseMatchBlock();
      return {
        kind: "match",
        scrutinee: args[0],
        arms,
        span: this.spanFrom(matchToken.start, span.end),
      };
    }
    return this.parseArrowOrLower();
  }

  private parseArrowOrLower(): Expr {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === "(") {
      const snapshot = this.index;
      try {
        const params = this.tryParseArrowParameters();
        if (params) {
          const body = this.parseBlockExpr();
          return {
            kind: "arrow",
            parameters: params,
            body,
            span: this.spanFrom(params[0]?.span.start ?? this.previous().start, body.span.end),
          };
        }
      } catch (error) {
        this.index = snapshot;
      }
      this.index = snapshot;
    }
    return this.parseCallExpression();
  }

  private tryParseArrowParameters(): Parameter[] | null {
    const startIndex = this.index;
    this.expectSymbol("(");
    const params: Parameter[] = [];
    if (!this.checkSymbol(")")) {
      do {
        const ident = this.expectIdentifier();
        let end = ident.end;
        const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
        if (annotation) {
          end = annotation.span.end;
        }
        params.push({
          kind: "parameter",
          name: ident.value,
          annotation,
          span: this.spanFrom(ident.start, end),
        });
      } while (this.matchSymbol(","));
    }
    this.expectSymbol(")");
    if (!this.matchSymbol("=>")) {
      this.index = startIndex;
      return null;
    }
    return params;
  }

  private parseCallExpression(): Expr {
    let expr = this.parsePrimaryExpression();
    while (this.matchSymbol("(")) {
      const open = this.previous();
      const args: Expr[] = [];
      if (!this.checkSymbol(")")) {
        do {
          args.push(this.parseExpression());
        } while (this.matchSymbol(","));
      }
      const close = this.expectSymbol(")");

      if (expr.kind === "constructor") {
        expr = {
          ...expr,
          args,
          span: this.spanFrom(expr.span.start, close.end),
        };
      } else {
        expr = {
          kind: "call",
          callee: expr,
          arguments: args,
          span: this.spanFrom(expr.span.start, close.end),
        };
      }
    }
    return expr;
  }

  private parsePrimaryExpression(): Expr {
    const token = this.peek();
    switch (token.kind) {
      case "identifier": {
        const ident = this.consume();
        return { kind: "identifier", name: ident.value, span: this.createSpan(ident, ident) } as Expr;
      }
      case "constructor": {
        const ctor = this.consume();
        return { kind: "constructor", name: ctor.value, args: [], span: this.createSpan(ctor, ctor) } as Expr;
      }
      case "number": {
        const num = this.consume();
        return {
          kind: "literal",
          literal: { kind: "int", value: Number(num.value), span: this.createSpan(num, num) },
          span: this.createSpan(num, num),
        } as Expr;
      }
      case "bool": {
        const bool = this.consume();
        return {
          kind: "literal",
          literal: { kind: "bool", value: bool.value === "true", span: this.createSpan(bool, bool) },
          span: this.createSpan(bool, bool),
        } as Expr;
      }
      case "symbol": {
        if (token.value === "(") {
          return this.parseParenExpression();
        }
        if (token.value === "{") {
          return this.parseBlockExpr();
        }
      }
    }
    throw this.error("Expected expression", token);
  }

  private parseParenExpression(): Expr {
    const open = this.expectSymbol("(");
    const elements: Expr[] = [];
    if (!this.checkSymbol(")")) {
      elements.push(this.parseExpression());
      while (this.matchSymbol(",")) {
        elements.push(this.parseExpression());
      }
    }
    const close = this.expectSymbol(")");
    if (elements.length === 0) {
      const span = this.spanFrom(open.start, close.end);
      return {
        kind: "literal",
        literal: { kind: "unit", span },
        span,
      } as Expr;
    }
    if (elements.length === 1) {
      return { ...elements[0], span: this.spanFrom(open.start, close.end) } as Expr;
    }
    return {
      kind: "tuple",
      elements,
      span: this.spanFrom(open.start, close.end),
    } as Expr;
  }

  private parseTypeExpr(): TypeExpr {
    return this.parseTypeArrow();
  }

  private parseTypeArrow(): TypeExpr {
    const snapshot = this.index;
    const open = this.peek();
    if (open.kind === "symbol" && open.value === "(") {
      this.consume();
      const parameters: TypeExpr[] = [];
      if (!this.checkSymbol(")")) {
        do {
          parameters.push(this.parseTypeExpr());
        } while (this.matchSymbol(","));
      }
      const close = this.expectSymbol(")");
      if (this.matchSymbol("=>")) {
        const result = this.parseTypeExpr();
        return {
          kind: "type_fn",
          parameters,
          result,
          span: this.spanFrom(open.start, result.span.end),
        };
      }
      this.index = snapshot;
    }
    return this.parseTypePrimary();
  }

  private parseTypePrimary(): TypeExpr {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === "(") {
      return this.parseTypeTupleOrGrouping();
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      return {
        kind: "type_var",
        name: ident.value,
        span: this.createSpan(ident, ident),
      };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      const typeArgs = this.matchSymbol("<") ? this.parseTypeArguments() : [];
      const end = typeArgs.length > 0 ? typeArgs[typeArgs.length - 1].span.end : ctor.end;
      return {
        kind: "type_ref",
        name: ctor.value,
        typeArgs,
        span: this.spanFrom(ctor.start, end),
      };
    }

    throw this.error("Expected type expression", token);
  }

  private parseTypeTupleOrGrouping(): TypeExpr {
    const open = this.expectSymbol("(");
    if (this.checkSymbol(")")) {
      const close = this.expectSymbol(")");
      return { kind: "type_unit", span: this.spanFrom(open.start, close.end) };
    }

    const elements: TypeExpr[] = [];
    elements.push(this.parseTypeExpr());
    while (this.matchSymbol(",")) {
      elements.push(this.parseTypeExpr());
    }
    const close = this.expectSymbol(")");

    if (elements.length === 1) {
      const single = elements[0];
      return { ...single, span: this.spanFrom(open.start, close.end) };
    }

    return {
      kind: "type_tuple",
      elements,
      span: this.spanFrom(open.start, close.end),
    };
  }

  private expectTypeParamName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw this.error("Expected type parameter name", token);
  }

  private parsePattern(): Pattern {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === "_") {
      const underscore = this.consume();
      return { kind: "wildcard", span: this.createSpan(underscore, underscore) };
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      return { kind: "variable", name: ident.value, span: this.createSpan(ident, ident) };
    }

    if (token.kind === "number") {
      const num = this.consume();
      const literal = {
        kind: "int" as const,
        value: Number(num.value),
        span: this.createSpan(num, num),
      };
      return { kind: "literal", literal, span: literal.span };
    }

    if (token.kind === "bool") {
      const bool = this.consume();
      const literal = {
        kind: "bool" as const,
        value: bool.value === "true",
        span: this.createSpan(bool, bool),
      };
      return { kind: "literal", literal, span: literal.span };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      const args: Pattern[] = [];
      if (this.matchSymbol("(")) {
        if (!this.checkSymbol(")")) {
          do {
            args.push(this.parsePattern());
          } while (this.matchSymbol(","));
        }
        this.expectSymbol(")");
      }
      const end = args.length > 0 ? args[args.length - 1].span.end : ctor.end;
      return {
        kind: "constructor",
        name: ctor.value,
        args,
        span: this.spanFrom(ctor.start, end),
      };
    }

    if (token.kind === "symbol" && token.value === "(") {
      const open = this.expectSymbol("(");
      const elements: Pattern[] = [];
      if (!this.checkSymbol(")")) {
        elements.push(this.parsePattern());
        while (this.matchSymbol(",")) {
          elements.push(this.parsePattern());
        }
      }
      const close = this.expectSymbol(")");
      if (elements.length === 1) {
        const single = elements[0];
        return { ...single, span: this.spanFrom(open.start, close.end) };
      }
      return { kind: "tuple", elements, span: this.spanFrom(open.start, close.end) };
    }

    throw this.error("Expected pattern", token);
  }

  private parseMatchBlock(): { arms: MatchArm[]; span: SourceSpan } {
    const open = this.expectSymbol("{");
    const arms: MatchArm[] = [];

    if (!this.checkSymbol("}")) {
      while (true) {
        const patternStart = this.peek();
        const pattern = this.parsePattern();
        this.expectSymbol("=>");
        const body = this.parseExpression();
        
        // Enforce that match arm bodies must be block expressions
        if (body.kind !== "block") {
          throw this.error("Match arm body must be a block expression (use { })", this.previous());
        }
        
        const hasComma = this.matchSymbol(",");
        const span = this.spanFrom(patternStart.start, body.span.end);
        arms.push({ pattern, body, hasTrailingComma: hasComma, span });
        if (!hasComma || this.checkSymbol("}")) {
          break;
        }
      }
    }

    const close = this.expectSymbol("}");
    if (arms.length === 0) {
      throw this.error("Match block requires at least one arm", close);
    }
    return { arms, span: this.spanFrom(open.start, close.end) };
  }

  private createSpan(start: Token, end: Token): SourceSpan {
    return { start: start.start, end: end.end };
  }

  private spanFrom(start: number, end: number): SourceSpan {
    return { start, end };
  }

  private expectKeyword(value: string): Token {
    const token = this.consume();
    if (token.kind !== "keyword" || token.value !== value) {
      throw this.error(`Expected keyword '${value}'`, token);
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

  private expectTypeName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw this.error("Expected type name", token);
  }

  private expectSymbol(value: string): Token {
    const token = this.consume();
    if (token.kind !== "symbol" || token.value !== value) {
      throw this.error(`Expected symbol '${value}'`, token);
    }
    return token;
  }

  private matchSymbol(value: string): boolean {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === value) {
      this.consume();
      return true;
    }
    return false;
  }

  private checkSymbol(value: string): boolean {
    const token = this.peek();
    return token.kind === "symbol" && token.value === value;
  }

  private checkKeyword(value: string): boolean {
    const token = this.peek();
    return token.kind === "keyword" && token.value === value;
  }

  private consume(): Token {
    if (this.isEOF()) {
      throw this.error("Unexpected end of input", this.peek(-1));
    }
    return this.tokens[this.index++];
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

  private previous(): Token {
    return this.tokens[this.index - 1];
  }

  private isEOF(): boolean {
    return this.peek().kind === "eof";
  }

  private error(message: string, token: Token = this.peek()): ParseError {
    return new ParseError(message, token);
  }
}
