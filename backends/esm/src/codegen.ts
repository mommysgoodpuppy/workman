// MIR → ESM JavaScript code generation

import type {
  MirProgram,
  MirFunction,
  MirBasicBlock,
  MirInstr,
  MirTerminator,
  MirTagTable,
  PrimOp,
} from "./mir.ts";
import { generateRuntimeCode, ORDERING_TAG_TABLE } from "./runtime.ts";

/**
 * Generate ESM JavaScript code from MIR program
 */
export function generateESM(mir: MirProgram): string {
  const lines: string[] = [];

  // Emit runtime helpers
  const hasOrdering = mir.tagTables.some((t) => t.typeName === "Ordering");
  lines.push(generateRuntimeCode(hasOrdering));
  lines.push("");

  // Emit tag tables and constructors
  for (const tagTable of mir.tagTables) {
    if (tagTable.typeName === "Ordering") {
      lines.push(ORDERING_TAG_TABLE);
    } else {
      lines.push(generateTagTable(tagTable));
    }
    lines.push("");
    
    // Emit constructor functions
    lines.push(...generateConstructorFunctions(tagTable));
    lines.push("");
  }

  // Emit functions
  for (const func of mir.functions) {
    lines.push(generateFunction(func));
    lines.push("");
  }

  // Emit exports
  for (const exp of mir.exports) {
    if (exp.kind === "value") {
      lines.push(`export { ${exp.name} };`);
    } else if (exp.kind === "type") {
      // Export tag table and constructors
      lines.push(`export { Tag_${exp.name} };`);
      if (exp.constructors) {
        for (const ctor of exp.constructors) {
          lines.push(`export { ${ctor} };`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate a tag table as a JavaScript object
 */
function generateTagTable(tagTable: MirTagTable): string {
  const entries = tagTable.constructors
    .map((ctor) => `  ${ctor.name}: ${ctor.tag}`)
    .join(",\n");
  return `const Tag_${tagTable.typeName} = {\n${entries}\n};`;
}

/**
 * Generate a function from MIR
 */
function generateFunction(func: MirFunction): string {
  const lines: string[] = [];

  // Function signature
  const params = func.env ? [func.env, ...func.params] : func.params;
  lines.push(`function ${func.name}(${params.join(", ")}) {`);

  // If self-recursive, wrap in a loop for tail-call optimization
  if (func.isSelfRecursive) {
    lines.push("  for (;;) {");
    
    // Emit blocks
    for (const block of func.blocks) {
      lines.push(...generateBlock(block, func.name, true).map((l) => "    " + l));
    }
    
    lines.push("  }");
  } else {
    // Emit blocks normally
    for (const block of func.blocks) {
      lines.push(...generateBlock(block, func.name, false).map((l) => "  " + l));
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate a basic block
 */
function generateBlock(
  block: MirBasicBlock,
  functionName: string,
  inLoop: boolean
): string[] {
  const lines: string[] = [];

  // Block label (as comment for readability)
  if (block.label !== "entry") {
    lines.push(`// ${block.label}`);
  }

  // Emit instructions
  for (const instr of block.instructions) {
    lines.push(generateInstruction(instr));
  }

  // Emit terminator
  lines.push(...generateTerminator(block.terminator, functionName, inLoop));

  return lines;
}

/**
 * Generate an instruction
 */
function generateInstruction(instr: MirInstr): string {
  switch (instr.kind) {
    case "mir_const": {
      const value = generateConstValue(instr.value);
      return `const ${instr.dest} = ${value};`;
    }

    case "mir_prim": {
      const op = generatePrimOp(instr.op, instr.args);
      return `const ${instr.dest} = ${op};`;
    }

    case "mir_make_tuple": {
      const elements = instr.args.join(", ");
      return `const ${instr.dest} = [${elements}];`;
    }

    case "mir_get_tuple": {
      return `const ${instr.dest} = ${instr.tuple}[${instr.index}];`;
    }

    case "mir_make_closure": {
      return `const ${instr.dest} = WM.mk_closure(${instr.funId}, ${instr.env});`;
    }

    case "mir_call": {
      const args = instr.args.join(", ");
      return `const ${instr.dest} = ${instr.fun}(${args});`;
    }

    case "mir_tailcall": {
      // This should be handled by the terminator in a loop
      throw new Error("Tail calls should be handled by terminator");
    }

    case "mir_alloc_ctor": {
      return `const ${instr.dest} = WM.mk(${instr.tag}, ...${instr.fields});`;
    }

    case "mir_get_tag": {
      return `const ${instr.dest} = WM.getTag(${instr.value});`;
    }

    case "mir_get_field": {
      return `const ${instr.dest} = WM.getField(${instr.value}, ${instr.index});`;
    }

    case "mir_if_else": {
      const lines: string[] = [];
      lines.push(`let ${instr.dest};`);
      lines.push(`if (${instr.condition}) {`);
      for (const thenInstr of instr.thenInstrs) {
        lines.push("  " + generateInstruction(thenInstr));
      }
      lines.push(`  ${instr.dest} = ${instr.thenResult};`);
      lines.push(`} else {`);
      for (const elseInstr of instr.elseInstrs) {
        lines.push("  " + generateInstruction(elseInstr));
      }
      lines.push(`  ${instr.dest} = ${instr.elseResult};`);
      lines.push(`}`);
      return lines.join("\n");
    }

    default:
      throw new Error(`Unsupported instruction: ${(instr as any).kind}`);
  }
}

/**
 * Generate a constant value
 */
function generateConstValue(value: any): string {
  switch (value.kind) {
    case "int":
      return String(value.value);
    case "bool":
      return String(value.value);
    case "char":
      return String(value.value); // Character as code point
    case "string":
      return JSON.stringify(value.value);
    case "unit":
      return "WM.unit";
    default:
      throw new Error(`Unsupported constant kind: ${value.kind}`);
  }
}

/**
 * Generate a primitive operation
 */
function generatePrimOp(op: PrimOp, args: string[]): string {
  switch (op) {
    case "add":
      return `WM.add(${args[0]}, ${args[1]})`;
    case "sub":
      return `WM.sub(${args[0]}, ${args[1]})`;
    case "mul":
      return `WM.mul(${args[0]}, ${args[1]})`;
    case "div":
      return `WM.div(${args[0]}, ${args[1]})`;
    case "cmpInt":
      return `WM.cmpInt(${args[0]}, ${args[1]})`;
    case "charEq":
      return `WM.charEq(${args[0]}, ${args[1]})`;
    case "eqInt":
      return `WM.eqInt(${args[0]}, ${args[1]})`;
    case "neInt":
      return `WM.neInt(${args[0]}, ${args[1]})`;
    case "ltInt":
      return `WM.ltInt(${args[0]}, ${args[1]})`;
    case "gtInt":
      return `WM.gtInt(${args[0]}, ${args[1]})`;
    case "leInt":
      return `WM.leInt(${args[0]}, ${args[1]})`;
    case "geInt":
      return `WM.geInt(${args[0]}, ${args[1]})`;
    case "and":
      return `WM.and(${args[0]}, ${args[1]})`;
    case "or":
      return `WM.or(${args[0]}, ${args[1]})`;
    case "not":
      return `WM.not(${args[0]})`;
    case "print":
      return `WM.print(${args[0]})`;
    default:
      throw new Error(`Unsupported primitive operation: ${op}`);
  }
}

/**
 * Generate a terminator
 */
function generateTerminator(
  term: MirTerminator,
  functionName: string,
  inLoop: boolean
): string[] {
  const lines: string[] = [];

  switch (term.kind) {
    case "mir_return":
      lines.push(`return ${term.value};`);
      break;

    case "mir_branch":
      // For now, branches are implicit (fall through to next block)
      // In a real implementation, we'd need proper goto/label handling
      lines.push(`// branch to ${term.target}`);
      break;

    case "mir_switch": {
      lines.push(`switch (${term.value}) {`);
      for (const switchCase of term.cases) {
        lines.push(`  case ${switchCase.value}:`);
        lines.push(`    // goto ${switchCase.target}`);
        lines.push(`    break;`);
      }
      if (term.default) {
        lines.push(`  default:`);
        lines.push(`    // goto ${term.default}`);
        lines.push(`    break;`);
      }
      lines.push(`}`);
      break;
    }

    default:
      throw new Error(`Unsupported terminator: ${(term as any).kind}`);
  }

  return lines;
}

/**
 * Simplified codegen for single-block functions (most common case)
 */
export function generateSimpleFunction(func: MirFunction): string {
  if (func.blocks.length !== 1) {
    return generateFunction(func);
  }

  const block = func.blocks[0];
  const lines: string[] = [];

  // Function signature
  const params = func.env ? [func.env, ...func.params] : func.params;
  lines.push(`function ${func.name}(${params.join(", ")}) {`);

  // Emit instructions
  for (const instr of block.instructions) {
    lines.push("  " + generateInstruction(instr));
  }

  // Emit return
  if (block.terminator.kind === "mir_return") {
    lines.push(`  return ${block.terminator.value};`);
  } else {
    lines.push("  " + generateTerminator(block.terminator, func.name, false).join("\n  "));
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate constructor helper functions
 * For M1, we infer arity from constructor usage in the program
 */
function generateConstructorFunctions(tagTable: MirTagTable): string[] {
  const lines: string[] = [];

  for (const ctor of tagTable.constructors) {
    // For M1, we'll generate nullary constructors as constants
    // and assume all others take at least one argument
    // This is a simplification - proper arity tracking would be better
    
    // Check if constructor name suggests nullary (common patterns: None, Empty, Nil, etc.)
    const isNullary = ["None", "Empty", "Nil", "Nothing", "LT", "EQ", "GT"].includes(ctor.name);
    
    if (isNullary) {
      // Nullary constructor - just a constant
      lines.push(`const ${ctor.name} = WM.mk(Tag_${tagTable.typeName}.${ctor.name});`);
    } else {
      // Constructor function - use rest parameters to accept any arity
      lines.push(
        `function ${ctor.name}(...args) { return WM.mk(Tag_${tagTable.typeName}.${ctor.name}, ...args); }`
      );
    }
  }

  return lines;
}
