#!/usr/bin/env -S deno run --allow-read --allow-write

import { lex } from "../src/lexer.ts";
import {
  parseSurfaceProgram,
  type OperatorInfo,
} from "../src/parser.ts";
import { WorkmanError } from "../src/error.ts";
import { loadModuleGraph } from "../src/module_loader.ts";
import type {
  BlockExpr,
  BlockStatement,
  CommentBlock,
  Expr,
  ImportSpecifier,
  LetDeclaration,
  MatchArm,
  MatchBundle,
  ModuleImport,
  ModuleReexport,
  Parameter,
  Pattern,
  Program,
  TypeDeclaration,
  TypeReexport,
  InfixDeclaration,
  PrefixDeclaration,
  InfectiousDeclaration,
  TypeExpr,
} from "../src/ast.ts";

type Declaration = import("../src/ast.ts").TopLevel;

interface FormatOptions {
  indentSize: number;
  check: boolean;
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
): Promise<{
  operators: Map<string, OperatorInfo>;
  prefixOperators: Set<string>;
}> {
  const graph = await loadModuleGraph(entryPath, { skipEvaluation: true });
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

  constructor(options: FormatOptions, source: string) {
    this.options = options;
    this.source = source;
  }

  format(program: Program): string {
    const parts: string[] = [];

    // Format imports
    for (const imp of program.imports) {
      if (
        imp.hasBlankLineBefore &&
        (parts.length === 0 || parts[parts.length - 1] !== "")
      ) {
        parts.push("");
      }
      parts.push(this.formatImport(imp));
    }

    // Format reexports
    for (const reexp of program.reexports) {
      if (
        reexp.hasBlankLineBefore &&
        (parts.length === 0 || parts[parts.length - 1] !== "")
      ) {
        parts.push("");
      }
      parts.push(this.formatReexport(reexp));
    }

    // Add blank line after imports/reexports if there are declarations
    if (
      (program.imports.length > 0 || program.reexports.length > 0) &&
      program.declarations.length > 0
    ) {
      parts.push("");
    }

    // Format declarations
    for (let i = 0; i < program.declarations.length; i++) {
      const decl = program.declarations[i];

      // Add blank line before this declaration if it had one originally
      if (i > 0 && decl.hasBlankLineBefore) {
        parts.push("");
      }

      parts.push(this.formatDeclaration(decl));
    }

    if (
      program.trailingComments && program.trailingComments.length > 0
    ) {
      if (parts.length > 0 && parts[parts.length - 1] !== "") {
        parts.push("");
      }
      for (const comment of program.trailingComments) {
        parts.push(`-- ${comment.text}`);
        if (comment.hasBlankLineAfter) {
          parts.push("");
        }
      }
    }

    const formatted = parts.join("\n") + "\n";

    // Collapse multiple consecutive empty lines to single empty line
    return formatted.replace(/\n\n\n+/g, "\n\n");
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
        result += `-- ${commentBlock}\n`;
        continue;
      }
      result += `-- ${commentBlock.text}\n`;
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
    result +=
      `from "${imp.source}" import { ${specs} }${this.formatTerminator(imp)}`;
    if (imp.trailingComment) {
      result += ` -- ${imp.trailingComment}`;
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
    result +=
      `export from "${reexp.source}" type ${types}${this.formatTerminator(reexp)}`;
    if (reexp.trailingComment) {
      result += ` -- ${reexp.trailingComment}`;
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

    switch (decl.kind) {
      case "let":
        result += this.formatLetDeclaration(decl as LetDeclaration);
        break;
      case "type":
        result += this.formatTypeDeclaration(decl as TypeDeclaration);
        break;
      case "infix":
        result += this.formatInfixDeclaration(decl as InfixDeclaration);
        break;
      case "prefix":
        result += this.formatPrefixDeclaration(decl as PrefixDeclaration);
        break;
      case "infectious":
        result += this.formatInfectiousDeclaration(decl as InfectiousDeclaration);
        break;
      default:
        break;
    }

    // Add trailing comment on same line
    if (decl.trailingComment) {
      result += ` -- ${decl.trailingComment}`;
    }

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
      result =
        `${exportPrefix}let ${recPrefix}${decl.name}${annotationSuffix} = ${formattedMatch}${semicolon}`;
    } else if (decl.parameters.length > 0 || decl.isArrowSyntax) {
      // If there are parameters OR originally used arrow syntax, format as arrow function
      const paramsStr = this.formatParameterList(decl.parameters);
      const body = this.formatBlock(decl.body, false, true);
      result =
        `${exportPrefix}let ${recPrefix}${decl.name}${annotationSuffix} = ${paramsStr} => ${body}${semicolon}`;
    } else {
      // No parameters and not arrow syntax - format body directly
      const body = this.formatBlockForLet(decl.body);

      if (body.startsWith("\n")) {
        // Body is already formatted with leading newline
        result =
          `${exportPrefix}let ${recPrefix}${decl.name}${annotationSuffix} =${body}${semicolon}`;
      } else {
        result =
          `${exportPrefix}let ${recPrefix}${decl.name}${annotationSuffix} = ${body}${semicolon}`;
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
          result +=
            `\nand ${mutual.name}${mutualAnnotation} = ${formattedMatch};`;
        } else if (mutual.parameters.length > 0 || mutual.isArrowSyntax) {
          const mutualParamsStr = this.formatParameterList(mutual.parameters);
          const mutualAnnotation = mutual.annotation
            ? `: ${this.formatTypeExpr(mutual.annotation)}`
            : "";
          const mutualBody = this.formatBlock(mutual.body, false, true);
          result +=
            `\nand ${mutual.name}${mutualAnnotation} = ${mutualParamsStr} => ${mutualBody};`;
        } else {
          const mutualBody = this.formatBlockForLet(mutual.body);
          const mutualAnnotation = mutual.annotation
            ? `: ${this.formatTypeExpr(mutual.annotation)}`
            : "";
          if (mutualBody.startsWith("\n")) {
            result += `\nand ${mutual.name}${mutualAnnotation} =${mutualBody};`;
          } else {
            result += `\nand ${mutual.name}${mutualAnnotation} = ${mutualBody};`;
          }
        }
      }
    }

    return result;
  }

  private formatBlockForLet(block: BlockExpr): string {
    if (this.blockHasComments(block)) {
      return this.source.slice(block.span.start, block.span.end);
    }
    // Single expression block
    if (block.statements.length === 0 && block.result) {
      // Special case: if the result is an arrow function, preserve the arrow syntax
      if (block.result.kind === "arrow") {
        return this.formatExpr(block.result);
      }

      let expr = this.formatExpr(block.result);
      if (block.resultTrailingComment) {
        expr += ` -- ${block.resultTrailingComment}`;
      }
      if (block.isMultiLine) {
        this.indent++;
        const indentedExpr = expr.split("\n").map((line) =>
          this.indentStr() + line
        ).join("\n");
        this.indent--;
        return `{\n${indentedExpr}\n${this.indentStr()}}`;
      }
      return expr;
    }

    // Multi-statement block
    const parts: string[] = [];
    this.indent++;

    for (const stmt of block.statements) {
      parts.push(this.indentStr() + this.formatBlockStatement(stmt));
    }

    if (block.result) {
      let resultLine = this.indentStr() + this.formatExpr(block.result);
      if (block.resultTrailingComment) {
        resultLine += ` -- ${block.resultTrailingComment}`;
      }
      parts.push(resultLine);
      if (block.resultCommentStatements) {
        for (const comment of block.resultCommentStatements) {
          parts.push(`${this.indentStr()}-- ${comment.text}`);
          if (comment.hasBlankLineAfter) {
            parts.push("");
          }
        }
      }
    }

    this.indent--;
    return `{\n${parts.join("\n")}\n${this.indentStr()}}`;
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
    const aliasMember = decl.members.length === 1 && decl.members[0].kind === "alias"
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
      lines[lines.length - 1] =
        `${lines[lines.length - 1]}${this.formatTerminator(decl)}`;
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
        const params = typeExpr.parameters.map((p) =>
          this.formatTypeExpr(p)
        ).join(", ");
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
    multiline: boolean = true,
    keepBraces: boolean = false,
  ): string {
    if (this.blockHasComments(block)) {
      return this.source.slice(block.span.start, block.span.end);
    }
    // Single expression block
    if (block.statements.length === 0 && block.result) {
      const expr = this.formatExpr(block.result);
      // Don't wrap simple expressions in extra braces unless keepBraces is true
      if (this.isSimpleExpr(block.result) && !keepBraces) {
        return expr;
      }

      // When keepBraces is true (arrow functions), always use multiline format
      // to preserve the original multi-line style and prevent multiple { on same line
      if (keepBraces) {
        this.indent++;
        const indentedExpr = expr.split("\n").map((line) =>
          this.indentStr() + line
        ).join("\n");
        this.indent--;
        return `{\n${indentedExpr}\n${this.indentStr()}}`;
      }

      // If the expression is multiline OR contains braces, format with proper indentation
      // This prevents multiple { on the same line
      if (expr.includes("\n") || expr.includes("{")) {
        this.indent++;
        const indentedExpr = expr.split("\n").map((line) =>
          this.indentStr() + line
        ).join("\n");
        this.indent--;
        return `{\n${indentedExpr}\n${this.indentStr()}}`;
      }
      return `{ ${expr} }`;
    }

    // Multi-statement block - always use multiple lines
    const parts: string[] = ["{"];
    this.indent++;

    for (const stmt of block.statements) {
      if (stmt.kind === "comment_statement") {
        parts.push(`${this.indentStr()}-- ${stmt.text}`);
        if (stmt.hasBlankLineAfter) {
          parts.push("");
        }
        continue;
      }
      parts.push(this.indentStr() + this.formatBlockStatement(stmt));
    }

    if (block.result) {
      parts.push(this.indentStr() + this.formatExpr(block.result));
    }

    this.indent--;
    parts.push(this.indentStr() + "}");

    return parts.join("\n");
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
          const line =
            `let ${recPrefix}${decl.name}${annotationSuffix} = ${formattedMatch};`;
          return decl.trailingComment ? `${line} -- ${decl.trailingComment}` : line;
        }

        // Use same logic as top-level let declarations
        if (decl.parameters.length > 0 || decl.isArrowSyntax) {
          const paramsStr = this.formatParameterList(decl.parameters);
          const body = this.formatBlock(decl.body, false, true);
          const line =
            `let ${recPrefix}${decl.name}${annotationSuffix} = ${paramsStr} => ${body};`;
          return decl.trailingComment ? `${line} -- ${decl.trailingComment}` : line;
        }

        // Simple let binding
        const body = this.formatBlockForLet(decl.body);
        if (body.startsWith("\n")) {
          const line =
            `let ${recPrefix}${decl.name}${annotationSuffix} =${body};`;
          return decl.trailingComment ? `${line} -- ${decl.trailingComment}` : line;
        } else {
          const line =
            `let ${recPrefix}${decl.name}${annotationSuffix} = ${body};`;
          return decl.trailingComment ? `${line} -- ${decl.trailingComment}` : line;
        }
      }
      case "expr_statement":
        let exprLine = this.formatExpr(stmt.expression) + ";";
        if (stmt.trailingComment) {
          exprLine += ` -- ${stmt.trailingComment}`;
        }
        return exprLine;
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
    switch (expr.kind) {
      case "identifier":
        return expr.name;
      case "literal":
        return this.formatLiteral(expr.literal);
      case "constructor":
        if (expr.args.length === 0) {
          return expr.name;
        }
        return `${expr.name}(${
          expr.args.map((a) => this.formatExpr(a)).join(", ")
        })`;
      case "record_literal":
        return this.formatRecordLiteral(expr);
      case "tuple":
        // Check if tuple should be formatted multi-line
        if (expr.isMultiLine && expr.elements.length > 1) {
          const formattedElements = expr.elements.map((e) =>
            this.formatExpr(e)
          );
          this.indent++;
          const indentedElements = formattedElements.map((el) =>
            `${this.indentStr()}${el}`
          ).join(",\n");
          this.indent--;
          return `(\n${indentedElements}\n${this.indentStr()})`;
        }
        return `(${expr.elements.map((e) => this.formatExpr(e)).join(", ")})`;
      case "call":
        return this.formatCall(expr);
      case "record_projection":
        return `${this.formatExpr(expr.target)}.${expr.field}`;
      case "binary":
        return this.formatBinary(expr);
      case "unary":
        return `${expr.operator}${this.formatExpr(expr.operand)}`;
      case "arrow":
        const params = expr.parameters.map((p) => p.name || "_").join(", ");
        // Always use parentheses for consistency
        const paramsStr = `(${params})`;
        const body = this.formatBlock(expr.body, false, true);
        return `${paramsStr} => ${body}`;
      case "block":
        return this.formatBlock(expr);
      case "match":
        return this.formatMatch(expr.scrutinee, expr.bundle);
      case "match_fn":
        return this.formatMatchFn(expr.parameters, expr.bundle);
      case "match_bundle_literal":
        return this.formatMatchBundleLiteral(expr.bundle);
      case "hole":
        return "?";
      default:
        return "???";
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
      if (ch === "\"" || ch === "'") {
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
        case "\"":
          escaped += "\\\"";
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
      const block = expr;
      if (this.blockHasComments(block)) {
        return this.source.slice(block.span.start, block.span.end);
      }
      // Single expression block
      if (block.statements.length === 0 && block.result) {
        // If the result contains braces (like a match or block), use multi-line format
        // to avoid double {{ on the same line
      if (block.result.kind === "match" || block.result.kind === "block") {
        // Format the expression at the next indent level
        this.indent++;
        const resultExpr = this.formatExpr(block.result);
        // Add indentation to the first line (match keyword line)
        const lines = resultExpr.split("\n");
        const indentedFirst = this.indentStr() + lines[0];
        const rest = lines.slice(1);
        this.indent--;
        const commentSuffix = block.resultTrailingComment
          ? ` -- ${block.resultTrailingComment}`
          : "";
        return `{\n${indentedFirst}\n${
          rest.join("\n")
        }\n${this.indentStr()}}${commentSuffix}`;
      }

      const resultExpr = this.formatExpr(block.result);
      const commentSuffix = block.resultTrailingComment
        ? ` -- ${block.resultTrailingComment}`
        : "";
      return `{ ${resultExpr}${commentSuffix} }`;
    }
      // Multi-statement block
      return this.formatBlock(block);
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
    const hasStatements = block.statements.some((stmt) =>
      stmt.kind === "comment_statement"
    );
    return hasStatements ||
      Boolean(block.resultTrailingComment) ||
      Boolean(block.resultCommentStatements);
  }

  private formatMatchArmContent(arm: MatchArm): string | null {
    if (arm.kind === "comment_statement") {
      return null;
    }
    if (arm.kind === "match_bundle_reference") {
      let text = arm.name;
      if (arm.trailingComment) {
        text += ` -- ${arm.trailingComment}`;
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
      text += ` -- ${arm.trailingComment}`;
    }
    if (arm.hasTrailingComma) {
      text += ",";
    }
    return text;
  }

  private formatMatchArmsMultiline(arms: MatchArm[]): string[] {
    const lines: string[] = [];
    for (const arm of arms) {
      if (arm.kind === "comment_statement") {
        lines.push(`${this.indentStr()}-- ${arm.text}`);
        if (arm.hasBlankLineAfter) {
          lines.push("");
        }
        continue;
      }
      const content = this.formatMatchArmContent(arm);
      if (content !== null) {
        lines.push(`${this.indentStr()}${content}`);
      }
    }
    return lines;
  }

  private formatMatch(
    scrutinee: Expr,
    bundle: MatchBundle,
    forceMultiLine: boolean = false,
  ): string {
    const scrutineeStr = this.formatMatchScrutineeExpr(scrutinee);
    const arms = bundle.arms;

    let inlineArm: string | null = null;
    if (arms.length === 1) {
      inlineArm = this.formatMatchArmContent(arms[0]);
    }
    const inlineMatch = inlineArm !== null
      ? `match(${scrutineeStr}) { ${inlineArm} }`
      : "";

    if (
      forceMultiLine || inlineArm === null || inlineMatch.length > 60 ||
      arms.length > 1
    ) {
      this.indent++;
      const armsParts = this.formatMatchArmsMultiline(arms);
      this.indent--;
      return `match(${scrutineeStr}) {\n${
        armsParts.join("\n")
      }\n${this.indentStr()}}`;
    }

    return inlineMatch;
  }

  private formatMatchFn(params: Expr[], bundle: MatchBundle): string {
    const arms = bundle.arms;
    const paramExpr = params.length === 1
      ? this.formatExpr(params[0])
      : params.map((p) => this.formatExpr(p)).join(", ");
    let inlineArm: string | null = null;
    if (arms.length === 1) {
      inlineArm = this.formatMatchArmContent(arms[0]);
    }
    const inlineFn = inlineArm !== null
      ? `match(${paramExpr}) { ${inlineArm} }`
      : "";

    if (inlineFn.length > 80 || arms.length > 2 || inlineArm === null) {
      this.indent++;
      const armsParts = this.formatMatchArmsMultiline(arms);
      this.indent--;
      return `match(${paramExpr}) {\n${armsParts.join("\n")}\n${
        this.indentStr()
      }}`;
    }

    return inlineFn;
  }

  private formatPattern(pattern: Pattern): string {
    switch (pattern.kind) {
      case "wildcard":
        return "_";
      case "variable":
        return pattern.name;
      case "literal":
        return this.formatLiteral(pattern.literal);
      case "tuple":
        return `(${
          pattern.elements.map((e) => this.formatPattern(e)).join(", ")
        })`;
      case "constructor":
        if (pattern.args.length === 0) {
          return pattern.name;
        }
        return `${pattern.name}(${
          pattern.args.map((a) => this.formatPattern(a)).join(", ")
        })`;
      case "all_errors":
        return "AllErrors";
      default:
        return "???";
    }
  }

  private formatMatchBundleLiteral(bundle: MatchBundle): string {
    const arms = bundle.arms;
    let inlineArm: string | null = null;
    if (arms.length === 1) {
      inlineArm = this.formatMatchArmContent(arms[0]);
    }
    const inline = inlineArm !== null ? `match { ${inlineArm} }` : "";
    if (inline.length <= 60 && arms.length <= 1 && inlineArm !== null) {
      return inline;
    }

    this.indent++;
    const parts = this.formatMatchArmsMultiline(arms);
    this.indent--;
    return `match {\n${parts.join("\n")}\n${this.indentStr()}}`;
  }

  private formatRecordLiteral(expr: Extract<Expr, { kind: "record_literal" }>): string {
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
    const args = expr.arguments.map((a) => this.formatExpr(a));
    if (args.length === 0) {
      return `${callee}()`;
    }
    if (this.shouldFormatCallMultiline(expr, args)) {
      this.indent++;
      const lines = args.map((arg, index) => {
        const comma = index < args.length - 1 ? "," : "";
        return `${this.indentStr()}${arg}${comma}`;
      });
      this.indent--;
      return `${callee}(\n${lines.join("\n")}\n${this.indentStr()})`;
    }
    return `${callee}(${args.join(", ")})`;
  }

  private shouldFormatCallMultiline(
    expr: Extract<Expr, { kind: "call" }>,
    formattedArgs: string[],
  ): boolean {
    if (formattedArgs.some((arg) => arg.includes("\n"))) {
      return true;
    }
    if (!this.source) {
      return false;
    }
    const slice = this.source.slice(expr.callee.span.end, expr.span.end);
    return slice.includes("\n");
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
    return " ".repeat(this.indent * this.options.indentSize);
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
  try {
    source = await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`File not found: ${filePath}`);
      return false;
    }
    throw error;
  }

  try {
    let operators: Map<string, OperatorInfo> = new Map();
    let prefixOperators: Set<string> = new Set();
    try {
      const env = await computeOperatorEnvironment(filePath);
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

    const skipVerification = Deno.env.get("WM_FMT_SKIP_VERIFY") === "1";
    if (
      !skipVerification &&
      !verifyOnlyWhitespaceChanged(source, formatted, filePath)
    ) {
      return false;
    }

    if (options.check) {
      if (source !== formatted) {
        console.error(`${filePath} is not formatted`);
        return false;
      }
      return true;
    } else {
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
    console.error(
      "Usage: wm fmt [--check] <file.wm|directory> [<file2.wm> ...]",
    );
    Deno.exit(1);
  }

  const check = args[0] === "--check";
  const paths = check ? args.slice(1) : args;

  if (paths.length === 0) {
    console.error(
      "Usage: wm fmt [--check] <file.wm|directory> [<file2.wm> ...]",
    );
    Deno.exit(1);
  }

  const options: FormatOptions = {
    indentSize: 2,
    check,
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
