import type { Token } from "./token.ts";
import {
  expectedTokenError,
  type ParseError,
  unexpectedTokenError,
} from "./error.ts";
import { nextNodeId, resetNodeIds } from "./node_ids.ts";
import type {
  Associativity,
  BlockExpr,
  BlockStatement,
  ExportModifier,
  Expr,
  ImportSpecifier,
  InfixDeclaration,
  LetDeclaration,
  PatternLetStatement,
  MatchArm,
  MatchBundle,
  ModuleImport,
  ModuleReexport,
  NamedImport,
  NamespaceImport,
  Parameter,
  Program,
  RecordField,
  TopLevel,
  TypeAliasMember,
  TypeDeclaration,
  TypeEffectRowCase,
  TypeExpr,
  TypeParameter,
  TypeRecordField,
  TypeReexport,
} from "./ast.ts";
import type { Pattern, SourceSpan } from "./ast.ts";

// Re-export ParseError from error module
//export { ParseError } from "./error.ts";

export type OperatorInfo = { precedence: number; associativity: Associativity };

export function parseSurfaceProgram(
  tokens: Token[],
  source?: string,
  preserveComments: boolean = false,
  initialOperators?: Map<string, OperatorInfo>,
  initialPrefixOperators?: Set<string>,
): Program {
  resetNodeIds(0); // Reset IDs before parsing
  const parser = new SurfaceParser(
    tokens,
    source,
    preserveComments,
    initialOperators,
    initialPrefixOperators,
  );
  return parser.parseProgram();
}

interface MatchParameterSpec {
  name: string;
  span?: SourceSpan;
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
    initialPrefixOperators?: Set<string>,
  ) {
    // Start with default comparison operators (these are defined in std/core/int but need to be known at parse time)
    const defaultOperators = new Map<string, OperatorInfo>([
      ["<", { precedence: 4, associativity: "none" }],
      [">", { precedence: 4, associativity: "none" }],
      ["<=", { precedence: 4, associativity: "none" }],
      [">=", { precedence: 4, associativity: "none" }],
    ]);

    this.operators = initialOperators
      ? new Map([...defaultOperators, ...initialOperators])
      : defaultOperators;
    this.prefixOperators = initialPrefixOperators
      ? new Set(initialPrefixOperators)
      : new Set();
  }

  parseProgram(): Program {
    const imports: ModuleImport[] = [];
    const reexports: ModuleReexport[] = [];
    const declarations: TopLevel[] = [];
    let lastTokenEnd = 0;
    const trailingCommentBlocks: import("./ast.ts").CommentBlock[] = [];
    let hasPreviousItem = false;
    let lastTopLevel: ModuleImport | ModuleReexport | TopLevel | null = null;

    while (!this.isEOF()) {
      // Check if there's a blank line before this declaration
      let hasBlankLineBefore = false;
      if (this.source && hasPreviousItem) {
        const currentTokenStart = this.peek().start;
        const textBetween = this.source.slice(lastTokenEnd, currentTokenStart);
        // Count newlines - if 2 or more, there's a blank line
        const newlineCount = (textBetween.match(/\n/g) || []).length;
        hasBlankLineBefore = newlineCount >= 2;
      }

      // Collect any leading comments (only when preserving comments for formatter)
      const leadingComments = this.preserveComments
        ? this.collectLeadingComments()
        : [];

      if (this.isEOF()) {
        if (leadingComments.length > 0) {
          trailingCommentBlocks.push(...leadingComments);
        }
        break;
      }

      const val = this.peek(this.index);
      //console.log(val, this.index);
      if (this.checkKeyword("from")) {
        const imp = this.parseImportDeclaration();
        if (leadingComments.length > 0) {
          imp.leadingComments = leadingComments;
        }
        if (hasBlankLineBefore) {
          imp.hasBlankLineBefore = true;
        }
        imports.push(imp);
        lastTopLevel = imp;
      } else if (
        this.checkKeyword("export") &&
        this.peek(1).kind === "keyword" &&
        this.peek(1).value === "from"
      ) {
        const reexp = this.parseModuleReexport();
        if (leadingComments.length > 0) {
          reexp.leadingComments = leadingComments;
        }
        if (hasBlankLineBefore) {
          reexp.hasBlankLineBefore = true;
        }
        reexports.push(reexp);
        lastTopLevel = reexp;
      } else {
        const decl = this.parseTopLevel();
        if (leadingComments.length > 0) {
          decl.leadingComments = leadingComments;
        }
        if (hasBlankLineBefore) {
          decl.hasBlankLineBefore = true;
        }
        declarations.push(decl);
        lastTopLevel = decl;
      }
      hasPreviousItem = true;
      let semicolonToken: Token | null = null;
      if (this.matchSymbol(";")) {
        semicolonToken = this.previous();
      } else if (!this.isEOF()) {
        semicolonToken = this.expectSymbol(";");
      }
      if (semicolonToken) {
        lastTokenEnd = semicolonToken.end;
        if (lastTopLevel) {
          lastTopLevel.hasTerminatingSemicolon = true;
        }
        if (
          this.preserveComments && this.peek().kind === "comment" && this.source
        ) {
          const commentToken = this.peek();
          const textBetween = this.source.slice(
            semicolonToken.end,
            commentToken.start,
          );
          if (!textBetween.includes("\n") && lastTopLevel) {
            const consumed = this.consume();
            lastTopLevel.trailingComment = this.source
              ? this.source.slice(consumed.start, consumed.end)
              : consumed.value;
            lastTokenEnd = this.previous().end;
          }
        }
        continue;
      } else if (lastTopLevel) {
        lastTopLevel.hasTerminatingSemicolon = false;
        lastTokenEnd = lastTopLevel.span.end;
      }
    }
    const trailingComments = this.preserveComments
      ? [...trailingCommentBlocks, ...this.collectLeadingComments()]
      : [];
    return {
      imports,
      reexports,
      declarations,
      trailingComments: trailingComments.length > 0 ? trailingComments : undefined,
    };
  }

  private tryParseTupleLetStatement(
    letToken: Token,
    statements: BlockStatement[],
  ): boolean {
    if (this.checkKeyword("rec") || !this.checkSymbol("(")) {
      return false;
    }

    const pattern = this.parsePattern();
    if (pattern.kind !== "tuple") {
      throw this.error(
        "Tuple destructuring requires a tuple pattern on the left-hand side",
        this.previous(),
      );
    }

    this.expectSymbol("=");
    const initializer = this.parseExpression();
    const statement: PatternLetStatement = {
      kind: "pattern_let_statement",
      pattern,
      initializer,
      span: this.spanFrom(letToken.start, initializer.span.end),
      id: nextNodeId(),
    };
    statements.push(statement);
    this.expectSymbol(";");
    return true;
  }

  private parseImportDeclaration(): ModuleImport {
    const fromToken = this.expectKeyword("from");
    const sourceToken = this.expectStringLiteral();
    this.expectKeyword("import");
    const { specifiers, endToken } = this.parseImportClause();
    if (specifiers.length === 0) {
      throw this.error(
        "Import statement must include at least one specifier",
        this.peek(),
      );
    }
    return {
      kind: "module_import",
      source: sourceToken.value,
      specifiers,
      span: this.spanFrom(fromToken.start, endToken.end),
      id: nextNodeId(),
    };
  }

  private parseImportClause(): {
    specifiers: ImportSpecifier[];
    endToken: Token;
  } {
    if (this.matchSymbol("*")) {
      const starToken = this.previous();
      this.expectKeyword("as");
      const aliasToken = this.expectImportBindingName();
      const specifier: NamespaceImport = {
        kind: "namespace",
        local: aliasToken.value,
        span: this.createSpan(starToken, aliasToken),
        id: nextNodeId(),
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
          id: nextNodeId(),
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
      id: nextNodeId(),
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
      id: nextNodeId(),
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
    const exportToken = this.matchKeyword("export")
      ? this.previous()
      : undefined;
    const token = this.peek();
    if (token.kind === "keyword") {
      switch (token.value) {
        case "let":
          return this.parseLetDeclaration(exportToken);
        case "type":
          return this.parseTypeDeclaration(exportToken);
        case "record":
          return this.parseRecordDeclaration(exportToken);
        /* case "carrier":
          return this.parseCarrierDeclaration(exportToken); */
        case "infix":
        case "infixl":
        case "infixr":
          return this.parseInfixDeclaration(exportToken);
        case "prefix":
          return this.parsePrefixDeclaration(exportToken);
        case "infectious":
          // Check if this is "infectious <domain> type" (combined syntax)
          // or standalone "infectious <domain> <TypeName>" (old syntax)
          return this.parseInfectiousOrTypeDeclaration(exportToken);
        default:
          throw this.error(
            `Unexpected keyword '${token.value}' at top-level`,
            token,
          );
      }
    }
    if (exportToken) {
      throw this.error(
        "Expected 'let', 'type', 'infix', 'prefix', or 'infectious' after 'export'",
        token,
      );
    }
    throw this.error("Expected top-level declaration", token);
  }

  private parseLetDeclaration(exportToken?: Token): LetDeclaration {
    const letToken = this.expectKeyword("let");
    const isRecursive = this.matchKeyword("rec");

    const firstBinding = this.parseLetBinding(letToken.start, isRecursive, true);

    // Parse mutual bindings with "and"
    const mutualBindings: LetDeclaration[] = [];
    while (this.matchKeyword("and")) {
      const andStart = this.previous().start;
      mutualBindings.push(this.parseLetBinding(andStart, true, true));
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

  private parseLetBinding(
    startPos: number,
    isRecursive: boolean,
    isTopLevel: boolean = false,
  ): LetDeclaration {
    const nameToken = this.expectIdentifier();
    const nameSpan = this.spanFrom(nameToken.start, nameToken.end);
    const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
    this.expectSymbol("=");
    const initializer = this.parseExpression();

    // Handle first-class match: match(x) { ... } desugars to (x) => { match(x) { ... } }
    // Only apply this transformation for top-level or recursive bindings when the scrutinee is a simple identifier or tuple of identifiers
    if (
      (isTopLevel || isRecursive) &&
      initializer.kind === "match" &&
      this.isValidMatchFunctionScrutinee(initializer.scrutinee)
    ) {
      const parameterSpecs = this.extractMatchParameters(initializer.scrutinee);
      const parameters = parameterSpecs.map((spec) =>
        this.createMatchParameter(spec)
      );

      // Detect if the match expression is multi-line
      let isMultiLine = false;
      if (this.source) {
        const matchText = this.source.slice(
          initializer.span.start,
          initializer.span.end,
        );
        isMultiLine = matchText.includes("\n");
      }

      const body: BlockExpr = {
        kind: "block",
        statements: [],
        result: initializer,
        span: initializer.span,
        isMultiLine,
        id: nextNodeId(),
      };
      return {
        kind: "let",
        name: nameToken.value,
        nameSpan,
        parameters,
        annotation,
        body,
        isRecursive,
        isFirstClassMatch: true,
        span: this.spanFrom(startPos, body.span.end),
        id: nextNodeId(),
      };
    }

    if (initializer.kind === "block") {
      if (isRecursive) {
        throw this.error(
          "Recursive let declarations must use arrow syntax",
          this.previous(),
        );
      }
      return {
        kind: "let",
        name: nameToken.value,
        nameSpan,
        parameters: [],
        annotation,
        body: initializer,
        isRecursive,
        span: this.spanFrom(startPos, initializer.span.end),
        id: nextNodeId(),
      };
    }

    if (initializer.kind === "arrow") {
      const { parameters, body, returnAnnotation } = initializer;
      return {
        kind: "let",
        name: nameToken.value,
        nameSpan,
        parameters,
        annotation,
        returnAnnotation,
        body,
        isRecursive,
        isArrowSyntax: true,
        span: this.spanFrom(startPos, body.span.end),
        id: nextNodeId(),
      };
    }

    if (isRecursive) {
      throw this.error(
        "Recursive let declarations must use arrow syntax",
        this.previous(),
      );
    }

    const body: BlockExpr = {
      kind: "block",
      statements: [],
      result: initializer,
      span: initializer.span,
      id: nextNodeId(),
    };

    return {
      kind: "let",
      name: nameToken.value,
      nameSpan,
      parameters: [],
      annotation,
      body,
      isRecursive,
      span: this.spanFrom(startPos, body.span.end),
      id: nextNodeId(),
    };
  }

  private extractMatchParameters(scrutinee: Expr): MatchParameterSpec[] {
    if (scrutinee.kind === "identifier") {
      return [{ name: scrutinee.name, span: scrutinee.span }];
    }
    if (scrutinee.kind === "tuple") {
      if (scrutinee.elements.length === 0) {
        throw this.error(
          "First-class match tuple scrutinee must include at least one identifier",
          this.previous(),
        );
      }
      return scrutinee.elements.map((element) => {
        if (element.kind !== "identifier") {
          throw this.error(
            "First-class match tuple scrutinee may only contain identifiers",
            this.previous(),
          );
        }
        return { name: element.name, span: element.span };
      });
    }
    throw this.error(
      "First-class match scrutinee must be an identifier or tuple of identifiers",
      this.previous(),
    );
  }

  private isValidMatchFunctionScrutinee(scrutinee: Expr): boolean {
    if (scrutinee.kind === "identifier") {
      return true;
    }
    if (scrutinee.kind === "tuple") {
      return scrutinee.elements.every((element) =>
        element.kind === "identifier"
      );
    }
    return false;
  }

  private createMatchParameter(spec: MatchParameterSpec): Parameter {
    const defaultSpan: SourceSpan = spec.span ?? { start: 0, end: 0 };
    const pattern: Pattern = {
      kind: "variable",
      name: spec.name,
      span: defaultSpan,
      id: nextNodeId(),
    };
    return {
      kind: "parameter",
      pattern,
      name: spec.name,
      annotation: undefined,
      span: defaultSpan,
      id: nextNodeId(),
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
        const annotation = this.matchSymbol(":")
          ? this.parseTypeExpr()
          : undefined;
        const spanEnd = annotation ? annotation.span.end : pattern.span.end;
        params.push({
          kind: "parameter",
          pattern,
          name: pattern.kind === "variable" ? pattern.name : undefined,
          annotation,
          span: this.spanFrom(pattern.span.start, spanEnd),
          id: nextNodeId(),
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
    return {
      kind: "identifier",
      value: "<pattern>",
      start: span.start,
      end: span.end,
    };
  }

  private parseBlockExpr(): BlockExpr {
    const open = this.expectSymbol("{");
    const statements: BlockStatement[] = [];
    let result: Expr | undefined;
    let resultTrailingComment: string | undefined;
    const resultCommentStatements: import("./ast.ts").CommentStatement[] = [];

    while (!this.checkSymbol("}")) {
      if (this.preserveComments && this.peek().kind === "comment") {
        statements.push(this.parseCommentStatement());
        continue;
      }
      if (this.checkKeyword("let")) {
        const letToken = this.expectKeyword("let");
        if (this.tryParseTupleLetStatement(letToken, statements)) {
          continue;
        }
        const isRecursive = this.matchKeyword("rec");
        // For let statements inside blocks, pass isTopLevel = false
        // This limits first-class match transformation to recursive helpers
        const declaration = this.parseLetBinding(letToken.start, isRecursive, false);
        statements.push({
          kind: "let_statement",
          declaration,
          span: declaration.span,
          id: nextNodeId(),
        });
        this.expectSymbol(";");
        const semicolonToken = this.previous();
        const trailingComment = this.consumeInlineCommentAfter(
          semicolonToken.end,
        );
        if (trailingComment) {
          declaration.trailingComment = trailingComment;
        }
        continue;
      }

      const expression = this.parseExpression();
      if (this.matchSymbol(";")) {
        const exprStmt: import("./ast.ts").ExprStatement = {
          kind: "expr_statement",
          expression,
          span: expression.span,
          id: nextNodeId(),
        };
        const semicolonToken = this.previous();
        const trailingComment = this.consumeInlineCommentAfter(
          semicolonToken.end,
        );
        if (trailingComment) {
          exprStmt.trailingComment = trailingComment;
        }
        statements.push(exprStmt);
        continue;
      }
      result = expression;
      const inlineComment = this.consumeInlineCommentAfter(expression.span.end);
      if (inlineComment) {
        resultTrailingComment = inlineComment;
      }
      while (this.preserveComments && this.peek().kind === "comment") {
        resultCommentStatements.push(this.parseCommentStatement());
      }
      break;
    }

    if (this.preserveComments) {
      while (this.peek().kind === "comment") {
        resultCommentStatements.push(this.parseCommentStatement());
      }
    }

    const close = this.expectSymbol("}");
    const span = this.spanFrom(open.start, close.end);

    // Detect if block is multi-line by checking if there's a newline between { and }
    let isMultiLine = false;
    if (this.source) {
      const blockText = this.source.slice(open.start, close.end);
      isMultiLine = blockText.includes("\n");
    }

    return {
      kind: "block",
      statements,
      result,
      span,
      isMultiLine,
      resultTrailingComment,
      resultCommentStatements: resultCommentStatements.length > 0
        ? resultCommentStatements
        : undefined,
      id: nextNodeId(),
    };
  }

  private looksLikeRecordLiteral(): boolean {
    let offset = 1;
    while (true) {
      const token = this.peek(offset);
      if (token.kind === "comment") {
        offset += 1;
        continue;
      }
      if (token.kind === "symbol" && token.value === "}") {
        return true;
      }
      if (token.kind === "identifier") {
        let nextOffset = offset + 1;
        while (this.peek(nextOffset).kind === "comment") {
          nextOffset += 1;
        }
        const nextToken = this.peek(nextOffset);
        return nextToken.kind === "symbol" && nextToken.value === ":";
      }
      return false;
    }
  }

  private parseRecordLiteralExpr(): Expr {
    const open = this.expectSymbol("{");
    const fields: RecordField[] = [];
    while (!this.checkSymbol("}")) {
      const nameToken = this.expectIdentifier();
      this.expectSymbol(":");
      const valueExpr = this.parseExpression();
      let hasTrailingComma = false;
      if (this.matchSymbol(",")) {
        hasTrailingComma = true;
      }
      fields.push({
        kind: "record_field",
        name: nameToken.value,
        value: valueExpr,
        hasTrailingComma,
        span: this.spanFrom(nameToken.start, valueExpr.span.end),
        id: nextNodeId(),
      });
    }
    const close = this.expectSymbol("}");
    const span = this.spanFrom(open.start, close.end);
    let isMultiLine = false;
    if (this.source) {
      const literalText = this.source.slice(open.start, close.end);
      isMultiLine = literalText.includes("\n");
    }
    return {
      kind: "record_literal",
      fields,
      span,
      isMultiLine,
      id: nextNodeId(),
    };
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
      id: nextNodeId(),
    };
    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }
    return declaration;
  }

  private parseRecordDeclaration(exportToken?: Token): TypeDeclaration {
    const recordToken = this.expectKeyword("record");
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
    const recordType = this.parseRecordTypeExpr();
    const aliasMember = {
      kind: "alias" as const,
      type: recordType,
      span: recordType.span,
      id: nextNodeId(),
    };
    const declaration: TypeDeclaration = {
      kind: "type",
      name: nameToken.value,
      typeParams,
      members: [aliasMember],
      declarationKind: "record",
      span: this.spanFrom(recordToken.start, recordType.span.end),
      id: nextNodeId(),
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
    const associativity: Associativity = infixToken.value === "infixl"
      ? "left"
      : infixToken.value === "infixr"
      ? "right"
      : "none";

    // Parse precedence (number)
    const precedenceToken = this.consume();
    if (precedenceToken.kind !== "number") {
      throw this.error("Expected precedence number", precedenceToken);
    }
    const precedence = Number(precedenceToken.value);

    // Parse operator (can be operator or symbol like < >)
    const operatorToken = this.consume();
    if (operatorToken.kind !== "operator" && operatorToken.kind !== "symbol") {
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
      id: nextNodeId(),
    };

    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }

    return declaration;
  }

  private parsePrefixDeclaration(
    exportToken?: Token,
  ): import("./ast.ts").PrefixDeclaration {
    const prefixToken = this.expectKeyword("prefix");

    // Parse operator (can be operator or symbol like < >)
    const operatorToken = this.consume();
    if (operatorToken.kind !== "operator" && operatorToken.kind !== "symbol") {
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
      id: nextNodeId(),
    };

    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
    }

    return declaration;
  }

  private parseInfectiousOrTypeDeclaration(
    exportToken?: Token,
  ): import("./ast.ts").TopLevel {
    const infectiousToken = this.expectKeyword("infectious");

    // Parse domain name (identifier)
    const domainToken = this.expectIdentifier();
    const domain = domainToken.value;

    // Check if next token is "type" (combined syntax)
    if (this.matchKeyword("type")) {
      // Combined syntax: infectious <domain> type <Name> = ...
      const typeToken = this.previous();
      const nameToken = this.expectTypeName();
      const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
      this.expectSymbol("=");
      const members = this.parseTypeAliasMembers();
      const endToken = this.previous();
      
      const infectiousModifier: import("./ast.ts").InfectiousModifier = {
        kind: "infectious",
        domain,
        span: this.spanFrom(infectiousToken.start, domainToken.end),
      };
      
      const declaration: import("./ast.ts").TypeDeclaration = {
        kind: "type",
        name: nameToken.value,
        typeParams,
        members,
        infectious: infectiousModifier,
        span: this.spanFrom(infectiousToken.start, endToken.end),
        id: nextNodeId(),
      };
      
      if (exportToken) {
        declaration.export = {
          kind: "export",
          span: this.createSpan(exportToken, exportToken),
        };
      }
      return declaration;
    }

    // Old standalone syntax: infectious <domain> <TypeName><T, E>
    const typeNameToken = this.expectTypeName();
    const typeName = typeNameToken.value;

    // Expect <
    this.expectSymbol("<");

    // Parse value parameter name
    const valueParamToken = this.expectTypeParamName();
    const valueParam = valueParamToken.value;

    // Expect ,
    this.expectSymbol(",");

    // Parse state parameter name
    const stateParamToken = this.expectTypeParamName();
    const stateParam = stateParamToken.value;

    // Expect >
    this.expectSymbol(">");

    const declaration: import("./ast.ts").InfectiousDeclaration = {
      kind: "infectious",
      domain,
      typeName,
      valueParam,
      stateParam,
      span: this.spanFrom(infectiousToken.start, this.previous().end),
      id: nextNodeId(),
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
        params.push({
          name: ident.value,
          span: this.createSpan(ident, ident),
          id: nextNodeId(),
        });
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
    // Check for @value or @effect annotation
    let annotation: import("./ast.ts").ConstructorAnnotation | undefined;
    const startToken = this.peek();
    
    if (this.matchSymbol("@")) {
      const annotToken = this.peek();
      if (annotToken.kind === "identifier") {
        if (annotToken.value === "value") {
          annotation = "value";
          this.consume();
        } else if (annotToken.value === "effect") {
          annotation = "effect";
          this.consume();
        } else {
          this.error(`Expected 'value' or 'effect' after @, got '${annotToken.value}'`);
        }
      } else {
        this.error(`Expected annotation name after @`);
      }
    }
    
    const token = this.peek();
    const isQuestionConstructor = (
      (token.kind === "symbol" || token.kind === "operator") &&
      token.value === "?"
    );
    if (token.kind === "constructor" || isQuestionConstructor) {
      const ctor = this.consume();
      const ctorName = isQuestionConstructor ? "?" : ctor.value;
      if (isQuestionConstructor && this.checkSymbol("<")) {
        throw this.error("Question mark constructor cannot take type arguments", this.peek());
      }
      const typeArgs = (!isQuestionConstructor && this.matchSymbol("<"))
        ? this.parseTypeArguments()
        : [];
      return {
        kind: "constructor",
        name: ctorName,
        typeArgs,
        annotation,
        span: this.spanFrom(
          startToken.start,
          typeArgs.length > 0
            ? typeArgs[typeArgs.length - 1].span.end
            : ctor.end,
        ),
        id: nextNodeId(),
      };
    }
    const type = this.parseTypeExpr();
    return { kind: "alias", type, span: type.span, id: nextNodeId() };
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

  private buildMatchScrutinee(args: Expr[]): Expr {
    if (args.length === 1) {
      return args[0];
    }
    const span: SourceSpan = {
      start: args[0].span.start,
      end: args[args.length - 1].span.end,
    };
    return {
      kind: "tuple",
      elements: args,
      span,
      id: nextNodeId(),
    };
  }

  private parseMatchExpression(): Expr {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === "match") {
      const matchToken = this.expectKeyword("match");
      if (this.matchSymbol("{")) {
        const { bundle, span } = this.parseMatchBlockFromOpenBrace(
          matchToken.start,
        );
        return {
          kind: "match_bundle_literal",
          bundle,
          span,
          id: nextNodeId(),
        };
      }

      this.expectSymbol("(");

      const args: Expr[] = [];
      if (!this.checkSymbol(")")) {
        do {
          args.push(this.parseExpression());
        } while (this.matchSymbol(","));
      }
      this.expectSymbol(")");

      if (args.length === 0) {
        throw this.error("Match requires a scrutinee expression");
      }

      const scrutineeExpr = this.buildMatchScrutinee(args);

      if (this.matchSymbol("=>")) {
        const { bundle, span } = this.parseMatchBlock();
        return {
          kind: "match_fn",
          parameters: [scrutineeExpr],
          bundle,
          span: this.spanFrom(matchToken.start, span.end),
          id: nextNodeId(),
        };
      }

      const { bundle, span } = this.parseMatchBlock();
      return {
        kind: "match",
        scrutinee: scrutineeExpr,
        bundle,
        span: this.spanFrom(matchToken.start, span.end),
        id: nextNodeId(),
      };
    }
    return this.parseArrowOrLower();
  }

  private parseArrowOrLower(): Expr {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === "(") {
      const snapshot = this.index;
      let arrowInfo:
        | { parameters: Parameter[]; returnAnnotation?: TypeExpr; start: number }
        | null = null;
      try {
        arrowInfo = this.tryParseArrowParameters();
      } catch (_error) {
        // Only failures while scanning arrow parameters should backtrack.
        this.index = snapshot;
      }
      // If arrowInfo is null, tryParseArrowParameters either restored the index
      // or we restored it in the catch above. In that case, fall through.
      if (arrowInfo) {
        const body = this.parseBlockExpr();
        return {
          kind: "arrow",
          parameters: arrowInfo.parameters,
          returnAnnotation: arrowInfo.returnAnnotation,
          body,
          span: this.spanFrom(
            arrowInfo.parameters[0]?.span.start ?? arrowInfo.start,
            body.span.end,
          ),
          id: nextNodeId(),
        };
      }
    }
    return this.parseBinaryExpression();
  }

  private tryParseArrowParameters(): {
    parameters: Parameter[];
    returnAnnotation?: TypeExpr;
    start: number;
  } | null {
    const startIndex = this.index;
    try {
      const startToken = this.peek();
      const params = this.parseParameterList();
      let returnAnnotation: TypeExpr | undefined;
      if (this.matchSymbol(":")) {
        returnAnnotation = this.parseTypeExpr();
      }
      if (!this.matchSymbol("=>")) {
        this.index = startIndex;
        return null;
      }
      return {
        parameters: params,
        returnAnnotation,
        start: startToken.start,
      };
    } catch (_error) {
      this.index = startIndex;
      return null;
    }
  }

  private parseBinaryExpression(minPrecedence: number = 0): Expr {
    let left = this.parseCallExpression();

    while (true) {
      const token = this.peek();
      // Check if it's an operator, or a symbol that's registered as an operator (like < >)
      if (token.kind !== "operator" && token.kind !== "symbol") {
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
        id: nextNodeId(),
      };
    }

    return left;
  }

  private parseCallExpression(): Expr {
    let expr = this.parsePrimaryExpression();
    while (true) {
      if (this.matchSymbol("(")) {
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
            id: nextNodeId(),
          };
        }
        continue;
      }

      if (this.matchSymbol(".")) {
        const fieldToken = this.expectIdentifier();
        const target = expr;
        expr = {
          kind: "record_projection",
          target,
          field: fieldToken.value,
          span: this.spanFrom(target.span.start, fieldToken.end),
          id: nextNodeId(),
        };
        continue;
      }

      break;
    }
    return expr;
  }

  private parsePrimaryExpression(): Expr {
    const token = this.peek();
    switch (token.kind) {
      case "identifier": {
        const ident = this.consume();
        return {
          kind: "identifier",
          name: ident.value,
          span: this.createSpan(ident, ident),
          id: nextNodeId(),
        } as Expr;
      }
      case "constructor": {
        const ctor = this.consume();
        return {
          kind: "constructor",
          name: ctor.value,
          args: [],
          span: this.createSpan(ctor, ctor),
          id: nextNodeId(),
        } as Expr;
      }
      case "number": {
        const num = this.consume();
        return {
          kind: "literal",
          literal: {
            kind: "int",
            value: Number(num.value),
            span: this.createSpan(num, num),
            id: nextNodeId(),
          },
          span: this.createSpan(num, num),
          id: nextNodeId(),
        } as Expr;
      }
      case "char": {
        const ch = this.consume();
        return {
          kind: "literal",
          literal: {
            kind: "char",
            value: ch.value,
            span: this.createSpan(ch, ch),
            id: nextNodeId(),
          },
          span: this.createSpan(ch, ch),
          id: nextNodeId(),
        } as Expr;
      }
      case "string": {
        const str = this.consume();
        return {
          kind: "literal",
          literal: {
            kind: "string",
            value: str.value,
            span: this.createSpan(str, str),
            id: nextNodeId(),
          },
          span: this.createSpan(str, str),
          id: nextNodeId(),
        } as Expr;
      }
      case "bool": {
        const bool = this.consume();
        return {
          kind: "literal",
          literal: {
            kind: "bool",
            value: bool.value === "true",
            span: this.createSpan(bool, bool),
            id: nextNodeId(),
          },
          span: this.createSpan(bool, bool),
          id: nextNodeId(),
        } as Expr;
      }
      case "symbol": {
        if (token.value === "?") {
          const holeToken = this.consume();
          return {
            kind: "hole",
            span: this.createSpan(holeToken, holeToken),
            id: nextNodeId(),
          } as Expr;
        }
        if (token.value === "(") {
          return this.parseParenExpression();
        }
        if (token.value === "{") {
          if (this.looksLikeRecordLiteral()) {
            return this.parseRecordLiteralExpr();
          }
          return this.parseBlockExpr();
        }
      }
      case "operator": {
        // Check for hole expression
        if (token.value === "?") {
          const holeToken = this.consume();
          return {
            kind: "hole",
            span: this.createSpan(holeToken, holeToken),
            id: nextNodeId(),
          } as Expr;
        }
        // Check if this is a registered prefix operator
        if (this.prefixOperators.has(token.value)) {
          const opToken = this.consume();
          const operand = this.parsePrimaryExpression();
          return {
            kind: "unary",
            operator: opToken.value,
            operand,
            span: this.spanFrom(opToken.start, operand.span.end),
            id: nextNodeId(),
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
        literal: { kind: "unit", span, id: nextNodeId() },
        span,
        id: nextNodeId(),
      } as Expr;
    }
    if (elements.length === 1) {
      return {
        ...elements[0],
        span: this.spanFrom(open.start, close.end),
      } as Expr;
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
      id: nextNodeId(),
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
          id: nextNodeId(),
        };
      }
      this.index = snapshot;
    }
    return this.parseTypePrimary();
  }

  private parseTypePrimary(): TypeExpr {
    const token = this.peek();
    if (token.kind === "symbol" && token.value === "<") {
      return this.parseEffectRowTypeExpr();
    }
    if (token.kind === "symbol" && token.value === "(") {
      return this.parseTypeTupleOrGrouping();
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      return {
        kind: "type_var",
        name: ident.value,
        span: this.createSpan(ident, ident),
        id: nextNodeId(),
      };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      const typeArgs = this.matchSymbol("<") ? this.parseTypeArguments() : [];
      const end = typeArgs.length > 0
        ? typeArgs[typeArgs.length - 1].span.end
        : ctor.end;
      return {
        kind: "type_ref",
        name: ctor.value,
        typeArgs,
        span: this.spanFrom(ctor.start, end),
        id: nextNodeId(),
      };
    }

    if (token.kind === "symbol" && token.value === "{") {
      return this.parseRecordTypeExpr();
    }

    throw this.error("Expected type expression", token);
  }

  private parseEffectRowTypeExpr(): TypeExpr {
    const open = this.expectSymbol("<");
    const cases: TypeEffectRowCase[] = [];
    let hasTailWildcard = false;
    let first = true;
    while (!this.checkSymbol(">")) {
      if (!first) {
        this.expectSymbol("|");
      }
      first = false;
      if (this.checkSymbol("_")) {
        if (hasTailWildcard) {
          throw this.error("Row wildcard already specified", this.peek());
        }
        const underscore = this.expectSymbol("_");
        hasTailWildcard = true;
        if (!this.checkSymbol(">")) {
          throw this.error("Row wildcard must be last entry", this.peek());
        }
        continue;
      }
      const ctor = this.expectConstructor("Expected error constructor");
      let payload: TypeExpr | undefined;
      let end = ctor.end;
      if (this.matchSymbol("(")) {
        payload = this.parseTypeExpr();
        this.expectSymbol(")");
        end = payload.span.end;
      }
      cases.push({
        kind: "type_effect_row_case",
        name: ctor.value,
        payload,
        span: this.spanFrom(ctor.start, end),
        id: nextNodeId(),
      });
    }
    const close = this.expectSymbol(">");
    return {
      kind: "type_effect_row",
      cases,
      hasTailWildcard,
      span: this.spanFrom(open.start, close.end),
      id: nextNodeId(),
    };
  }

  private parseRecordTypeExpr(): TypeExpr {
    const open = this.expectSymbol("{");
    const fields: TypeRecordField[] = [];
    while (!this.checkSymbol("}")) {
      const nameToken = this.expectIdentifier();
      this.expectSymbol(":");
      const typeExpr = this.parseTypeExpr();
      let hasTrailingComma = false;
      if (this.matchSymbol(",")) {
        hasTrailingComma = true;
      }
      fields.push({
        kind: "type_record_field",
        name: nameToken.value,
        type: typeExpr,
        hasTrailingComma,
        span: this.spanFrom(nameToken.start, typeExpr.span.end),
        id: nextNodeId(),
      });
    }
    const close = this.expectSymbol("}");
    return {
      kind: "type_record",
      fields,
      span: this.spanFrom(open.start, close.end),
      id: nextNodeId(),
    };
  }

  private parseTypeTupleOrGrouping(): TypeExpr {
    const open = this.expectSymbol("(");
    if (this.checkSymbol(")")) {
      const close = this.expectSymbol(")");
      return {
        kind: "type_unit",
        span: this.spanFrom(open.start, close.end),
        id: nextNodeId(),
      };
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
      id: nextNodeId(),
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
      return {
        kind: "wildcard",
        span: this.createSpan(underscore, underscore),
        id: nextNodeId(),
      };
    }

    if (
      (token.kind === "constructor" || token.kind === "identifier") &&
      token.value === "AllErrors"
    ) {
      const all = this.consume();
      return {
        kind: "all_errors",
        span: this.createSpan(all, all),
        id: nextNodeId(),
      };
    }

    if (token.kind === "operator" && token.value === "^") {
      const caret = this.consume();
      const ident = this.expectIdentifier();
      return {
        kind: "variable",
        name: ident.value,
        isExplicitPin: true,
        span: this.createSpan(caret, ident),
        id: nextNodeId(),
      };
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      return {
        kind: "variable",
        name: ident.value,
        span: this.createSpan(ident, ident),
        id: nextNodeId(),
      };
    }

    if (token.kind === "number") {
      const num = this.consume();
      const literal = {
        kind: "int" as const,
        value: Number(num.value),
        span: this.createSpan(num, num),
        id: nextNodeId(),
      };
      return { kind: "literal", literal, span: literal.span, id: nextNodeId() };
    }

    if (token.kind === "bool") {
      const bool = this.consume();
      const literal = {
        kind: "bool" as const,
        value: bool.value === "true",
        span: this.createSpan(bool, bool),
        id: nextNodeId(),
      };
      return { kind: "literal", literal, span: literal.span, id: nextNodeId() };
    }

    if (token.kind === "string") {
      const str = this.consume();
      const literal = {
        kind: "string" as const,
        value: str.value,
        span: this.createSpan(str, str),
        id: nextNodeId(),
      };
      return { kind: "literal", literal, span: literal.span, id: nextNodeId() };
    }

    if (token.kind === "char") {
      const ch = this.consume();
      const literal = {
        kind: "char" as const,
        value: ch.value,
        span: this.createSpan(ch, ch),
        id: nextNodeId(),
      };
      return { kind: "literal", literal, span: literal.span, id: nextNodeId() };
    }

    const isQuestionConstructor = (
      (token.kind === "symbol" || token.kind === "operator") &&
      token.value === "?"
    );
    if (token.kind === "constructor" || isQuestionConstructor) {
      const ctor = this.consume();
      const ctorName = isQuestionConstructor ? "?" : ctor.value;
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
        name: ctorName,
        args,
        span: this.spanFrom(ctor.start, end),
        id: nextNodeId(),
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
      return {
        kind: "tuple",
        elements,
        span: this.spanFrom(open.start, close.end),
        id: nextNodeId(),
      };
    }

    throw this.error("Expected pattern", token);
  }

  private parseMatchBlock(): { bundle: MatchBundle; span: SourceSpan } {
    const open = this.expectSymbol("{");
    return this.parseMatchBlockFromOpenBrace(open.start);
  }

  private parseMatchBlockFromOpenBrace(
    start: number,
  ): { bundle: MatchBundle; span: SourceSpan } {
    const openStart = start;
    const arms: MatchArm[] = [];

    if (!this.checkSymbol("}")) {
      while (true) {
        if (this.preserveComments && this.peek().kind === "comment") {
          arms.push(this.parseCommentStatement());
          continue;
        }

        if (this.checkSymbol("}")) {
          break;
        }

        const entryStart = this.peek();

        if (entryStart.kind === "identifier") {
          const next = this.peek(1);
          if (
            next.kind === "symbol" && (next.value === "," || next.value === "}")
          ) {
            const identifier = this.expectIdentifier();
            const hasComma = this.matchSymbol(",");
            const endToken = hasComma ? this.previous() : identifier;
            const span = this.spanFrom(identifier.start, endToken.end);
            const trailingComment = this.consumeInlineCommentAfter(
              endToken.end,
            );
            arms.push({
              kind: "match_bundle_reference",
              name: identifier.value,
              hasTrailingComma: hasComma,
              trailingComment,
              span,
              id: nextNodeId(),
            });
            continue;
          }
        }

        const patternStart = this.peek();
        const pattern = this.parsePattern();
        this.expectSymbol("=>");
        const body = this.parseBlockExpr();

        const trailingComment = this.consumeInlineCommentAfter(body.span.end);
        const hasComma = this.matchSymbol(",");
        const span = this.spanFrom(patternStart.start, body.span.end);
        arms.push({
          kind: "match_pattern",
          pattern,
          body,
          hasTrailingComma: hasComma,
          trailingComment,
          span,
          id: nextNodeId(),
        });
      }
    }

    const close = this.expectSymbol("}");
    if (arms.length === 0) {
      throw this.error("Match block requires at least one arm", close);
    }
    const span = this.spanFrom(openStart, close.end);
    const bundle: MatchBundle = {
      kind: "match_bundle",
      arms,
      span,
      id: nextNodeId(),
    };
    return { bundle, span };
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

  private expectConstructor(message = "constructor"): Token {
    const token = this.consume();
    if (token.kind !== "constructor") {
      throw expectedTokenError(message, token, this.source);
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
    return this.tokens[index];
  }

  private peek(offset = 0): Token {
    if (!this.preserveComments) {
      // Skip comments before peeking
      let tempIndex = this.index;
      while (
        tempIndex < this.tokens.length &&
        this.tokens[tempIndex].kind === "comment"
      ) {
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
        const textBetween = this.source.slice(
          commentToken.end,
          nextToken.start,
        );
        // Count newlines - if 2 or more, there's a blank line
        const newlineCount = (textBetween.match(/\n/g) || []).length;
        hasBlankLineAfter = newlineCount >= 2;
      }

      comments.push({
        text: commentText,
        hasBlankLineAfter,
        rawText: this.source
          ? this.source.slice(commentToken.start, commentToken.end)
          : undefined,
      });
    }
    return comments;
  }

  private parseCommentStatement(): import("./ast.ts").CommentStatement {
    const token = this.peek();
    if (token.kind !== "comment") {
      throw this.error("Expected comment", token);
    }
    const commentToken = this.consume();
    let hasBlankLineAfter = false;
    if (this.source) {
      const nextToken = this.peek();
      const textBetween = this.source.slice(
        commentToken.end,
        nextToken.start,
      );
      const newlineCount = (textBetween.match(/\n/g) || []).length;
      hasBlankLineAfter = newlineCount >= 2;
    }
    return {
      kind: "comment_statement",
      text: commentToken.value,
      hasBlankLineAfter,
      span: this.spanFrom(commentToken.start, commentToken.end),
      rawText: this.source
        ? this.source.slice(commentToken.start, commentToken.end)
        : undefined,
      id: nextNodeId(),
    };
  }

  private consumeInlineCommentAfter(position: number): string | undefined {
    if (
      !this.preserveComments || this.peek().kind !== "comment" ||
      !this.source
    ) {
      return undefined;
    }
    const commentToken = this.peek();
    const textBetween = this.source.slice(position, commentToken.start);
    if (textBetween.includes("\n")) {
      return undefined;
    }
    this.consume();
    return this.source.slice(commentToken.start, commentToken.end);
  }

  private skipComments(): void {
    while (
      this.index < this.tokens.length &&
      this.tokens[this.index].kind === "comment"
    ) {
      this.index++;
    }
  }
}
