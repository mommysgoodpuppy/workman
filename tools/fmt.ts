#!/usr/bin/env -S deno run --allow-read --allow-write

import { lex } from "../src/lexer.ts";
import { ParseError, parseSurfaceProgram } from "../src/parser.ts";
import { LexError, WorkmanError } from "../src/error.ts";
import type {
  BlockExpr,
  BlockStatement,
  Declaration,
  Expr,
  ImportSpecifier,
  LetDeclaration,
  MatchArm,
  ModuleImport,
  ModuleReexport,
  Pattern,
  Program,
  TypeDeclaration,
  TypeReexport,
} from "../src/ast.ts";

interface FormatOptions {
  indentSize: number;
  check: boolean;
}

class Formatter {
  private options: FormatOptions;
  private indent: number = 0;

  constructor(options: FormatOptions) {
    this.options = options;
  }

  format(program: Program): string {
    const parts: string[] = [];

    // Format imports
    for (const imp of program.imports) {
      parts.push(this.formatImport(imp));
    }

    // Format reexports
    for (const reexp of program.reexports) {
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

    const formatted = parts.join("\n") + "\n";

    // Collapse multiple consecutive empty lines to single empty line
    return formatted.replace(/\n\n\n+/g, "\n\n");
  }

  private formatImport(imp: ModuleImport): string {
    const specs = imp.specifiers.map((s) => this.formatImportSpecifier(s)).join(
      ", ",
    );
    return `from "${imp.source}" import { ${specs} };`;
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
    return `export from "${reexp.source}" type ${types};`;
  }

  private formatTypeReexport(typeExp: TypeReexport): string {
    return typeExp.exportConstructors ? `${typeExp.name}(..)` : typeExp.name;
  }

  private formatDeclaration(decl: Declaration): string {
    let result = "";

    // Add leading comments
    if (decl.leadingComments && decl.leadingComments.length > 0) {
      for (const commentBlock of decl.leadingComments) {
        // Handle both old string format and new CommentBlock format
        const commentText = typeof commentBlock === "string"
          ? commentBlock
          : commentBlock.text;
        const hasBlankLineAfter = typeof commentBlock === "object" &&
          commentBlock.hasBlankLineAfter;

        result += `-- ${commentText}\n`;

        // Add blank line after comment if needed
        if (hasBlankLineAfter) {
          result += "\n";
        }
      }
    }

    switch (decl.kind) {
      case "let":
        result += this.formatLetDeclaration(decl);
        break;
      case "type":
        result += this.formatTypeDeclaration(decl);
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

  private formatLetDeclaration(decl: LetDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const recPrefix = decl.isRecursive ? "rec " : "";

    let result: string;

    // Determine if we should add semicolon (not if there are mutual bindings)
    const hasMutualBindings = decl.mutualBindings &&
      decl.mutualBindings.length > 0;
    const semicolon = hasMutualBindings ? "" : ";";

    // If this was originally a first-class match, format it that way
    if (
      decl.isFirstClassMatch && decl.parameters.length === 1 &&
      decl.body.statements.length === 0 && decl.body.result?.kind === "match"
    ) {
      const matchExpr = decl.body.result;
      // Force multi-line if the body was originally multi-line
      const forceMultiLine = decl.body.isMultiLine === true;
      const formattedMatch = this.formatMatch(
        matchExpr.scrutinee,
        matchExpr.arms,
        forceMultiLine,
      );
      result =
        `${exportPrefix}let ${recPrefix}${decl.name} = ${formattedMatch}${semicolon}`;
    } else if (decl.parameters.length > 0 || decl.isArrowSyntax) {
      // If there are parameters OR originally used arrow syntax, format as arrow function
      const params = decl.parameters.map((p) => p.name || "_").join(", ");
      // Always use parentheses for consistency
      const paramsStr = `(${params})`;
      const body = this.formatBlock(decl.body, false, true);
      result =
        `${exportPrefix}let ${recPrefix}${decl.name} = ${paramsStr} => ${body}${semicolon}`;
    } else {
      // No parameters and not arrow syntax - format body directly
      const body = this.formatBlockForLet(decl.body);

      if (body.startsWith("\n")) {
        // Body is already formatted with leading newline
        result =
          `${exportPrefix}let ${recPrefix}${decl.name} =${body}${semicolon}`;
      } else {
        result =
          `${exportPrefix}let ${recPrefix}${decl.name} = ${body}${semicolon}`;
      }
    }

    // Format mutual bindings (applies to all cases)
    if (decl.mutualBindings && decl.mutualBindings.length > 0) {
      for (const mutual of decl.mutualBindings) {
        // Check if this is a first-class match
        if (
          mutual.isFirstClassMatch && mutual.parameters.length === 1 &&
          mutual.body.statements.length === 0 &&
          mutual.body.result?.kind === "match"
        ) {
          const matchExpr = mutual.body.result;
          const forceMultiLine = mutual.body.isMultiLine === true;
          const formattedMatch = this.formatMatch(
            matchExpr.scrutinee,
            matchExpr.arms,
            forceMultiLine,
          );
          result += `\nand ${mutual.name} = ${formattedMatch};`;
        } else if (mutual.parameters.length > 0 || mutual.isArrowSyntax) {
          const mutualParams = mutual.parameters.map((p) => p.name || "_").join(
            ", ",
          );
          const mutualParamsStr = `(${mutualParams})`;
          const mutualBody = this.formatBlock(mutual.body, false, true);
          result +=
            `\nand ${mutual.name} = ${mutualParamsStr} => ${mutualBody};`;
        } else {
          const mutualBody = this.formatBlockForLet(mutual.body);
          if (mutualBody.startsWith("\n")) {
            result += `\nand ${mutual.name} =${mutualBody};`;
          } else {
            result += `\nand ${mutual.name} = ${mutualBody};`;
          }
        }
      }
    }

    return result;
  }

  private formatBlockForLet(block: BlockExpr): string {
    // Single expression block
    if (block.statements.length === 0 && block.result) {
      // Special case: if the result is an arrow function, preserve the arrow syntax
      if (block.result.kind === "arrow") {
        return this.formatExpr(block.result);
      }

      const expr = this.formatExpr(block.result);

      // Simple expression - unwrap if possible (but only if not originally multi-line)
      if (this.isSimpleExpr(block.result) && !block.isMultiLine) {
        return expr;
      }

      // Check if the expression itself is multiline (like a match)
      if (expr.includes("\n")) {
        // Put opening brace on new line, indent content
        this.indent++;
        const indentedExpr = expr.split("\n").map((line) =>
          this.indentStr() + line
        ).join("\n");
        this.indent--;
        return `\n${this.indentStr()}{\n${indentedExpr}\n${this.indentStr()}}`;
      }

      // If the block was originally multi-line, preserve the braces
      if (block.isMultiLine) {
        return `{\n${this.indentStr()}  ${expr}\n${this.indentStr()}}`;
      }

      return `{ ${expr} }`;
    }

    // Multi-statement block
    const parts: string[] = [];
    this.indent++;

    for (const stmt of block.statements) {
      parts.push(this.indentStr() + this.formatBlockStatement(stmt));
    }

    if (block.result) {
      parts.push(this.indentStr() + this.formatExpr(block.result));
    }

    this.indent--;
    return `{\n${parts.join("\n")}\n${this.indentStr()}}`;
  }

  private formatTypeDeclaration(decl: TypeDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const typeParams = decl.typeParams.length > 0
      ? `<${decl.typeParams.map((p) => p.name).join(", ")}>`
      : "";
    const members = decl.members.map((m) => {
      if (m.kind === "alias") {
        return m.name;
      } else {
        const args = m.typeArgs.length > 0
          ? `<${m.typeArgs.map((a) => this.formatTypeExpr(a)).join(", ")}>`
          : "";
        return `${m.name}${args}`;
      }
    }).join(" | ");

    return `${exportPrefix}type ${decl.name}${typeParams} = ${members};`;
  }

  private formatTypeExpr(typeExpr: any): string {
    // Handle legacy string format
    if (typeof typeExpr === "string") {
      return typeExpr;
    }

    // Handle structured type expressions
    switch (typeExpr.kind) {
      case "type_var":
        return typeExpr.name;
      case "type_ref":
        if (typeExpr.typeArgs.length === 0) {
          return typeExpr.name;
        }
        return `${typeExpr.name}<${
          typeExpr.typeArgs.map((a: any) => this.formatTypeExpr(a)).join(", ")
        }>`;
      case "type_fn":
        const params = typeExpr.parameters.map((p: any) =>
          this.formatTypeExpr(p)
        ).join(", ");
        const result = this.formatTypeExpr(typeExpr.result);
        return `(${params}) -> ${result}`;
      case "type_tuple":
        return `(${
          typeExpr.elements.map((e: any) => this.formatTypeExpr(e)).join(", ")
        })`;
      case "type_unit":
        return "()";
      default:
        return "???";
    }
  }

  private formatBlock(
    block: BlockExpr,
    multiline: boolean = true,
    keepBraces: boolean = false,
  ): string {
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

        // If this was originally a first-class match, format it that way
        if (
          decl.isFirstClassMatch && decl.parameters.length === 1 &&
          decl.body.statements.length === 0 &&
          decl.body.result?.kind === "match"
        ) {
          const matchExpr = decl.body.result;
          const forceMultiLine = decl.body.isMultiLine === true;
          const formattedMatch = this.formatMatch(
            matchExpr.scrutinee,
            matchExpr.arms,
            forceMultiLine,
          );
          return `let ${recPrefix}${decl.name} = ${formattedMatch};`;
        }

        // Use same logic as top-level let declarations
        if (decl.parameters.length > 0 || decl.isArrowSyntax) {
          const params = decl.parameters.map((p) => p.name || "_").join(", ");
          const paramsStr = `(${params})`;
          const body = this.formatBlock(decl.body, false, true);
          return `let ${recPrefix}${decl.name} = ${paramsStr} => ${body};`;
        }

        // Simple let binding
        const body = this.formatBlockForLet(decl.body);
        if (body.startsWith("\n")) {
          return `let ${recPrefix}${decl.name} =${body};`;
        } else {
          return `let ${recPrefix}${decl.name} = ${body};`;
        }
      }
      case "expr_statement":
        return this.formatExpr(stmt.expression) + ";";
      default:
        return "";
    }
  }

  private formatExpr(expr: Expr): string {
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
        return `${this.formatExpr(expr.callee)}(${
          expr.arguments.map((a) => this.formatExpr(a)).join(", ")
        })`;
      case "arrow":
        const params = expr.parameters.map((p) => p.name || "_").join(", ");
        // Always use parentheses for consistency
        const paramsStr = `(${params})`;
        const body = this.formatBlock(expr.body, false, true);
        return `${paramsStr} => ${body}`;
      case "block":
        return this.formatBlock(expr);
      case "match":
        return this.formatMatch(expr.scrutinee, expr.arms);
      case "match_fn":
        return this.formatMatchFn(expr.parameters, expr.arms);
      default:
        return "???";
    }
  }

  private formatLiteral(lit: any): string {
    switch (lit.kind) {
      case "int":
        return String(lit.value);
      case "bool":
        return String(lit.value);
      case "string":
        return `"${lit.value}"`;
      case "unit":
        return "()";
      default:
        return "???";
    }
  }

  private formatMatchArmBody(expr: Expr): string {
    // Match arm bodies must always be block expressions
    if (expr.kind === "block") {
      const block = expr;
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
          return `{\n${indentedFirst}\n${
            rest.join("\n")
          }\n${this.indentStr()}}`;
        }

        const resultExpr = this.formatExpr(block.result);
        return `{ ${resultExpr} }`;
      }
      // Multi-statement block
      return this.formatBlock(block);
    }
    // If it's not a block, wrap it in braces (shouldn't happen in valid code)
    return `{ ${this.formatExpr(expr)} }`;
  }

  private formatMatch(
    scrutinee: Expr,
    arms: MatchArm[],
    forceMultiLine: boolean = false,
  ): string {
    const scrutineeStr = this.formatExpr(scrutinee);

    // Try inline format first
    const armsInline = arms.map((arm) => {
      if (arm.kind === "match_bundle_reference") {
        return arm.name;
      }
      const pattern = this.formatPattern(arm.pattern);
      const body = this.formatMatchArmBody(arm.body);
      return `${pattern} => ${body}`;
    }).join(", ");
    const inlineMatch = `match(${scrutineeStr}) { ${armsInline} }`;

    // If too long, has multiple arms, or forced multi-line, use multi-line format
    if (forceMultiLine || inlineMatch.length > 60 || arms.length > 1) {
      const armsParts: string[] = [];
      this.indent++;
      for (const arm of arms) {
        if (arm.kind === "match_bundle_reference") {
          armsParts.push(`${this.indentStr()}${arm.name}`);
          continue;
        }
        const pattern = this.formatPattern(arm.pattern);
        const body = this.formatMatchArmBody(arm.body);
        armsParts.push(`${this.indentStr()}${pattern} => ${body}`);
      }
      this.indent--;
      // Format with opening brace on same line but closing brace indented
      return `match(${scrutineeStr}) {\n${
        armsParts.join(",\n")
      }\n${this.indentStr()}}`;
    }

    return inlineMatch;
  }

  private formatMatchFn(params: Expr[], arms: MatchArm[]): string {
    // Try inline format first
    const armsInline = arms.map((arm) => {
      if (arm.kind === "match_bundle_reference") {
        return arm.name;
      }
      const pattern = this.formatPattern(arm.pattern);
      const body = this.formatMatchArmBody(arm.body);
      return `${pattern} => ${body}`;
    }).join(", ");
    const inlineFn = `fn { ${armsInline} }`;

    // If too long or has multiple arms, use multi-line format
    if (inlineFn.length > 80 || arms.length > 2) {
      const armsParts: string[] = [];
      this.indent++;
      for (const arm of arms) {
        if (arm.kind === "match_bundle_reference") {
          armsParts.push(`${this.indentStr()}${arm.name}`);
          continue;
        }
        const pattern = this.formatPattern(arm.pattern);
        const body = this.formatMatchArmBody(arm.body);
        armsParts.push(`${this.indentStr()}${pattern} => ${body}`);
      }
      this.indent--;
      return `fn {\n${armsParts.join(",\n")}\n${this.indentStr()}}`;
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
      default:
        return "???";
    }
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
    console.error(
      `\nOriginal (no whitespace): ${originalStripped.slice(0, 100)}${
        originalStripped.length > 100 ? "..." : ""
      }`,
    );
    console.error(
      `Formatted (no whitespace): ${formattedStripped.slice(0, 100)}${
        formattedStripped.length > 100 ? "..." : ""
      }`,
    );

    // Find first difference
    const minLen = Math.min(originalStripped.length, formattedStripped.length);
    for (let i = 0; i < minLen; i++) {
      if (originalStripped[i] !== formattedStripped[i]) {
        console.error(`\nFirst difference at position ${i}:`);
        console.error(
          `  Original: ...${
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
    const tokens = lex(source, filePath);
    const program = parseSurfaceProgram(tokens, source, true); // preserveComments = true for formatter

    const formatter = new Formatter(options);
    const formatted = formatter.format(program);

    // Safety check: ensure only whitespace changed
    if (!verifyOnlyWhitespaceChanged(source, formatted, filePath)) {
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
