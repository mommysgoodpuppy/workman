import { Token } from "./token.ts";
import { ParseError, expectedTokenError, unexpectedTokenError } from "./error.ts";
import type {
  Associativity,
  BlockExpr,
  BlockStatement,
  Expr,
  ExportModifier,
  ImportSpecifier,
  InfixDeclaration,
  LetDeclaration,
  MatchArm,
  ModuleImport,
  ModuleReexport,
  NamedImport,
  NamespaceImport,
  Parameter,
  Program,
  TopLevel,
  TypeAliasMember,
  TypeDeclaration,
  TypeExpr,
  TypeParameter,
  TypeReexport,
} from "./ast.ts";
import type { Pattern, SourceSpan } from "./ast.ts";

// Re-export ParseError from error module
export { ParseError } from "./error.ts";

export type OperatorInfo = { precedence: number; associativity: Associativity };

export function parseSurfaceProgram(
  tokens: Token[], 
  source?: string, 
  preserveComments: boolean = false,
  initialOperators?: Map<string, OperatorInfo>,
  initialPrefixOperators?: Set<string>
): Program {
  const parser = new SurfaceParser(tokens, source, preserveComments, initialOperators, initialPrefixOperators);
  return parser.parseProgram();
}

class SurfaceParser {
  private index = 0;
  private operators: Map<string, OperatorInfo>;
  private prefixOperators: Set<string>;

  constructor(
    private readonly tokens: Token[],
    private readonly source?: string,
    private readonly preserveComments: boolean = false,
    initialOperators?: Map<string, OperatorInfo>,
    initialPrefixOperators?: Set<string>
  ) {
    this.operators = initialOperators ? new Map(initialOperators) : new Map();
    this.prefixOperators = initialPrefixOperators ? new Set(initialPrefixOperators) : new Set();
  }

  parseProgram(): Program {

    const imports: ModuleImport[] = [];
    const reexports: ModuleReexport[] = [];
    const declarations: TopLevel[] = [];
    let lastTokenEnd = 0;
    
    while (!this.isEOF()) {
      // Check if there's a blank line before this declaration
      let hasBlankLineBefore = false;
      if (this.source && declarations.length > 0) {
        const currentTokenStart = this.peek().start;
        const textBetween = this.source.slice(lastTokenEnd, currentTokenStart);
        // Count newlines - if 2 or more, there's a blank line
        const newlineCount = (textBetween.match(/\n/g) || []).length;
        hasBlankLineBefore = newlineCount >= 2;
      }
      
      // Collect any leading comments (only when preserving comments for formatter)
      const leadingComments = this.preserveComments ? this.collectLeadingComments() : [];
      
      if (this.isEOF()) {
        break;
      }
      
      const val = this.peek(this.index)
      //console.log(val, this.index);
      if (this.checkKeyword("from")) {
        imports.push(this.parseImportDeclaration());
      } else if (
        this.checkKeyword("export") &&
        this.peek(1).kind === "keyword" &&
        this.peek(1).value === "from"
      ) {
        reexports.push(this.parseModuleReexport());
      } else {
        const decl = this.parseTopLevel();
        if (leadingComments.length > 0) {
          decl.leadingComments = leadingComments;
        }
        if (hasBlankLineBefore) {
          decl.hasBlankLineBefore = true;
        }
        declarations.push(decl);
      }
      if (this.matchSymbol(";")) {
        const semicolonToken = this.previous();
        lastTokenEnd = semicolonToken.end;
        // Check for trailing comment on the same line (only when preserving comments)
        if (this.preserveComments && this.peek().kind === "comment" && this.source) {
          const commentToken = this.peek();
          const textBetween = this.source.slice(semicolonToken.end, commentToken.start);
          // Only treat as trailing if there's no newline between semicolon and comment
          if (!textBetween.includes("\n")) {
            const lastDecl = declarations[declarations.length - 1];
            if (lastDecl) {
              lastDecl.trailingComment = this.consume().value;
              lastTokenEnd = this.previous().end;
            }
          }
        }
        continue;
      }
      if (!this.isEOF()) {
        this.expectSymbol(";"); //cause of error
      }
    }
    return { imports, reexports, declarations };
  }

  private parseImportDeclaration(): ModuleImport {
    const fromToken = this.expectKeyword("from");
    const sourceToken = this.expectStringLiteral();
    this.expectKeyword("import");
    const { specifiers, endToken } = this.parseImportClause();
    if (specifiers.length === 0) {
      throw this.error("Import statement must include at least one specifier", this.peek());
    }
    return {
      kind: "module_import",
      source: sourceToken.value,
      specifiers,
      span: this.spanFrom(fromToken.start, endToken.end),
    };
  }

  private parseImportClause(): { specifiers: ImportSpecifier[]; endToken: Token } {
    if (this.matchSymbol("*")) {
      const starToken = this.previous();
      this.expectKeyword("as");
      const aliasToken = this.expectImportBindingName();
      const specifier: NamespaceImport = {
        kind: "namespace",
        local: aliasToken.value,
        span: this.createSpan(starToken, aliasToken),
      };
      return { specifiers: [specifier], endToken: aliasToken };
    }

    const _open = this.expectSymbol("{");
    const specifiers: ImportSpecifier[] = [];
    if (!this.checkSymbol("}")) {
      do {
        const importedToken = this.expectImportableName();
        let endToken = importedToken;
        let localToken = importedToken;
        if (this.matchKeyword("as")) {
          localToken = this.expectImportBindingName();
          endToken = localToken;
        }
        const specifier: NamedImport = {
          kind: "named",
          imported: importedToken.value,
          local: localToken.value,
          span: this.createSpan(importedToken, endToken),
        };
        specifiers.push(specifier);
      } while (this.matchSymbol(","));
    }
    const close = this.expectSymbol("}");
    return { specifiers, endToken: close };
  }

  private parseModuleReexport(): ModuleReexport {
    const exportToken = this.expectKeyword("export");
    this.expectKeyword("from");
    const sourceToken = this.expectStringLiteral();
    this.expectKeyword("type");
    const typeExports = this.parseTypeReexportList();
    const endToken = this.previous();
    return {
      kind: "module_reexport",
      source: sourceToken.value,
      typeExports,
      span: this.spanFrom(exportToken.start, endToken.end),
    };
  }

  private parseTypeReexportList(): TypeReexport[] {
    const typeExports: TypeReexport[] = [];
    typeExports.push(this.parseTypeReexport());
    while (this.matchSymbol(",")) {
      typeExports.push(this.parseTypeReexport());
    }
    return typeExports;
  }

  private parseTypeReexport(): TypeReexport {
    const nameToken = this.expectTypeName();
    let exportConstructors = false;
    let endToken: Token = nameToken;
    if (this.matchSymbol("(")) {
      if (this.matchSymbol(")")) {
        endToken = this.previous();
      } else {
        this.expectSymbol("..");
        const closeToken = this.expectSymbol(")");
        exportConstructors = true;
        endToken = closeToken;
      }
    }
    return {
      name: nameToken.value,
      exportConstructors,
      span: this.spanFrom(nameToken.start, endToken.end),
    };
  }

  private expectStringLiteral(): Token {
    const token = this.consume();
    if (token.kind !== "string") {
      throw this.error("Expected string literal", token);
    }
    return token;
  }

  private expectImportableName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw this.error("Expected import name", token);
  }

  private expectImportBindingName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw this.error("Expected binding name", token);
  }

  private parseTopLevel(): TopLevel {
    const exportToken = this.matchKeyword("export") ? this.previous() : undefined;
    const token = this.peek();
    if (token.kind === "keyword") {
      switch (token.value) {
        case "let":
          return this.parseLetDeclaration(exportToken);
        case "type":
          return this.parseTypeDeclaration(exportToken);
        case "infix":
        case "infixl":
        case "infixr":
          return this.parseInfixDeclaration(exportToken);
        case "prefix":
          return this.parsePrefixDeclaration(exportToken);
        default:
          throw this.error(`Unexpected keyword '${token.value}' at top-level`, token);
      }
    }
    if (exportToken) {
      throw this.error("Expected 'let', 'type', 'infix', or 'prefix' after 'export'", token);
    }
    throw this.error("Expected top-level declaration", token);
  }

  private parseLetDeclaration(exportToken?: Token): LetDeclaration {
    const letToken = this.expectKeyword("let");
    const isRecursive = this.matchKeyword("rec");

    const firstBinding = this.parseLetBinding(letToken.start, isRecursive);

    // Parse mutual bindings with "and"
    const mutualBindings: LetDeclaration[] = [];
    while (this.matchKeyword("and")) {
      const andStart = this.previous().start;
      mutualBindings.push(this.parseLetBinding(andStart, true));
    }
    if (mutualBindings.length > 0) {
      firstBinding.mutualBindings = mutualBindings;
    }

    if (exportToken) {
      const modifier: ExportModifier = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
      firstBinding.export = modifier;
      if (firstBinding.mutualBindings) {
        for (const binding of firstBinding.mutualBindings) {
          binding.export = modifier;
        }
      }
    }

    return firstBinding;
  }

  private parseLetBinding(startPos: number, isRecursive: boolean): LetDeclaration {
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
        const parameterPattern: Pattern = {
          kind: "variable",
          name: paramName,
          span: scrutinee.span,
        };
        const parameters: Parameter[] = [{
          kind: "parameter",
          pattern: parameterPattern,
          name: paramName,
          annotation: undefined,
          span: scrutinee.span,
        }];
      
      // Detect if the match expression is multi-line
      let isMultiLine = false;
      if (this.source) {
        const matchText = this.source.slice(initializer.span.start, initializer.span.end);
        isMultiLine = matchText.includes("\n");
      }
      
      const body: BlockExpr = {
        kind: "block",
        statements: [],
        result: initializer,
        span: initializer.span,
        isMultiLine,
      };
      return {
        kind: "let",
        name: nameToken.value,
        parameters,
        annotation,
        body,
        isRecursive,
        isFirstClassMatch: true,
        span: this.spanFrom(startPos, body.span.end),
      };
    }
    
    if (initializer.kind === "block") {
      if (isRecursive) {
        throw this.error("Recursive let declarations must use arrow syntax", this.previous());
      }
      return {
        kind: "let",
        name: nameToken.value,
        parameters: [],
        annotation,
        body: initializer,
        isRecursive,
        span: this.spanFrom(startPos, initializer.span.end),
      };
    }

    if (initializer.kind === "arrow") {
      const { parameters, body } = initializer;
      return {
        kind: "let",
        name: nameToken.value,
        parameters,
        annotation,
        body,
        isRecursive,
        isArrowSyntax: true,
        span: this.spanFrom(startPos, body.span.end),
      };
    }

    if (isRecursive) {
      throw this.error("Recursive let declarations must use arrow syntax", this.previous());
    }

    const body: BlockExpr = {
      kind: "block",
      statements: [],
      result: initializer,
      span: initializer.span,
    };

    return {
      kind: "let",
      name: nameToken.value,
      parameters: [],
      annotation,
      body,
      isRecursive,
      span: this.spanFrom(startPos, body.span.end),
    };
  }

  private matchKeyword(value: string): boolean {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === value) {
      this.consume();
      return true;
    }
    return false;
  }

  private parseParameterList(): Parameter[] {
    this.expectSymbol("(");
    const params: Parameter[] = [];
    if (!this.checkSymbol(")")) {
      do {
        const pattern = this.parsePattern();
        this.ensureValidParameterPattern(pattern);
        const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
        const spanEnd = annotation ? annotation.span.end : pattern.span.end;
        params.push({
          kind: "parameter",
          pattern,
          name: pattern.kind === "variable" ? pattern.name : undefined,
          annotation,
          span: this.spanFrom(pattern.span.start, spanEnd),
        });
      } while (this.matchSymbol(","));
    }
    this.expectSymbol(")");
    return params;
  }

  private ensureValidParameterPattern(pattern: Pattern): void {
    switch (pattern.kind) {
      case "variable":
      case "wildcard":
        return;
      case "tuple":
        for (const element of pattern.elements) {
          this.ensureValidParameterPattern(element);
        }
        return;
      default:
        throw this.error(
          "Only identifier, wildcard, or tuple patterns are allowed in parameter lists",
          this.syntheticToken(pattern.span),
        );
    }
  }

  private syntheticToken(span: SourceSpan): Token {
    return { kind: "identifier", value: "<pattern>", start: span.start, end: span.end };
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
    
    // Detect if block is multi-line by checking if there's a newline between { and }
    let isMultiLine = false;
    if (this.source) {
      const blockText = this.source.slice(open.start, close.end);
      isMultiLine = blockText.includes("\n");
    }
    
    return { kind: "block", statements, result, span, isMultiLine };
  }

  private parseTypeDeclaration(exportToken?: Token): TypeDeclaration {
    const typeToken = this.expectKeyword("type");
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
    this.expectSymbol("=");
    const members = this.parseTypeAliasMembers();
    const endToken = this.previous();
    const declaration: TypeDeclaration = {
      kind: "type",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(typeToken.start, endToken.end),
    };
    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }
    return declaration;
  }

  private parseInfixDeclaration(exportToken?: Token): InfixDeclaration {
    const infixToken = this.consume(); // infix, infixl, or infixr
    const associativity: Associativity = 
      infixToken.value === "infixl" ? "left" :
      infixToken.value === "infixr" ? "right" : "none";
    
    // Parse precedence (number)
    const precedenceToken = this.consume();
    if (precedenceToken.kind !== "number") {
      throw this.error("Expected precedence number", precedenceToken);
    }
    const precedence = Number(precedenceToken.value);
    
    // Parse operator
    const operatorToken = this.consume();
    if (operatorToken.kind !== "operator") {
      throw this.error("Expected operator", operatorToken);
    }
    const operator = operatorToken.value;
    
    // Parse "="
    this.expectSymbol("=");
    
    // Parse implementation function name
    const implToken = this.expectIdentifier();
    const implementation = implToken.value;
    
    // Register the operator
    this.operators.set(operator, { precedence, associativity });
    
    const declaration: InfixDeclaration = {
      kind: "infix",
      operator,
      associativity,
      precedence,
      implementation,
      span: this.spanFrom(infixToken.start, implToken.end),
    };
    
    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }
    
    return declaration;
  }

  private parsePrefixDeclaration(exportToken?: Token): import("./ast.ts").PrefixDeclaration {
    const prefixToken = this.expectKeyword("prefix");
    
    // Parse operator
    const operatorToken = this.consume();
    if (operatorToken.kind !== "operator") {
      throw this.error("Expected operator", operatorToken);
    }
    const operator = operatorToken.value;
    
    // Parse "="
    this.expectSymbol("=");
    
    // Parse implementation function name
    const implToken = this.expectIdentifier();
    const implementation = implToken.value;
    
    // Register the prefix operator
    this.prefixOperators.add(operator);
    
    const declaration: import("./ast.ts").PrefixDeclaration = {
      kind: "prefix",
      operator,
      implementation,
      span: this.spanFrom(prefixToken.start, implToken.end),
    };
    
    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }
    
    return declaration;
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
    // Allow optional leading pipe for multi-line type definitions
    this.matchSymbol("|");
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
      let params: Parameter[] | null = null;
      try {
        params = this.tryParseArrowParameters();
      } catch (_error) {
        // Only failures while scanning arrow parameters should backtrack.
        this.index = snapshot;
      }
      // If params is null, tryParseArrowParameters either restored the index itself
      // or we restored it in the catch above. In that case, fall through.
      if (params) {
        const body = this.parseBlockExpr();
        return {
          kind: "arrow",
          parameters: params,
          body,
          span: this.spanFrom(params[0]?.span.start ?? this.previous().start, body.span.end),
        };
      }
    }
    return this.parseBinaryExpression();
  }

  private tryParseArrowParameters(): Parameter[] | null {
    const startIndex = this.index;
    try {
      const params = this.parseParameterList();
      if (!this.matchSymbol("=>")) {
        this.index = startIndex;
        return null;
      }
      return params;
    } catch (_error) {
      this.index = startIndex;
      return null;
    }
  }

  private parseBinaryExpression(minPrecedence: number = 0): Expr {
    let left = this.parseCallExpression();
    
    while (true) {
      const token = this.peek();
      if (token.kind !== "operator") {
        break;
      }
      
      const opInfo = this.operators.get(token.value);
      if (!opInfo || opInfo.precedence < minPrecedence) {
        break;
      }
      
      const operator = this.consume().value;
      const nextMinPrecedence = opInfo.associativity === "left" 
        ? opInfo.precedence + 1 
        : opInfo.precedence;
      
      const right = this.parseBinaryExpression(nextMinPrecedence);
      
      left = {
        kind: "binary",
        operator,
        left,
        right,
        span: this.spanFrom(left.span.start, right.span.end),
      };
    }
    
    return left;
  }

  private parseCallExpression(): Expr {
    let expr = this.parsePrimaryExpression();
    while (this.matchSymbol("(")) {
      const _open = this.previous();
      const args: Expr[] = [];
      if (!this.checkSymbol(")")) {
        do {
          args.push(this.parseExpression());
        } while (this.matchSymbol(","));
      }
      const _close = this.expectSymbol(")");

      if (expr.kind === "constructor") {
        expr = {
          ...expr,
          args,
          span: this.spanFrom(expr.span.start, _close.end),
        };
      } else {
        expr = {
          kind: "call",
          callee: expr,
          arguments: args,
          span: this.spanFrom(expr.span.start, _close.end),
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
      case "char": {
        const ch = this.consume();
        return {
          kind: "literal",
          literal: { kind: "char", value: ch.value, span: this.createSpan(ch, ch) },
          span: this.createSpan(ch, ch),
        } as Expr;
      }
      case "string": {
        const str = this.consume();
        return {
          kind: "literal",
          literal: { kind: "string", value: str.value, span: this.createSpan(str, str) },
          span: this.createSpan(str, str),
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
      case "operator": {
        // Check if this is a registered prefix operator
        if (this.prefixOperators.has(token.value)) {
          const opToken = this.consume();
          const operand = this.parsePrimaryExpression();
          return {
            kind: "unary",
            operator: opToken.value,
            operand,
            span: this.spanFrom(opToken.start, operand.span.end),
          } as Expr;
        }
        // Otherwise, it's an unexpected operator
        break;
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
    
    // Detect if tuple is multi-line
    let isMultiLine = false;
    if (this.source) {
      const tupleText = this.source.slice(open.start, close.end);
      isMultiLine = tupleText.includes("\n");
    }
    
    return {
      kind: "tuple",
      elements,
      span: this.spanFrom(open.start, close.end),
      isMultiLine,
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

    if (token.kind === "char") {
      const ch = this.consume();
      const literal = {
        kind: "char" as const,
        value: ch.value,
        span: this.createSpan(ch, ch),
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
      throw expectedTokenError(`keyword '${value}'`, token, this.source);
    }
    return token;
  }

  private expectIdentifier(): Token {
    const token = this.consume();
    if (token.kind !== "identifier") {
      throw expectedTokenError("identifier", token, this.source);
    }
    return token;
  }

  private expectTypeName(): Token {
    const token = this.consume();
    if (token.kind === "identifier" || token.kind === "constructor") {
      return token;
    }
    throw expectedTokenError("type name", token, this.source);
  }

  private expectSymbol(value: string): Token {
    const token = this.consume();
    if (token.kind !== "symbol" || token.value !== value) {
      throw expectedTokenError(`symbol '${value}'`, token, this.source);
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
    if (!this.preserveComments) {
      this.skipComments();
    }
    if (this.isEOF()) {
      throw this.error("Unexpected end of input", this.peek(-1));
    }
    const index = this.index++;
    //console.log("CONSUME at", index, this.tokens[index])
    return this.tokens[index];
  }

  private peek(offset = 0): Token {
    if (!this.preserveComments) {
      // Skip comments before peeking
      let tempIndex = this.index;
      while (tempIndex < this.tokens.length && this.tokens[tempIndex].kind === "comment") {
        tempIndex++;
      }
      const index = tempIndex + offset;
      if (index < 0) {
        return this.tokens[0];
      }
      if (index >= this.tokens.length) {
        return this.tokens[this.tokens.length - 1];
      }
      return this.tokens[index];
    }
    
    // Original behavior when preserving comments
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
    return unexpectedTokenError(message, token, this.source);
  }

  private collectLeadingComments(): import("./ast.ts").CommentBlock[] {
    const comments: import("./ast.ts").CommentBlock[] = [];
    while (this.peek().kind === "comment") {
      const commentToken = this.consume();
      const commentText = commentToken.value;
      
      // Check if there's a blank line after this comment (before next token)
      let hasBlankLineAfter = false;
      if (this.source && this.peek().kind === "comment") {
        const nextToken = this.peek();
        const textBetween = this.source.slice(commentToken.end, nextToken.start);
        // Count newlines - if 2 or more, there's a blank line
        const newlineCount = (textBetween.match(/\n/g) || []).length;
        hasBlankLineAfter = newlineCount >= 2;
      }
      
      comments.push({ text: commentText, hasBlankLineAfter });
    }
    return comments;
  }

  private skipComments(): void {
    while (this.index < this.tokens.length && this.tokens[this.index].kind === "comment") {
      this.index++;
    }
  }
}
