// Workman → JavaScript compiler (v0)
// Simple, readable output for demonstration

import {
  Program,
  Declaration,
  LetDeclaration,
  Expr,
  Pattern,
  MatchArm,
  Literal,
  BlockStatement,
  TypeDeclaration,
  InfixDeclaration,
  PrefixDeclaration,
} from "./ast.ts";

export interface CompileOptions {
  module?: "esm" | "cjs";
  minify?: boolean;
}

export function compileToJS(program: Program, options: CompileOptions = {}): string {
  const ctx: CodegenContext = {
    module: options.module ?? "esm",
    indent: 0,
    varCounter: 0,
  };

  const parts: string[] = [];

  // Compile each declaration
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      parts.push(compileLetDeclaration(ctx, decl));
    }
    // Skip type declarations (they're compile-time only)
    // Skip infix/prefix declarations (handled by desugaring)
  }

  return parts.join("\n\n");
}

interface CodegenContext {
  module: "esm" | "cjs";
  indent: number;
  varCounter: number;
}

function freshVar(ctx: CodegenContext): string {
  return `_v${ctx.varCounter++}`;
}

function compileLetDeclaration(ctx: CodegenContext, decl: LetDeclaration): string {
  const isExported = decl.isExport || decl.export;
  const exportPrefix = isExported && ctx.module === "esm" ? "export " : "";
  
  // Check if it uses arrow syntax - if so, it's a function even with 0 params
  if (decl.isArrowSyntax) {
    // Arrow syntax: let x = () => { ... } or let x = (a, b) => { ... }
    if (decl.parameters && decl.parameters.length > 0) {
      return compileFunctionDeclaration(ctx, decl, exportPrefix);
    } else {
      // Zero-parameter function (thunk)
      const body = compileExpr(ctx, decl.body);
      return `${exportPrefix}const ${decl.name} = function() { return ${body}; };`;
    }
  } else {
    // Non-arrow syntax
    // Check if body is a block containing only a match expression
    let matchExpr = null;
    if (decl.body.kind === "match") {
      matchExpr = decl.body;
    } else if (decl.body.kind === "block" && decl.body.statements.length === 0 && decl.body.result.kind === "match") {
      matchExpr = decl.body.result;
    }
    
    if (matchExpr && matchExpr.scrutinee && matchExpr.scrutinee.kind === "identifier") {
      // match(param) syntax creates a function
      const paramName = escapeIdentifier(matchExpr.scrutinee.name);
      const matchCode = compileMatch(ctx, matchExpr);
      return `${exportPrefix}const ${decl.name} = function(${paramName}) { return ${matchCode}; };`;
    } else {
      // Regular value binding
      const value = compileExpr(ctx, decl.body);
      return `${exportPrefix}const ${decl.name} = ${value};`;
    }
  }
}

function compileFunctionDeclaration(ctx: CodegenContext, decl: LetDeclaration, exportPrefix: string): string {
  // Generate curried function
  const params = decl.parameters;
  const body = compileExpr(ctx, decl.body);
  
  let result = body;
  
  // Build curried functions from right to left
  for (let i = params.length - 1; i >= 0; i--) {
    const param = params[i];
    // Handle both parameter objects and patterns
    const paramName = param.pattern ? compilePattern(ctx, param.pattern) : compilePattern(ctx, param);
    result = `function(${paramName}) { return ${result}; }`;
  }
  
  return `${exportPrefix}const ${decl.name} = ${result};`;
}

// JavaScript reserved keywords that need to be escaped
const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "finally", "for", "function",
  "if", "import", "in", "instanceof", "new", "return", "super", "switch",
  "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield",
  "enum", "implements", "interface", "let", "package", "private", "protected",
  "public", "static", "await", "abstract", "boolean", "byte", "char", "double",
  "final", "float", "goto", "int", "long", "native", "short", "synchronized",
  "throws", "transient", "volatile"
]);

function escapeIdentifier(name: string): string {
  return JS_RESERVED.has(name) ? `_${name}` : name;
}

function compilePattern(ctx: CodegenContext, pattern: Pattern): string {
  switch (pattern.kind) {
    case "variable":
    case "identifier":
      return escapeIdentifier(pattern.name);
    case "wildcard":
      return freshVar(ctx);
    case "tuple": {
      // Destructure tuple: (x, y) becomes _tuple, then extract
      const tupleVar = freshVar(ctx);
      return tupleVar;
    }
    case "constructor":
      // For now, just use a variable name
      return freshVar(ctx);
    case "literal":
      return freshVar(ctx);
    default:
      return freshVar(ctx);
  }
}

function compileExpr(ctx: CodegenContext, expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return compileLiteral(expr.literal ?? expr.value);
    
    case "identifier":
      return escapeIdentifier(expr.name);
    
    case "arrow":
    case "lambda": {
      // Arrow might be a parameter-less thunk or have a parameter
      if (expr.parameter || expr.param) {
        const param = compilePattern(ctx, expr.parameter ?? expr.param);
        const body = compileExpr(ctx, expr.body);
        return `function(${param}) { return ${body}; }`;
      } else {
        // Parameter-less arrow (thunk)
        const body = compileExpr(ctx, expr.body);
        return `function() { return ${body}; }`;
      }
    }
    
    case "call":
    case "application": {
      const callee = compileExpr(ctx, expr.callee ?? expr.func);
      const args = expr.arguments ?? [expr.argument];
      
      // Handle curried application
      let result = callee;
      for (const arg of args) {
        const argCode = compileExpr(ctx, arg);
        result = `(${result})(${argCode})`;
      }
      return result;
    }
    
    case "match": {
      return compileMatch(ctx, expr);
    }
    
    case "block": {
      return compileBlock(ctx, expr);
    }
    
    case "tuple": {
      const elements = expr.elements.map(e => compileExpr(ctx, e));
      return `[${elements.join(", ")}]`;
    }
    
    case "constructor": {
      // Constructor application
      const args = expr.args?.map(a => compileExpr(ctx, a)) ?? [];
      if (args.length === 0) {
        return `{ kind: "${expr.name}" }`;
      } else {
        return `{ kind: "${expr.name}", fields: [${args.join(", ")}] }`;
      }
    }
    
    default:
      return `/* TODO: ${expr.kind} */`;
  }
}

function compileLiteral(lit: Literal): string {
  switch (lit.kind) {
    case "int":
      return lit.value.toString();
    case "bool":
      return lit.value.toString();
    case "char":
      return `'${lit.value}'`;
    case "string":
      return JSON.stringify(lit.value);
    case "unit":
      return "undefined";
    default:
      return "null";
  }
}

function compileMatch(ctx: CodegenContext, expr: Expr): string {
  if (expr.kind !== "match") return "";
  
  const scrutinee = compileExpr(ctx, expr.scrutinee);
  const scrutineeVar = freshVar(ctx);
  
  // Generate if-else chain for match arms
  const arms = expr.arms.map((arm, i) => {
    const condition = compilePatternTest(ctx, arm.pattern, scrutineeVar);
    const bindings = compilePatternBindings(ctx, arm.pattern, scrutineeVar);
    const body = compileExpr(ctx, arm.body);
    
    let result = body;
    if (bindings.length > 0) {
      const bindingsCode = bindings.map(b => `const ${b.name} = ${b.value};`).join(" ");
      result = `(function() { ${bindingsCode} return ${body}; })()`;
    }
    
    if (i === 0) {
      return `if (${condition}) { return ${result}; }`;
    } else if (arm.pattern.kind === "wildcard") {
      return `{ return ${result}; }`;
    } else {
      return `else if (${condition}) { return ${result}; }`;
    }
  }).join(" ");
  
  return `(function() { const ${scrutineeVar} = ${scrutinee}; ${arms} })()`;
}

function compilePatternTest(ctx: CodegenContext, pattern: Pattern, scrutineeVar: string): string {
  switch (pattern.kind) {
    case "wildcard":
      return "true";
    case "variable":
    case "identifier":
      return "true";
    case "literal":
      // Pattern might have literal nested or directly
      const lit = pattern.literal ?? pattern.value;
      return `${scrutineeVar} === ${compileLiteral(lit)}`;
    case "constructor":
      return `${scrutineeVar}.kind === "${pattern.name}"`;
    case "tuple":
      return `Array.isArray(${scrutineeVar})`;
    default:
      return "true";
  }
}

function compilePatternBindings(ctx: CodegenContext, pattern: Pattern, scrutineeVar: string): Array<{name: string, value: string}> {
  const bindings: Array<{name: string, value: string}> = [];
  
  switch (pattern.kind) {
    case "variable":
    case "identifier":
      bindings.push({ name: escapeIdentifier(pattern.name), value: scrutineeVar });
      break;
    case "constructor":
      pattern.args.forEach((arg, i) => {
        if (arg.kind === "variable" || arg.kind === "identifier") {
          bindings.push({ name: escapeIdentifier(arg.name), value: `${scrutineeVar}.fields[${i}]` });
        }
      });
      break;
    case "tuple":
      pattern.elements.forEach((elem, i) => {
        if (elem.kind === "variable" || elem.kind === "identifier") {
          bindings.push({ name: escapeIdentifier(elem.name), value: `${scrutineeVar}[${i}]` });
        }
      });
      break;
  }
  
  return bindings;
}

function compileBlock(ctx: CodegenContext, expr: Expr): string {
  if (expr.kind !== "block") return "";
  
  const statements: string[] = [];
  
  for (const stmt of expr.statements) {
    if (stmt.kind === "let_statement" && stmt.declaration) {
      // Handle let_statement with nested declaration
      const decl = stmt.declaration;
      const value = compileExpr(ctx, decl.body);
      statements.push(`const ${escapeIdentifier(decl.name)} = ${value};`);
    } else if (stmt.kind === "let") {
      const value = compileExpr(ctx, stmt.value ?? stmt.body);
      statements.push(`const ${escapeIdentifier(stmt.name)} = ${value};`);
    } else if (stmt.kind === "expr") {
      statements.push(compileExpr(ctx, stmt.expr) + ";");
    }
  }
  
  const result = compileExpr(ctx, expr.result);
  
  // If there are no statements, just return the result directly
  if (statements.length === 0) {
    return result;
  }
  
  return `(function() { ${statements.join(" ")} return ${result}; })()`;
}
