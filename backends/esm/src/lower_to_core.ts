// Surface AST → Core IR lowering
// Desugars surface syntax into canonical Core representation

import type { Program, Expr, Pattern, LetDeclaration, TypeDeclaration, BlockExpr } from "../../../src/ast.ts";
import type { Type, TypeEnv, TypeEnvADT, TypeScheme } from "../../../src/types.ts";
import type { InferResult } from "../../../src/infer.ts";
import {
  CoreExpr,
  CorePattern,
  CoreProgram,
  CoreTypeDecl,
  CoreTopLevelBinding,
  CoreLitValue,
  PrimOp,
} from "./core_ir.ts";
import { instantiate } from "../../../src/types.ts";

interface LoweringContext {
  env: TypeEnv;
  adtEnv: TypeEnvADT;
  // All bindings including block-scoped ones
  allBindings: Map<string, TypeScheme>;
}

/**
 * Lower a typed Surface program to Core IR
 */
export function lowerToCore(program: Program, inferResult: InferResult): CoreProgram {
  const ctx: LoweringContext = {
    env: inferResult.env,
    adtEnv: inferResult.adtEnv,
    allBindings: inferResult.allBindings,
  };

  // Extract type declarations
  const types: CoreTypeDecl[] = [];
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      types.push(lowerTypeDecl(decl, ctx));
    }
  }

  // Lower top-level let bindings
  const bindings: CoreTopLevelBinding[] = [];
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      bindings.push(lowerTopLevelLet(decl, ctx));
    }
  }

  // Collect exports
  const exports = [];
  for (const decl of program.declarations) {
    if (decl.kind === "let" && decl.export) {
      exports.push({ kind: "value" as const, name: decl.name });
    } else if (decl.kind === "type" && decl.export) {
      exports.push({ kind: "type" as const, name: decl.name });
    }
  }

  return { types, bindings, exports };
}

function lowerTypeDecl(decl: TypeDeclaration, ctx: LoweringContext): CoreTypeDecl {
  const typeInfo = ctx.adtEnv.get(decl.name);
  if (!typeInfo) {
    throw new Error(`Type ${decl.name} not found in ADT environment`);
  }

  const constructors = typeInfo.constructors.map((ctor: { name: string; arity: number }) => ({
    name: ctor.name,
    arity: ctor.arity,
  }));

  return {
    name: decl.name,
    constructors,
    exported: !!decl.export,
  };
}

function lowerTopLevelLet(decl: LetDeclaration, ctx: LoweringContext): CoreTopLevelBinding {
  const scheme = ctx.env.get(decl.name);
  if (!scheme) {
    throw new Error(`Binding ${decl.name} not found in type environment`);
  }

  const expr = lowerLetDeclaration(decl, ctx);

  return {
    name: decl.name,
    expr,
    exported: !!decl.export,
  };
}

function lowerLetDeclaration(decl: LetDeclaration, ctx: LoweringContext): CoreExpr {
  // Try to get the scheme from allBindings first (includes block-scoped bindings)
  let scheme = ctx.allBindings.get(decl.name);
  
  // Fall back to global env if not found (shouldn't happen, but be safe)
  if (!scheme) {
    scheme = ctx.env.get(decl.name);
  }
  
  if (!scheme) {
    throw new Error(`Binding ${decl.name} not found in type environment`);
  }

  // Get the type for this binding
  const type = instantiate(scheme);

  if (decl.isRecursive) {
    // Recursive bindings must be lambdas
    const allBindings = [decl, ...(decl.mutualBindings || [])];
    const coreBindings = allBindings.map((binding) => {
      const bindingScheme = ctx.allBindings.get(binding.name) || ctx.env.get(binding.name);
      if (!bindingScheme) {
        throw new Error(`Binding ${binding.name} not found`);
      }
      const bindingType = instantiate(bindingScheme);
      
      const lam = lowerToLambda(binding, bindingType, ctx);
      if (lam.kind !== "core_lam") {
        throw new Error(`Recursive binding ${binding.name} must be a lambda`);
      }
      return { name: binding.name, lam };
    });

    // The body is just a reference to the first binding
    const body: CoreExpr = {
      kind: "core_var",
      name: decl.name,
      type,
    };

    return {
      kind: "core_letrec",
      bindings: coreBindings,
      body,
      type,
    };
  }

  // Non-recursive
  if (decl.parameters.length > 0) {
    // It's a function
    return lowerToLambda(decl, type, ctx);
  }

  // It's a value
  return lowerBlockExpr(decl.body, type, ctx);
}

function lowerToLambda(decl: LetDeclaration, type: Type, ctx: LoweringContext): CoreExpr {
  const params = decl.parameters.map((p: { name?: string }) => {
    if (!p.name) {
      throw new Error("Parameter must have a name after tuple lowering");
    }
    return p.name;
  });

  const body = lowerBlockExpr(decl.body, extractReturnType(type, params.length), ctx);

  return {
    kind: "core_lam",
    params,
    body,
    type,
  };
}

function extractReturnType(type: Type, paramCount: number): Type {
  let current = type;
  for (let i = 0; i < paramCount; i++) {
    if (current.kind !== "func") {
      throw new Error("Type mismatch: expected function type");
    }
    current = current.to;
  }
  return current;
}

function lowerBlockExpr(block: BlockExpr, type: Type, ctx: LoweringContext): CoreExpr {
  let body: CoreExpr = block.result
    ? lowerExpr(block.result, type, ctx)
    : { kind: "core_lit", value: { kind: "unit" }, type: { kind: "unit" } };

  // Process statements in reverse order to build nested lets
  for (let i = block.statements.length - 1; i >= 0; i--) {
    const stmt = block.statements[i];
    if (stmt.kind === "let_statement") {
      const decl = stmt.declaration;
      const rhs = lowerLetDeclaration(decl, ctx);
      body = {
        kind: "core_let",
        name: decl.name,
        rhs,
        body,
        type: body.type,
      };
    } else if (stmt.kind === "expr_statement") {
      // Expression statements are sequenced with let _ = expr in body
      const rhs = lowerExpr(stmt.expression, { kind: "unit" }, ctx);
      body = {
        kind: "core_let",
        name: "_",
        rhs,
        body,
        type: body.type,
      };
    }
  }

  return body;
}

function lowerExpr(expr: Expr, expectedType: Type, ctx: LoweringContext): CoreExpr {
  switch (expr.kind) {
    case "identifier":
      return {
        kind: "core_var",
        name: expr.name,
        type: expectedType,
      };

    case "literal":
      return {
        kind: "core_lit",
        value: lowerLiteral(expr.literal),
        type: expectedType,
      };

    case "constructor": {
      // Constructor with arguments
      const fields = expr.args.map((arg: Expr) => lowerExpr(arg, { kind: "var", id: -1 }, ctx));
      
      // Extract type name from expectedType or look it up in ADT environment
      let typeName = "Unknown";
      if (expectedType.kind === "constructor") {
        typeName = expectedType.name;
      } else {
        // Expected type is a variable - look up the constructor in ADT environment
        for (const [name, info] of ctx.adtEnv) {
          if (info.constructors.some(c => c.name === expr.name)) {
            typeName = name;
            break;
          }
        }
      }

      return {
        kind: "core_ctor",
        typeName,
        ctorName: expr.name,
        fields,
        type: expectedType,
      };
    }

    case "tuple": {
      const elements = expr.elements.map((el: Expr) => lowerExpr(el, { kind: "var", id: -1 }, ctx));
      return {
        kind: "core_tuple",
        elements,
        type: expectedType,
      };
    }

    case "call": {
      const fn = lowerExpr(expr.callee, { kind: "var", id: -1 }, ctx);
      const args = expr.arguments.map((arg: Expr) => lowerExpr(arg, { kind: "var", id: -1 }, ctx));
      return {
        kind: "core_app",
        fn,
        args,
        type: expectedType,
      };
    }

    case "arrow": {
      const params = expr.parameters.map((p: { name?: string }) => {
        if (!p.name) throw new Error("Parameter must have name");
        return p.name;
      });
      const body = lowerBlockExpr(expr.body, expectedType, ctx);
      return {
        kind: "core_lam",
        params,
        body,
        type: expectedType,
      };
    }

    case "block":
      return lowerBlockExpr(expr, expectedType, ctx);

    case "match": {
      const scrutinee = lowerExpr(expr.scrutinee, { kind: "var", id: -1 }, ctx);
      const cases = expr.arms.map((arm: { pattern: Pattern; body: Expr }) => ({
        pattern: lowerPattern(arm.pattern),
        body: lowerExpr(arm.body, expectedType, ctx),
      }));
      return {
        kind: "core_match",
        scrutinee,
        cases,
        type: expectedType,
      };
    }

    case "match_fn": {
      // match(x) { ... } desugars to (x) => match x { ... }
      if (expr.parameters.length !== 1) {
        throw new Error("Match function must have exactly one parameter");
      }
      const param = expr.parameters[0];
      if (param.kind !== "identifier") {
        throw new Error("Match function parameter must be identifier");
      }
      
      const scrutinee: CoreExpr = {
        kind: "core_var",
        name: param.name,
        type: { kind: "var", id: -1 },
      };
      
      const cases = expr.arms.map((arm: { pattern: Pattern; body: Expr }) => ({
        pattern: lowerPattern(arm.pattern),
        body: lowerExpr(arm.body, expectedType, ctx),
      }));
      
      const matchExpr: CoreExpr = {
        kind: "core_match",
        scrutinee,
        cases,
        type: expectedType,
      };
      
      return {
        kind: "core_lam",
        params: [param.name],
        body: matchExpr,
        type: expectedType,
      };
    }

    case "binary": {
      const left = lowerExpr(expr.left, { kind: "var", id: -1 }, ctx);
      const right = lowerExpr(expr.right, { kind: "var", id: -1 }, ctx);
      const op = mapBinaryOpToPrim(expr.operator);
      
      if (op) {
        return {
          kind: "core_prim",
          op,
          args: [left, right],
          type: expectedType,
        };
      }
      
      // Not a built-in primitive, treat as function call
      const opFunc: CoreExpr = {
        kind: "core_var",
        name: `__op_${expr.operator}`,
        type: { kind: "var", id: -1 },
      };
      
      return {
        kind: "core_app",
        fn: opFunc,
        args: [left, right],
        type: expectedType,
      };
    }

    case "unary": {
      const operand = lowerExpr(expr.operand, { kind: "var", id: -1 }, ctx);
      const op = mapUnaryOpToPrim(expr.operator);
      
      if (op) {
        return {
          kind: "core_prim",
          op,
          args: [operand],
          type: expectedType,
        };
      }
      
      // Not a built-in primitive
      const opFunc: CoreExpr = {
        kind: "core_var",
        name: `__prefix_${expr.operator}`,
        type: { kind: "var", id: -1 },
      };
      
      return {
        kind: "core_app",
        fn: opFunc,
        args: [operand],
        type: expectedType,
      };
    }

    default:
      throw new Error(`Unsupported expression kind: ${(expr as any).kind}`);
  }
}

function lowerPattern(pattern: Pattern): CorePattern {
  switch (pattern.kind) {
    case "wildcard":
      return { kind: "core_pwildcard" };

    case "variable":
      return { kind: "core_pvar", name: pattern.name };

    case "literal":
      return { kind: "core_plit", value: lowerLiteral(pattern.literal) };

    case "tuple":
      return {
        kind: "core_ptuple",
        elements: pattern.elements.map(lowerPattern),
      };

    case "constructor":
      return {
        kind: "core_pctor",
        ctorName: pattern.name,
        subpatterns: pattern.args.map(lowerPattern),
      };

    default:
      throw new Error(`Unsupported pattern kind: ${(pattern as any).kind}`);
  }
}

function lowerLiteral(lit: any): CoreLitValue {
  switch (lit.kind) {
    case "int":
      return { kind: "int", value: lit.value };
    case "bool":
      return { kind: "bool", value: lit.value };
    case "char":
      return { kind: "char", value: lit.value };
    case "string":
      return { kind: "string", value: lit.value };
    case "unit":
      return { kind: "unit" };
    default:
      throw new Error(`Unsupported literal kind: ${lit.kind}`);
  }
}

function mapBinaryOpToPrim(op: string): PrimOp | null {
  switch (op) {
    case "+": return "add";
    case "-": return "sub";
    case "*": return "mul";
    case "/": return "div";
    case "==": return "eqInt";
    case "!=": return "neInt";
    case "<": return "ltInt";
    case ">": return "gtInt";
    case "<=": return "leInt";
    case ">=": return "geInt";
    case "&&": return "and";
    case "||": return "or";
    default: return null;
  }
}

function mapUnaryOpToPrim(op: string): PrimOp | null {
  switch (op) {
    case "!": return "not";
    default: return null;
  }
}
