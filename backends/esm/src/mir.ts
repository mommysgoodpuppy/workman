// MIR: Backend-agnostic, ANF-style intermediate representation
// Closure-converted, explicit control flow, portable across targets

/**
 * MIR Value types (abstract, no layout assumptions)
 */
export type MirValueType =
  | { kind: "mir_int" }
  | { kind: "mir_bool" }
  | { kind: "mir_char" }
  | { kind: "mir_string" }
  | { kind: "mir_unit" }
  | { kind: "mir_tuple"; elements: MirValueType[] }
  | { kind: "mir_closure" }
  | { kind: "mir_adt"; typeName: string };

/**
 * MIR Variable (SSA-style naming)
 */
export interface MirVar {
  name: string;
  type: MirValueType;
}

/**
 * MIR Instructions (within basic blocks)
 */
export type MirInstr =
  | MirConst
  | MirPrim
  | MirMakeTuple
  | MirGetTuple
  | MirMakeClosure
  | MirCall
  | MirTailCall
  | MirAllocCtor
  | MirGetTag
  | MirGetField
  | MirIfElse;

export interface MirConst {
  kind: "mir_const";
  dest: string; // Destination variable
  value: MirConstValue;
}

export type MirConstValue =
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "char"; value: string }
  | { kind: "string"; value: string }
  | { kind: "unit" };

export interface MirPrim {
  kind: "mir_prim";
  dest: string;
  op: PrimOp;
  args: string[]; // Variable names
}

export type PrimOp =
  // Arithmetic
  | "add"
  | "sub"
  | "mul"
  | "div"
  // Comparisons
  | "cmpInt"
  | "charEq"
  | "eqInt"
  | "neInt"
  | "ltInt"
  | "gtInt"
  | "leInt"
  | "geInt"
  // Boolean
  | "and"
  | "or"
  | "not"
  // IO
  | "print";

export interface MirMakeTuple {
  kind: "mir_make_tuple";
  dest: string;
  args: string[];
}

export interface MirGetTuple {
  kind: "mir_get_tuple";
  dest: string;
  tuple: string;
  index: number;
}

export interface MirMakeClosure {
  kind: "mir_make_closure";
  dest: string;
  funId: string; // Function name
  env: string; // Environment tuple variable
}

export interface MirCall {
  kind: "mir_call";
  dest: string;
  fun: string; // Variable holding function/closure
  args: string[];
}

export interface MirTailCall {
  kind: "mir_tailcall";
  fun: string; // Must be the current function for self-recursion
  args: string[];
}

export interface MirAllocCtor {
  kind: "mir_alloc_ctor";
  dest: string;
  tag: number; // Numeric tag from tag table
  fields: string; // Variable holding fields tuple
}

export interface MirGetTag {
  kind: "mir_get_tag";
  dest: string;
  value: string;
}

export interface MirGetField {
  kind: "mir_get_field";
  dest: string;
  value: string;
  index: number;
}

export interface MirIfElse {
  kind: "mir_if_else";
  dest: string;
  condition: string; // Variable holding condition
  thenInstrs: MirInstr[];
  thenResult: string; // Variable holding then result
  elseInstrs: MirInstr[];
  elseResult: string; // Variable holding else result
}

/**
 * Control flow terminators
 */
export type MirTerminator =
  | MirReturn
  | MirBranch
  | MirSwitch;

export interface MirReturn {
  kind: "mir_return";
  value: string;
}

export interface MirBranch {
  kind: "mir_branch";
  target: string; // Basic block label
}

export interface MirSwitch {
  kind: "mir_switch";
  value: string; // Variable to switch on
  cases: Array<{ value: number; target: string }>; // Tag/literal -> block
  default?: string; // Default block (for non-exhaustive or wildcard)
}

/**
 * Basic Block
 */
export interface MirBasicBlock {
  label: string;
  instructions: MirInstr[];
  terminator: MirTerminator;
}

/**
 * MIR Function
 */
export interface MirFunction {
  name: string;
  params: string[]; // Parameter variable names
  env?: string; // Environment parameter (for closures)
  blocks: MirBasicBlock[];
  isSelfRecursive: boolean; // For tail-call optimization
}

/**
 * Tag table for ADT
 */
export interface MirTagTable {
  typeName: string;
  constructors: Array<{
    name: string;
    tag: number;
  }>;
}

/**
 * MIR Program
 */
export interface MirProgram {
  tagTables: MirTagTable[];
  localTagTables?: MirTagTable[];
  functions: MirFunction[];
  exports: MirExport[];
}

export interface MirExport {
  kind: "value" | "type";
  name: string;
  // For type exports, also export constructors
  constructors?: string[]; // Constructor names
}

/**
 * Helper: Create a fresh variable name
 */
let varCounter = 0;
export function freshVar(prefix: string = "t"): string {
  return `${prefix}${varCounter++}`;
}

export function resetVarCounter(): void {
  varCounter = 0;
}
