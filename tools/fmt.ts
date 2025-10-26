#!/usr/bin/env -S deno run --allow-read --allow-write

import { lex } from "../src/lexer.ts";
import { parseSurfaceProgram, ParseError } from "../src/parser.ts";
import type {
  Program,
  Declaration,
  LetDeclaration,
  TypeDeclaration,
  Expr,
  BlockExpr,
  BlockStatement,
  Pattern,
  MatchArm,
  ModuleImport,
  ModuleReexport,
  ImportSpecifier,
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
    if ((program.imports.length > 0 || program.reexports.length > 0) && program.declarations.length > 0) {
      parts.push("");
    }

    // Format declarations
    for (let i = 0; i < program.declarations.length; i++) {
      const decl = program.declarations[i];
      parts.push(this.formatDeclaration(decl));
      
      // Add blank line between top-level declarations
      if (i < program.declarations.length - 1) {
        parts.push("");
      }
    }

    return parts.join("\n") + "\n";
  }

  private formatImport(imp: ModuleImport): string {
    const specs = imp.specifiers.map(s => this.formatImportSpecifier(s)).join(", ");
    return `from "${imp.source}" import { ${specs} };`;
  }

  private formatImportSpecifier(spec: ImportSpecifier): string {
    if (spec.kind === "namespace") {
      return `* as ${spec.local}`;
    }
    return spec.imported === spec.local ? spec.imported : `${spec.imported} as ${spec.local}`;
  }

  private formatReexport(reexp: ModuleReexport): string {
    const types = reexp.typeExports.map(t => this.formatTypeReexport(t)).join(", ");
    return `export from "${reexp.source}" type ${types};`;
  }

  private formatTypeReexport(typeExp: TypeReexport): string {
    return typeExp.exportConstructors ? `${typeExp.name}(..)` : typeExp.name;
  }

  private formatDeclaration(decl: Declaration): string {
    let result = "";
    
    // Add leading comments
    if (decl.leadingComments && decl.leadingComments.length > 0) {
      for (const comment of decl.leadingComments) {
        result += `-- ${comment}\n`;
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
    
    // If this was originally a first-class match, format it that way
    if (decl.isFirstClassMatch && decl.parameters.length === 1 && 
        decl.body.statements.length === 0 && decl.body.result?.kind === "match") {
      const matchExpr = decl.body.result;
      // Force multi-line if the body was originally multi-line
      const forceMultiLine = decl.body.isMultiLine === true;
      const formattedMatch = this.formatMatch(matchExpr.scrutinee, matchExpr.arms, forceMultiLine);
      return `${exportPrefix}let ${recPrefix}${decl.name} = ${formattedMatch};`;
    }
    
    // If there are parameters OR originally used arrow syntax, format as arrow function
    if (decl.parameters.length > 0 || decl.isArrowSyntax) {
      const params = decl.parameters.map(p => p.name || "_").join(", ");
      // Always use parentheses for consistency
      const paramsStr = `(${params})`;
      const body = this.formatBlock(decl.body, false, true);
      return `${exportPrefix}let ${recPrefix}${decl.name} = ${paramsStr} => ${body};`;
    }
    
    // No parameters and not arrow syntax - format body directly
    const body = this.formatBlockForLet(decl.body);
    
    let result;
    if (body.startsWith("\n")) {
      // Body is already formatted with leading newline
      result = `${exportPrefix}let ${recPrefix}${decl.name} =${body};`;
    } else {
      result = `${exportPrefix}let ${recPrefix}${decl.name} = ${body};`;
    }

    // Format mutual bindings
    if (decl.mutualBindings && decl.mutualBindings.length > 0) {
      for (const mutual of decl.mutualBindings) {
        if (mutual.parameters.length > 0) {
          const mutualParams = mutual.parameters.map(p => p.name || "_").join(", ");
          const mutualParamsStr = `(${mutualParams})`;
          const mutualBody = this.formatBlock(mutual.body, false);
          result += `\nand ${mutual.name} = ${mutualParamsStr} => ${mutualBody};`;
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
      // Check if the expression itself is multiline (like a match)
      if (expr.includes("\n")) {
        // Put opening brace on new line, indent content
        this.indent++;
        const indentedExpr = expr.split("\n").map(line => this.indentStr() + line).join("\n");
        this.indent--;
        return `\n${this.indentStr()}{\n${indentedExpr}\n${this.indentStr()}}`;
      }
      // Simple expression - unwrap if possible
      if (this.isSimpleExpr(block.result)) {
        return expr;
      }
      return `{ ${expr} }`;
    }

    // Multi-statement block - always use multiple lines with opening brace on new line
    const parts: string[] = [];
    this.indent++;
    
    for (const stmt of block.statements) {
      parts.push(this.indentStr() + this.formatBlockStatement(stmt));
    }

    if (block.result) {
      parts.push(this.indentStr() + this.formatExpr(block.result));
    }

    this.indent--;
    return `\n${this.indentStr()}{\n${parts.join("\n")}\n${this.indentStr()}}`;
  }

  private formatTypeDeclaration(decl: TypeDeclaration): string {
    const exportPrefix = decl.export ? "export " : "";
    const typeParams = decl.typeParams.length > 0 ? `<${decl.typeParams.join(", ")}>` : "";
    const members = decl.members.map(m => {
      if (m.kind === "alias") {
        return m.name;
      } else {
        const args = m.typeArgs.length > 0 ? `<${m.typeArgs.map(a => this.formatTypeExpr(a)).join(", ")}>` : "";
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
        return `${typeExpr.name}<${typeExpr.typeArgs.map((a: any) => this.formatTypeExpr(a)).join(", ")}>`;
      case "type_fn":
        const params = typeExpr.parameters.map((p: any) => this.formatTypeExpr(p)).join(", ");
        const result = this.formatTypeExpr(typeExpr.result);
        return `(${params}) -> ${result}`;
      case "type_tuple":
        return `(${typeExpr.elements.map((e: any) => this.formatTypeExpr(e)).join(", ")})`;
      case "type_unit":
        return "()";
      default:
        return "???";
    }
  }

  private formatBlock(block: BlockExpr, multiline: boolean = true, keepBraces: boolean = false): string {
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
        const indentedExpr = expr.split("\n").map(line => this.indentStr() + line).join("\n");
        this.indent--;
        return `{\n${indentedExpr}\n${this.indentStr()}}`;
      }
      
      // If the expression is multiline OR contains braces, format with proper indentation
      // This prevents multiple { on the same line
      if (expr.includes("\n") || expr.includes("{")) {
        this.indent++;
        const indentedExpr = expr.split("\n").map(line => this.indentStr() + line).join("\n");
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
        
        // Use same logic as top-level let declarations
        if (decl.parameters.length > 0 || decl.isArrowSyntax) {
          const params = decl.parameters.map(p => p.name || "_").join(", ");
          const paramsStr = `(${params})`;
          const body = this.formatBlock(decl.body, false, true);
          return `let ${decl.name} = ${paramsStr} => ${body};`;
        }
        
        // Simple let binding
        const body = this.formatBlockForLet(decl.body);
        if (body.startsWith("\n")) {
          return `let ${decl.name} =${body};`;
        } else {
          return `let ${decl.name} = ${body};`;
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
        return `${expr.name}(${expr.args.map(a => this.formatExpr(a)).join(", ")})`;
      case "tuple":
        return `(${expr.elements.map(e => this.formatExpr(e)).join(", ")})`;
      case "call":
        return `${this.formatExpr(expr.callee)}(${expr.arguments.map(a => this.formatExpr(a)).join(", ")})`;
      case "arrow":
        const params = expr.parameters.map(p => p.name || "_").join(", ");
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
      // Single expression block - always keep braces for match arms with spaces
      if (block.statements.length === 0 && block.result) {
        const resultExpr = this.formatExpr(block.result);
        return `{ ${resultExpr} }`;
      }
      // Multi-statement block
      return this.formatBlock(block);
    }
    // If it's not a block, wrap it in braces (shouldn't happen in valid code)
    return `{ ${this.formatExpr(expr)} }`;
  }

  private formatMatch(scrutinee: Expr, arms: MatchArm[], forceMultiLine: boolean = false): string {
    const scrutineeStr = this.formatExpr(scrutinee);
    
    // Try inline format first
    const armsInline = arms.map(arm => {
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
        const pattern = this.formatPattern(arm.pattern);
        const body = this.formatMatchArmBody(arm.body);
        armsParts.push(`${this.indentStr()}${pattern} => ${body}`);
      }
      this.indent--;
      // Format with opening brace on same line but closing brace indented
      return `match(${scrutineeStr}) {\n${armsParts.join(",\n")}\n${this.indentStr()}}`;
    }
    
    return inlineMatch;
  }

  private formatMatchFn(params: Expr[], arms: MatchArm[]): string {
    // Try inline format first
    const armsInline = arms.map(arm => {
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
        return `(${pattern.elements.map(e => this.formatPattern(e)).join(", ")})`;
      case "constructor":
        if (pattern.args.length === 0) {
          return pattern.name;
        }
        return `${pattern.name}(${pattern.args.map(a => this.formatPattern(a)).join(", ")})`;
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

function verifyOnlyWhitespaceChanged(original: string, formatted: string, filePath: string): void {
  const originalStripped = stripWhitespace(original);
  const formattedStripped = stripWhitespace(formatted);
  
  if (originalStripped !== formattedStripped) {
    console.error(`\n❌ FORMATTER ERROR in ${filePath}!`);
    console.error(`The formatter would change non-whitespace characters.`);
    console.error(`\nOriginal (no whitespace): ${originalStripped.slice(0, 100)}${originalStripped.length > 100 ? "..." : ""}`);
    console.error(`Formatted (no whitespace): ${formattedStripped.slice(0, 100)}${formattedStripped.length > 100 ? "..." : ""}`);
  
    // Find first difference
    const minLen = Math.min(originalStripped.length, formattedStripped.length);
    for (let i = 0; i < minLen; i++) {
      if (originalStripped[i] !== formattedStripped[i]) {
        console.error(`\nFirst difference at position ${i}:`);
        console.error(`  Original: ...${originalStripped.slice(Math.max(0, i-20), i+20)}...`);
        console.error(`  Formatted: ...${formattedStripped.slice(Math.max(0, i-20), i+20)}...`);
        break;
      }
    }
    console.error(`\nLength: original=${originalStripped.length}, formatted=${formattedStripped.length}`);
    
    console.error(`\nAborting to prevent data loss. The file was not modified.`);
    Deno.exit(1);
  }
}

async function formatFile(filePath: string, options: FormatOptions): Promise<void> {
  try {
    const source = await Deno.readTextFile(filePath);
    const tokens = lex(source);
    const program = parseSurfaceProgram(tokens, source);
    
    const formatter = new Formatter(options);
    const formatted = formatter.format(program);

    // Safety check: ensure only whitespace changed
    verifyOnlyWhitespaceChanged(source, formatted, filePath);

    if (options.check) {
      if (source !== formatted) {
        console.error(`${filePath} is not formatted`);
        Deno.exit(1);
      } else {
        console.log(`${filePath} is formatted`);
      }
    } else {
      await Deno.writeTextFile(filePath, formatted);
      console.log(`Formatted ${filePath}`);
    }
  } catch (error) {
    if (error instanceof ParseError) {
      console.error(`Parse error in ${filePath}: ${error.message}`);
      Deno.exit(1);
    } else if (error instanceof Deno.errors.NotFound) {
      console.error(`File not found: ${filePath}`);
      Deno.exit(1);
    } else {
      console.error(`Error formatting ${filePath}: ${error}`);
      Deno.exit(1);
    }
  }
}

export async function runFormatter(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: wm fmt [--check] <file.wm> [<file2.wm> ...]");
    Deno.exit(1);
  }

  const check = args[0] === "--check";
  const files = check ? args.slice(1) : args;

  if (files.length === 0) {
    console.error("Usage: wm fmt [--check] <file.wm> [<file2.wm> ...]");
    Deno.exit(1);
  }

  const options: FormatOptions = {
    indentSize: 2,
    check,
  };

  for (const file of files) {
    await formatFile(file, options);
  }
}

if (import.meta.main) {
  await runFormatter(Deno.args);
}
