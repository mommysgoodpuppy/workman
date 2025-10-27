// Minimal runtime helpers for compiled Workman code
// These will be inlined into generated ESM modules

/**
 * Runtime value representations:
 * - Int: JS number
 * - Bool: JS boolean
 * - Char: JS number (code point)
 * - String: JS string
 * - Unit: undefined
 * - Tuple: JS array [v0, v1, ...]
 * - ADT: JS object { tag: number, _0?: any, _1?: any, ... }
 * - Closure: JS function (closure conversion handles env capture)
 */

export interface WMRuntime {
  // Unit value
  unit: undefined;
  
  // ADT construction and access
  mk(tag: number, ...fields: any[]): ADTValue;
  getTag(v: ADTValue): number;
  getField(v: ADTValue, i: number): any;
  
  // Tuple operations (may not be needed if we use arrays directly)
  tuple(...elements: any[]): any[];
  getTuple(t: any[], i: number): any;
  
  // Primitives
  add(a: number, b: number): number;
  sub(a: number, b: number): number;
  mul(a: number, b: number): number;
  div(a: number, b: number): number;
  cmpInt(a: number, b: number): ADTValue; // Returns Ordering ADT
  charEq(a: number, b: number): boolean;
  print(x: any): undefined;
  
  // Boolean operations (for M1 completeness)
  and(a: boolean, b: boolean): boolean;
  or(a: boolean, b: boolean): boolean;
  not(a: boolean): boolean;
  
  // Integer comparisons
  eqInt(a: number, b: number): boolean;
  neInt(a: number, b: number): boolean;
  ltInt(a: number, b: number): boolean;
  gtInt(a: number, b: number): boolean;
  leInt(a: number, b: number): boolean;
  geInt(a: number, b: number): boolean;
  
  // String operations
  strFromLiteral(str: string): ADTValue; // Converts JS string to List<Int>
  
  // Error handling
  panic(msg: string): never;
}

export interface ADTValue {
  tag: number;
  [key: string]: any; // _0, _1, _2, etc.
}

/**
 * Generate the runtime object as a string for inlining into compiled modules.
 * The Ordering tag table will be injected by the compiler when needed.
 */
export function generateRuntimeCode(hasOrdering: boolean): string {
  return `
const WM = {
  unit: undefined,
  
  mk(tag, ...fields) {
    const obj = { tag };
    fields.forEach((f, i) => obj[\`_\${i}\`] = f);
    return obj;
  },
  
  getTag(v) { return v.tag; },
  getField(v, i) { return v[\`_\${i}\`]; },
  
  tuple(...elements) { return elements; },
  getTuple(t, i) { return t[i]; },
  
  add(a, b) { return (a + b) | 0; },
  sub(a, b) { return (a - b) | 0; },
  mul(a, b) { return (a * b) | 0; },
  div(a, b) { return Math.trunc(a / b); },
  
  ${hasOrdering ? `cmpInt(a, b) {
    if (a < b) return WM.mk(Tag_Ordering.LT);
    if (a > b) return WM.mk(Tag_Ordering.GT);
    return WM.mk(Tag_Ordering.EQ);
  },` : '// cmpInt not needed'}
  
  charEq(a, b) { return a === b; },
  print(x) { console.log(x); return WM.unit; },
  
  and(a, b) { return a && b; },
  or(a, b) { return a || b; },
  not(a) { return !a; },
  
  eqInt(a, b) { return a === b; },
  neInt(a, b) { return a !== b; },
  ltInt(a, b) { return a < b; },
  gtInt(a, b) { return a > b; },
  leInt(a, b) { return a <= b; },
  geInt(a, b) { return a >= b; },
  
  strFromLiteral(str) {
    // Convert JS string to List<Int> (char codes)
    // List has constructors: Link (tag 0), Empty (tag 1)
    let result = WM.mk(1); // Empty
    for (let i = str.length - 1; i >= 0; i--) {
      result = WM.mk(0, str.charCodeAt(i), result); // Link(charCode, rest)
    }
    return result;
  },
  
  panic(msg) { throw new Error(\`Workman panic: \${msg}\`); }
};
`.trim();
}

/**
 * The Ordering type is special - it's used by cmpInt primitive.
 * We need to detect if it's defined in the program.
 */
export const ORDERING_TAG_TABLE = `
const Tag_Ordering = { LT: 0, EQ: 1, GT: 2 };
`.trim();
