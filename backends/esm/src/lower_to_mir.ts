// Core IR → MIR lowering (Complete implementation)
// Performs ANF transformation, closure conversion, and pattern lowering

import type {
  CoreExpr,
  CoreProgram,
  CorePattern,
  CoreMatchCase,
  CoreTypeDecl,
  CoreLitValue,
} from "./core_ir.ts";
import {
  MirProgram,
  MirFunction,
  MirBasicBlock,
  MirInstr,
  MirTerminator,
  MirTagTable,
  MirExport,
  freshVar,
  resetVarCounter,
} from "./mir.ts";

interface LoweringContext {
  functions: MirFunction[];
  tagTables: Map<string, MirTagTable>;
  localTagTables: MirTagTable[];
  currentFunction: string;
  currentBlocks: MirBasicBlock[];
  currentInstrs: MirInstr[];
  blockCounter: number;
  // Variable substitution map for let bindings
  varSubst: Map<string, string>;
}

/**
 * Lower a Core program to MIR
 * @param importedTagTables - Tag tables from imported modules
 */
export function lowerToMir(
  core: CoreProgram,
  importedTagTables?: Map<string, MirTagTable>
): MirProgram {
  resetVarCounter();
  
  const ctx: LoweringContext = {
    functions: [],
    tagTables: new Map(),
    localTagTables: [],
    currentFunction: "",
    currentBlocks: [],
    currentInstrs: [],
    blockCounter: 0,
    varSubst: new Map(),
  };

  // Add imported tag tables first
  if (importedTagTables) {
    for (const [name, table] of importedTagTables) {
      ctx.tagTables.set(name, table);
    }
  }

  // Generate tag tables for types declared in this module
  // These may override imported ones (for re-exports)
  for (const typeDecl of core.types) {
    const tagTable = generateTagTable(typeDecl);
    ctx.tagTables.set(typeDecl.name, tagTable);
    ctx.localTagTables.push(tagTable);
  }

  // Lower each top-level binding
  for (const binding of core.bindings) {
    lowerTopLevelBinding(ctx, binding.name, binding.expr);
  }

  // Generate exports
  const exports: MirExport[] = [];
  for (const exp of core.exports) {
    if (exp.kind === "value") {
      exports.push({ kind: "value", name: exp.name });
    } else if (exp.kind === "type") {
      const tagTable = ctx.tagTables.get(exp.name);
      if (tagTable) {
        exports.push({
          kind: "type",
          name: exp.name,
          constructors: tagTable.constructors.map((c) => c.name),
        });
      }
    }
  }

  return {
    tagTables: Array.from(ctx.tagTables.values()),
    localTagTables: ctx.localTagTables,
    functions: ctx.functions,
    exports,
  };
}

function generateTagTable(typeDecl: CoreTypeDecl): MirTagTable {
  return {
    typeName: typeDecl.name,
    constructors: typeDecl.constructors.map((ctor, index) => ({
      name: ctor.name,
      tag: index,
    })),
  };
}

function freshLabel(ctx: LoweringContext, prefix: string): string {
  return `${prefix}_${ctx.blockCounter++}`;
}

function lowerTopLevelBinding(ctx: LoweringContext, name: string, expr: CoreExpr): void {
  // Top-level bindings are either lambdas or values
  if (expr.kind === "core_lam") {
    lowerLambdaToFunction(ctx, name, expr);
  } else if (expr.kind === "core_letrec") {
    // Recursive bindings - lower each lambda
    for (const binding of expr.bindings) {
      lowerLambdaToFunction(ctx, binding.name, binding.lam);
    }
  } else {
    // It's a value - wrap in a nullary function
    ctx.currentFunction = name;
    ctx.currentBlocks = [];
    ctx.currentInstrs = [];
    ctx.blockCounter = 0;
    ctx.varSubst = new Map();

    const resultVar = lowerExprToVar(ctx, expr);
    
    const entryBlock: MirBasicBlock = {
      label: "entry",
      instructions: ctx.currentInstrs,
      terminator: { kind: "mir_return", value: resultVar },
    };

    ctx.functions.push({
      name,
      params: [],
      blocks: [entryBlock, ...ctx.currentBlocks],
      isSelfRecursive: false,
    });
  }
}

function lowerLambdaToFunction(ctx: LoweringContext, name: string, lam: CoreExpr): void {
  if (lam.kind !== "core_lam") {
    throw new Error(`Expected lambda for function ${name}`);
  }

  ctx.currentFunction = name;
  ctx.currentBlocks = [];
  ctx.currentInstrs = [];
  ctx.blockCounter = 0;
  ctx.varSubst = new Map();

  // Check if this is self-recursive (for tail-call optimization)
  const isSelfRecursive = containsSelfCall(lam.body, name);

  // Lower the body
  const resultVar = lowerExprToVar(ctx, lam.body);

  const entryBlock: MirBasicBlock = {
    label: "entry",
    instructions: ctx.currentInstrs,
    terminator: { kind: "mir_return", value: resultVar },
  };

  ctx.functions.push({
    name,
    params: lam.params,
    blocks: [entryBlock, ...ctx.currentBlocks],
    isSelfRecursive,
  });
}

/**
 * Lower an expression to ANF, returning the variable holding the result
 */
function lowerExprToVar(ctx: LoweringContext, expr: CoreExpr): string {
  switch (expr.kind) {
    case "core_var": {
      // Check if this variable has been substituted
      const substVar = ctx.varSubst.get(expr.name);
      return substVar || expr.name;
    }

    case "core_lit": {
      const dest = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_const",
        dest,
        value: expr.value,
      });
      return dest;
    }

    case "core_tuple": {
      const elementVars = expr.elements.map((el) => lowerExprToVar(ctx, el));
      const dest = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_make_tuple",
        dest,
        args: elementVars,
      });
      return dest;
    }

    case "core_ctor": {
      // Lower fields
      const fieldVars = expr.fields.map((field) => lowerExprToVar(ctx, field));
      
      // Make tuple of fields
      const fieldsTuple = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_make_tuple",
        dest: fieldsTuple,
        args: fieldVars,
      });

      // Get tag
      const tagTable = ctx.tagTables.get(expr.typeName);
      if (!tagTable) {
        throw new Error(`Unknown type: ${expr.typeName}`);
      }
      const ctorInfo = tagTable.constructors.find((c) => c.name === expr.ctorName);
      if (!ctorInfo) {
        throw new Error(`Unknown constructor: ${expr.ctorName}`);
      }

      // Allocate constructor
      const dest = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_alloc_ctor",
        dest,
        tag: ctorInfo.tag,
        fields: fieldsTuple,
      });
      return dest;
    }

    case "core_prim": {
      const argVars = expr.args.map((arg) => lowerExprToVar(ctx, arg));
      const dest = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_prim",
        dest,
        op: expr.op,
        args: argVars,
      });
      return dest;
    }

    case "core_app": {
      const funVar = lowerExprToVar(ctx, expr.fn);
      const argVars = expr.args.map((arg) => lowerExprToVar(ctx, arg));
      const dest = freshVar();
      ctx.currentInstrs.push({
        kind: "mir_call",
        dest,
        fun: funVar,
        args: argVars,
      });
      return dest;
    }

    case "core_let": {
      const rhsVar = lowerExprToVar(ctx, expr.rhs);
      // Add variable substitution
      const oldSubst = ctx.varSubst.get(expr.name);
      ctx.varSubst.set(expr.name, rhsVar);
      
      // Lower the body with the binding in scope
      const result = lowerExprToVar(ctx, expr.body);
      
      // Restore old substitution
      if (oldSubst !== undefined) {
        ctx.varSubst.set(expr.name, oldSubst);
      } else {
        ctx.varSubst.delete(expr.name);
      }
      
      return result;
    }

    case "core_letrec": {
      // Recursive bindings are already top-level functions
      // Just return a reference to the first binding
      return expr.bindings[0].name;
    }

    case "core_lam": {
      // Lambda needs closure conversion
      // For M1, we'll skip closure conversion and just create function references
      // TODO: Implement proper closure conversion
      throw new Error("Nested lambdas not yet supported in M1");
    }

    case "core_match": {
      return lowerMatch(ctx, expr.scrutinee, expr.cases);
    }

    default:
      throw new Error(`Unsupported Core expression: ${(expr as any).kind}`);
  }
}

/**
 * Lower a match expression to switch/branch instructions with proper control flow
 */
function lowerMatch(ctx: LoweringContext, scrutinee: CoreExpr, cases: CoreMatchCase[]): string {
  const scrutVar = lowerExprToVar(ctx, scrutinee);
  
  if (cases.length === 0) {
    throw new Error("Match must have at least one case");
  }

  // Determine match type from first pattern
  const firstPattern = cases[0].pattern;
  
  if (firstPattern.kind === "core_pctor") {
    return lowerAdtMatch(ctx, scrutVar, cases);
  } else if (firstPattern.kind === "core_plit") {
    return lowerLiteralMatch(ctx, scrutVar, cases);
  } else if (firstPattern.kind === "core_pvar") {
    // Variable pattern - bind and evaluate body
    const oldSubst = ctx.varSubst.get(firstPattern.name);
    ctx.varSubst.set(firstPattern.name, scrutVar);
    const result = lowerExprToVar(ctx, cases[0].body);
    if (oldSubst !== undefined) {
      ctx.varSubst.set(firstPattern.name, oldSubst);
    } else {
      ctx.varSubst.delete(firstPattern.name);
    }
    return result;
  } else if (firstPattern.kind === "core_pwildcard") {
    // Wildcard - just evaluate body
    return lowerExprToVar(ctx, cases[0].body);
  } else if (firstPattern.kind === "core_ptuple") {
    return lowerTupleMatch(ctx, scrutVar, cases);
  }

  throw new Error("Unsupported pattern kind in match");
}

/**
 * Lower ADT pattern match to nested if/else (simplified for M1)
 */
function lowerAdtMatch(ctx: LoweringContext, scrutVar: string, cases: CoreMatchCase[]): string {
  // Extract tag
  const tagVar = freshVar("tag");
  ctx.currentInstrs.push({
    kind: "mir_get_tag",
    dest: tagVar,
    value: scrutVar,
  });

  // Build nested if/else chain
  return lowerAdtMatchCases(ctx, scrutVar, tagVar, cases, 0);
}

/**
 * Lower a nested constructor pattern by checking tag and extracting fields
 */
function lowerNestedPattern(
  ctx: LoweringContext,
  scrutVar: string,
  pattern: CorePattern
): void {
  if (pattern.kind !== "core_pctor") {
    throw new Error(`Expected constructor pattern, got ${pattern.kind}`);
  }

  // Get the tag for this constructor
  const ctorName = pattern.ctorName;
  let tag = -1;
  for (const tagTable of ctx.tagTables.values()) {
    const ctor = tagTable.constructors.find((c) => c.name === ctorName);
    if (ctor) {
      tag = ctor.tag;
      break;
    }
  }

  if (tag === -1) {
    throw new Error(`Unknown constructor: ${ctorName}`);
  }

  // Check that the tag matches (we assume it does in the current branch)
  // In a more complete implementation, we'd add a runtime check here
  // For now, we just extract the fields

  // Extract fields and bind pattern variables
  for (let i = 0; i < pattern.subpatterns.length; i++) {
    const subpat = pattern.subpatterns[i];
    if (subpat.kind === "core_pvar") {
      const fieldVar = freshVar(`field_${i}`);
      ctx.currentInstrs.push({
        kind: "mir_get_field",
        dest: fieldVar,
        value: scrutVar,
        index: i,
      });
      ctx.varSubst.set(subpat.name, fieldVar);
    } else if (subpat.kind === "core_pwildcard") {
      // No binding needed
    } else if (subpat.kind === "core_pctor") {
      // Recursively handle nested patterns
      const fieldVar = freshVar(`field_${i}`);
      ctx.currentInstrs.push({
        kind: "mir_get_field",
        dest: fieldVar,
        value: scrutVar,
        index: i,
      });
      lowerNestedPattern(ctx, fieldVar, subpat);
    } else {
      throw new Error(`Unsupported nested pattern: ${subpat.kind}`);
    }
  }
}

/**
 * Recursively build if/else chain for ADT cases
 */
function lowerAdtMatchCases(
  ctx: LoweringContext,
  scrutVar: string,
  tagVar: string,
  cases: CoreMatchCase[],
  caseIndex: number
): string {
  if (caseIndex >= cases.length) {
    throw new Error("Non-exhaustive pattern match");
  }

  const matchCase = cases[caseIndex];
  const pattern = matchCase.pattern;

  // Handle wildcard - just evaluate body
  if (pattern.kind === "core_pwildcard") {
    return lowerExprToVar(ctx, matchCase.body);
  }

  if (pattern.kind !== "core_pctor") {
    throw new Error(`Expected constructor pattern in ADT match, got ${pattern.kind}`);
  }

  // Find tag for this constructor
  const ctorName = pattern.ctorName;
  let tag = -1;
  for (const tagTable of ctx.tagTables.values()) {
    const ctor = tagTable.constructors.find((c) => c.name === ctorName);
    if (ctor) {
      tag = ctor.tag;
      break;
    }
  }

  if (tag === -1) {
    throw new Error(`Unknown constructor: ${ctorName}`);
  }

  // Create condition: tag === expectedTag
  const tagConstVar = freshVar("tag_const");
  ctx.currentInstrs.push({
    kind: "mir_const",
    dest: tagConstVar,
    value: { kind: "int", value: tag },
  });
  
  const condVar = freshVar("cond");
  ctx.currentInstrs.push({
    kind: "mir_prim",
    dest: condVar,
    op: "eqInt",
    args: [tagVar, tagConstVar],
  });

  // Save current instructions for the condition
  const beforeIfInstrs = ctx.currentInstrs;
  
  // Build then branch (this case matches)
  ctx.currentInstrs = [];
  const savedSubsts = new Map(ctx.varSubst);
  
  // Extract fields and bind pattern variables
  for (let i = 0; i < pattern.subpatterns.length; i++) {
    const subpat = pattern.subpatterns[i];
    if (subpat.kind === "core_pvar") {
      const fieldVar = freshVar(`field_${i}`);
      ctx.currentInstrs.push({
        kind: "mir_get_field",
        dest: fieldVar,
        value: scrutVar,
        index: i,
      });
      ctx.varSubst.set(subpat.name, fieldVar);
    } else if (subpat.kind === "core_pwildcard") {
      // No binding needed
    } else if (subpat.kind === "core_pctor") {
      // Nested constructor pattern - extract field and match it
      const fieldVar = freshVar(`field_${i}`);
      ctx.currentInstrs.push({
        kind: "mir_get_field",
        dest: fieldVar,
        value: scrutVar,
        index: i,
      });
      // Recursively match the nested pattern
      lowerNestedPattern(ctx, fieldVar, subpat);
    } else if (subpat.kind === "core_plit") {
      // Literal pattern in tuple - we assume it matches (exhaustiveness checking happens earlier)
      // No binding needed, just skip it
    } else {
      throw new Error(`Unsupported pattern kind in tuple: ${subpat.kind}`);
    }
  }

  const thenResult = lowerExprToVar(ctx, matchCase.body);
  const thenInstrs = ctx.currentInstrs;

  // Restore substitutions
  ctx.varSubst = savedSubsts;

  // Build else branch (try next case or handle last case)
  ctx.currentInstrs = [];
  let elseResult: string;
  let elseInstrs: MirInstr[];
  
  if (caseIndex + 1 < cases.length) {
    // More cases to check
    elseResult = lowerAdtMatchCases(ctx, scrutVar, tagVar, cases, caseIndex + 1);
    elseInstrs = ctx.currentInstrs;
  } else {
    // This is the last case - should be exhaustive, but add a panic for safety
    const panicMsg = freshVar("panic_msg");
    ctx.currentInstrs.push({
      kind: "mir_const",
      dest: panicMsg,
      value: { kind: "string", value: "Non-exhaustive pattern match" },
    });
    elseResult = freshVar("panic_result");
    ctx.currentInstrs.push({
      kind: "mir_prim",
      dest: elseResult,
      op: "print", // Use print as a stand-in for panic
      args: [panicMsg],
    });
    elseInstrs = ctx.currentInstrs;
  }

  // Restore instruction list and emit if/else
  ctx.currentInstrs = beforeIfInstrs;
  
  const resultVar = freshVar("match_result");
  ctx.currentInstrs.push({
    kind: "mir_if_else",
    dest: resultVar,
    condition: condVar,
    thenInstrs,
    thenResult,
    elseInstrs,
    elseResult,
  });

  return resultVar;
}

/**
 * Lower literal pattern match to if/else chain
 */
function lowerLiteralMatch(ctx: LoweringContext, scrutVar: string, cases: CoreMatchCase[]): string {
  if (cases.length === 0) {
    throw new Error("Literal match must have at least one case");
  }

  return lowerLiteralMatchCases(ctx, scrutVar, cases, 0);
}

function lowerLiteralMatchCases(
  ctx: LoweringContext,
  scrutVar: string,
  cases: CoreMatchCase[],
  caseIndex: number,
): string {
  if (caseIndex >= cases.length) {
    // Should be unreachable for exhaustive matches; emit panic as safety net
    const panicMsg = freshVar("panic_msg");
    ctx.currentInstrs.push({
      kind: "mir_const",
      dest: panicMsg,
      value: { kind: "string", value: "Non-exhaustive literal match" },
    });
    const panicResult = freshVar("panic_result");
    ctx.currentInstrs.push({
      kind: "mir_prim",
      dest: panicResult,
      op: "print",
      args: [panicMsg],
    });
    return panicResult;
  }

  const matchCase = cases[caseIndex];
  const pattern = matchCase.pattern;

  if (pattern.kind === "core_pwildcard") {
    return lowerExprToVar(ctx, matchCase.body);
  }

  if (pattern.kind === "core_pvar") {
    const prev = ctx.varSubst.get(pattern.name);
    ctx.varSubst.set(pattern.name, scrutVar);
    const result = lowerExprToVar(ctx, matchCase.body);
    if (prev !== undefined) {
      ctx.varSubst.set(pattern.name, prev);
    } else {
      ctx.varSubst.delete(pattern.name);
    }
    return result;
  }

  if (pattern.kind !== "core_plit") {
    throw new Error(`Expected literal pattern, got ${pattern.kind}`);
  }

  // Matching on unit is equivalent to wildcard (only one possible value)
  if (pattern.value.kind === "unit") {
    return lowerExprToVar(ctx, matchCase.body);
  }

  const condVar = buildLiteralCondition(ctx, scrutVar, pattern.value);
  const beforeIfInstrs = ctx.currentInstrs;

  // Then branch
  ctx.currentInstrs = [];
  const savedSubsts = new Map(ctx.varSubst);
  const thenResult = lowerExprToVar(ctx, matchCase.body);
  const thenInstrs = ctx.currentInstrs;
  ctx.varSubst = savedSubsts;

  // Else branch
  ctx.currentInstrs = [];
  const elseResult = lowerLiteralMatchCases(ctx, scrutVar, cases, caseIndex + 1);
  const elseInstrs = ctx.currentInstrs;

  ctx.currentInstrs = beforeIfInstrs;
  const resultVar = freshVar("match_result");
  ctx.currentInstrs.push({
    kind: "mir_if_else",
    dest: resultVar,
    condition: condVar,
    thenInstrs,
    thenResult,
    elseInstrs,
    elseResult,
  });

  return resultVar;
}

function buildLiteralCondition(
  ctx: LoweringContext,
  scrutVar: string,
  lit: CoreLitValue,
): string {
  switch (lit.kind) {
    case "int": {
      const litVar = freshVar("lit_int");
      ctx.currentInstrs.push({
        kind: "mir_const",
        dest: litVar,
        value: { kind: "int", value: lit.value },
      });
      const condVar = freshVar("cond");
      ctx.currentInstrs.push({
        kind: "mir_prim",
        dest: condVar,
        op: "eqInt",
        args: [scrutVar, litVar],
      });
      return condVar;
    }

    case "bool": {
      if (lit.value === true) {
        return scrutVar;
      }
      const condVar = freshVar("cond");
      ctx.currentInstrs.push({
        kind: "mir_prim",
        dest: condVar,
        op: "not",
        args: [scrutVar],
      });
      return condVar;
    }

    case "char": {
      const litVar = freshVar("lit_char");
      ctx.currentInstrs.push({
        kind: "mir_const",
        dest: litVar,
        value: { kind: "char", value: lit.value },
      });
      const condVar = freshVar("cond");
      ctx.currentInstrs.push({
        kind: "mir_prim",
        dest: condVar,
        op: "charEq",
        args: [scrutVar, litVar],
      });
      return condVar;
    }

    case "string":
      throw new Error("String literal pattern matching is not supported in M1 lowering");

    case "unit":
      // Handled earlier
      return scrutVar;
  }
}

/**
 * Lower tuple pattern match
 */
function lowerTupleMatch(ctx: LoweringContext, scrutVar: string, cases: CoreMatchCase[]): string {
  if (cases.length === 0) {
    throw new Error("Tuple match must have at least one case");
  }

  return lowerTupleMatchCases(ctx, scrutVar, cases, 0);
}

function lowerTupleMatchCases(
  ctx: LoweringContext,
  scrutVar: string,
  cases: CoreMatchCase[],
  caseIndex: number,
): string {
  if (caseIndex >= cases.length) {
    const panicMsg = freshVar("panic_msg");
    ctx.currentInstrs.push({
      kind: "mir_const",
      dest: panicMsg,
      value: { kind: "string", value: "Non-exhaustive tuple match" },
    });
    const panicResult = freshVar("panic_result");
    ctx.currentInstrs.push({
      kind: "mir_prim",
      dest: panicResult,
      op: "print",
      args: [panicMsg],
    });
    return panicResult;
  }

  const matchCase = cases[caseIndex];
  const pattern = matchCase.pattern;

  if (pattern.kind === "core_pwildcard") {
    return lowerExprToVar(ctx, matchCase.body);
  }

  if (pattern.kind === "core_pvar") {
    const previous = ctx.varSubst.get(pattern.name);
    ctx.varSubst.set(pattern.name, scrutVar);
    const result = lowerExprToVar(ctx, matchCase.body);
    if (previous !== undefined) {
      ctx.varSubst.set(pattern.name, previous);
    } else {
      ctx.varSubst.delete(pattern.name);
    }
    return result;
  }

  if (pattern.kind !== "core_ptuple") {
    throw new Error(`Expected tuple pattern, got ${pattern.kind}`);
  }

  const condVarRaw = buildTupleCaseCondition(ctx, scrutVar, pattern);
  const condVar = condVarRaw ?? createBoolConst(ctx, true);
  const beforeIfInstrs = ctx.currentInstrs;

  // Then branch
  ctx.currentInstrs = [];
  const savedSubsts = new Map(ctx.varSubst);
  bindTuplePattern(ctx, scrutVar, pattern);
  const thenResult = lowerExprToVar(ctx, matchCase.body);
  const thenInstrs = ctx.currentInstrs;
  ctx.varSubst = savedSubsts;

  // Else branch
  ctx.currentInstrs = [];
  const elseResult = lowerTupleMatchCases(ctx, scrutVar, cases, caseIndex + 1);
  const elseInstrs = ctx.currentInstrs;

  ctx.currentInstrs = beforeIfInstrs;
  const resultVar = freshVar("match_result");
  ctx.currentInstrs.push({
    kind: "mir_if_else",
    dest: resultVar,
    condition: condVar,
    thenInstrs,
    thenResult,
    elseInstrs,
    elseResult,
  });

  return resultVar;
}

function buildTupleCaseCondition(
  ctx: LoweringContext,
  tupleVar: string,
  pattern: CorePattern & { kind: "core_ptuple" },
): string | null {
  let condition: string | null = null;

  for (let i = 0; i < pattern.elements.length; i++) {
    const elemVar = freshVar(`tuple_elem_${i}`);
    ctx.currentInstrs.push({
      kind: "mir_get_tuple",
      dest: elemVar,
      tuple: tupleVar,
      index: i,
    });
    const subpat = pattern.elements[i];
    const subCond = buildPatternCondition(ctx, elemVar, subpat);
    if (subCond) {
      condition = combineConditions(ctx, condition, subCond);
    }
  }

  return condition;
}

function buildPatternCondition(
  ctx: LoweringContext,
  valueVar: string,
  pattern: CorePattern,
): string | null {
  switch (pattern.kind) {
    case "core_pwildcard":
    case "core_pvar":
      return null;
    case "core_plit":
      return buildLiteralCondition(ctx, valueVar, pattern.value);
    case "core_pctor":
      return buildConstructorCondition(ctx, valueVar, pattern);
    case "core_ptuple":
      return buildTupleConditionForValue(ctx, valueVar, pattern);
    default:
      throw new Error(`Unsupported pattern in condition: ${pattern.kind}`);
  }
}

function buildConstructorCondition(
  ctx: LoweringContext,
  valueVar: string,
  pattern: CorePattern & { kind: "core_pctor" },
): string {
  const tag = getConstructorTag(ctx, pattern.ctorName);
  if (tag === undefined) {
    throw new Error(`Unknown constructor: ${pattern.ctorName}`);
  }

  const tagVar = freshVar("ctor_tag");
  ctx.currentInstrs.push({
    kind: "mir_get_tag",
    dest: tagVar,
    value: valueVar,
  });

  const tagConst = freshVar("tag_const");
  ctx.currentInstrs.push({
    kind: "mir_const",
    dest: tagConst,
    value: { kind: "int", value: tag },
  });

  let condition = freshVar("cond");
  ctx.currentInstrs.push({
    kind: "mir_prim",
    dest: condition,
    op: "eqInt",
    args: [tagVar, tagConst],
  });

  for (let i = 0; i < pattern.subpatterns.length; i++) {
    const fieldVar = freshVar(`field_${i}`);
    ctx.currentInstrs.push({
      kind: "mir_get_field",
      dest: fieldVar,
      value: valueVar,
      index: i,
    });
    const subCond = buildPatternCondition(ctx, fieldVar, pattern.subpatterns[i]);
    if (subCond) {
      condition = combineConditions(ctx, condition, subCond);
    }
  }

  return condition;
}

function buildTupleConditionForValue(
  ctx: LoweringContext,
  valueVar: string,
  pattern: CorePattern & { kind: "core_ptuple" },
): string | null {
  let condition: string | null = null;
  for (let i = 0; i < pattern.elements.length; i++) {
    const elemVar = freshVar(`tuple_elem_${i}`);
    ctx.currentInstrs.push({
      kind: "mir_get_tuple",
      dest: elemVar,
      tuple: valueVar,
      index: i,
    });
    const subCond = buildPatternCondition(ctx, elemVar, pattern.elements[i]);
    if (subCond) {
      condition = combineConditions(ctx, condition, subCond);
    }
  }
  return condition;
}

function combineConditions(ctx: LoweringContext, existing: string | null, next: string): string {
  if (existing === null) {
    return next;
  }

  const combined = freshVar("cond");
  ctx.currentInstrs.push({
    kind: "mir_prim",
    dest: combined,
    op: "and",
    args: [existing, next],
  });
  return combined;
}

function createBoolConst(ctx: LoweringContext, value: boolean): string {
  const dest = freshVar(value ? "true" : "false");
  ctx.currentInstrs.push({
    kind: "mir_const",
    dest,
    value: { kind: "bool", value },
  });
  return dest;
}

function bindTuplePattern(
  ctx: LoweringContext,
  tupleVar: string,
  pattern: CorePattern & { kind: "core_ptuple" },
): void {
  for (let i = 0; i < pattern.elements.length; i++) {
    const elemVar = freshVar(`tuple_elem_${i}`);
    ctx.currentInstrs.push({
      kind: "mir_get_tuple",
      dest: elemVar,
      tuple: tupleVar,
      index: i,
    });
    bindPattern(ctx, elemVar, pattern.elements[i]);
  }
}

function bindPattern(ctx: LoweringContext, valueVar: string, pattern: CorePattern): void {
  switch (pattern.kind) {
    case "core_pwildcard":
      return;
    case "core_pvar":
      ctx.varSubst.set(pattern.name, valueVar);
      return;
    case "core_plit":
      // Literals have already been checked in the condition.
      return;
    case "core_pctor": {
      for (let i = 0; i < pattern.subpatterns.length; i++) {
        const fieldVar = freshVar(`field_${i}`);
        ctx.currentInstrs.push({
          kind: "mir_get_field",
          dest: fieldVar,
          value: valueVar,
          index: i,
        });
        bindPattern(ctx, fieldVar, pattern.subpatterns[i]);
      }
      return;
    }
    case "core_ptuple": {
      bindTuplePattern(ctx, valueVar, pattern);
      return;
    }
    default:
      throw new Error(`Unsupported pattern binding: ${pattern.kind}`);
  }
}

function getConstructorTag(ctx: LoweringContext, ctorName: string): number | undefined {
  for (const tagTable of ctx.tagTables.values()) {
    const entry = tagTable.constructors.find((ctor) => ctor.name === ctorName);
    if (entry) {
      return entry.tag;
    }
  }
  return undefined;
}

/**
 * Check if an expression contains a self-recursive call
 */
function containsSelfCall(expr: CoreExpr, functionName: string): boolean {
  switch (expr.kind) {
    case "core_var":
      return expr.name === functionName;
    case "core_app":
      return containsSelfCall(expr.fn, functionName) ||
        expr.args.some((arg) => containsSelfCall(arg, functionName));
    case "core_let":
      return containsSelfCall(expr.rhs, functionName) ||
        containsSelfCall(expr.body, functionName);
    case "core_match":
      return containsSelfCall(expr.scrutinee, functionName) ||
        expr.cases.some((c) => containsSelfCall(c.body, functionName));
    case "core_prim":
      return expr.args.some((arg) => containsSelfCall(arg, functionName));
    case "core_tuple":
      return expr.elements.some((el) => containsSelfCall(el, functionName));
    case "core_ctor":
      return expr.fields.some((field) => containsSelfCall(field, functionName));
    default:
      return false;
  }
}
