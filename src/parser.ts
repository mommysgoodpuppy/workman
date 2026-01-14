import type { Token } from "./token.ts";
import {
  expectedTokenError,
  ParseError,
  unexpectedTokenError,
} from "./error.ts";
import { nextNodeId, resetNodeIds } from "./node_ids.ts";
import type {
  AnnotateDeclaration,
  Associativity,
  BlockExpr,
  BlockStatement,
  DomainDeclaration,
  ExportModifier,
  Expr,
  ImportSpecifier,
  InfixDeclaration,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  ModuleImport,
  ModuleReexport,
  NamedImport,
  NamespaceImport,
  OpRuleDeclaration,
  Parameter,
  PatternLetStatement,
  PolicyDeclaration,
  Program,
  RecordDeclaration,
  RecordField,
  RecordMember,
  RuleEntry,
  RuleValue,
  RuleValuePart,
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

export interface ParseSurfaceProgramOptions {
  tolerant?: boolean;
  preservePipeOperator?: boolean;
}

function computeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToLineCol(
  offset: number,
  offsets: number[],
): { line: number; column: number } {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = offsets[mid];
    const next = mid + 1 < offsets.length ? offsets[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (offset < start) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return { line: mid + 1, column: offset - start + 1 };
    }
  }
  const lastStart = offsets[offsets.length - 1] ?? 0;
  return { line: offsets.length, column: offset - lastStart + 1 };
}

export function parseSurfaceProgram(
  tokens: Token[],
  source?: string,
  preserveComments: boolean = false,
  initialOperators?: Map<string, OperatorInfo>,
  initialPrefixOperators?: Set<string>,
  options?: ParseSurfaceProgramOptions,
): Program {
  resetNodeIds(0); // Reset IDs before parsing
  const parser = new SurfaceParser(
    tokens,
    source,
    preserveComments,
    initialOperators,
    initialPrefixOperators,
    options?.tolerant ?? false,
    options?.preservePipeOperator ?? false,
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
  private readonly lineOffsets?: number[];

  constructor(
    private readonly tokens: Token[],
    private readonly source?: string,
    private readonly preserveComments: boolean = false,
    initialOperators?: Map<string, OperatorInfo>,
    initialPrefixOperators?: Set<string>,
    private readonly tolerant: boolean = false,
    private readonly preservePipeOperator: boolean = false,
  ) {
    // Start with default comparison operators (these are defined in std/core/int but need to be known at parse time)
    const defaultOperators = new Map<string, OperatorInfo>([
      ["<", { precedence: 4, associativity: "none" }],
      [">", { precedence: 4, associativity: "none" }],
      ["<=", { precedence: 4, associativity: "none" }],
      [">=", { precedence: 4, associativity: "none" }],
      [":>", { precedence: 1, associativity: "left" }],
    ]);
    

    this.operators = initialOperators
      ? new Map([...defaultOperators, ...initialOperators])
      : defaultOperators;
    this.prefixOperators = initialPrefixOperators
      ? new Set(initialPrefixOperators)
      : new Set();
    this.lineOffsets = source ? computeLineOffsets(source) : undefined;
  }

  parseProgram(): Program {
    const imports: ModuleImport[] = [];
    const reexports: ModuleReexport[] = [];
    const declarations: TopLevel[] = [];
    let lastTokenEnd = 0;
    const trailingCommentBlocks: import("./ast.ts").CommentBlock[] = [];
    let hasPreviousItem = false;
    let lastTopLevel: ModuleImport | ModuleReexport | TopLevel | null = null;

    // Check for @raw or @core pragma at the start of the file
    let mode: import("./ast.ts").ModuleMode | undefined;
    let core = false;
    while (this.checkSymbol("@")) {
      this.consume(); // consume @
      const pragmaToken = this.peek();
      if (pragmaToken.kind === "identifier" && pragmaToken.value === "raw") {
        this.consume();
        mode = "raw";
        // Register raw mode prefix operators
        this.prefixOperators.add("&"); // address-of operator for Zig
        // Consume optional semicolon after pragma
        this.matchSymbol(";");
      } else if (
        pragmaToken.kind === "identifier" && pragmaToken.value === "core"
      ) {
        this.consume();
        core = true;
        // Consume optional semicolon after pragma
        this.matchSymbol(";");
      } else {
        this.error(`Unknown module pragma: @${pragmaToken.value}`);
      }
    }

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
        if (this.tolerant && this.canStartTopLevelDeclaration()) {
          semicolonToken = null;
        } else {
          semicolonToken = this.expectSymbol(";");
        }
      }
      if (semicolonToken) {
        lastTokenEnd = semicolonToken.end;
        if (lastTopLevel) {
          lastTopLevel.hasTerminatingSemicolon = true;
        }
        if (
          this.preserveComments &&
          this.peek().kind === "comment" &&
          this.source
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
      trailingComments: trailingComments.length > 0
        ? trailingComments
        : undefined,
      mode,
      core: core || undefined,
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
        if (importedToken.kind === "string" && !this.checkKeyword("as")) {
          throw this.error(
            "String import specifiers must use 'as <binding>'",
            this.peek(),
          );
        }
        if (this.matchKeyword("as")) {
          localToken = this.expectImportBindingName();
          endToken = localToken;
        } else if (importedToken.kind === "string") {
          // Defensive - should have thrown above, but keep TypeScript happy
          throw this.error(
            "String import specifiers must use 'as <binding>'",
            importedToken,
          );
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
    if (
      token.kind === "identifier" ||
      token.kind === "constructor" ||
      token.kind === "string"
    ) {
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
        case "domain":
          return this.parseDomainDeclaration(exportToken);
        case "op":
          return this.parseOpRuleDeclaration(exportToken);
        case "policy":
          return this.parsePolicyDeclaration(exportToken);
        case "annotate":
          return this.parseAnnotateDeclaration(exportToken);
        default:
          throw this.error(
            `Unexpected keyword '${token.value}' at top-level`,
            token,
          );
      }
    }
    if (exportToken) {
      throw this.error(
        "Expected 'let', 'type', 'infix', 'prefix', 'infectious', 'domain', 'op', 'policy', or 'annotate' after 'export'",
        token,
      );
    }
    throw this.error("Expected top-level declaration", token);
  }

  private parseLetDeclaration(exportToken?: Token): LetDeclaration {
    const letToken = this.expectKeyword("let");
    const { isRecursive, isMutable } = this.parseLetModifiers();

    const firstBinding = this.parseLetBinding(
      letToken.start,
      isRecursive,
      true,
      isMutable,
    );

    // Parse mutual bindings with "and"
    const mutualBindings: LetDeclaration[] = [];
    while (this.matchKeyword("and")) {
      const andStart = this.previous().start;
      mutualBindings.push(this.parseLetBinding(andStart, isRecursive, true));
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

  private parseLetModifiers(): {
    isRecursive: boolean;
    isMutable: boolean;
  } {
    let isRecursive = false;
    let isMutable = false;
    let advanced = true;
    while (advanced) {
      advanced = false;
      if (this.matchKeyword("mut")) {
        if (isMutable) {
          throw this.error("Duplicate 'mut' modifier", this.previous());
        }
        isMutable = true;
        advanced = true;
        continue;
      }
      if (this.matchKeyword("rec")) {
        if (isRecursive) {
          throw this.error("Duplicate 'rec' modifier", this.previous());
        }
        isRecursive = true;
        advanced = true;
        continue;
      }
    }
    return { isRecursive, isMutable };
  }

  private parseLetBinding(
    startPos: number,
    isRecursive: boolean,
    isTopLevel: boolean = false,
    isMutablePrefix: boolean = false,
  ): LetDeclaration {
    let isMutable = isMutablePrefix;
    if (this.matchKeyword("mut")) {
      if (isMutable) {
        throw this.error("Duplicate 'mut' modifier", this.previous());
      }
      isMutable = true;
    }
    const nameToken = this.expectIdentifier();
    const nameSpan = this.spanFrom(nameToken.start, nameToken.end);
    const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
    this.expectSymbol("=");
    let initializer: Expr;
    if (annotation && this.checkSymbol("{")) {
      const open = this.expectSymbol("{");
      initializer = this.parseRecordLiteralExprFromOpen(open, open.start);
    } else {
      initializer = this.parseExpression();
    }

    // Handle first-class match: match(x) => { ... } desugars to (x) => { match(x) { ... } }
    if (initializer.kind === "match_fn") {
      if (initializer.parameters.length !== 1) {
        throw this.error(
          "First-class match requires a single scrutinee expression",
          this.previous(),
        );
      }
      const scrutineeExpr = initializer.parameters[0];
      if (!this.isValidMatchFunctionScrutinee(scrutineeExpr)) {
        throw this.error(
          "First-class match scrutinee must be an identifier or tuple of identifiers",
          this.previous(),
        );
      }
      const parameterSpecs = this.extractMatchParameters(scrutineeExpr);
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

      const matchExpr: Expr = {
        kind: "match",
        scrutinee: scrutineeExpr,
        bundle: initializer.bundle,
        span: initializer.span,
        id: nextNodeId(),
      };

      const body: BlockExpr = {
        kind: "block",
        statements: [],
        result: matchExpr,
        span: matchExpr.span,
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
        isMutable,
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
        isMutable,
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
        isMutable,
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
      isMutable,
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
      return scrutinee.elements.every(
        (element) => element.kind === "identifier",
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
        const { isRecursive, isMutable } = this.parseLetModifiers();
        if (this.checkSymbol("(")) {
          if (isRecursive || isMutable) {
            throw this.error(
              "Tuple destructuring does not support 'mut' or 'rec'",
              this.peek(),
            );
          }
          if (this.tryParseTupleLetStatement(letToken, statements)) {
            continue;
          }
        }
        // For let statements inside blocks, pass isTopLevel = false
        // This limits first-class match transformation to recursive helpers
        const declaration = this.parseLetBinding(
          letToken.start,
          isRecursive,
          false,
          isMutable,
        );
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
        return nextToken.kind === "symbol" && nextToken.value === "=";
      }
      return false;
    }
  }

  private looksLikeTupleLiteral(): boolean {
    // Called after consuming the opening '{' in .{
    // Check if it's NOT a record literal (i.e., no field names with equals signs)
    let offset = 0;
    while (true) {
      const token = this.peek(offset);
      if (token.kind === "comment") {
        offset += 1;
        continue;
      }
      if (token.kind === "symbol" && token.value === "}") {
        // Empty braces - treat as empty tuple
        return true;
      }
      // Spread syntax `..` means it's a record literal
      if (token.kind === "symbol" && token.value === "..") {
        return false;
      }
      if (token.kind === "identifier") {
        let nextOffset = offset + 1;
        while (this.peek(nextOffset).kind === "comment") {
          nextOffset += 1;
        }
        const nextToken = this.peek(nextOffset);
        // If there's an equals, it's a record literal
        if (nextToken.kind === "symbol" && nextToken.value === "=") {
          return false;
        }
        // If there's a comma or }, it could be punning - check if it's a valid record field
        if (
          nextToken.kind === "symbol" &&
          (nextToken.value === "," || nextToken.value === "}")
        ) {
          // This could be punning { x, y } - treat as record literal
          return false;
        }
        // Otherwise it's a tuple (identifier followed by something else)
        return true;
      }
      // If it starts with something other than identifier or }, assume tuple
      return true;
    }
  }

  private parseRecordLiteralExprFromOpen(open: Token, start: number): Expr {
    const fields: RecordField[] = [];
    let spread: Expr | undefined;

    while (!this.checkSymbol("}")) {
      // Check for spread syntax: ...expr
      if (this.checkSymbol("..")) {
        this.consume(); // consume ..
        spread = this.parseExpression();
        this.matchSymbol(","); // optional trailing comma after spread
        continue;
      }

      const nameToken = this.expectIdentifier();

      // Check for punning: { name } instead of { name = expr }
      let valueExpr: Expr;
      let isPunned = false;
      if (this.checkSymbol("=")) {
        this.consume(); // consume =
        valueExpr = this.parseExpression();
      } else {
        // Punning: { name } expands to { name = name }
        isPunned = true;
        valueExpr = {
          kind: "identifier",
          name: nameToken.value,
          span: this.createSpan(nameToken, nameToken),
          id: nextNodeId(),
        };
      }

      let hasTrailingComma = false;
      if (this.matchSymbol(",")) {
        hasTrailingComma = true;
      }
      fields.push({
        kind: "record_field",
        name: nameToken.value,
        value: valueExpr,
        hasTrailingComma,
        isPunned,
        span: this.spanFrom(nameToken.start, valueExpr.span.end),
        id: nextNodeId(),
      });
    }
    const close = this.expectSymbol("}");
    const span = this.spanFrom(start, close.end);
    let isMultiLine = false;
    if (this.source) {
      const literalText = this.source.slice(open.start, close.end);
      isMultiLine = literalText.includes("\n");
    }
    return {
      kind: "record_literal",
      fields,
      spread,
      span,
      isMultiLine,
      id: nextNodeId(),
    };
  }

  private parseTypeDeclaration(exportToken?: Token): TypeDeclaration {
    const typeToken = this.expectKeyword("type");
    const isRecursive = this.matchKeyword("rec");
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];

    // Support opaque types: `type Foo;` or `type Foo<T>;` without `= members`
    // These are extern/primitive types with no Workman-side constructors
    let members: TypeAliasMember[];
    let isOpaque = false;
    if (this.checkSymbol(";") || this.isEOF()) {
      // Opaque type - no constructors
      members = [];
      isOpaque = true;
    } else {
      this.expectSymbol("=");
      members = this.parseTypeAliasMembers();
    }

    const endToken = this.previous();
    const declaration: TypeDeclaration = {
      kind: "type",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(typeToken.start, endToken.end),
      id: nextNodeId(),
    };
    if (isOpaque) {
      declaration.opaque = true;
    }
    if (isRecursive) {
      declaration.isRecursive = true;
    }

    // Parse mutual bindings with "and"
    const mutualBindings: Array<TypeDeclaration | RecordDeclaration> = [];
    while (this.matchKeyword("and")) {
      const nextToken = this.peek();
      if (nextToken.kind === "keyword" && nextToken.value === "type") {
        const mutualType = this.parseTypeDeclaration();
        mutualType.isRecursive = true;
        mutualBindings.push(mutualType);
      } else if (nextToken.kind === "keyword" && nextToken.value === "record") {
        const mutualRecord = this.parseRecordDeclaration();
        mutualRecord.isRecursive = true;
        mutualBindings.push(mutualRecord);
      } else {
        // Default to type if no keyword (allows `and Foo = ...`)
        const mutualType = this.parseTypeDeclarationBody(isRecursive);
        mutualBindings.push(mutualType);
      }
    }
    if (mutualBindings.length > 0) {
      declaration.mutualBindings = mutualBindings;
    }

    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
      // Also mark mutual bindings as exported
      if (declaration.mutualBindings) {
        for (const binding of declaration.mutualBindings) {
          binding.export = declaration.export;
        }
      }
    }
    return declaration;
  }

  // Parse a type declaration body (name, params, members) without the 'type' keyword
  private parseTypeDeclarationBody(isRecursive: boolean): TypeDeclaration {
    const startToken = this.peek();
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];

    let members: TypeAliasMember[];
    let isOpaque = false;
    if (this.checkSymbol(";") || this.isEOF()) {
      members = [];
      isOpaque = true;
    } else {
      this.expectSymbol("=");
      members = this.parseTypeAliasMembers();
    }

    const endToken = this.previous();
    const declaration: TypeDeclaration = {
      kind: "type",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(startToken.start, endToken.end),
      id: nextNodeId(),
    };
    if (isOpaque) declaration.opaque = true;
    if (isRecursive) declaration.isRecursive = true;
    return declaration;
  }

  private parseRecordDeclaration(exportToken?: Token): RecordDeclaration {
    const recordToken = this.expectKeyword("record");
    const isRecursive = this.matchKeyword("rec");
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
    this.expectSymbol("=");
    const { members, endToken } = this.parseRecordMembers();
    const declaration: RecordDeclaration = {
      kind: "record_decl",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(recordToken.start, endToken.end),
      id: nextNodeId(),
    };
    if (isRecursive) {
      declaration.isRecursive = true;
    }

    // Parse mutual bindings with "and"
    const mutualBindings: Array<TypeDeclaration | RecordDeclaration> = [];
    while (this.matchKeyword("and")) {
      const nextToken = this.peek();
      if (nextToken.kind === "keyword" && nextToken.value === "type") {
        const mutualType = this.parseTypeDeclaration();
        mutualType.isRecursive = true;
        mutualBindings.push(mutualType);
      } else if (nextToken.kind === "keyword" && nextToken.value === "record") {
        const mutualRecord = this.parseRecordDeclaration();
        mutualRecord.isRecursive = true;
        mutualBindings.push(mutualRecord);
      } else {
        // Default to record if no keyword (allows `and Foo = { ... }`)
        const mutualRecord = this.parseRecordDeclarationBody(isRecursive);
        mutualBindings.push(mutualRecord);
      }
    }
    if (mutualBindings.length > 0) {
      declaration.mutualBindings = mutualBindings;
    }

    if (exportToken) {
      declaration.export = {
        kind: "export",
        span: this.createSpan(exportToken, exportToken),
      };
      // Also mark mutual bindings as exported
      if (declaration.mutualBindings) {
        for (const binding of declaration.mutualBindings) {
          binding.export = declaration.export;
        }
      }
    }
    return declaration;
  }

  // Parse a record declaration body (name, params, members) without the 'record' keyword
  private parseRecordDeclarationBody(isRecursive: boolean): RecordDeclaration {
    const startToken = this.peek();
    const nameToken = this.expectTypeName();
    const typeParams = this.matchSymbol("<") ? this.parseTypeParameters() : [];
    this.expectSymbol("=");
    const { members, endToken } = this.parseRecordMembers();
    const declaration: RecordDeclaration = {
      kind: "record_decl",
      name: nameToken.value,
      typeParams,
      members,
      span: this.spanFrom(startToken.start, endToken.end),
      id: nextNodeId(),
    };
    if (isRecursive) declaration.isRecursive = true;
    return declaration;
  }

  private parseRecordMembers(): { members: RecordMember[]; endToken: Token } {
    const open = this.expectSymbol("{");
    const members: RecordMember[] = [];
    while (!this.checkSymbol("}")) {
      const nameToken = this.expectIdentifier();
      if (this.checkSymbol("(")) {
        const parameters = this.parseParameterList();
        let returnAnnotation: TypeExpr | undefined;
        if (this.matchSymbol(":")) {
          returnAnnotation = this.parseTypeExpr();
        }
        this.expectSymbol("=>");
        const body = this.parseBlockExpr();
        const valueExpr: Expr = {
          kind: "arrow",
          parameters,
          returnAnnotation,
          body,
          span: this.spanFrom(
            parameters[0]?.span.start ?? nameToken.start,
            body.span.end,
          ),
          id: nextNodeId(),
        };
        let hasTrailingComma = false;
        if (this.matchSymbol(",")) {
          hasTrailingComma = true;
        }
        members.push({
          kind: "record_value_field",
          name: nameToken.value,
          value: valueExpr,
          hasTrailingComma,
          span: this.spanFrom(nameToken.start, valueExpr.span.end),
          id: nextNodeId(),
        });
        continue;
      }

      this.expectSymbol(":");
      const valueStart = this.index;
      let member: RecordMember | null = null;
      let parsedType: TypeExpr | null = null;
      const typeSnapshot = this.index;
      try {
        parsedType = this.parseTypeExpr();
      } catch (_error) {
        this.index = typeSnapshot;
        parsedType = null;
      }

      if (parsedType && this.matchSymbol("=")) {
        const valueExpr = this.parseExpression();
        let hasTrailingComma = false;
        if (this.matchSymbol(",")) {
          hasTrailingComma = true;
        }
        member = {
          kind: "record_value_field",
          name: nameToken.value,
          annotation: parsedType,
          value: valueExpr,
          hasTrailingComma,
          span: this.spanFrom(nameToken.start, valueExpr.span.end),
          id: nextNodeId(),
        };
      } else if (
        parsedType && (this.checkSymbol(",") || this.checkSymbol("}"))
      ) {
        let hasTrailingComma = false;
        if (this.matchSymbol(",")) {
          hasTrailingComma = true;
        }
        member = {
          kind: "record_typed_field",
          name: nameToken.value,
          annotation: parsedType,
          hasTrailingComma,
          span: this.spanFrom(nameToken.start, parsedType.span.end),
          id: nextNodeId(),
        };
      } else {
        this.index = valueStart;
        const valueExpr = this.parseExpression();
        let hasTrailingComma = false;
        if (this.matchSymbol(",")) {
          hasTrailingComma = true;
        }
        member = {
          kind: "record_value_field",
          name: nameToken.value,
          value: valueExpr,
          hasTrailingComma,
          span: this.spanFrom(nameToken.start, valueExpr.span.end),
          id: nextNodeId(),
        };
      }

      members.push(member);
    }
    const close = this.expectSymbol("}");
    return { members, endToken: close };
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
      const typeParams = this.matchSymbol("<")
        ? this.parseTypeParameters()
        : [];
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

  private parseDomainDeclaration(exportToken?: Token): DomainDeclaration {
    const domainToken = this.expectKeyword("domain");
    const nameToken = this.expectIdentifier();
    const { entries, defaultEntries, closeToken } = this.parseDomainRuleBlock();
    const declaration: DomainDeclaration = {
      kind: "domain",
      name: nameToken.value,
      entries,
      defaultEntries,
      span: this.spanFrom(domainToken.start, closeToken.end),
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

  private parseOpRuleDeclaration(exportToken?: Token): OpRuleDeclaration {
    const opToken = this.expectKeyword("op");
    const { name } = this.parseQualifiedName();
    const { entries, closeToken } = this.parseRuleBlock();
    const declaration: OpRuleDeclaration = {
      kind: "op",
      name,
      entries,
      span: this.spanFrom(opToken.start, closeToken.end),
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

  private parsePolicyDeclaration(exportToken?: Token): PolicyDeclaration {
    const policyToken = this.expectKeyword("policy");
    const nameToken = this.expectIdentifier();
    const { entries, closeToken } = this.parseRuleBlock();
    const declaration: PolicyDeclaration = {
      kind: "policy",
      name: nameToken.value,
      entries,
      span: this.spanFrom(policyToken.start, closeToken.end),
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

  private parseAnnotateDeclaration(exportToken?: Token): AnnotateDeclaration {
    const annotateToken = this.expectKeyword("annotate");
    const { name } = this.parseQualifiedName();
    const open = this.expectSymbol("{");
    const policies: string[] = [];
    if (!this.checkSymbol("}")) {
      do {
        const policyToken = this.expectRuleNameToken();
        policies.push(policyToken.value);
      } while (this.matchSymbol(","));
    }
    const close = this.expectSymbol("}");
    const declaration: AnnotateDeclaration = {
      kind: "annotate",
      target: name,
      policies,
      span: this.spanFrom(annotateToken.start, close.end),
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

  private parseRuleBlock(): { entries: RuleEntry[]; closeToken: Token } {
    this.expectSymbol("{");
    const entries: RuleEntry[] = [];
    while (!this.checkSymbol("}")) {
      entries.push(this.parseRuleEntry());
      this.matchSymbol(";") || this.matchSymbol(",");
    }
    const closeToken = this.expectSymbol("}");
    return { entries, closeToken };
  }

  private parseDomainRuleBlock(): {
    entries: RuleEntry[];
    defaultEntries?: RuleEntry[];
    closeToken: Token;
  } {
    this.expectSymbol("{");
    const entries: RuleEntry[] = [];
    let defaultEntries: RuleEntry[] | undefined;
    while (!this.checkSymbol("}")) {
      const token = this.peek();
      const next = this.peek(1);
      if (
        token.kind === "identifier" && token.value === "default" &&
        this.isSymbolToken(next, "{")
      ) {
        if (defaultEntries) {
          throw this.error("Duplicate default rule block", token);
        }
        this.consume();
        const parsed = this.parseRuleBlock();
        defaultEntries = parsed.entries;
        this.matchSymbol(";") || this.matchSymbol(",");
        continue;
      }
      entries.push(this.parseRuleEntry());
      this.matchSymbol(";") || this.matchSymbol(",");
    }
    const closeToken = this.expectSymbol("}");
    return { entries, defaultEntries, closeToken };
  }

  private parseRuleEntry(): RuleEntry {
    const keyToken = this.expectRuleNameToken();
    let value: RuleValue | undefined;
    let endToken: Token = keyToken;

    if (
      !this.checkSymbol("}") &&
      !this.checkSymbol(";") &&
      !this.checkSymbol(",")
    ) {
      const parts: RuleValuePart[] = [];
      if (this.checkSymbol("[")) {
        const listPart = this.parseListPart();
        parts.push(listPart.part);
        endToken = listPart.endToken;
      } else {
        const nameToken = this.expectRuleNameToken();
        parts.push({ kind: "name", name: nameToken.value });
        endToken = nameToken;
        if (this.checkSymbol("[")) {
          const listPart = this.parseListPart();
          parts.push(listPart.part);
          endToken = listPart.endToken;
        }
      }
      value = { kind: "sequence", parts };
    }

    return {
      kind: "rule_entry",
      key: keyToken.value,
      value,
      span: this.spanFrom(keyToken.start, endToken.end),
      id: nextNodeId(),
    };
  }

  private parseListPart(): { part: RuleValuePart; endToken: Token } {
    const open = this.expectSymbol("[");
    if (this.checkSymbol("]")) {
      const close = this.expectSymbol("]");
      return { part: { kind: "list", items: [] }, endToken: close };
    }
    if (this.checkSymbol("(")) {
      return this.parsePairListAfterOpen(open);
    }
    return this.parseNameListAfterOpen(open);
  }

  private parseNameListAfterOpen(_open: Token): {
    part: RuleValuePart;
    endToken: Token;
  } {
    const items: string[] = [];
    do {
      const nameToken = this.expectRuleNameToken();
      items.push(nameToken.value);
    } while (this.matchSymbol(","));
    const close = this.expectSymbol("]");
    return { part: { kind: "list", items }, endToken: close };
  }

  private parsePairListAfterOpen(_open: Token): {
    part: RuleValuePart;
    endToken: Token;
  } {
    const pairs: [string, string][] = [];
    do {
      this.expectSymbol("(");
      const left = this.expectRuleNameToken();
      this.expectSymbol(",");
      const right = this.expectRuleNameToken();
      this.expectSymbol(")");
      pairs.push([left.value, right.value]);
    } while (this.matchSymbol(","));
    const close = this.expectSymbol("]");
    return { part: { kind: "pair_list", pairs }, endToken: close };
  }

  private parseQualifiedName(): { name: string; end: Token } {
    const first = this.expectRuleNameToken();
    const parts = [first.value];
    let endToken = first;
    while (this.matchSymbol(".")) {
      const next = this.expectRuleNameToken();
      parts.push(next.value);
      endToken = next;
    }
    return { name: parts.join("."), end: endToken };
  }

  private expectRuleNameToken(): Token {
    const token = this.consume();
    if (
      token.kind === "identifier" ||
      token.kind === "constructor" ||
      token.kind === "keyword" ||
      token.kind === "bool"
    ) {
      return token;
    }
    throw this.error("Expected name", token);
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
          this.error(
            `Expected 'value' or 'effect' after @, got '${annotToken.value}'`,
          );
        }
      } else {
        this.error(`Expected annotation name after @`);
      }
    }

    const token = this.peek();
    const isQuestionConstructor =
      (token.kind === "symbol" || token.kind === "operator") &&
      token.value === "?";
    if (token.kind === "constructor" || isQuestionConstructor) {
      const ctor = this.consume();
      const ctorName = isQuestionConstructor ? "?" : ctor.value;
      if (isQuestionConstructor && this.checkSymbol("<")) {
        throw this.error(
          "Question mark constructor cannot take type arguments",
          this.peek(),
        );
      }
      const typeArgs = !isQuestionConstructor && this.matchSymbol("<")
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
    const expr = this.parseIfExpression();
    return this.parseAsExpression(expr);
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

  private parseIfExpression(): Expr {
    const token = this.peek();
    if (token.kind === "keyword" && token.value === "if") {
      const ifToken = this.expectKeyword("if");
      this.expectSymbol("(");
      const condition = this.parseExpression();
      this.expectSymbol(")");
      const thenBranch = this.parseBlockExpr();
      if (!this.matchKeyword("else")) {
        throw this.error(
          "'if' expression is missing 'else' block.",
          this.peek(),
        );
      }
      if (this.checkKeyword("if")) {
        throw this.error(
          "Workman does not support 'else if'. Use 'match' for multiple conditions.",
          this.peek(),
        );
      }
      const elseBranch = this.parseBlockExpr();
      return {
        kind: "if",
        condition,
        thenBranch,
        elseBranch,
        span: this.spanFrom(ifToken.start, elseBranch.span.end),
        id: nextNodeId(),
      };
    }
    return this.parseMatchExpression();
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
    // Handle zero-arg arrow: => { ... } (CoffeeScript style)
    if (token.kind === "symbol" && token.value === "=>") {
      this.consume(); // consume =>
      const body = this.parseBlockExpr();
      return {
        kind: "arrow",
        parameters: [],
        returnAnnotation: undefined,
        body,
        span: this.spanFrom(token.start, body.span.end),
        id: nextNodeId(),
      };
    }
    if (token.kind === "symbol" && token.value === "(") {
      const snapshot = this.index;
      let arrowInfo: {
        parameters: Parameter[];
        returnAnnotation?: TypeExpr;
        start: number;
      } | null = null;
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

      let right: Expr;
      try {
        right = this.parseBinaryExpression(nextMinPrecedence);
      } catch (error) {
        if (
          this.tolerant &&
          error instanceof ParseError &&
          this.isExpectedExpressionError(error)
        ) {
          right = this.createImplicitHoleBefore(error.token);
        } else {
          throw error;
        }
      }

      if (operator === ":>" && !this.preservePipeOperator) {
        left = this.createPipeCall(left, right);
        continue;
      }

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

  private parseAsExpression(expr: Expr): Expr {
    let result = expr;
    while (this.matchKeyword("as")) {
      const typeAnnotation = this.parseTypeExpr();
      result = {
        kind: "type_as",
        expression: result,
        typeAnnotation,
        span: this.spanFrom(result.span.start, typeAnnotation.span.end),
        id: nextNodeId(),
      };
    }
    return result;
  }

  private createPipeCall(left: Expr, right: Expr): Expr {
    if (right.kind === "index") {
      const callee: Expr = {
        kind: "identifier",
        name: "write",
        span: this.spanFrom(right.span.start, right.span.start),
        id: nextNodeId(),
      };
      return {
        kind: "call",
        callee,
        arguments: [right.target, right.index, left],
        span: this.spanFrom(left.span.start, right.span.end),
        id: nextNodeId(),
      };
    }

    const leftArgs = left.kind === "tuple" ? left.elements : [left];

    if (right.kind === "call") {
      return {
        kind: "call",
        callee: right.callee,
        arguments: [...leftArgs, ...right.arguments],
        span: this.spanFrom(left.span.start, right.span.end),
        id: nextNodeId(),
      };
    }

    return {
      kind: "call",
      callee: right,
      arguments: leftArgs,
      span: this.spanFrom(left.span.start, right.span.end),
      id: nextNodeId(),
    };
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

      if (this.matchSymbol("[")) {
        const indexExpr = this.parseExpression();
        const close = this.expectSymbol("]");
        expr = {
          kind: "index",
          target: expr,
          index: indexExpr,
          span: this.spanFrom(expr.span.start, close.end),
          id: nextNodeId(),
        };
        continue;
      }

      if (this.matchSymbol(".")) {
        // Check for ^identifier syntax (capitalize first letter for Zig interop)
        const capitalize = this.peek().kind === "operator" &&
          this.peek().value === "^";
        if (capitalize) {
          this.consume(); // consume the ^
        }
        const fieldToken = this.expectIdentifier();
        const target = expr;
        expr = {
          kind: "record_projection",
          target,
          field: fieldToken.value,
          capitalize,
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
        if (token.value === "Void") {
          const voidToken = this.consume();
          return {
            kind: "literal",
            literal: {
              kind: "unit",
              span: this.createSpan(voidToken, voidToken),
              id: nextNodeId(),
            },
            span: this.createSpan(voidToken, voidToken),
            id: nextNodeId(),
          } as Expr;
        }
        if (token.value === "Panic") {
          const panicToken = this.consume();
          this.expectSymbol("(");
          const message = this.parseExpression();
          const close = this.expectSymbol(")");
          return {
            kind: "panic",
            message,
            span: this.spanFrom(panicToken.start, close.end),
            id: nextNodeId(),
          } as Expr;
        }
        const snapshot = this.index;
        const typeAnnotation = this.parseTypePrimary();
        if (this.checkSymbol("{")) {
          const open = this.expectSymbol("{");
          const recordExpr = this.parseRecordLiteralExprFromOpen(
            open,
            typeAnnotation.span.start,
          );
          return {
            kind: "type_as",
            expression: recordExpr,
            typeAnnotation,
            span: this.spanFrom(typeAnnotation.span.start, recordExpr.span.end),
            id: nextNodeId(),
          } as Expr;
        }
        this.index = snapshot;
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
        if (token.value === ".") {
          const next = this.peek(1);
          if (next.kind === "symbol" && next.value === "{") {
            const dotToken = this.consume();
            const open = this.expectSymbol("{");
            // Check if this is a tuple .{a, b} or record .{x: a, y: b}
            if (this.looksLikeTupleLiteral()) {
              return this.parseBraceTupleExpr(open, dotToken.start);
            } else {
              return this.parseRecordLiteralExprFromOpen(open, dotToken.start);
            }
          }
          // Enum literal: .identifier (for Zig interop in raw mode)
          if (next.kind === "identifier") {
            const dotToken = this.consume();
            const nameToken = this.consume();
            return {
              kind: "enum_literal",
              name: nameToken.value,
              span: this.spanFrom(dotToken.start, nameToken.end),
              id: nextNodeId(),
            } as Expr;
          }
        }
        if (token.value === "(") {
          return this.parseParenExpression();
        }
        if (token.value === "{") {
          // Plain {} is always a block expression
          // Use .{} for record literals
          return this.parseBlockExpr();
        }
        if (token.value === "[") {
          return this.parseListLiteralExpr();
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
    if (this.tolerant) {
      return this.createImplicitHoleBefore(token);
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

  private parseBraceTupleExpr(open: Token, start: number): Expr {
    // Parse .{a, b, c} as a tuple
    const elements: Expr[] = [];
    if (!this.checkSymbol("}")) {
      elements.push(this.parseExpression());
      while (this.matchSymbol(",")) {
        if (this.checkSymbol("}")) {
          // Trailing comma before closing brace
          break;
        }
        elements.push(this.parseExpression());
      }
    }
    const close = this.expectSymbol("}");

    if (elements.length === 0) {
      // Empty tuple .{} - keep as empty record for Zig interop
      const span = this.spanFrom(start, close.end);
      return {
        kind: "record_literal",
        fields: [],
        span,
        id: nextNodeId(),
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
      span: this.spanFrom(start, close.end),
      isMultiLine,
      id: nextNodeId(),
    } as Expr;
  }

  private parseListLiteralExpr(): Expr {
    // Parse [a, b, c] or [a, b, ...rest] as list literal
    const open = this.expectSymbol("[");
    const elements: Expr[] = [];
    let spread: Expr | undefined;

    if (!this.checkSymbol("]")) {
      while (true) {
        // Check for spread syntax: ...expr
        if (this.checkSymbol("..")) {
          this.consume(); // consume ..
          spread = this.parseExpression();
          // Spread must be the last element
          this.matchSymbol(","); // optional trailing comma
          break;
        }

        elements.push(this.parseExpression());

        if (!this.matchSymbol(",")) {
          break;
        }

        // Check for trailing comma before closing bracket
        if (this.checkSymbol("]")) {
          break;
        }
      }
    }

    const close = this.expectSymbol("]");

    return {
      kind: "list_literal",
      elements,
      spread,
      span: this.spanFrom(open.start, close.end),
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

    if (token.kind === "symbol" && token.value === "[") {
      const open = this.consume();
      const lengthToken = this.peek();
      if (lengthToken.kind !== "number") {
        throw this.error("Expected array length number in type", lengthToken);
      }
      const length = Number(this.consume().value);
      this.expectSymbol("]");
      const element = this.parseTypePrimary();
      return {
        kind: "type_array",
        length,
        element,
        span: this.spanFrom(open.start, element.span.end),
        id: nextNodeId(),
      };
    }

    // Pointer type: *T
    if (token.kind === "operator" && token.value === "*") {
      const star = this.consume();
      const pointee = this.parseTypePrimary();
      return {
        kind: "type_pointer",
        pointee,
        span: this.spanFrom(star.start, pointee.span.end),
        id: nextNodeId(),
      };
    }

    if (token.kind === "identifier") {
      const ident = this.consume();
      // Check for qualified name: std.Build, std.mem.Allocator, etc.
      const parts = [ident.value];
      let endToken = ident;
      while (this.matchSymbol(".")) {
        const next = this.peek();
        if (next.kind === "identifier" || next.kind === "constructor") {
          const part = this.consume();
          parts.push(part.value);
          endToken = part;
        } else {
          throw this.error(
            "Expected identifier after '.' in qualified type name",
            next,
          );
        }
      }
      const qualifiedName = parts.join(".");
      const typeArgs = this.matchSymbol("<") ? this.parseTypeArguments() : [];
      const end = typeArgs.length > 0
        ? typeArgs[typeArgs.length - 1].span.end
        : endToken.end;
      // If it's a qualified name or has type args, treat as type_ref
      if (parts.length > 1 || typeArgs.length > 0) {
        return {
          kind: "type_ref",
          name: qualifiedName,
          typeArgs,
          span: this.spanFrom(ident.start, end),
          id: nextNodeId(),
        };
      }
      return {
        kind: "type_var",
        name: ident.value,
        span: this.createSpan(ident, ident),
        id: nextNodeId(),
      };
    }

    if (token.kind === "constructor") {
      const ctor = this.consume();
      // Check for qualified name after constructor: Build.Options, etc.
      const parts = [ctor.value];
      let endToken = ctor;
      while (this.matchSymbol(".")) {
        const next = this.peek();
        if (next.kind === "identifier" || next.kind === "constructor") {
          const part = this.consume();
          parts.push(part.value);
          endToken = part;
        } else {
          throw this.error(
            "Expected identifier after '.' in qualified type name",
            next,
          );
        }
      }
      const qualifiedName = parts.join(".");
      const typeArgs = this.matchSymbol("<") ? this.parseTypeArguments() : [];
      const end = typeArgs.length > 0
        ? typeArgs[typeArgs.length - 1].span.end
        : endToken.end;
      return {
        kind: "type_ref",
        name: qualifiedName,
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

    if (
      (token.kind === "constructor" || token.kind === "identifier") &&
      token.value === "Var"
    ) {
      const varToken = this.consume();
      this.expectSymbol("(");
      const binder = this.expectIdentifier();
      const close = this.expectSymbol(")");
      return {
        kind: "variable",
        name: binder.value,
        isExplicitBinding: true,
        span: this.spanFrom(varToken.start, close.end),
        id: nextNodeId(),
      };
    }

    if (
      (token.kind === "constructor" || token.kind === "identifier") &&
      token.value === "Void"
    ) {
      const voidToken = this.consume();
      const literal = {
        kind: "unit" as const,
        span: this.createSpan(voidToken, voidToken),
        id: nextNodeId(),
      };
      return { kind: "literal", literal, span: literal.span, id: nextNodeId() };
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

    const isQuestionConstructor =
      (token.kind === "symbol" || token.kind === "operator") &&
      token.value === "?";
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

    if (token.kind === "symbol" && token.value === "[") {
      return this.parseListPattern();
    }

    throw this.error("Expected pattern", token);
  }

  private parseListPattern(): Pattern {
    // Parse [a, b, c] or [a, b, ...rest] or [a, b, ..._] as list patterns
    const open = this.expectSymbol("[");
    const elements: Pattern[] = [];
    let rest: Pattern | undefined;

    if (!this.checkSymbol("]")) {
      while (true) {
        // Check for spread syntax: ...pattern
        if (this.checkSymbol("..")) {
          this.consume(); // consume ..
          rest = this.parsePattern();
          // Spread must be the last element
          this.matchSymbol(","); // optional trailing comma
          break;
        }

        elements.push(this.parsePattern());

        if (!this.matchSymbol(",")) {
          break;
        }

        // Check for trailing comma before closing bracket
        if (this.checkSymbol("]")) {
          break;
        }
      }
    }

    const close = this.expectSymbol("]");

    return {
      kind: "list",
      elements,
      rest,
      span: this.spanFrom(open.start, close.end),
      id: nextNodeId(),
    };
  }

  private parseMatchBlock(): { bundle: MatchBundle; span: SourceSpan } {
    const open = this.expectSymbol("{");
    return this.parseMatchBlockFromOpenBrace(open.start);
  }

  private parseMatchBlockFromOpenBrace(start: number): {
    bundle: MatchBundle;
    span: SourceSpan;
  } {
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
            next.kind === "symbol" &&
            (next.value === "," || next.value === "}")
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
        const guard = this.matchKeyword("when")
          ? this.parseExpression()
          : undefined;
        this.expectSymbol("=>");
        const body = this.parseBlockExpr();

        const trailingComment = this.consumeInlineCommentAfter(body.span.end);
        const hasComma = this.matchSymbol(",");
        const span = this.spanFrom(patternStart.start, body.span.end);
        arms.push({
          kind: "match_pattern",
          pattern,
          guard,
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
    return this.spanFrom(start.start, end.end);
  }

  private spanFrom(start: number, end: number): SourceSpan {
    if (!this.lineOffsets || !this.source) {
      return { start, end };
    }
    const startLoc = offsetToLineCol(start, this.lineOffsets);
    const endLoc = offsetToLineCol(end, this.lineOffsets);
    return {
      start,
      end,
      line: startLoc.line,
      column: startLoc.column,
      endLine: endLoc.line,
      endColumn: endLoc.column,
    };
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
    return this.consumeSymbolToken(value);
  }

  private matchSymbol(value: string): boolean {
    const token = this.peek();
    if (this.isSymbolToken(token, value)) {
      this.consumeSymbolToken(value);
      return true;
    }
    return false;
  }

  private checkSymbol(value: string): boolean {
    return this.isSymbolToken(this.peek(), value);
  }

  private checkKeyword(value: string): boolean {
    const token = this.peek();
    return token.kind === "keyword" && token.value === value;
  }

  private isSymbolToken(token: Token, value: string): boolean {
    if (
      (token.kind === "symbol" || token.kind === "operator") &&
      token.value === value
    ) {
      return true;
    }
    return false;
  }

  private consumeSymbolToken(value: string): Token {
    const token = this.consume();
    if (!this.isSymbolToken(token, value)) {
      throw expectedTokenError(`symbol '${value}'`, token, this.source);
    }

    if (token.kind === "operator" && token.value === value) {
      return { ...token, kind: "symbol" };
    }

    return token;
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

  private canStartTopLevelDeclaration(): boolean {
    const token = this.peek();
    if (token.kind === "keyword") {
      return (
        token.value === "let" ||
        token.value === "type" ||
        token.value === "record" ||
        token.value === "from" ||
        token.value === "infix" ||
        token.value === "infixl" ||
        token.value === "infixr" ||
        token.value === "prefix" ||
        token.value === "infectious" ||
        token.value === "domain" ||
        token.value === "op" ||
        token.value === "policy" ||
        token.value === "annotate" ||
        token.value === "export"
      );
    }
    return token.kind === "eof";
  }

  private createImplicitHoleBefore(token: Token): Expr {
    const position = token.start;
    const span = { start: position, end: position };
    return {
      kind: "hole",
      span,
      id: nextNodeId(),
    } as Expr;
  }

  private isExpectedExpressionError(error: ParseError): boolean {
    return error.message === "Expected expression";
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
      const textBetween = this.source.slice(commentToken.end, nextToken.start);
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
      !this.preserveComments ||
      this.peek().kind !== "comment" ||
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
