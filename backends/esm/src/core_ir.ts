// Core IR: Typed, canonical representation for Workman semantics
// This is the source of truth that both interpreter and compiler can consume

import type { Type } from "../../../src/types.ts";

/**
 * Core IR nodes carry full type information from inference
 */
export interface CoreNode {
  type: Type;
}

/**
 * Core expressions
 */
export type CoreExpr =
  | CoreVar
  | CoreLit
  | CoreLam
  | CoreApp
  | CoreLet
  | CoreLetRec
  | CoreCtor
  | CoreTuple
  | CoreMatch
  | CorePrim;

export interface CoreVar extends CoreNode {
  kind: "core_var";
  name: string;
}

export interface CoreLit extends CoreNode {
  kind: "core_lit";
  value: CoreLitValue;
}

export type CoreLitValue =
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "char"; value: string }
  | { kind: "string"; value: string }
  | { kind: "unit" };

export interface CoreLam extends CoreNode {
  kind: "core_lam";
  params: string[]; // Parameter names (n-ary)
  body: CoreExpr;
}

export interface CoreApp extends CoreNode {
  kind: "core_app";
  fn: CoreExpr;
  args: CoreExpr[]; // Fully saturated in M1
}

export interface CoreLet extends CoreNode {
  kind: "core_let";
  name: string;
  rhs: CoreExpr;
  body: CoreExpr;
}

export interface CoreLetRec extends CoreNode {
  kind: "core_letrec";
  bindings: Array<{ name: string; lam: CoreLam }>;
  body: CoreExpr;
}

export interface CoreCtor extends CoreNode {
  kind: "core_ctor";
  typeName: string;
  ctorName: string;
  fields: CoreExpr[];
}

export interface CoreTuple extends CoreNode {
  kind: "core_tuple";
  elements: CoreExpr[];
}

export interface CoreMatch extends CoreNode {
  kind: "core_match";
  scrutinee: CoreExpr;
  cases: CoreMatchCase[];
}

export interface CoreMatchCase {
  pattern: CorePattern;
  body: CoreExpr;
}

export interface CorePrim extends CoreNode {
  kind: "core_prim";
  op: PrimOp;
  args: CoreExpr[];
}

/**
 * Primitive operations
 */
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

/**
 * Core patterns
 */
export type CorePattern =
  | CorePWildcard
  | CorePVar
  | CorePLit
  | CorePTuple
  | CorePCtor;

export interface CorePWildcard {
  kind: "core_pwildcard";
}

export interface CorePVar {
  kind: "core_pvar";
  name: string;
}

export interface CorePLit {
  kind: "core_plit";
  value: CoreLitValue;
}

export interface CorePTuple {
  kind: "core_ptuple";
  elements: CorePattern[];
}

export interface CorePCtor {
  kind: "core_pctor";
  ctorName: string;
  subpatterns: CorePattern[];
}

/**
 * Top-level Core program
 */
export interface CoreProgram {
  // Type declarations (for tag table generation)
  types: CoreTypeDecl[];
  // Top-level bindings
  bindings: CoreTopLevelBinding[];
  // Exports
  exports: CoreExport[];
}

export interface CoreTypeDecl {
  name: string;
  constructors: Array<{
    name: string;
    arity: number;
  }>;
  exported: boolean;
}

export interface CoreTopLevelBinding {
  name: string;
  expr: CoreExpr;
  exported: boolean;
}

export interface CoreExport {
  kind: "value" | "type";
  name: string;
}
