#!/usr/bin/env -S deno run --allow-read --allow-write

import { lex } from "../src/lexer.ts";
import { type OperatorInfo, parseSurfaceProgram } from "../src/parser.ts";
import { WorkmanError } from "../src/error.ts";
import { FormatContext } from "../tests/fixtures/format/format_context.ts";
import { loadModuleGraph } from "../src/module_loader.ts";
import { isAbsolute, resolve } from "../src/io.ts";
import type {
  BlockExpr,
  BlockStatement,
  CommentBlock,
  CommentStatement,
  Expr,
  ImportSpecifier,
  InfectiousDeclaration,
  InfixDeclaration,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  ModuleImport,
  ModuleReexport,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  TypeDeclaration,
  TypeExpr,
  TypeReexport,
} from "../src/ast.ts";

type Declaration = import("../src/ast.ts").TopLevel;

interface FormatOptions {
  indentSize: number;
  mode: "write" | "check" | "check-full" | "stdout";
  doubleCheck?: boolean;
  sourceOverrides?: Map<string, string>;
  outputPath?: string;
}

function isStdCoreModule(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/std/core/") ||
    normalized.includes("std/core/") ||
    normalized.endsWith("/std/list/core.wm") ||
    normalized.endsWith("std/list/core.wm") ||
    normalized.endsWith("/std/option/core.wm") ||
    normalized.endsWith("std/option/core.wm") ||
    normalized.endsWith("/std/result/core.wm") ||
    normalized.endsWith("std/result/core.wm") ||
    normalized.endsWith("/std/hole/core.wm") ||
    normalized.endsWith("std/hole/core.wm");
}

async function computeOperatorEnvironment(
  entryPath: string,
  sourceOverrides?: Map<string, string>,
): Promise<{
  operators: Map<string, OperatorInfo>;
  prefixOperators: Set<string>;
}> {
  const graph = await loadModuleGraph(entryPath, {
    skipEvaluation: true,
    sourceOverrides,
  });
  const entry = graph.entry;
  const node = graph.nodes.get(entry);
  if (!node) {
    return { operators: new Map(), prefixOperators: new Set() };
  }

  const availableOperators = new Map<string, OperatorInfo>();
  const availablePrefixOperators = new Set<string>();

  if (graph.prelude && entry !== graph.prelude && !isStdCoreModule(entry)) {
    const preludeNode = graph.nodes.get(graph.prelude);
    if (preludeNode) {
      for (const [op, info] of preludeNode.exportedOperators) {
        availableOperators.set(op, info);
      }
      for (const op of preludeNode.exportedPrefixOperators) {
        availablePrefixOperators.add(op);
      }
    }
  }

  for (const record of node.imports) {
    if (record.kind === "workman") {
      const depNode = graph.nodes.get(record.sourcePath);
      if (depNode) {
        for (const [op, info] of depNode.exportedOperators) {
          availableOperators.set(op, info);
        }
        for (const op of depNode.exportedPrefixOperators) {
          availablePrefixOperators.add(op);
        }
      }
    }
  }

  return {
    operators: availableOperators,
    prefixOperators: availablePrefixOperators,
  };
}

class Formatter {
  private options: FormatOptions;
  private indent: number = 0;
  private source: string;
  private newline: string;
  private hadTrailingNewline: boolean;
  private exprFormatters: Map<string, (expr: Expr) => string> = new Map();
  private declarationFormatters: Map<string, (decl: Declaration) => string> =
    new Map();
  private patternFormatters: Map<string, (pattern: Pattern) => string> =
    new Map();

  constructor(options: FormatOptions, source: string) {
    this.options = options;
    this.source = source;
    this.newline = source.includes("\r\n") ? "\r\n" : "\n";
    this.hadTrailingNewline = source.endsWith("\n") || source.endsWith("\r");
    this.setupFormatters();
  }

  private setupFormatters() {
    this.setupExprFormatters();
    this.setupDeclarationFormatters();
    this.setupPatternFormatters();
  }

  private setupExprFormatters() {
    this.exprFormatters.set("identifier", (expr) => expr.name);
    this.exprFormatters.set(
      "literal",
      (expr) => this.formatLiteral(expr.literal),
    );
    this.exprFormatters.set(
      "constructor",
      (expr) => this.formatConstructor(expr),
    );
    this.exprFormatters.set(
      "record_literal",
      (expr) => this.formatRecordLiteral(expr),
    );
    this.exprFormatters.set("tuple", (expr) => {
      if (expr.isMultiLine && expr.elements.length > 1) {
        const formattedElements = expr.elements.map((e) => this.formatExpr(e));
        this.indent++;
        const indentedElements = formattedElements.map((el) =>
          `${this.indentStr()}${el}`
        ).join(",\n");
        this.indent--;
        return `(\n${indentedElements}\n${this.indentStr()})`;
      }
      return `(${expr.elements.map((e) => this.formatExpr(e)).join(", ")})`;
    });
    this.exprFormatters.set("call", (expr) => this.formatCall(expr));
    this.exprFormatters.set(
      "record_projection",
      (expr) => `${this.formatExpr(expr.target)}.${expr.field}`,
    );
    this.exprFormatters.set("binary", (expr) => this.formatBinary(expr));
    this.exprFormatters.set(
      "unary",
      (expr) => `${expr.operator}${this.formatExpr(expr.operand)}`,
    );
    this.exprFormatters.set("arrow", (expr) => {
      const paramsStr = this.formatParameterList(expr.parameters);
      const body = this.formatBlock(expr.body, true);
      const returnAnn = expr.returnAnnotation
        ? `: ${this.formatTypeExpr(expr.returnAnnotation)}`
        : "";
      return `${paramsStr}${returnAnn} => ${body}`;
    });
    this.exprFormatters.set("block", (expr) => this.formatBlock(expr));
    this.exprFormatters.set(
      "match",
      (expr) => this.formatMatch(expr.scrutinee, expr.bundle),
    );
    this.exprFormatters.set(
      "match_fn",
      (expr) => this.formatMatchFn(expr.parameters, expr.bundle),
    );
    this.exprFormatters.set(
      "match_bundle_literal",
      (expr) => this.formatMatchBundleLiteral(expr.bundle),
    );
    this.exprFormatters.set("hole", (expr) => "?");
  }

  private setupDeclarationFormatters() {
    this.declarationFormatters.set(
      "let",
      (decl) => this.formatLetDeclaration(decl as LetDeclaration),
    );
    this.declarationFormatters.set(
      "type",
      (decl) => this.formatTypeDeclaration(decl as TypeDeclaration),
    );
    this.declarationFormatters.set(
      "infix",
      (decl) => this.formatInfixDeclaration(decl as InfixDeclaration),
    );
    this.declarationFormatters.set(
      "prefix",
      (decl) => this.formatPrefixDeclaration(decl as PrefixDeclaration),
    );
    this.declarationFormatters.set(
      "infectious",
      (decl) => this.formatInfectiousDeclaration(decl as InfectiousDeclaration),
    );
  }

  private setupPatternFormatters() {
    this.patternFormatters.set("wildcard", (pattern) => "_");
    this.patternFormatters.set("variable", (pattern) => pattern.name);
    this.patternFormatters.set(
      "literal",
      (pattern) => this.formatLiteral(pattern.literal),
    );
    this.patternFormatters.set(
      "tuple",
      (pattern) =>
        `(${pattern.elements.map((e) => this.formatPattern(e)).join(", ")})`,
    );
    this.patternFormatters.set("constructor", (pattern) => {
      if (pattern.args.length === 0) {
        return pattern.name;
      }
      return `${pattern.name}(${
        pattern.args.map((a) => this.formatPattern(a)).join(", ")
      })`;
    });
    this.patternFormatters.set("all_errors", (pattern) => "AllErrors");
  }

  format(program: Program): string {
    return this.formatProgramWithContext(program);
  }

  private formatProgramWithContext(program: Program): string {
    const ctx = new FormatContext({
      indentSize: this.options.indentSize,
      newline: this.newline,
    });
    let partCount = 0;
    let lastWasEmpty = false;

    const appendPart = (text: string) => {
      if (partCount > 0) {
        ctx.writeLine();
      }
      if (text.length > 0) {
        ctx.write(text);
        lastWasEmpty = false;
      } else {
        lastWasEmpty = true;
      }
      partCount++;
    };

    for (const imp of program.imports) {
      if (imp.hasBlankLineBefore && (partCount === 0 || !lastWasEmpty)) {
        appendPart("");
      }
      appendPart(this.formatImport(imp));
    }

    for (const reexp of program.reexports) {
      if (reexp.hasBlankLineBefore && (partCount === 0 || !lastWasEmpty)) {
        appendPart("");
      }
      appendPart(this.formatReexport(reexp));
    }

    if (
      (program.imports.length > 0 || program.reexports.length > 0) &&
      program.declarations.length > 0
    ) {
      appendPart("");
    }

    for (let i = 0; i < program.declarations.length; i++) {
      const decl = program.declarations[i];
      if (i > 0 && decl.hasBlankLineBefore) {
        appendPart("");
      }
      this.indent = 0;
      appendPart(this.formatDeclaration(decl));
    }

    if (
      program.trailingComments && program.trailingComments.length > 0
    ) {
      if (partCount > 0 && !lastWasEmpty) {
        appendPart("");
      }
      for (const comment of program.trailingComments) {
        appendPart(this.formatCommentLine(comment.text));
        if (comment.hasBlankLineAfter) {
          appendPart("");
        }
      }
    }

    const formattedBody = ctx.toString();
    const formatted = this.hadTrailingNewline
      ? `${formattedBody}\n`
      : formattedBody;
    const collapsed = formatted.replace(/\n\n\n+/g, "\n\n");
    return this.normalizeNewlines(collapsed);
  }

  private renderLeadingComments(
    comments?: (CommentBlock | string)[],
  ): string {
    if (!comments || comments.length === 0) {
      return "";
    }
    let result = "";
    for (const commentBlock of comments) {
      if (typeof commentBlock === "string") {
        result += `${this.formatCommentLine(commentBlock)}\n`;
        continue;
      }
      const raw = commentBlock.rawText
        ? this.normalizeNewlines(commentBlock.rawText)
        : undefined;
      const line = raw ?? this.formatCommentLine(commentBlock.text);
      result += `${line}\n`;
      if (commentBlock.hasBlankLineAfter) {
        result += "\n";
      }
    }
    return result;
  }

  private formatTerminator(
    node?: { hasTerminatingSemicolon?: boolean },
  ): string {
    if (node && node.hasTerminatingSemicolon === false) {
      return "";
    }
    return ";";
  }

  private formatImport(imp: ModuleImport): string {
    const specs = imp.specifiers.map((s) => this.formatImportSpecifier(s)).join(
      ", ",
    );
    let result = this.renderLeadingComments(imp.leadingComments);
    result += `from "${imp.source}" import { ${specs} }${
      this.formatTerminator(imp)
    }`;
    if (imp.trailingComment) {
      result += this.formatInlineComment(imp.trailingComment);
    }
    return result;
  }

  private formatImportSpecifier(spec: ImportSpecifier): string {
    if (spec.kind === "namespace") {
      return `* as ${spec.local}`;
    }
    return spec.imported === spec.local
      ? spec.imported
      : `${spec.imported} as ${spec.local}`;
  }

  private formatReexport(reexp: ModuleReexport): string {
    const types = reexp.typeExports.map((t) => this.formatTypeReexport(t)).join(
      ", ",
    );
    let result = this.renderLeadingComments(reexp.leadingComments);
    result += `export from "${reexp.source}" type ${types}${
      this.formatTerminator(reexp)
    }`;
    if (reexp.trailingComment) {
      result += this.formatInlineComment(reexp.trailingComment);
    }
    return result;
  }

  private formatTypeReexport(typeExp: TypeReexport): string {
    return typeExp.exportConstructors ? `${typeExp.name}(..)` : typeExp.name;
  }

  private formatDeclaration(decl: Declaration): string {
    let result = "";

    // Add leading comments
    result += this.renderLeadingComments(decl.leadingComments);

    const formatter = this.declarationFormatters.get(decl.kind);
    if (formatter) {
      result += formatter(decl);
    } else {
      result += this.source.slice(decl.span.start, decl.span.end);
    }

    // Add trailing comment on same line
    return result;
  }

  private formatParameter(param: Parameter): string {
    const pattern = this.formatPattern(param.pattern);
    const annotation = param.annotation
      ? `: ${this.formatTypeExpr(param.annotation)}`
      : "";
    return `${pattern}${annotation}`;
  }

  private formatParameterList(params: Parameter[]): string {
    const inner = params.map((p) => this.formatParameter(p)).join(", ");
    return `(${inner})`;
  }

  private formatLetLeftSide(decl: LetDeclaration): string {
    if (decl.pattern) {
      return this.formatPattern(decl.pattern);
    }
    return decl.name;
  }

  private formatLetDeclaration(decl: LetDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const recPrefix = decl.isRecursive ? "rec " : "";
    const annotationSuffix = decl.annotation
      ? `: ${this.formatTypeExpr(decl.annotation)}`
      : "";

    let result: string;

    // Determine if we should add semicolon (not if there are mutual bindings)
    const hasMutualBindings = decl.mutualBindings &&
      decl.mutualBindings.length > 0;
    const shouldEmitSemicolon = !hasMutualBindings &&
      decl.hasTerminatingSemicolon !== false;
    const semicolon = shouldEmitSemicolon ? ";" : "";

    // If this was originally a first-class match, format it that way
    if (
      decl.isFirstClassMatch && decl.body.statements.length === 0 &&
      decl.body.result?.kind === "match"
    ) {
      const matchExpr = decl.body.result;
      // Force multi-line if the body was originally multi-line
      const forceMultiLine = decl.body.isMultiLine === true;
      const formattedMatch = this.formatMatch(
        matchExpr.scrutinee,
        matchExpr.bundle,
        forceMultiLine,
      );
      result = `${exportPrefix}let ${recPrefix}${
        this.formatLetLeftSide(decl)
      }${annotationSuffix} = ${formattedMatch}${semicolon}`;
    } else if (decl.parameters.length > 0 || decl.isArrowSyntax) {
      // If there are parameters OR originally used arrow syntax, format as arrow function
      const paramsStr = this.formatParameterList(decl.parameters);
      const body = this.formatBlock(decl.body, true);
      result = `${exportPrefix}let ${recPrefix}${
        this.formatLetLeftSide(decl)
      }${annotationSuffix} = ${paramsStr} => ${body}${semicolon}`;
    } else {
      // No parameters and not arrow syntax - format body directly
      const body = this.formatBlockForLet(decl.body);

      if (body.startsWith("\n")) {
        // Body is already formatted with leading newline
        result = `${exportPrefix}let ${recPrefix}${
          this.formatLetLeftSide(decl)
        }${annotationSuffix} =${body}${semicolon}`;
      } else {
        result = `${exportPrefix}let ${recPrefix}${
          this.formatLetLeftSide(decl)
        }${annotationSuffix} = ${body}${semicolon}`;
      }
    }

    // Format mutual bindings (applies to all cases)
    if (decl.mutualBindings && decl.mutualBindings.length > 0) {
      for (const mutual of decl.mutualBindings) {
        // Check if this is a first-class match
        if (
          mutual.isFirstClassMatch &&
          mutual.body.statements.length === 0 &&
          mutual.body.result?.kind === "match"
        ) {
          const matchExpr = mutual.body.result;
          const forceMultiLine = mutual.body.isMultiLine === true;
          const formattedMatch = this.formatMatch(
            matchExpr.scrutinee,
            matchExpr.bundle,
            forceMultiLine,
          );
          const mutualAnnotation = mutual.annotation
            ? `: ${this.formatTypeExpr(mutual.annotation)}`
            : "";
          result += `\nand ${
            this.formatLetLeftSide(mutual)
          }${mutualAnnotation} = ${formattedMatch};`;
        } else if (mutual.parameters.length > 0 || mutual.isArrowSyntax) {
          const mutualParamsStr = this.formatParameterList(mutual.parameters);
          const mutualAnnotation = mutual.annotation
            ? `: ${this.formatTypeExpr(mutual.annotation)}`
            : "";
          const mutualBody = this.formatBlock(mutual.body, true);
          result += `\nand ${
            this.formatLetLeftSide(mutual)
          }${mutualAnnotation} = ${mutualParamsStr} => ${mutualBody};`;
        } else {
          const mutualBody = this.formatBlockForLet(mutual.body);
          const mutualAnnotation = mutual.annotation
            ? `: ${this.formatTypeExpr(mutual.annotation)}`
            : "";
          if (mutualBody.startsWith("\n")) {
            result += `\nand ${
              this.formatLetLeftSide(mutual)
            }${mutualAnnotation} =${mutualBody};`;
          } else {
            result += `\nand ${
              this.formatLetLeftSide(mutual)
            }${mutualAnnotation} = ${mutualBody};`;
          }
        }
      }
    }

    if (decl.trailingComment) {
      result += this.formatInlineComment(decl.trailingComment);
    }

    return result;
  }

  private formatBlockForLet(block: BlockExpr): string {
    if (this.blockHasOnlyResultComments(block)) {
      return this.source
        ? this.source.slice(block.span.start, block.span.end)
        : "{}";
    }
    if (block.statements.length === 0 && block.result) {
      if (block.result.kind === "arrow") {
        return this.formatExpr(block.result);
      }
      let expr = this.formatExpr(block.result);
      if (block.resultTrailingComment) {
        expr += this.formatInlineComment(block.resultTrailingComment);
      }
      if (block.isMultiLine) {
        const ctx = this.createBlockContext();
        ctx.writeLine("{");
        ctx.withIndent(() => {
          this.writeNormalizedLines(ctx, expr);
        });
        ctx.write("}");
        return ctx.toString();
      }
      return expr;
    }
    return this.formatStructuredBlock(block);
  }

  private hasLeadingConstructorPipe(decl: TypeDeclaration): boolean {
    const slice = this.source.slice(decl.span.start, decl.span.end);
    const equalsIndex = slice.indexOf("=");
    if (equalsIndex === -1) {
      return false;
    }
    for (let i = equalsIndex + 1; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === "|") {
        return true;
      }
      if (!/\s/.test(ch)) {
        return false;
      }
    }
    return false;
  }

  private formatTypeDeclaration(decl: TypeDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const infectiousPrefix = decl.infectious
      ? `infectious ${decl.infectious.domain} `
      : "";
    const typeParams = decl.typeParams.length > 0
      ? `<${decl.typeParams.map((p) => p.name).join(", ")}>`
      : "";
    const aliasMember =
      decl.members.length === 1 && decl.members[0].kind === "alias"
        ? decl.members[0]
        : undefined;
    if (
      decl.declarationKind === "record" &&
      aliasMember &&
      aliasMember.type.kind === "type_record"
    ) {
      const recordType = aliasMember.type;
      const fields = recordType.fields.map((field, index) => {
        const value = this.formatTypeExpr(field.type);
        const needsComma = field.hasTrailingComma ||
          index < recordType.fields.length - 1;
        return `${field.name}: ${value}${needsComma ? "," : ""}`;
      }).join(" ");
      return `${exportPrefix}record ${decl.name}${typeParams} { ${fields} }${
        this.formatTerminator(decl)
      }`;
    }
    const members = decl.members.map((m) => {
      if (m.kind === "alias") {
        return this.formatTypeExpr(m.type);
      } else {
        const annotation = m.annotation ? `@${m.annotation} ` : "";
        const args = m.typeArgs.length > 0
          ? `<${m.typeArgs.map((a) => this.formatTypeExpr(a)).join(", ")}>`
          : "";
        return `${annotation}${m.name}${args}`;
      }
    });
    const header =
      `${exportPrefix}${infectiousPrefix}type ${decl.name}${typeParams} =`;
    const forceMultiline = !aliasMember && this.hasLeadingConstructorPipe(decl);
    if (forceMultiline && members.length > 0) {
      const lines = members.map((member) => `  | ${member}`);
      lines[lines.length - 1] = `${lines[lines.length - 1]}${
        this.formatTerminator(decl)
      }`;
      return `${header}\n${lines.join("\n")}`;
    }
    const body = members.join(" | ");
    const separator = body.length > 0 ? " " : "";
    return `${header}${separator}${body}${this.formatTerminator(decl)}`;
  }

  private formatInfixDeclaration(decl: InfixDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const keyword = decl.associativity === "left"
      ? "infixl"
      : decl.associativity === "right"
      ? "infixr"
      : "infix";
    return `${exportPrefix}${keyword} ${decl.precedence} ${decl.operator} = ${decl.implementation}${
      this.formatTerminator(decl)
    }`;
  }

  private formatPrefixDeclaration(decl: PrefixDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    return `${exportPrefix}prefix ${decl.operator} = ${decl.implementation}${
      this.formatTerminator(decl)
    }`;
  }

  private formatInfectiousDeclaration(decl: InfectiousDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    return `${exportPrefix}infectious ${decl.domain} ${decl.typeName}<${decl.valueParam}, ${decl.stateParam}>${
      this.formatTerminator(decl)
    }`;
  }

  private formatTypeExpr(typeExpr: TypeExpr | string): string {
    if (typeof typeExpr === "string") {
      return typeExpr;
    }
    const formatted = this.formatTypeExprWithoutParens(typeExpr);
    const extraPairs = this.computeTypeExtraParentheses(typeExpr);
    if (extraPairs === 0) {
      return formatted;
    }
    const prefix = "(".repeat(extraPairs);
    const suffix = ")".repeat(extraPairs);
    return `${prefix}${formatted}${suffix}`;
  }

  private formatTypeExprWithoutParens(typeExpr: TypeExpr): string {
    switch (typeExpr.kind) {
      case "type_var":
        return typeExpr.name;
      case "type_ref":
        if (typeExpr.typeArgs.length === 0) {
          return typeExpr.name;
        }
        return `${typeExpr.name}<${
          typeExpr.typeArgs.map((a) => this.formatTypeExpr(a)).join(", ")
        }>`;
      case "type_fn": {
        const params = typeExpr.parameters.map((p) => this.formatTypeExpr(p))
          .join(", ");
        const result = this.formatTypeExpr(typeExpr.result);
        return `(${params}) => ${result}`;
      }
      case "type_tuple":
        return `(${
          typeExpr.elements.map((e) => this.formatTypeExpr(e)).join(", ")
        })`;
      case "type_record": {
        if (typeExpr.fields.length === 0) {
          return "{}";
        }
        const parts = typeExpr.fields.map((field, index) => {
          const value = this.formatTypeExpr(field.type);
          const needsComma = field.hasTrailingComma ||
            index < typeExpr.fields.length - 1;
          return `${field.name}: ${value}${needsComma ? "," : ""}`;
        });
        return `{ ${parts.join(" ")} }`;
      }
      case "type_unit":
        return "()";
      case "type_effect_row": {
        const parts: string[] = [];
        for (const kase of typeExpr.cases) {
          if (kase.payload) {
            parts.push(
              `${kase.name}(${this.formatTypeExpr(kase.payload)})`,
            );
          } else {
            parts.push(kase.name);
          }
        }
        if (typeExpr.hasTailWildcard) {
          parts.push("_");
        }
        const inner = parts.join(" | ");
        return `<${inner}>`;
      }
      default:
        return "???";
    }
  }

  private formatBlock(
    block: BlockExpr,
    keepBraces: boolean = false,
  ): string {
    if (this.blockHasOnlyResultComments(block)) {
      return this.source
        ? this.source.slice(block.span.start, block.span.end)
        : "{}";
    }
    if (block.statements.length === 0 && block.result) {
      return this.formatSingleExprBlock(block, keepBraces);
    }
    return this.formatStructuredBlock(block);
  }

  private blockHasOnlyResultComments(block: BlockExpr): boolean {
    return block.statements.length === 0 &&
      !block.result &&
      !!(block.resultCommentStatements &&
        block.resultCommentStatements.length > 0);
  }

  private formatSingleExprBlock(
    block: BlockExpr,
    keepBraces: boolean,
  ): string {
    if (!block.result) {
      return "{}";
    }
    let expr = this.formatExpr(block.result);
    if (block.resultTrailingComment) {
      expr += this.formatInlineComment(block.resultTrailingComment);
    }
    const normalizedExpr = this.normalizeNewlines(expr);
    const exprLines = normalizedExpr.split("\n");
    const hasResultComments = !!(
      block.resultCommentStatements && block.resultCommentStatements.length > 0
    );
    const requiresMultiline = block.isMultiLine === true ||
      exprLines.length > 1 ||
      hasResultComments;
    const needsMultilineFormatting = requiresMultiline ||
      expr.includes("{");
    if (!keepBraces && !requiresMultiline && this.isSimpleExpr(block.result)) {
      return expr;
    }
    if (keepBraces && !requiresMultiline) {
      return `{ ${expr} }`;
    }
    if (!keepBraces && !needsMultilineFormatting) {
      return `{ ${expr} }`;
    }
    const ctx = this.createBlockContext();
    ctx.writeLine("{");
    ctx.withIndent(() => {
      this.writeNormalizedLines(ctx, normalizedExpr);
      if (block.resultCommentStatements) {
        for (const comment of block.resultCommentStatements) {
          this.writeCommentStatementLines(ctx, comment);
          if (comment.hasBlankLineAfter) {
            ctx.writeLine();
          }
        }
      }
    });
    ctx.write("}");
    return ctx.toString();
  }

  private formatStructuredBlock(block: BlockExpr): string {
    const ctx = this.createBlockContext();
    ctx.writeLine("{");
    ctx.withIndent(() => {
      let previousSpanEnd: number | null = null;
      for (const stmt of block.statements) {
        if (
          previousSpanEnd !== null &&
          this.hasBlankLineBetween(previousSpanEnd, stmt.span.start)
        ) {
          ctx.writeLine();
        }
        if (stmt.kind === "comment_statement") {
          this.writeCommentStatementLines(ctx, stmt);
          if (stmt.hasBlankLineAfter) {
            ctx.writeLine();
          }
          previousSpanEnd = stmt.span.end;
          continue;
        }
        const stmtText = this.formatBlockStatement(stmt);
        this.writeNormalizedLines(ctx, stmtText);
        previousSpanEnd = stmt.span.end;
      }
      if (block.result) {
        if (
          previousSpanEnd !== null &&
          this.hasBlankLineBetween(previousSpanEnd, block.result.span.start)
        ) {
          ctx.writeLine();
        }
        this.writeResultExpressionLines(
          ctx,
          block.result,
          block.resultTrailingComment,
        );
        previousSpanEnd = block.result.span.end;
      }
      if (block.resultCommentStatements) {
        for (const comment of block.resultCommentStatements) {
          this.writeCommentStatementLines(ctx, comment);
          if (comment.hasBlankLineAfter) {
            ctx.writeLine();
          }
        }
      }
    });
    ctx.write("}");
    return ctx.toString();
  }

  private createBlockContext(): FormatContext {
    return new FormatContext({
      indentSize: this.options.indentSize,
      newline: this.newline,
    });
  }

  private writeNormalizedLines(ctx: FormatContext, text: string): void {
    const sanitized = this.normalizeNewlines(text).replace(/\r/g, "");
    const lines = sanitized.split("\n");
    for (const line of lines) {
      if (line.length === 0) {
        ctx.writeLine();
      } else {
        ctx.writeLine(line);
      }
    }
  }

  private writeCommentStatementLines(
    ctx: FormatContext,
    comment: CommentStatement,
  ): void {
    const commentText = comment.rawText
      ? this.normalizeNewlines(comment.rawText)
      : this.formatCommentLine(comment.text);
    const lines = commentText.replace(/\r/g, "").split("\n");
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.length === 0) {
        ctx.writeLine();
      } else {
        ctx.writeLine(trimmed);
      }
    }
  }

  private writeResultExpressionLines(
    ctx: FormatContext,
    expr: Expr,
    trailingComment?: string,
  ): void {
    let text = this.formatExpr(expr);
    if (trailingComment) {
      text += this.formatInlineComment(trailingComment);
    }
    this.writeNormalizedLines(ctx, text);
  }

  private writeMatchArmsWithContext(
    ctx: FormatContext,
    arms: MatchArm[],
  ): void {
    for (const arm of arms) {
      if (arm.kind === "comment_statement") {
        this.writeCommentStatementLines(ctx, arm);
        if (arm.hasBlankLineAfter) {
          ctx.writeLine();
        }
        continue;
      }
      const content = this.formatMatchArmContent(arm);
      if (content !== null) {
        this.writeNormalizedLines(ctx, content);
      }
    }
  }

  private writeArgumentLines(
    ctx: FormatContext,
    text: string,
    needsComma: boolean,
  ): void {
    const normalized = this.normalizeNewlines(text).replace(/\r/g, "");
    const lines = normalized.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const suffix = i === lines.length - 1 && needsComma ? "," : "";
      const content = lines[i] + suffix;
      if (content.length === 0) {
        ctx.writeLine();
      } else {
        ctx.writeLine(content);
      }
    }
  }

  private isSimpleExpr(expr: Expr): boolean {
    // Check if expression is simple enough to not need braces
    switch (expr.kind) {
      case "identifier":
      case "literal":
        return true;
      case "call":
      case "constructor":
        return true;
      case "tuple":
        return expr.elements.length <= 2;
      default:
        return false;
    }
  }

  private formatBlockStatement(stmt: BlockStatement): string {
    switch (stmt.kind) {
      case "let_statement": {
        const decl = stmt.declaration;
        const recPrefix = decl.isRecursive ? "rec " : "";
        const annotationSuffix = decl.annotation
          ? `: ${this.formatTypeExpr(decl.annotation)}`
          : "";

        // If this was originally a first-class match, format it that way
        if (
          decl.isFirstClassMatch &&
          decl.body.statements.length === 0 &&
          decl.body.result?.kind === "match"
        ) {
          const matchExpr = decl.body.result;
          const forceMultiLine = decl.body.isMultiLine === true;
          const formattedMatch = this.formatMatch(
            matchExpr.scrutinee,
            matchExpr.bundle,
            forceMultiLine,
          );
          const line = `let ${recPrefix}${
            this.formatLetLeftSide(decl)
          }${annotationSuffix} = ${formattedMatch};`;
          return decl.trailingComment
            ? `${line}${this.formatInlineComment(decl.trailingComment)}`
            : line;
        }

        // Use same logic as top-level let declarations
        if (decl.parameters.length > 0 || decl.isArrowSyntax) {
          const paramsStr = this.formatParameterList(decl.parameters);
          const body = this.formatBlock(decl.body, true);
          const line = `let ${recPrefix}${
            this.formatLetLeftSide(decl)
          }${annotationSuffix} = ${paramsStr} => ${body};`;
          return decl.trailingComment
            ? `${line}${this.formatInlineComment(decl.trailingComment)}`
            : line;
        }

        // Simple let binding
        const body = this.formatBlockForLet(decl.body);
        if (body.startsWith("\n")) {
          const line = `let ${recPrefix}${
            this.formatLetLeftSide(decl)
          }${annotationSuffix} =${body};`;
          return decl.trailingComment
            ? `${line}${this.formatInlineComment(decl.trailingComment)}`
            : line;
        } else {
          const line = `let ${recPrefix}${
            this.formatLetLeftSide(decl)
          }${annotationSuffix} = ${body};`;
          return decl.trailingComment
            ? `${line}${this.formatInlineComment(decl.trailingComment)}`
            : line;
        }
      }
      case "expr_statement":
        let exprLine = this.formatExpr(stmt.expression) + ";";
        if (stmt.trailingComment) {
          exprLine += ` -- ${stmt.trailingComment}`;
        }
        return exprLine;
      case "pattern_let_statement":
        const pattern = this.formatPattern(stmt.pattern);
        const initializer = this.formatExpr(stmt.initializer);
        return `let ${pattern} = ${initializer};`;
      default:
        return "";
    }
  }

  private formatExpr(expr: Expr): string {
    const formatted = this.formatExprWithoutParens(expr);
    const extraPairs = this.computeExtraParentheses(expr);
    if (extraPairs === 0) {
      return formatted;
    }
    const prefix = "(".repeat(extraPairs);
    const suffix = ")".repeat(extraPairs);
    return `${prefix}${formatted}${suffix}`;
  }

  private formatExprWithoutParens(expr: Expr): string {
    const formatter = this.exprFormatters.get(expr.kind);
    if (formatter) {
      return formatter(expr);
    } else {
      return this.source.slice(expr.span.start, expr.span.end);
    }
  }

  private computeTypeExtraParentheses(typeExpr: TypeExpr): number {
    const required = this.requiredTypeParentheses(typeExpr);
    let leading = 0;
    for (
      let i = typeExpr.span.start;
      i < typeExpr.span.end && this.source[i] === "(";
      i++
    ) {
      leading++;
    }
    let trailing = 0;
    for (
      let i = typeExpr.span.end - 1;
      i >= typeExpr.span.start && this.source[i] === ")";
      i--
    ) {
      trailing++;
    }
    const extraLeading = Math.max(0, leading - required.leading);
    const extraTrailing = Math.max(0, trailing - required.trailing);
    return Math.min(extraLeading, extraTrailing);
  }

  private requiredTypeParentheses(
    typeExpr: TypeExpr,
  ): { leading: number; trailing: number } {
    if (typeExpr.kind === "type_tuple") {
      return { leading: 1, trailing: 1 };
    }
    if (typeExpr.kind === "type_unit") {
      return { leading: 1, trailing: 1 };
    }
    return { leading: 0, trailing: 0 };
  }

  private computeExtraParentheses(expr: Expr): number {
    const required = this.requiredParentheses(expr);
    const wrappingPairs = this.countWrappingParenthesisPairs(
      expr.span.start,
      expr.span.end,
    );
    return Math.max(0, wrappingPairs - required.leading);
  }

  private requiredParentheses(
    expr: Expr,
  ): { leading: number; trailing: number } {
    if (expr.kind === "tuple") {
      return { leading: 1, trailing: 1 };
    }
    if (expr.kind === "literal" && expr.literal.kind === "unit") {
      return { leading: 1, trailing: 1 };
    }
    return { leading: 0, trailing: 0 };
  }

  private countWrappingParenthesisPairs(start: number, end: number): number {
    let pairs = 0;
    let left = start;
    let right = end;
    while (true) {
      left = this.skipWhitespaceForward(left, right);
      right = this.skipWhitespaceBackward(left, right);
      if (left >= right) {
        break;
      }
      if (this.source[left] !== "(" || this.source[right - 1] !== ")") {
        break;
      }
      const closing = this.findMatchingClosingParen(left, right);
      if (closing === null || closing !== right - 1) {
        break;
      }
      pairs++;
      left++;
      right--;
    }
    return pairs;
  }

  private skipWhitespaceForward(start: number, end: number): number {
    let index = start;
    while (index < end && /\s/.test(this.source[index])) {
      index++;
    }
    return index;
  }

  private skipWhitespaceBackward(start: number, end: number): number {
    let index = end;
    while (index > start && /\s/.test(this.source[index - 1])) {
      index--;
    }
    return index;
  }

  private findMatchingClosingParen(
    start: number,
    end: number,
  ): number | null {
    let depth = 0;
    for (let i = start; i < end; i++) {
      const ch = this.source[i];
      if (ch === '"' || ch === "'") {
        i = this.skipQuotedText(i, end, ch);
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return i;
        }
        if (depth < 0) {
          return null;
        }
      }
    }
    return null;
  }

  private skipQuotedText(index: number, end: number, quote: string): number {
    let i = index + 1;
    while (i < end) {
      const ch = this.source[i];
      if (ch === "\\" && i + 1 < end) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        return i;
      }
      i++;
    }
    return end - 1;
  }

  private formatLiteral(lit: any): string {
    switch (lit.kind) {
      case "int":
        return String(lit.value);
      case "bool":
        return String(lit.value);
      case "char":
        return this.formatCharLiteral(lit.value);
      case "string":
        return this.formatStringLiteral(lit.value);
      case "unit":
        return "()";
      default:
        return "???";
    }
  }

  private formatStringLiteral(value: string): string {
    let escaped = "";
    for (const ch of value) {
      switch (ch) {
        case "\\":
          escaped += "\\\\";
          break;
        case '"':
          escaped += '\\"';
          break;
        case "\n":
          escaped += "\\n";
          break;
        case "\r":
          escaped += "\\r";
          break;
        case "\t":
          escaped += "\\t";
          break;
        case "\0":
          escaped += "\\0";
          break;
        default:
          escaped += ch;
          break;
      }
    }
    return `"${escaped}"`;
  }

  private formatMatchArmBody(expr: Expr): string {
    // Match arm bodies must always be block expressions
    if (expr.kind === "block") {
      return this.formatBlock(expr, true);
    }
    // If it's not a block, wrap it in braces (shouldn't happen in valid code)
    return `{ ${this.formatExpr(expr)} }`;
  }

  private formatMatchScrutineeExpr(scrutinee: Expr): string {
    if (
      scrutinee.kind === "tuple" &&
      this.source[scrutinee.span.start] !== "("
    ) {
      return scrutinee.elements.map((element) => this.formatExpr(element))
        .join(", ");
    }
    return this.formatExpr(scrutinee);
  }

  private blockHasComments(block: BlockExpr): boolean {
    const hasCommentStatements = block.statements.some((stmt) =>
      stmt.kind === "comment_statement"
    );
    if (hasCommentStatements) {
      return true;
    }
    if (
      block.resultCommentStatements &&
      block.resultCommentStatements.length > 0
    ) {
      return true;
    }
    return false;
  }

  private formatCommentLine(text: string): string {
    const needsSpace = text.length === 0 || !/^[\s]/.test(text);
    return needsSpace ? `-- ${text}` : `--${text}`;
  }

  private formatInlineComment(text: string | undefined): string {
    if (!text) {
      return "";
    }
    if (text.includes("String literal")) {
    }
    const normalized = this.normalizeNewlines(text);
    if (normalized.startsWith("--")) {
      return ` ${normalized}`;
    }
    const suffix = normalized.length > 0 && normalized[0] === " "
      ? normalized
      : ` ${normalized}`;
    return ` --${suffix}`;
  }

  private formatMatchArmContent(arm: MatchArm): string | null {
    if (arm.kind === "comment_statement") {
      return null;
    }
    if (arm.kind === "match_bundle_reference") {
      let text = arm.name;
      if (arm.trailingComment) {
        text += this.formatInlineComment(arm.trailingComment);
      }
      if (arm.hasTrailingComma) {
        text += ",";
      }
      return text;
    }
    const pattern = this.formatPattern(arm.pattern);
    const body = this.formatMatchArmBody(arm.body);
    let text = `${pattern} => ${body}`;
    if (arm.trailingComment) {
      text += this.formatInlineComment(arm.trailingComment);
    }
    if (arm.hasTrailingComma) {
      text += ",";
    }
    return text;
  }

  private formatMatch(
    scrutinee: Expr,
    bundle: MatchBundle,
    forceMultiLine: boolean = false,
  ): string {
    const scrutineeStr = this.formatMatchScrutineeExpr(scrutinee);
    const arms = bundle.arms;
    const inlineArm = arms.length === 1
      ? this.formatMatchArmContent(arms[0])
      : null;
    const inlineMatch = inlineArm !== null
      ? `match(${scrutineeStr}) { ${inlineArm} }`
      : "";
    const shouldForce = forceMultiLine || this.matchBundleIsMultiLine(bundle);
    if (
      !shouldForce && inlineArm !== null && inlineMatch.length <= 60 &&
      arms.length === 1
    ) {
      return inlineMatch;
    }
    const ctx = this.createBlockContext();
    ctx.write(`match(${scrutineeStr}) {`);
    ctx.writeLine();
    ctx.withIndent(() => {
      this.writeMatchArmsWithContext(ctx, arms);
    });
    ctx.write("}");
    return ctx.toString();
  }

  private formatMatchFn(params: Expr[], bundle: MatchBundle): string {
    const arms = bundle.arms;
    const paramExpr = params.length === 1
      ? this.formatExpr(params[0])
      : params.map((p) => this.formatExpr(p)).join(", ");
    const inlineArm = arms.length === 1
      ? this.formatMatchArmContent(arms[0])
      : null;
    const inlineFn = inlineArm !== null
      ? `match(${paramExpr}) { ${inlineArm} }`
      : "";
    if (
      !this.matchBundleIsMultiLine(bundle) && inlineFn.length <= 80 &&
      arms.length <= 2 && inlineArm !== null
    ) {
      return inlineFn;
    }
    const ctx = this.createBlockContext();
    ctx.write(`match(${paramExpr}) {`);
    ctx.writeLine();
    ctx.withIndent(() => {
      this.writeMatchArmsWithContext(ctx, arms);
    });
    ctx.write("}");
    return ctx.toString();
  }

  private formatPattern(pattern: Pattern): string {
    const formatter = this.patternFormatters.get(pattern.kind);
    if (formatter) {
      return formatter(pattern);
    } else {
      return this.source.slice(pattern.span.start, pattern.span.end);
    }
  }

  private formatMatchBundleLiteral(bundle: MatchBundle): string {
    const arms = bundle.arms;
    const inlineArm = arms.length === 1
      ? this.formatMatchArmContent(arms[0])
      : null;
    const inline = inlineArm !== null ? `match { ${inlineArm} }` : "";
    if (
      !this.matchBundleIsMultiLine(bundle) && inline.length <= 60 &&
      arms.length <= 1 && inlineArm !== null
    ) {
      return inline;
    }
    const ctx = this.createBlockContext();
    ctx.write("match {");
    ctx.writeLine();
    ctx.withIndent(() => {
      this.writeMatchArmsWithContext(ctx, arms);
    });
    ctx.write("}");
    return ctx.toString();
  }

  private formatRecordLiteral(
    expr: Extract<Expr, { kind: "record_literal" }>,
  ): string {
    if (expr.fields.length === 0) {
      return "{}";
    }

    const singleLine = !expr.isMultiLine;
    if (singleLine) {
      const inner = expr.fields.map((field, index) => {
        const value = this.formatExpr(field.value);
        const needsComma = index < expr.fields.length - 1;
        return `${field.name}: ${value}${needsComma ? ", " : ""}`;
      }).join("");
      return `{ ${inner} }`;
    }

    this.indent++;
    const lines = expr.fields.map((field, index) => {
      const value = this.formatExpr(field.value);
      const needsComma = field.hasTrailingComma ||
        index < expr.fields.length - 1;
      return `${this.indentStr()}${field.name}: ${value}${
        needsComma ? "," : ""
      }`;
    });
    this.indent--;
    return `{\n${lines.join("\n")}\n${this.indentStr()}}`;
  }

  private formatCall(expr: Extract<Expr, { kind: "call" }>): string {
    const callee = this.formatExpr(expr.callee);
    const argInfos = expr.arguments.map((argument) => ({
      expr: argument,
      text: this.formatExpr(argument),
    }));
    if (argInfos.length === 0) {
      return `${callee}()`;
    }
    if (!this.shouldFormatCallMultiline(expr, argInfos)) {
      return `${callee}(${argInfos.map((info) => info.text).join(", ")})`;
    }
    const ctx = this.createBlockContext();
    ctx.write(`${callee}(`);
    ctx.writeLine();
    ctx.withIndent(() => {
      argInfos.forEach((info, index) => {
        this.writeArgumentLines(ctx, info.text, index < argInfos.length - 1);
      });
    });
    ctx.write(")");
    return ctx.toString();
  }

  private formatConstructor(
    expr: Extract<Expr, { kind: "constructor" }>,
  ): string {
    if (expr.args.length === 0) {
      return expr.name;
    }
    const argInfos = expr.args.map((argument) => ({
      expr: argument,
      text: this.formatExpr(argument),
    }));
    if (!this.shouldFormatConstructorMultiline(expr, argInfos)) {
      return `${expr.name}(${argInfos.map((info) => info.text).join(", ")})`;
    }
    const ctx = this.createBlockContext();
    ctx.write(`${expr.name}(`);
    ctx.writeLine();
    ctx.withIndent(() => {
      argInfos.forEach((info, index) => {
        this.writeArgumentLines(ctx, info.text, index < argInfos.length - 1);
      });
    });
    ctx.write(")");
    return ctx.toString();
  }

  private shouldFormatCallMultiline(
    expr: Extract<Expr, { kind: "call" }>,
    formattedArgs: { expr: Expr; text: string }[],
  ): boolean {
    if (this.hasTopLevelCallNewline(expr)) {
      return true;
    }
    if (
      formattedArgs.some((info) =>
        info.text.includes("\n") && !this.isInlineBlockArgument(info.expr)
      )
    ) {
      return true;
    }
    return false;
  }

  private shouldFormatConstructorMultiline(
    expr: Extract<Expr, { kind: "constructor" }>,
    formattedArgs: { expr: Expr; text: string }[],
  ): boolean {
    if (this.hasTopLevelConstructorNewline(expr)) {
      return true;
    }
    if (
      formattedArgs.some((info) =>
        info.text.includes("\n") && !this.isInlineBlockArgument(info.expr)
      )
    ) {
      return true;
    }
    return false;
  }

  private hasTopLevelCallNewline(
    expr: Extract<Expr, { kind: "call" }>,
  ): boolean {
    if (!this.source) {
      return false;
    }
    const spans: Array<[number, number]> = [];
    if (expr.arguments.length === 0) {
      spans.push([expr.callee.span.end, expr.span.end]);
    } else {
      spans.push([expr.callee.span.end, expr.arguments[0].span.start]);
      for (let index = 1; index < expr.arguments.length; index++) {
        const prev = expr.arguments[index - 1];
        const current = expr.arguments[index];
        spans.push([prev.span.end, current.span.start]);
      }
      const lastArgument = expr.arguments[expr.arguments.length - 1];
      spans.push([lastArgument.span.end, expr.span.end]);
    }

    return spans.some(([start, end]) =>
      /\r?\n/.test(this.source.slice(start, end))
    );
  }

  private hasTopLevelConstructorNewline(
    expr: Extract<Expr, { kind: "constructor" }>,
  ): boolean {
    if (!this.source) {
      return false;
    }
    if (expr.args.length === 0) {
      return false;
    }
    const spans: Array<[number, number]> = [];
    spans.push([expr.span.start, expr.args[0].span.start]);
    for (let index = 1; index < expr.args.length; index++) {
      const prev = expr.args[index - 1];
      const current = expr.args[index];
      spans.push([prev.span.end, current.span.start]);
    }
    const lastArgument = expr.args[expr.args.length - 1];
    spans.push([lastArgument.span.end, expr.span.end]);

    return spans.some(([start, end]) =>
      /\r?\n/.test(this.source.slice(start, end))
    );
  }

  private isInlineBlockArgument(expr: Expr): boolean {
    if (expr.kind === "arrow") {
      return true;
    }
    if (expr.kind === "block") {
      return true;
    }
    return false;
  }

  private normalizeNewlines(text: string): string {
    const withoutCR = text.replace(/\r/g, "");
    return this.newline === "\n"
      ? withoutCR
      : withoutCR.replace(/\n/g, this.newline);
  }

  private formatBinary(expr: Extract<Expr, { kind: "binary" }>): string {
    const left = this.formatExpr(expr.left);
    const right = this.formatExpr(expr.right);
    return `${left} ${expr.operator} ${right}`;
  }

  private formatCharLiteral(value: string): string {
    let escaped: string;
    switch (value) {
      case "'":
        escaped = "\\'";
        break;
      case "\\":
        escaped = "\\\\";
        break;
      case "\n":
        escaped = "\\n";
        break;
      case "\r":
        escaped = "\\r";
        break;
      case "\t":
        escaped = "\\t";
        break;
      case "\0":
        escaped = "\\0";
        break;
      default:
        escaped = value;
        break;
    }
    return `'${escaped}'`;
  }

  private indentStr(): string {
    return this.indentStrForLevel(this.indent);
  }

  private indentStrForLevel(level: number): string {
    return " ".repeat(level * this.options.indentSize);
  }

  private indentMultiline(text: string, indent: string): string {
    const lines = text.split("\n");
    return lines.map((line) => line.length === 0 ? indent : `${indent}${line}`)
      .join("\n");
  }

  private indentFirstLine(text: string, indent: string): string {
    const lines = text.split("\n");
    if (lines.length === 0) {
      return indent;
    }
    lines[0] = indent + lines[0];
    return lines.join("\n");
  }

  private computeAbsoluteIndent(position: number): number | null {
    if (!this.source || position <= 0) {
      return null;
    }
    let lineStart = position - 1;
    while (lineStart >= 0) {
      const ch = this.source[lineStart];
      if (ch === "\n") {
        lineStart++;
        break;
      }
      lineStart--;
    }
    if (lineStart < 0) {
      lineStart = 0;
    }
    let count = 0;
    while (
      lineStart + count < this.source.length &&
      this.source[lineStart + count] === " "
    ) {
      count++;
    }
    return count;
  }

  private normalizeIndent(text: string): string {
    const lines = text.split("\n");
    let minIndent = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) {
        continue;
      }
      if (line[0] !== " ") {
        continue;
      }
      let count = 0;
      while (count < line.length && line[count] === " ") {
        count++;
      }
      minIndent = Math.min(minIndent, count);
      if (minIndent === 0) {
        break;
      }
    }
    if (!isFinite(minIndent) || minIndent === 0) {
      return text;
    }
    const strip = " ".repeat(minIndent);
    const normalized = lines.map((line, index) => {
      if (index === 0) {
        return line;
      }
      return line.startsWith(strip) ? line.slice(minIndent) : line;
    });
    return normalized.join("\n");
  }

  private hasBlankLineBetween(start: number, end: number): boolean {
    if (!this.source || end <= start) {
      return false;
    }
    const between = this.source.slice(start, end);
    return /\r?\n\s*\r?\n/.test(between);
  }

  private stripBaseIndent(text: string, baseIndent: string): string {
    if (!text.includes("\n") || baseIndent.length === 0) {
      return text;
    }
    const lines = text.split("\n");
    const stripped = lines.map((line) =>
      line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line
    );
    return stripped.join("\n");
  }

  private matchBundleIsMultiLine(bundle: MatchBundle): boolean {
    if (!this.source) {
      return false;
    }
    const text = this.source.slice(bundle.span.start, bundle.span.end);
    return text.includes("\n");
  }
}

function stripWhitespace(text: string): string {
  // Remove all whitespace characters (spaces, tabs, newlines, carriage returns)
  return text.replace(/[\s\r\n\t]+/g, "");
}

function verifyOnlyWhitespaceChanged(
  original: string,
  formatted: string,
  filePath: string,
): boolean {
  const originalStripped = stripWhitespace(original);
  const formattedStripped = stripWhitespace(formatted);

  if (originalStripped !== formattedStripped) {
    console.error(`\n❌ FORMATTER ERROR in ${filePath}!`);
    console.error(`The formatter would change non-whitespace characters.`);

    // Find first difference
    const minLen = Math.min(originalStripped.length, formattedStripped.length);
    for (let i = 0; i < minLen; i++) {
      if (originalStripped[i] !== formattedStripped[i]) {
        console.error(`\nFirst difference at position ${i}:`);
        console.error(
          `  Original : ...${
            originalStripped.slice(Math.max(0, i - 20), i + 20)
          }...`,
        );
        console.error(
          `  Formatted: ...${
            formattedStripped.slice(Math.max(0, i - 20), i + 20)
          }...`,
        );
        break;
      }
    }
    console.error(
      `\nLength: original=${originalStripped.length}, formatted=${formattedStripped.length}`,
    );

    console.error(
      `\nAborting to prevent data loss. The file was not modified.`,
    );
    return false;
  }
  return true;
}

async function formatFile(
  filePath: string,
  options: FormatOptions,
): Promise<boolean> {
  let source: string;
  const overrideSource = options.sourceOverrides?.get(filePath);
  if (overrideSource !== undefined) {
    source = overrideSource;
  } else {
    try {
      source = await Deno.readTextFile(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`File not found: ${filePath}`);
        return false;
      }
      throw error;
    }
  }

  try {
    let operators: Map<string, OperatorInfo> = new Map();
    let prefixOperators: Set<string> = new Set();
    try {
      const env = await computeOperatorEnvironment(
        filePath,
        options.sourceOverrides,
      );
      operators = env.operators;
      prefixOperators = env.prefixOperators;
    } catch (error) {
      console.warn(
        `Warning: failed to compute operator environment for ${filePath}, falling back to built-in defaults: ${error}`,
      );
    }
    const tokens = lex(source, filePath);
    const program = parseSurfaceProgram(
      tokens,
      source,
      true,
      operators,
      prefixOperators,
    ); // preserveComments = true for formatter

    const formatter = new Formatter(options, source);
    const formatted = formatter.format(program);

    if (!verifyOnlyWhitespaceChanged(source, formatted, filePath)) {
      return false;
    }

    if (options.doubleCheck) {
      const tokensSecond = lex(formatted, filePath);
      const programSecond = parseSurfaceProgram(
        tokensSecond,
        formatted,
        true,
        operators,
        prefixOperators,
      );
      const formatterSecond = new Formatter(options, formatted);
      const formattedTwice = formatterSecond.format(programSecond);
      if (formattedTwice !== formatted) {
        console.error(
          `${filePath} failed doublecheck (formatter drift detected)`,
        );
        printDiffSnippets(filePath, formatted, formattedTwice);
        return false;
      }
    }

    const changed = source !== formatted;
    switch (options.mode) {
      case "check":
        if (changed) {
          console.error(`${filePath} is not formatted`);
          printDiffSnippets(filePath, source, formatted);
          return false;
        }
        return true;
      case "check-full":
        if (changed) {
          console.error(`${filePath} is not formatted`);
          printFullFormattedFile(filePath, formatted);
          return false;
        }
        return true;
      case "stdout":
        if (options.outputPath) {
          await Deno.writeTextFile(options.outputPath, formatted);
        } else {
          console.log(formatted);
        }
        return true;
      case "write":
      default:
        await Deno.writeTextFile(filePath, formatted);
        console.log(`Formatted ${filePath}`);
        return true;
    }
  } catch (error) {
    if (error instanceof WorkmanError) {
      // Use the formatted error message with source context
      const formatted = error.format(source);
      console.error(`Error formatting ${filePath}:\n${formatted}`);
      return false;
    } else {
      console.error(`Error formatting ${filePath}: ${error}`);
      return false;
    }
  }
}

async function collectWmFiles(path: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const stat = await Deno.stat(path);

    if (stat.isFile) {
      if (path.endsWith(".wm")) {
        files.push(path);
      }
      return files;
    }

    if (stat.isDirectory) {
      for await (const entry of Deno.readDir(path)) {
        const fullPath = `${path}/${entry.name}`;
        if (entry.isFile && entry.name.endsWith(".wm")) {
          files.push(fullPath);
        } else if (entry.isDirectory && !entry.name.startsWith(".")) {
          // Recursively collect from subdirectories (skip hidden dirs)
          const subFiles = await collectWmFiles(fullPath);
          files.push(...subFiles);
        }
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`Path not found: ${path}`);
      Deno.exit(1);
    }
    throw error;
  }

  return files;
}

export async function runFormatter(args: string[]): Promise<void> {
  if (args.length === 0) {
    printFormatterUsage();
    Deno.exit(1);
  }

  let mode: FormatOptions["mode"] = "write";
  let doubleCheck = false;
  const paths: string[] = [];
  let stdinFilePath: string | null = null;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check" || arg === "--check-full") {
      if (mode !== "write") {
        console.error("Only one of --check or --check-full may be provided.");
        Deno.exit(1);
      }
      mode = arg === "--check" ? "check" : "check-full";
      continue;
    }
    if (arg === "--doublecheck") {
      doubleCheck = true;
      continue;
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      if (outputPath !== null) {
        console.error("Only one --output may be provided.");
        Deno.exit(1);
      }
      if (arg === "--output") {
        const next = args[i + 1];
        if (!next) {
          console.error("--output requires a path argument.");
          Deno.exit(1);
        }
        outputPath = next;
        i++;
      } else {
        outputPath = arg.slice("--output=".length);
        if (!outputPath) {
          console.error("--output requires a non-empty path.");
          Deno.exit(1);
        }
      }
      continue;
    }
    if (arg === "--stdin-filepath" || arg.startsWith("--stdin-filepath=")) {
      if (stdinFilePath !== null) {
        console.error("Only one --stdin-filepath may be provided.");
        Deno.exit(1);
      }
      if (arg === "--stdin-filepath") {
        const next = args[i + 1];
        if (!next) {
          console.error("--stdin-filepath requires a path argument.");
          Deno.exit(1);
        }
        stdinFilePath = next;
        i++;
      } else {
        stdinFilePath = arg.slice("--stdin-filepath=".length);
        if (!stdinFilePath) {
          console.error("--stdin-filepath requires a non-empty path.");
          Deno.exit(1);
        }
      }
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
      printFormatterUsage();
      Deno.exit(1);
    }
    paths.push(arg);
  }

  if (stdinFilePath) {
    if (mode !== "write") {
      console.error("--stdin-filepath cannot be combined with check modes.");
      Deno.exit(1);
    }
    if (outputPath) {
      outputPath = resolve(outputPath);
    }
    const entryPath = normalizeEntryPath(stdinFilePath);
    const stdinText = await new Response(Deno.stdin.readable).text();
    const sourceOverrides = new Map<string, string>([[entryPath, stdinText]]);
    const stdinOptions: FormatOptions = {
      indentSize: 2,
      mode: "stdout",
      doubleCheck,
      sourceOverrides,
      outputPath: outputPath ?? undefined,
    };
    const success = await formatFile(entryPath, stdinOptions);
    if (!success) {
      Deno.exit(1);
    }
    return;
  }

  if (paths.length === 0) {
    printFormatterUsage();
    Deno.exit(1);
  }

  if (outputPath !== null) {
    console.error("--output is only supported with --stdin-filepath.");
    Deno.exit(1);
  }

  if (doubleCheck && mode === "write") {
    mode = "check";
  }

  const options: FormatOptions = {
    indentSize: 2,
    mode,
    doubleCheck,
  };

  // Collect all .wm files from paths (files or directories)
  const allFiles: string[] = [];
  for (const path of paths) {
    const files = await collectWmFiles(path);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    console.error("No .wm files found");
    Deno.exit(1);
  }

  // Format all files and track results
  let successCount = 0;
  let failCount = 0;

  for (const file of allFiles) {
    const success = await formatFile(file, options);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Exit with error if any files failed (in check mode or had errors)
  if (failCount > 0) {
    console.error(
      `\n${failCount} file(s) failed, ${successCount} file(s) succeeded`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await runFormatter(Deno.args);
}

function printFormatterUsage(): void {
  console.error(
    "Usage: wm fmt [--check|--check-full] [--doublecheck] <file.wm|directory> [<file2.wm> ...] | wm fmt --stdin-filepath <file.wm> [--output <path>]",
  );
}

function normalizeEntryPath(path: string): string {
  const normalized = isAbsolute(path) ? path : resolve(path);
  if (normalized.toLowerCase().endsWith(".wm")) {
    return normalized;
  }
  return `${normalized}.wm`;
}

function printDiffSnippets(
  filePath: string,
  original: string,
  formatted: string,
) {
  const originalLines = original.split(/\r?\n/);
  const formattedLines = formatted.split(/\r?\n/);

  let prefix = 0;
  while (
    prefix < originalLines.length && prefix < formattedLines.length &&
    originalLines[prefix] === formattedLines[prefix]
  ) {
    prefix++;
  }

  if (prefix === originalLines.length && prefix === formattedLines.length) {
    return;
  }

  let suffixOriginal = originalLines.length - 1;
  let suffixFormatted = formattedLines.length - 1;
  while (
    suffixOriginal >= prefix && suffixFormatted >= prefix &&
    originalLines[suffixOriginal] === formattedLines[suffixFormatted]
  ) {
    suffixOriginal--;
    suffixFormatted--;
  }

  const blockStart = prefix + 1;
  console.error(`--- ${filePath}:${blockStart}`);

  for (let i = prefix; i <= suffixOriginal; i++) {
    if (i < originalLines.length) {
      console.error(`- ${i + 1}| ${originalLines[i]}`);
    }
  }
  for (let j = prefix; j <= suffixFormatted; j++) {
    if (j < formattedLines.length) {
      console.error(`+ ${j + 1}| ${formattedLines[j]}`);
    }
  }
  console.error("");
}

function printFullFormattedFile(filePath: string, formatted: string) {
  console.error(`+++ ${filePath} (formatted output) +++`);
  console.error(formatted);
}
