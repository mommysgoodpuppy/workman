import { dirname, extname, relative } from "../../../src/io.ts";
import type {
  CoreExpr,
  CoreLiteral,
  CoreMatchCase,
  CoreModule,
  CoreModuleGraph,
  CorePattern,
  CorePrimOp,
  CoreTypeDeclaration,
} from "../ir/core.ts";
import type { Type } from "../../../src/types.ts";

interface NameState {
  used: Set<string>;
  counter: number;
}

function getOrCreateCImportBinding(ctx: EmitContext, source: string): string {
  const existing = ctx.cImports.get(source);
  if (existing) {
    return existing;
  }
  const binding = allocateTempName(ctx.state, "c_import");
  ctx.cImports.set(source, binding);
  ctx.hoisted.push(`const ${binding} = @cImport(@cInclude("${source}"));`);
  return binding;
}

interface VarRef {
  value: string;
  address: string;
}

interface EmitContext {
  state: NameState;
  scope: Map<string, VarRef>;
  typeBindings: Map<string, string>;
  captureInfo?: Map<string, string[]>;
  options: EmitModuleOptions;
  modulePath: string;
  hoisted: string[];
  /** Collected .wm source file paths referenced in string literals */
  wmSourcePaths: Set<string>;
  /** Module-level names (imports and top-level bindings) - these don't need to be captured */
  moduleNames: Set<string>;
  /** Map of function names to their captured variables (for let_rec) */
  capturedVarsMap: Map<string, string[]>;
  /** Cached c header imports so we only @cImport each header once */
  cImports: Map<string, string>;
}

export interface EmitModuleOptions {
  readonly extension?: string;
  readonly baseDir?: string;
  /** If true, rewrite .wm paths to .zig in string literals */
  readonly rewriteWmPaths?: boolean;
}

export interface EmitRawResult {
  readonly code: string;
  /** .wm source file paths found in string literals (before rewriting) */
  readonly wmSourcePaths: readonly string[];
}

const RESERVED = new Set<string>([
  "align", "allowzero", "and", "anyframe", "anytype", "asm", "async",
  "await", "break", "catch", "comptime", "const", "continue", "defer",
  "else", "enum", "errdefer", "error", "export", "extern", "false",
  "for", "if", "inline", "linksection", "noalias", "noinline", "nosuspend",
  "opaque", "or", "orelse", "packed", "pub", "resume", "return", "struct",
  "suspend", "switch", "test", "threadlocal", "true", "try", "union",
  "unreachable", "usingnamespace", "var", "volatile", "while", "_",
]);

// Compiler builtins that should not be captured as free variables
const RAW_BUILTINS = new Set<string>([
  "zigImport",
  "zigField",
]);

// Map __op_* calls to native Zig operators
const RAW_OPERATOR_MAP = new Map<string, string>([
  ["__op_+", "+"],
  ["__op_-", "-"],
  ["__op_*", "*"],
  ["__op_/", "/"],
  ["__op_%", "%"],
  ["__op_==", "=="],
  ["__op_!=", "!="],
  ["__op_<", "<"],
  ["__op_>", ">"],
  ["__op_<=", "<="],
  ["__op_>=", ">="],
  ["__op_&&", "and"],
  ["__op_||", "or"],
]);

const RAW_OMITTED_BINDINGS = new Set<string>([
  "zig_optional_is_non_null",
  "zig_optional_unwrap",
  "zig_optional_unwrap_or",
  "zig_alloc_struct",
  "zig_alloc_struct_uninit",
  "zig_alloc_struct_init",
  "zig_alloc_slice",
  "zig_free",
  "zig_free_slice",
  // GPA intrinsics
  "zig_gpa_init",
  "zig_gpa_get",
  "zig_gpa_deinit",
  "zig_gpa_create",
  "zig_gpa_create_uninit",
  "zig_gpa_create_init",
  "zig_gpa_destroy",
  "zig_gpa_alloc",
  "zig_gpa_free",
]);

const RAW_STD_ZIG_OPTION_HELPERS = new Set<string>([
  "isSome",
  "isNone",
  "unwrap",
  "unwrapOr",
  "expect",
]);

// Zig primitive types that should not be imported (they're built-in)
const ZIG_PRIMITIVES = new Set<string>([
  // Signed integers
  "I8", "I16", "I32", "I64", "I128", "Isize",
  // Unsigned integers
  "U8", "U16", "U32", "U64", "U128", "Usize",
  // Floating point
  "F16", "F32", "F64", "F128",
  // Special types
  "Bool", "Void", "NoReturn", "Anyerror", "ComptimeInt", "ComptimeFloat",
  // C interop types
  "CShort", "CUShort", "CInt", "CUInt", "CLong", "CULong",
  "CLongLong", "CULongLong", "CChar",
]);

/**
 * Raw mode emitter - outputs direct Zig code without runtime wrapper.
 * Used for build.wm -> build.zig and other "zig mode" Workman files.
 */
export function emitRawModule(
  module: CoreModule,
  _graph: CoreModuleGraph,
  options: EmitModuleOptions = {},
): EmitRawResult {
  const extension = options.extension ?? ".zig";
  const isStdZigOption = normalizeSlashes(module.path)
    .toLowerCase()
    .endsWith("/std/zig/option.wm");

  const state: NameState = { used: new Set(), counter: 0 };
  const scope = new Map<string, VarRef>();
  
  // Collect module-level names (imports and top-level bindings)
  const moduleNames = new Set<string>();
  for (const imp of module.imports) {
    for (const spec of imp.specifiers) {
      if (spec.kind === "value") {
        moduleNames.add(spec.local);
      }
    }
  }
  for (const binding of module.values) {
    moduleNames.add(binding.name);
  }
  
  const ctx: EmitContext = {
    state,
    scope,
    typeBindings: new Map(),
    options: { ...options, extension },
    modulePath: module.path,
    hoisted: [],
    wmSourcePaths: new Set(),
    moduleNames,
    capturedVarsMap: new Map(),
    cImports: new Map(),
  };

  preallocateNames(module, ctx);

  const lines: string[] = [];
  lines.push("// Generated by Workman compiler (Raw Zig mode)");

  // Emit imports (skip Zig primitives - they're built-in)
  for (const imp of module.imports) {
    // Check if this is a C header import
    const isCHeader = imp.source.endsWith(".h");
    
    for (const spec of imp.specifiers) {
      if (spec.kind === "value") {
        // Skip importing Zig primitive types - they're built-in
        if (ZIG_PRIMITIVES.has(spec.imported)) {
          continue;
        }
        const ref = resolveName(ctx.scope, spec.local, ctx.state);
        ctx.typeBindings.set(spec.local, ref);
        
        if (isCHeader) {
          const cImportBinding = getOrCreateCImportBinding(ctx, imp.source);
          lines.push(`const ${ref} = ${cImportBinding}.${sanitizeIdentifier(spec.imported, ctx.state)};`);
          // Also map the underlying C type names (union_X, struct_X, enum_X) to the binding
          // so that type annotations resolve correctly
          ctx.typeBindings.set(`union_${spec.imported}`, ref);
          ctx.typeBindings.set(`struct_${spec.imported}`, ref);
          ctx.typeBindings.set(`enum_${spec.imported}`, ref);
        } else {
          const relPath = computeRelativePath(module.path, imp.source, extension, options.baseDir);
          lines.push(`const ${ref} = @import("${relPath}").${sanitizeIdentifier(spec.imported, ctx.state)};`);
        }
      }
    }
  }

  // Collect exports
  const exportSet = new Set<string>();
  for (const exp of module.exports) {
    if (exp.kind === "value") {
      exportSet.add(exp.local);
    }
  }

  // Emit type declarations
  for (const decl of module.typeDeclarations) {
    lines.push(...emitTypeDeclaration(decl, ctx));
  }

  // Emit value bindings
  for (const binding of module.values) {
    if (RAW_OMITTED_BINDINGS.has(binding.name)) {
      continue;
    }
    const bindingRef = resolveName(ctx.scope, binding.name, ctx.state);
    // main must always be pub for Zig's entry point
    const isExported = exportSet.has(binding.name) || binding.name === "main";
    
    // For lambdas, emit as named functions
    if (binding.value.kind === "lambda") {
      if (isStdZigOption && RAW_STD_ZIG_OPTION_HELPERS.has(binding.name)) {
        lines.push(emitRawZigOptionHelper(binding.name, bindingRef, isExported));
      } else {
        const fnCode = emitNamedLambda(binding.value, bindingRef, ctx);
        lines.push(`${isExported ? "pub " : ""}${fnCode}`);
      }
    } else {
      const expr = emitExpr(binding.value, ctx);
      lines.push(`${isExported ? "pub " : ""}const ${bindingRef} = ${expr};`);
    }
  }

  if (ctx.hoisted.length > 0) {
    lines.unshift(...ctx.hoisted);
  }

  return {
    code: `${lines.join("\n")}\n`,
    wmSourcePaths: Array.from(ctx.wmSourcePaths),
  };
}

function emitRawZigOptionHelper(
  name: string,
  ref: string,
  isExported: boolean,
): string {
  const prefix = isExported ? "pub " : "";
  switch (name) {
    case "isSome":
      return `${prefix}fn ${ref}(value: anytype) bool { return (value != null); }`;
    case "isNone":
      return `${prefix}fn ${ref}(value: anytype) bool { return (value == null); }`;
    case "unwrap":
      return `${prefix}fn ${ref}(value: anytype) @TypeOf((value).?) { return (value).?; }`;
    case "unwrapOr":
      return `${prefix}fn ${ref}(value: anytype, defaultValue: anytype) @TypeOf((value) orelse defaultValue) { return (value) orelse defaultValue; }`;
    case "expect":
      return `${prefix}fn ${ref}(value: anytype, message: []const u8) @TypeOf((value).?) { if (value != null) return (value).?; zig.debug.panic("{s}", .{message}); }`;
    default:
      return `${prefix}fn ${ref}() void { }`;
  }
}

function preallocateNames(module: CoreModule, ctx: EmitContext): void {
  // Preallocate import names so hoisted lambdas don't shadow them
  for (const imp of module.imports) {
    for (const spec of imp.specifiers) {
      if (spec.kind === "value") {
        ctx.state.used.add(spec.local);
      }
    }
  }
  for (const binding of module.values) {
    bindLocal(ctx.scope, binding.name, ctx.state);
  }
}

function computeRelativePath(
  fromPath: string,
  toPath: string,
  extension: string,
  baseDir?: string,
): string {
  const fromDir = baseDir ?? dirname(fromPath);
  let rel = relative(fromDir, toPath);
  const ext = extname(rel);
  if (ext) {
    rel = rel.slice(0, -ext.length) + extension;
  }
  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }
  return rel.replace(/\\/g, "/");
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function sanitizeIdentifier(name: string, state: NameState): string {
  if (RESERVED.has(name)) {
    return `@"${name}"`;
  }
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return name;
  }
  return `@"${name}"`;
}

function isIntentionallyUnusedName(name: string): boolean {
  return name.length > 1 && name.startsWith("_") && !name.startsWith("__");
}

function allocateTempName(state: NameState, prefix: string): string {
  let name: string;
  do {
    name = `${prefix}_${state.counter++}`;
  } while (state.used.has(name));
  state.used.add(name);
  return name;
}

function bindLocal(scope: Map<string, VarRef>, name: string, state: NameState): VarRef {
  const sanitized = sanitizeIdentifier(name, state);
  let finalName = sanitized;
  if (state.used.has(sanitized) || RESERVED.has(name)) {
    finalName = allocateTempName(state, sanitized.replace(/^@"|"$/g, ""));
  }
  state.used.add(finalName);
  const ref: VarRef = { value: finalName, address: `&${finalName}` };
  scope.set(name, ref);
  return ref;
}

function resolveName(scope: Map<string, VarRef>, name: string, state: NameState): string {
  const existing = scope.get(name);
  if (existing) {
    return existing.value;
  }
  return sanitizeIdentifier(name, state);
}

function emitTypeDeclaration(decl: CoreTypeDeclaration, ctx: EmitContext): string[] {
  const lines: string[] = [];
  
  // Handle record types (emit as Zig struct)
  if (decl.recordFields && decl.recordFields.length > 0) {
    const fields = decl.recordFields
      .map(f => `${f.name}: ${f.typeAnnotation ?? "anytype"}`)
      .join(", ");
    const pub = decl.exported ? "pub " : "";
    lines.push(`${pub}const ${decl.name} = struct { ${fields} };`);
    return lines;
  }
  
  // For opaque types, just emit a type alias placeholder
  if (decl.constructors.length === 0) {
    // Special case: GpaHandle maps to DebugAllocator
    if (decl.name === "GpaHandle") {
      lines.push(`pub const GpaHandle = @import("std").heap.DebugAllocator(.{});`);
      return lines;
    }
    if (decl.name === "Allocator") {
      lines.push(`pub const Allocator = @import("std").mem.Allocator;`);
      return lines;
    }
    // Opaque type - these map directly to Zig types
    // Don't emit anything - they're built-in Zig types
    return lines;
  }
  // For ADTs in raw mode, we can't emit proper generic types
  // Instead, export constructor names as simple marker types
  // The actual values use anonymous structs like .{ .IOk = value }
  const pub = decl.exported ? "pub " : "";
  if (decl.constructors.length > 0) {
    // Export the type name as a function that returns anytype (for type annotations)
    lines.push(`${pub}fn ${decl.name}(comptime T: type, comptime E: type) type { return union(enum) { IOk: T, IErr: E }; }`);
    // Export constructor names as marker constants
    for (const ctor of decl.constructors) {
      lines.push(`${pub}const ${ctor.name} = .${ctor.name};`);
    }
  }
  return lines;
}

function emitExpr(expr: CoreExpr, ctx: EmitContext): string {
  switch (expr.kind) {
    case "literal":
      return emitLiteral(expr.literal, ctx);
    case "var":
      if (expr.name === "null" && !ctx.scope.has("null")) {
        return "null";
      }
      // Check if this var name is a primitive type (U8 -> u8, I32 -> i32, etc.)
      {
        const primitiveType: Type = { kind: "constructor", name: expr.name, args: [] };
        const zigPrimitive = mapZigPrimitive(primitiveType);
        if (zigPrimitive) {
          return zigPrimitive;
        }
      }
      return resolveName(ctx.scope, expr.name, ctx.state);
    case "lambda":
      return emitLambda(expr, ctx);
    case "call":
      return emitCall(expr, ctx);
    case "let":
      return emitLet(expr, ctx);
    case "let_rec":
      return emitLetRec(expr, ctx);
    case "match":
      return emitMatch(expr, ctx);
    case "if":
      return emitIf(expr, ctx);
    case "prim":
      return emitPrimOp(expr.op, expr.args, ctx);
    case "record":
      return emitRecord(expr, ctx);
    case "tuple_get":
      return `${emitExpr(expr.target, ctx)}[${expr.index}]`;
    case "data":
      return emitData(expr, ctx);
    case "tuple":
      return emitTuple(expr, ctx);
    case "enum_literal":
      return `.${expr.name}`;
    default:
      throw new Error(`Unsupported expression kind '${(expr as CoreExpr).kind}' in raw mode`);
  }
}

function emitLiteral(lit: CoreLiteral, ctx: EmitContext): string {
  switch (lit.kind) {
    case "int":
      return String(lit.value);
    case "bool":
      return lit.value ? "true" : "false";
    case "char":
      return `'\\x${lit.value.toString(16).padStart(2, "0")}'`;
    case "string": {
      let value = lit.value;
      // Track and optionally rewrite .wm paths to .zig
      if (value.endsWith(".wm")) {
        ctx.wmSourcePaths.add(value);
        if (ctx.options.rewriteWmPaths !== false) {
          value = value.slice(0, -3) + ".zig";
        }
      }
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    case "unit":
      return "{}";
  }
}

function emitRecord(
  expr: CoreExpr & { kind: "record" },
  ctx: EmitContext,
): string {
  // Check if any field is a lambda - if so, emit as a struct with methods
  const hasLambdaFields = expr.fields.some((f) => f.value.kind === "lambda");
  if (hasLambdaFields) {
    return emitRecordWithMethods(expr, ctx);
  }
  
  const fields = expr.fields.map((field) => {
    const value = emitExpr(field.value, ctx);
    return `.${sanitizeIdentifier(field.name, ctx.state)} = ${value}`;
  }).join(", ");
  const literal = expr.fields.length === 0 ? ".{}" : `.{ ${fields} }`;
  const recordTypeRef = resolveRecordTypeReference(expr.type, ctx);
  if (recordTypeRef) {
    if (expr.fields.length === 0) {
      return `${recordTypeRef}{}`;
    }
    return `${recordTypeRef}{ ${fields} }`;
  }
  return literal;
}

/**
 * Emit a record with lambda fields as a Zig struct with pub fn methods.
 * This handles patterns like:
 *   record Gpa { init: () => ..., create: (handle, t) => ... }
 * Which becomes:
 *   struct { pub fn init() ... { } pub fn create(handle, t) ... { } }{}
 */
function emitRecordWithMethods(
  expr: CoreExpr & { kind: "record" },
  ctx: EmitContext,
): string {
  const methods: string[] = [];
  const dataFields: string[] = [];
  
  for (const field of expr.fields) {
    if (field.value.kind === "lambda") {
      const lambda = field.value;
      const methodName = sanitizeIdentifier(field.name, ctx.state);
      const fnCode = emitNamedLambda(lambda, methodName, ctx);
      methods.push(`pub ${fnCode}`);
    } else {
      const value = emitExpr(field.value, ctx);
      dataFields.push(`${sanitizeIdentifier(field.name, ctx.state)}: @TypeOf(${value}) = ${value}`);
    }
  }
  
  const allMembers = [...dataFields, ...methods].join(" ");
  // If there are only methods (no data fields), emit as a namespace struct without instantiation
  // This allows calling methods like gpa.init() directly
  if (dataFields.length === 0) {
    return `struct { ${allMembers} }`;
  }
  return `struct { ${allMembers} }{}`;
}

function emitNamedLambda(
  expr: CoreExpr & { kind: "lambda" },
  name: string,
  ctx: EmitContext,
): string {
  // Extract parameter types from the lambda's function type
  const paramTypes = getParamTypes(expr.type, expr.params.length);
  const typeParamNames = new Map<number, string>();
  const scope = new Map(ctx.scope);
  const rawMem = isRawMemModule(ctx.modulePath);
  const gpa = isGpaModule(ctx.modulePath);
  const rawMemTypeParams = rawMem && RAW_MEM_TYPE_PARAM_FUNCS.has(name);
  const gpaTypeParams = gpa && GPA_TYPE_PARAM_FUNCS.has(name);
  const hasTypeParams = rawMemTypeParams || gpaTypeParams;

  const boundParams = expr.params.map((p) => ({
    name: p,
    ref: bindLocal(scope, p, ctx.state),
  }));

  if (rawMem && name === "allocArrayUninit") {
    const typeParam = boundParams[0]?.ref.value ?? "t";
    const lenParam = boundParams[1]?.ref.value ?? "len";
    const innerCtx = { ...ctx, scope };
    const body = emitExpr(expr.body, innerCtx);
    return `fn ${name}(comptime ${typeParam}: type, comptime ${lenParam}: usize) [${lenParam}]${typeParam} { return ${body}; }`;
  }

  const params = boundParams.map((p, i) => {
    const pname = p.ref.value;
    if (rawMem && name === "freeSlice") {
      return `${pname}: anytype`;
    }
    const ptype = paramTypes[i];
    if (
      rawMem &&
      name === "freeSlice" &&
      ptype &&
      ptype.kind === "constructor" &&
      ptype.name === "Slice" &&
      ptype.args.length === 1 &&
      ptype.args[0].kind === "var"
    ) {
      return `${pname}: anytype`;
    }
    if (hasTypeParams && ptype && ptype.kind === "var") {
      const existing = typeParamNames.get(ptype.id);
      if (!existing) {
        typeParamNames.set(ptype.id, pname);
        return `comptime ${pname}: type`;
      }
      return `${pname}: ${existing}`;
    }
    const rendered = ptype ? emitType(ptype, ctx) : "anytype";
    if (rendered === "anyopaque" || rendered === "*anyopaque" || rendered === "?*anyopaque") {
      return `${pname}: anytype`;
    }
    return `${pname}: ${rendered}`;
  }).join(", ");
  
  const innerCtx = { ...ctx, scope };
  const body = emitExpr(expr.body, innerCtx);
  
  // Get return type from the lambda's type annotation
  let returnType = hasTypeParams && typeParamNames.size > 0
    ? emitTypeWithTypeParams(getReturnType(expr.type), typeParamNames)
    : emitType(expr.type, ctx);
  
  // main function must return void for Zig's entry point
  if (name === "main" && (returnType === "anyopaque" || returnType === "anytype")) {
    returnType = "void";
  }
  
  // If return type contains anyopaque in a generic context, we can't use it directly
  // Use a concrete tagged union type that works with any payload
  if (returnType.includes("anyopaque") && returnType.includes("(")) {
    // For IResult-like types, use a union that can hold any error or value
    returnType = "union(enum) { IOk: []const u8, IErr: anyerror }";
  }
  
  // anyopaque alone is not allowed as a return type in Zig
  // For generic functions with zigres, use the module-level __ZigRes type
  if (returnType === "anyopaque" || returnType === "*anyopaque" || returnType === "?*anyopaque") {
    if (body.includes("__ZigRes(")) {
      // Function returns a ZigRes type - use inline to propagate comptime types
      // Extract the IOk and IErr field types from the union
      return `inline fn ${name}(${params}) __ZigRes(@typeInfo(@TypeOf(${body})).@"union".fields[0].type, @typeInfo(@TypeOf(${body})).@"union".fields[1].type) { return ${body}; }`;
    }
    return `fn ${name}(${params}) void { _ = ${body}; }`;
  }
  
  return `fn ${name}(${params}) ${returnType} { return ${body}; }`;
}

function emitLambda(
  expr: CoreExpr & { kind: "lambda" },
  ctx: EmitContext,
): string {
  // In raw mode, lambdas must be hoisted to module level
  // We emit the function definition to hoisted and return just the name
  const fnName = allocateTempName(ctx.state, "__fn");
  const fnCode = emitNamedLambda(expr, fnName, ctx);
  ctx.hoisted.push(fnCode);
  return fnName;
}

function emitCall(
  expr: CoreExpr & { kind: "call" },
  ctx: EmitContext,
): string {
  // Check if this is an operator call (__op_+, __op_-, etc.)
  if (expr.callee.kind === "var" && RAW_OPERATOR_MAP.has(expr.callee.name)) {
    const op = RAW_OPERATOR_MAP.get(expr.callee.name)!;
    if (expr.args.length === 2) {
      const left = emitExpr(expr.args[0], ctx);
      const right = emitExpr(expr.args[1], ctx);
      return `(${left} ${op} ${right})`;
    }
  }

    if (expr.callee.kind === "var") {
    if (expr.callee.name === "zig_alloc_struct" && expr.args.length === 1) {
      const typeExpr = emitExpr(expr.args[0], ctx);
      return emitRawAllocStruct(typeExpr, ctx, "allocStruct");
    }
    if (expr.callee.name === "zig_alloc_struct_uninit" && expr.args.length === 1) {
      const typeExpr = emitExpr(expr.args[0], ctx);
      return `@import("std").heap.page_allocator.create(${typeExpr}) catch @panic("allocStructUninit failed")`;
    }
    if (expr.callee.name === "zig_alloc_struct_init" && expr.args.length === 2) {
      const typeExpr = emitExpr(expr.args[0], ctx);
      const valueExpr = emitExpr(expr.args[1], ctx);
      return emitRawAllocStruct(typeExpr, ctx, "allocStructInit", valueExpr);
    }
    if (expr.callee.name === "zig_alloc_slice" && expr.args.length === 2) {
      const typeExpr = emitExpr(expr.args[0], ctx);
      const lenExpr = emitExpr(expr.args[1], ctx);
      return emitRawAllocSlice(typeExpr, lenExpr, ctx);
    }
    if (expr.callee.name === "zig_alloc_array_uninit" && expr.args.length === 2) {
      const typeExpr = emitExpr(expr.args[0], ctx);
      const lenExpr = emitExpr(expr.args[1], ctx);
      return `@as([${lenExpr}]${typeExpr}, undefined)`;
    }
    if (expr.callee.name === "zig_free" && expr.args.length === 1) {
      const ptrExpr = emitExpr(expr.args[0], ctx);
      return `@import("std").heap.page_allocator.destroy(${ptrExpr})`;
    }
    if (expr.callee.name === "zig_free_slice" && expr.args.length === 1) {
      const sliceExpr = emitExpr(expr.args[0], ctx);
      return `@import("std").heap.page_allocator.free(@as([*]@TypeOf(${sliceExpr}.ptr.*), @ptrCast(${sliceExpr}.ptr))[0..${sliceExpr}.len])`;
    }
    // GPA (DebugAllocator) intrinsics
    if (expr.callee.name === "zig_gpa_init" && expr.args.length === 0) {
      return emitGpaInit(ctx);
    }
    if (expr.callee.name === "zig_gpa_get" && expr.args.length === 1) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      return `${handleExpr}.allocator()`;
    }
    if (expr.callee.name === "zig_gpa_deinit" && expr.args.length === 1) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      // Use a block to discard the result and return void
      return `{ _ = ${handleExpr}.deinit(); }`;
    }
    if (expr.callee.name === "zig_gpa_create" && expr.args.length === 2) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const typeExpr = emitExpr(expr.args[1], ctx);
      return emitGpaCreate(handleExpr, typeExpr, ctx, "create");
    }
    if (expr.callee.name === "zig_gpa_create_uninit" && expr.args.length === 2) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const typeExpr = emitExpr(expr.args[1], ctx);
      return `${handleExpr}.allocator().create(${typeExpr}) catch @panic("gpa.createUninit failed")`;
    }
    if (expr.callee.name === "zig_gpa_create_init" && expr.args.length === 3) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const typeExpr = emitExpr(expr.args[1], ctx);
      const valueExpr = emitExpr(expr.args[2], ctx);
      return emitGpaCreate(handleExpr, typeExpr, ctx, "createInit", valueExpr);
    }
    if (expr.callee.name === "zig_gpa_destroy" && expr.args.length === 2) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const ptrExpr = emitExpr(expr.args[1], ctx);
      return `${handleExpr}.allocator().destroy(${ptrExpr})`;
    }
    if (expr.callee.name === "zig_gpa_alloc" && expr.args.length === 3) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const typeExpr = emitExpr(expr.args[1], ctx);
      const lenExpr = emitExpr(expr.args[2], ctx);
      return emitGpaAlloc(handleExpr, typeExpr, lenExpr, ctx);
    }
    if (expr.callee.name === "zig_gpa_free" && expr.args.length === 2) {
      const handleExpr = emitExpr(expr.args[0], ctx);
      const sliceExpr = emitExpr(expr.args[1], ctx);
      return `${handleExpr}.allocator().free(@as([*]@TypeOf(${sliceExpr}.ptr.*), @ptrCast(${sliceExpr}.ptr))[0..${sliceExpr}.len])`;
    }
    if (expr.callee.name === "zig_optional_is_non_null" && expr.args.length === 1) {
      const value = emitExpr(expr.args[0], ctx);
      return `(${value} != null)`;
    }
    if (expr.callee.name === "zig_optional_unwrap" && expr.args.length === 1) {
      const value = emitExpr(expr.args[0], ctx);
      return `(${value}).?`;
    }
    if (expr.callee.name === "zig_optional_unwrap_or" && expr.args.length === 2) {
      const value = emitExpr(expr.args[0], ctx);
      const fallback = emitExpr(expr.args[1], ctx);
      return `(${value} orelse ${fallback})`;
    }
  }
  
  // Handle zigImport("module") -> @import("module")
  if (expr.callee.kind === "var" && expr.callee.name === "zigImport") {
    if (expr.args.length === 1 && expr.args[0].kind === "literal" && expr.args[0].literal.kind === "string") {
      const moduleName = expr.args[0].literal.value;
      return `@import("${moduleName}")`;
    }
  }
  
  // Handle zigField(obj, "fieldname") -> @field(obj, "fieldname")
  // This is for accessing fields with reserved names like "type"
  if (expr.callee.kind === "var" && expr.callee.name === "zigField") {
    if (expr.args.length === 2 && expr.args[1].kind === "literal" && expr.args[1].literal.kind === "string") {
      const obj = emitExpr(expr.args[0], ctx);
      const fieldName = expr.args[1].literal.value;
      return `@field(${obj}, "${fieldName}")`;
    }
  }
  
  // Handle curried zigField(obj)("fieldname") -> @field(obj, "fieldname")
  if (expr.callee.kind === "app" && 
      expr.callee.callee.kind === "var" && 
      expr.callee.callee.name === "zigField" &&
      expr.callee.args.length === 1 &&
      expr.args.length === 1 && 
      expr.args[0].kind === "literal" && 
      expr.args[0].literal.kind === "string") {
    const obj = emitExpr(expr.callee.args[0], ctx);
    const fieldName = expr.args[0].literal.value;
    return `@field(${obj}, "${fieldName}")`;
  }
  
  // Check if this is a call to a function with captured vars
  if (expr.callee.kind === "var") {
    // Check both captureInfo (local let_rec context) and capturedVarsMap (global hoisted functions)
    const captures = ctx.captureInfo?.get(expr.callee.name) ?? ctx.capturedVarsMap.get(expr.callee.name);
    if (captures && captures.length > 0) {
      const fn = resolveName(ctx.scope, expr.callee.name, ctx.state);
      const args = expr.args.map((arg) => emitExpr(arg, ctx));
      // Add captured vars as extra args
      for (const v of captures) {
        args.push(resolveName(ctx.scope, v, ctx.state));
      }
      return `${fn}(${args.join(", ")})`;
    }
  }
  
  const fn = emitExpr(expr.callee, ctx);
  const args = expr.args.map((arg) => emitExpr(arg, ctx)).join(", ");
  return `${fn}(${args})`;
}

const RAW_MEM_TYPE_PARAM_FUNCS = new Set<string>([
  "allocStruct",
  "allocStructUninit",
  "allocStructInit",
  "allocSlice",
  "allocArrayUninit",
]);

const GPA_TYPE_PARAM_FUNCS = new Set<string>([
  "create",
  "createUninit",
  "createInit",
  "alloc",
]);

function emitTypeWithTypeParams(
  type: Type,
  typeParamNames: Map<number, string>,
): string {
  // Check for Zig primitives first (Usize -> usize, etc.)
  const zigPrimitive = mapZigPrimitive(type);
  if (zigPrimitive) {
    return zigPrimitive;
  }
  switch (type.kind) {
    case "var": {
      const mapped = typeParamNames.get(type.id);
      return mapped ?? "anytype";
    }
    case "int":
      return "i32";
    case "bool":
      return "bool";
    case "char":
      return "u8";
    case "string":
      return "[]const u8";
    case "unit":
      return "void";
    case "func":
      return emitTypeWithTypeParams(getReturnType(type), typeParamNames);
    case "constructor":
      if ((type.name === "Optional" || type.name === "Opt") && type.args.length === 1) {
        return `?${emitTypeWithTypeParams(type.args[0], typeParamNames)}`;
      }
      if (type.name === "Null" && type.args.length === 0) {
        return "?anyopaque";
      }
      if (
        (type.name === "Opaque" || type.name === "Anyopaque") &&
        type.args.length === 0
      ) {
        return "anyopaque";
      }
      if (type.name === "Ptr" && type.args.length >= 1) {
        const base = emitTypeWithTypeParams(type.args[0], typeParamNames);
        const state = type.args[1];
        if (state && state.kind === "effect_row" && state.cases.has("Null")) {
          return `?*${base}`;
        }
        return `*${base}`;
      }
      if (type.args.length === 0) {
        return type.name;
      }
      return `${type.name}(${type.args.map((arg) => emitTypeWithTypeParams(arg, typeParamNames)).join(", ")})`;
    case "tuple": {
      const elements = type.elements.map((el) =>
        emitTypeWithTypeParams(el, typeParamNames)
      ).join(", ");
      return `struct { ${elements} }`;
    }
    case "array":
      return `[${type.length}]${emitTypeWithTypeParams(type.element, typeParamNames)}`;
    case "record": {
      const fields = Array.from(type.fields.entries())
        .map(([name, t]) =>
          `${name}: ${emitTypeWithTypeParams(t, typeParamNames)}`
        )
        .join(", ");
      return `struct { ${fields} }`;
    }
    default:
      return "anytype";
  }
}

function isRawMemModule(modulePath: string): boolean {
  const normalized = normalizeSlashes(modulePath).toLowerCase();
  return normalized.endsWith("/std/zig/rawmem.wm");
}

function isGpaModule(modulePath: string): boolean {
  const normalized = normalizeSlashes(modulePath).toLowerCase();
  return normalized.endsWith("/std/zig/gpa.wm");
}

function emitRawAllocStruct(
  typeExpr: string,
  ctx: EmitContext,
  label: string,
  initExpr?: string,
): string {
  const ptrName = allocateTempName(ctx.state, "alloc_ptr");
  const blockName = allocateTempName(ctx.state, "alloc_blk");
  const stdImport = `@import("std")`;
  const initLine = initExpr
    ? `${ptrName}.* = ${initExpr};`
    : `${ptrName}.* = ${stdImport}.mem.zeroes(${typeExpr});`;
  return `${blockName}: { const ${ptrName} = ${stdImport}.heap.page_allocator.create(${typeExpr}) catch @panic("${label} failed"); ${initLine} break :${blockName} ${ptrName}; }`;
}

function emitRawAllocSlice(
  typeExpr: string,
  lenExpr: string,
  ctx: EmitContext,
): string {
  const sliceName = allocateTempName(ctx.state, "alloc_slice");
  const blockName = allocateTempName(ctx.state, "alloc_blk");
  const stdImport = `@import("std")`;
  const lenCast = `@as(usize, @intCast(${lenExpr}))`;
  return `${blockName}: { const ${sliceName} = ${stdImport}.heap.page_allocator.alloc(${typeExpr}, ${lenCast}) catch @panic("allocSlice failed"); break :${blockName} .{ .ptr = @as(*${typeExpr}, @ptrCast(${sliceName}.ptr)), .len = ${sliceName}.len }; }`;
}

function emitGpaInit(_ctx: EmitContext): string {
  // Returns the init value for a DebugAllocator - caller must store in a var binding
  // The type annotation is handled by emitLet which will use GpaHandle
  return `@import("std").heap.DebugAllocator(.{}).init`;
}


function getFinalReturnType(type: Type): Type {
  let current = type;
  while (current.kind === "func") {
    current = current.to;
  }
  return current;
}

function emitGpaCreate(
  handleExpr: string,
  typeExpr: string,
  ctx: EmitContext,
  label: string,
  initExpr?: string,
): string {
  const ptrName = allocateTempName(ctx.state, "gpa_ptr");
  const blockName = allocateTempName(ctx.state, "gpa_blk");
  const stdImport = `@import("std")`;
  const initLine = initExpr
    ? `${ptrName}.* = ${initExpr};`
    : `${ptrName}.* = ${stdImport}.mem.zeroes(${typeExpr});`;
  return `${blockName}: { const ${ptrName} = ${handleExpr}.allocator().create(${typeExpr}) catch @panic("gpa.${label} failed"); ${initLine} break :${blockName} ${ptrName}; }`;
}

function emitGpaAlloc(
  handleExpr: string,
  typeExpr: string,
  lenExpr: string,
  ctx: EmitContext,
): string {
  const sliceName = allocateTempName(ctx.state, "gpa_slice");
  const blockName = allocateTempName(ctx.state, "gpa_blk");
  const lenCast = `@as(usize, @intCast(${lenExpr}))`;
  return `${blockName}: { const ${sliceName} = ${handleExpr}.allocator().alloc(${typeExpr}, ${lenCast}) catch @panic("gpa.alloc failed"); break :${blockName} .{ .ptr = @as(*${typeExpr}, @ptrCast(${sliceName}.ptr)), .len = ${sliceName}.len }; }`;
}

// Ensure the module-level __ZigRes type generator is hoisted (only once per module)
function ensureZigResType(ctx: EmitContext): void {
  const marker = "__ZigRes_hoisted";
  if (!ctx.state.used.has(marker)) {
    ctx.state.used.add(marker);
    ctx.hoisted.push(`fn __ZigRes(comptime T: type, comptime E: type) type { return union(enum) { IOk: T, IErr: E }; }`);
  }
}

function emitLet(
  expr: CoreExpr & { kind: "let" },
  ctx: EmitContext,
): string {
  const scope = new Map(ctx.scope);
  const value = emitExpr(expr.binding.value, ctx);
  const label = allocateTempName(ctx.state, "blk");
  const useVar = expr.binding.isMutable || needsVarBinding(expr.body, expr.binding.name);
  
  // For discarded statement results (__stmt_*), use _ to avoid unused variable warning
  if (expr.binding.name.startsWith("__stmt")) {
    const innerCtx = { ...ctx, scope };
    const body = emitExpr(expr.body, innerCtx);
    return `${label}: { _ = ${value}; break :${label} ${body}; }`;
  }
  
  // Detect "zigres" prefix bindings - wrap Zig error unions into IResult
  if (expr.binding.name.startsWith("zigres")) {
    const ref = bindLocal(scope, expr.binding.name, ctx.state);
    const innerCtx = { ...ctx, scope };
    const body = emitExpr(expr.body, innerCtx);
    // Emit code that wraps Zig's error!T into a tagged union
    // Use a module-level generic type to avoid duplicate type issues with inline functions
    ensureZigResType(ctx);
    const tmpName = allocateTempName(ctx.state, "__zigres_tmp");
    const payloadType = `@typeInfo(@TypeOf(${tmpName})).error_union.payload`;
    const errorType = `@typeInfo(@TypeOf(${tmpName})).error_union.error_set`;
    const wrappedValue = `if (${tmpName}) |__ok| __ZigRes(${payloadType}, ${errorType}){ .IOk = __ok } else |__err| __ZigRes(${payloadType}, ${errorType}){ .IErr = __err }`;
    return `${label}: { const ${tmpName} = ${value}; const ${ref.value} = ${wrappedValue}; break :${label} ${body}; }`;
  }
  
  // Bind the variable BEFORE emitting the body so it's in scope
  const ref = bindLocal(scope, expr.binding.name, ctx.state);
  const unusedGuard = isIntentionallyUnusedName(expr.binding.name)
    ? ` _ = ${ref.value};`
    : "";
  const innerCtx = { ...ctx, scope };
  const body = emitExpr(expr.body, innerCtx);
  const bindingKeyword = useVar ? "var" : "const";
  const bindingType = useVar
    ? emitType(expr.binding.value.type, ctx)
    : null;
  const typeAnnotation = useVar && bindingType && bindingType !== "anytype" &&
      bindingType !== "anyopaque"
    ? `: ${bindingType}`
    : "";
  return `${label}: { ${bindingKeyword} ${ref.value}${typeAnnotation} = ${value};${unusedGuard} break :${label} ${body}; }`;
}

function needsVarBinding(expr: CoreExpr, name: string): boolean {
  return containsAddressOf(expr, name, new Set());
}

function containsAddressOf(
  expr: CoreExpr,
  name: string,
  shadowed: Set<string>,
): boolean {
  switch (expr.kind) {
    case "var":
    case "literal":
    case "enum_literal":
      return false;
    case "prim":
      if (
        expr.op === "address_of" &&
        expr.args[0]?.kind === "var" &&
        expr.args[0].name === name &&
        !shadowed.has(name)
      ) {
        return true;
      }
      return expr.args.some((arg) => containsAddressOf(arg, name, shadowed));
    case "call":
      return containsAddressOf(expr.callee, name, shadowed) ||
        expr.args.some((arg) => containsAddressOf(arg, name, shadowed));
    case "if":
      return containsAddressOf(expr.condition, name, shadowed) ||
        containsAddressOf(expr.thenBranch, name, shadowed) ||
        containsAddressOf(expr.elseBranch, name, shadowed);
    case "match":
      return containsAddressOf(expr.scrutinee, name, shadowed) ||
        expr.cases.some((c) => containsAddressOf(c.body, name, shadowed)) ||
        (expr.fallback ? containsAddressOf(expr.fallback, name, shadowed) : false);
    case "record":
      return expr.fields.some((f) => containsAddressOf(f.value, name, shadowed));
    case "tuple":
      return expr.elements.some((el) => containsAddressOf(el, name, shadowed));
    case "data":
      return expr.fields.some((el) => containsAddressOf(el, name, shadowed));
    case "tuple_get":
      return containsAddressOf(expr.target, name, shadowed);
    case "lambda": {
      const nextShadowed = new Set(shadowed);
      for (const param of expr.params) {
        nextShadowed.add(param);
      }
      return containsAddressOf(expr.body, name, nextShadowed);
    }
    case "let": {
      const inValue = containsAddressOf(expr.binding.value, name, shadowed);
      const nextShadowed = new Set(shadowed);
      nextShadowed.add(expr.binding.name);
      const inBody = containsAddressOf(expr.body, name, nextShadowed);
      return inValue || inBody;
    }
    case "let_rec": {
      const nextShadowed = new Set(shadowed);
      for (const binding of expr.bindings) {
        nextShadowed.add(binding.name);
      }
      const inBindings = expr.bindings.some((binding) =>
        containsAddressOf(binding.value, name, nextShadowed)
      );
      const inBody = containsAddressOf(expr.body, name, nextShadowed);
      return inBindings || inBody;
    }
    default:
      return false;
  }
}

function emitMatch(
  expr: CoreExpr & { kind: "match" },
  ctx: EmitContext,
): string {
  const scrutinee = emitExpr(expr.scrutinee, ctx);
  const nullability = tryEmitNullabilityMatch(expr, scrutinee, ctx);
  if (nullability) {
    return nullability;
  }
  const clauses = expr.cases.map((c) => emitMatchCase(c, scrutinee, ctx));
  if (expr.fallback) {
    const fallbackBody = emitExpr(expr.fallback, ctx);
    clauses.push(`else => ${fallbackBody}`);
  }
  return `switch (${scrutinee}) { ${clauses.join(", ")} }`;
}

function tryEmitNullabilityMatch(
  expr: CoreExpr & { kind: "match" },
  scrutinee: string,
  ctx: EmitContext,
): string | null {
  let nullCase: CoreMatchCase | null = null;
  let nonNullCase: CoreMatchCase | null = null;
  let wildcardCase: CoreMatchCase | null = null;
  for (const matchCase of expr.cases) {
    const pattern = matchCase.pattern;
    if (pattern.kind === "constructor") {
      const ctor = pattern.constructor;
      if (ctor === "Null" && pattern.fields.length === 0) {
        if (!nullCase) {
          nullCase = matchCase;
          continue;
        }
      } else if (
        ctor === "NonNull" &&
        pattern.fields.length === 1 &&
        (pattern.fields[0].kind === "binding" ||
          pattern.fields[0].kind === "wildcard")
      ) {
        if (!nonNullCase) {
          nonNullCase = matchCase;
          continue;
        }
      }
    } else if (isWildcardPattern(pattern)) {
      if (!wildcardCase) {
        wildcardCase = matchCase;
        continue;
      }
    }
    return null;
  }

  if (!nullCase && !nonNullCase) {
    return null;
  }

  const emitCase = (matchCase: CoreMatchCase): { body: string; scope: Map<string, VarRef> } => {
    const scope = new Map(ctx.scope);
    bindPatternVars(matchCase.pattern, scope, ctx.state);
    const innerCtx = { ...ctx, scope };
    return { body: emitExpr(matchCase.body, innerCtx), scope };
  };

  const fallbackBody = expr.fallback ? emitExpr(expr.fallback, ctx) : null;
  const nullInfo = nullCase
    ? emitCase(nullCase)
    : wildcardCase
    ? emitCase(wildcardCase)
    : null;
  const nonNullInfo = nonNullCase ? emitCase(nonNullCase) : null;

  const nullBody = nullInfo?.body ?? fallbackBody ?? "unreachable";
  const nonNullBody = nonNullInfo?.body ??
    (wildcardCase ? emitCase(wildcardCase).body : fallbackBody ?? "unreachable");

  let binding = "_";
  if (nonNullCase?.pattern.kind === "constructor") {
    const field = nonNullCase.pattern.fields[0];
    if (field) {
      if (field.kind === "binding" && nonNullInfo) {
        binding = resolveName(nonNullInfo.scope, field.name, ctx.state);
      } else {
        binding = emitPattern(field, ctx);
      }
    }
  }

  return `if (${scrutinee}) |${binding}| ${nonNullBody} else ${nullBody}`;
}

function emitMatchCase(
  matchCase: CoreMatchCase,
  scrutinee: string,
  ctx: EmitContext,
): string {
  const scope = new Map(ctx.scope);
  bindPatternVars(matchCase.pattern, scope, ctx.state);
  const innerCtx = { ...ctx, scope };
  const body = emitExpr(matchCase.body, innerCtx);
  if (isWildcardPattern(matchCase.pattern)) {
    return `else => ${body}`;
  }
  if (matchCase.pattern.kind === "constructor" && matchCase.pattern.fields.length > 0) {
    const args = matchCase.pattern.fields.map((a) => emitPattern(a, ctx)).join(", ");
    return `.${matchCase.pattern.constructor} => |${args}| ${body}`;
  }
  const pattern = emitPattern(matchCase.pattern, ctx);
  if (pattern === "_") {
    return `else => ${body}`;
  }
  return `${pattern} => ${body}`;
}

function isWildcardPattern(pattern: CorePattern): boolean {
  switch (pattern.kind) {
    case "wildcard":
    case "all_errors":
      return true;
    case "binding":
      return pattern.name === "_";
    default:
      return false;
  }
}

function emitPattern(pattern: CorePattern, ctx: EmitContext): string {
  switch (pattern.kind) {
    case "wildcard":
      return "_";
    case "binding":
      // For intentionally unused bindings (starting with _), use _ to avoid Zig's error discard rules
      if (pattern.name.startsWith("_")) {
        return "_";
      }
      return sanitizeIdentifier(pattern.name, ctx.state);
    case "literal":
      return emitLiteral(pattern.literal, ctx);
    case "constructor":
      if (pattern.fields.length === 0) {
        return `.${pattern.constructor}`;
      }
      return `.${pattern.constructor}`;
    case "tuple":
      const elements = pattern.elements.map((e) => emitPattern(e, ctx)).join(", ");
      return `.{ ${elements} }`;
    case "pinned":
      return sanitizeIdentifier(pattern.name, ctx.state);
    case "all_errors":
      return "_";
  }
}

function bindPatternVars(
  pattern: CorePattern,
  scope: Map<string, VarRef>,
  state: NameState,
): void {
  switch (pattern.kind) {
    case "binding":
      bindLocal(scope, pattern.name, state);
      break;
    case "constructor":
      for (const field of pattern.fields) {
        bindPatternVars(field, scope, state);
      }
      break;
    case "tuple":
      for (const el of pattern.elements) {
        bindPatternVars(el, scope, state);
      }
      break;
    case "wildcard":
    case "literal":
    case "pinned":
    case "all_errors":
      break;
  }
}

function emitIf(
  expr: CoreExpr & { kind: "if" },
  ctx: EmitContext,
): string {
  const cond = emitExpr(expr.condition, ctx);
  const thenBranch = emitExpr(expr.thenBranch, ctx);
  const elseBranch = emitExpr(expr.elseBranch, ctx);
  return `if (${cond}) ${thenBranch} else ${elseBranch}`;
}

function emitPrimOp(op: CorePrimOp, args: readonly CoreExpr[], ctx: EmitContext): string {
  // Special case for record_get - extract field name from string literal
  if (op === "record_get") {
    const target = emitExpr(args[0], ctx);
    const fieldArg = args[1];
    // Field name is passed as a string literal
    if (fieldArg.kind === "literal" && fieldArg.literal.kind === "string") {
      let fieldName = fieldArg.literal.value;
      // Handle ^identifier syntax - capitalize first letter for Zig interop
      if (fieldName.startsWith("^")) {
        const rest = fieldName.slice(1);
        fieldName = rest.charAt(0).toUpperCase() + rest.slice(1);
      }
      return `${target}.${fieldName}`;
    }
    // Fallback - shouldn't happen
    return `${target}.${emitExpr(fieldArg, ctx)}`;
  }
  
  const emittedArgs = [...args].map((a) => emitExpr(a, ctx));
  
  switch (op) {
    case "int_add":
      return `(${emittedArgs[0]} + ${emittedArgs[1]})`;
    case "int_sub":
      return `(${emittedArgs[0]} - ${emittedArgs[1]})`;
    case "int_mul":
      return `(${emittedArgs[0]} * ${emittedArgs[1]})`;
    case "int_div":
      return `@divTrunc(${emittedArgs[0]}, ${emittedArgs[1]})`;
    case "int_eq":
      return `(${emittedArgs[0]} == ${emittedArgs[1]})`;
    case "int_ne":
      return `(${emittedArgs[0]} != ${emittedArgs[1]})`;
    case "int_lt":
      return `(${emittedArgs[0]} < ${emittedArgs[1]})`;
    case "int_le":
      return `(${emittedArgs[0]} <= ${emittedArgs[1]})`;
    case "int_gt":
      return `(${emittedArgs[0]} > ${emittedArgs[1]})`;
    case "int_ge":
      return `(${emittedArgs[0]} >= ${emittedArgs[1]})`;
    case "int_cmp":
      return `std.math.order(${emittedArgs[0]}, ${emittedArgs[1]})`;
    case "bool_and":
      return `(${emittedArgs[0]} and ${emittedArgs[1]})`;
    case "bool_or":
      return `(${emittedArgs[0]} or ${emittedArgs[1]})`;
    case "bool_not":
      return `(!${emittedArgs[0]})`;
    case "char_eq":
      return `(${emittedArgs[0]} == ${emittedArgs[1]})`;
    case "string_length":
      return `${emittedArgs[0]}.len`;
    case "string_slice":
      return `${emittedArgs[0]}[${emittedArgs[1]}..${emittedArgs[2]}]`;
    case "native_print":
      return `std.debug.print("{any}", .{${emittedArgs[0]}})`;
    case "address_of":
      return `&${emittedArgs[0]}`;
  }
}

function emitData(
  expr: CoreExpr & { kind: "data" },
  ctx: EmitContext,
): string {
  // Check if this is a primitive type used as a value (U8 -> u8, I32 -> i32, etc.)
  if (expr.fields.length === 0) {
    const primitiveType: Type = { kind: "constructor", name: expr.constructor, args: [] };
    const zigPrimitive = mapZigPrimitive(primitiveType);
    if (zigPrimitive) {
      return zigPrimitive;
    }
  }
  if (expr.fields.length === 0 && expr.typeName === expr.constructor) {
    const typeRef = resolveRecordTypeReference(expr.type, ctx);
    if (typeRef) {
      return typeRef;
    }
  }
  if (expr.fields.length === 0) {
    if (ctx.moduleNames.has(expr.constructor)) {
      return resolveName(ctx.scope, expr.constructor, ctx.state);
    }
    return `.${expr.constructor}`;
  }
  const args = expr.fields.map((a) => emitExpr(a, ctx)).join(", ");
  // For single-field constructors, don't wrap in extra braces
  if (expr.fields.length === 1) {
    return `.{ .${expr.constructor} = ${args} }`;
  }
  return `.{ .${expr.constructor} = .{ ${args} } }`;
}

function emitTuple(
  expr: CoreExpr & { kind: "tuple" },
  ctx: EmitContext,
): string {
  const elements = expr.elements.map((e) => emitExpr(e, ctx)).join(", ");
  return `.{ ${elements} }`;
}

function resolveRecordTypeReference(type: Type | undefined, ctx: EmitContext): string | null {
  if (!type) return null;
  if (type.kind === "constructor") {
    const aliased = ctx.typeBindings.get(type.name);
    if (aliased) {
      return aliased;
    }
    const scoped = ctx.scope.get(type.name);
    if (scoped) {
      return scoped.value;
    }
    return sanitizeIdentifier(type.name, ctx.state);
  }
  return null;
}

function emitLetRec(
  expr: CoreExpr & { kind: "let_rec" },
  ctx: EmitContext,
): string {
  const scope = new Map(ctx.scope);
  const refs: string[] = [];
  const capturedVarsMap = new Map<string, string[]>();
  
  // First pass: bind all recursive function names so they can reference each other
  for (const binding of expr.bindings) {
    bindLocal(scope, binding.name, ctx.state);
  }
  
  // For let rec, we need to hoist lambda definitions to module level
  // but also handle captured variables by passing them as extra parameters
  for (const binding of expr.bindings) {
    const ref = scope.get(binding.name)!;
    refs.push(ref.value);
    
    if (binding.value.kind === "lambda") {
      // Find free variables that are captured from outer scope
      const lambdaParams = new Set(binding.value.params);
      const recNames = new Set(expr.bindings.map(b => b.name));
      const freeVars = collectFreeVars(binding.value.body, lambdaParams, recNames);
      
      // Filter out module-level names, built-in operators, and compiler builtins
      const capturedVars = freeVars.filter(v => 
        !ctx.moduleNames.has(v) && !RAW_OPERATOR_MAP.has(v) && !RAW_BUILTINS.has(v)
      );
      capturedVarsMap.set(binding.name, capturedVars);
      
      // Also store in context so emitCall can find it
      ctx.capturedVarsMap.set(binding.name, capturedVars);
      
      // Hoist the function with extra parameters for captured vars
      const fnCode = emitNamedLambdaWithCaptures(binding.value, ref.value, capturedVars, { ...ctx, scope });
      ctx.hoisted.push(fnCode);
    } else {
      // Non-lambda bindings can't really be recursive, emit inline
      ctx.hoisted.push(`const ${ref.value} = ${emitExpr(binding.value, { ...ctx, scope })};`);
    }
  }
  
  const innerCtx = { ...ctx, scope, captureInfo: mergeCaptureInfo(ctx, capturedVarsMap) };
  
  return emitExpr(expr.body, innerCtx);
}

/** Collect free variables in an expression that aren't bound locally */
function collectFreeVars(expr: CoreExpr, bound: Set<string>, recNames: Set<string>): string[] {
  const free = new Set<string>();
  
  function walk(e: CoreExpr, localBound: Set<string>): void {
    switch (e.kind) {
      case "var":
        if (!localBound.has(e.name) && !recNames.has(e.name)) {
          free.add(e.name);
        }
        break;
      case "lambda": {
        const newBound = new Set(localBound);
        for (const p of e.params) newBound.add(p);
        walk(e.body, newBound);
        break;
      }
      case "let": {
        walk(e.binding.value, localBound);
        const newBound = new Set(localBound);
        newBound.add(e.binding.name);
        walk(e.body, newBound);
        break;
      }
      case "let_rec": {
        const newBound = new Set(localBound);
        for (const b of e.bindings) newBound.add(b.name);
        for (const b of e.bindings) walk(b.value, newBound);
        walk(e.body, newBound);
        break;
      }
      case "call":
        walk(e.callee, localBound);
        for (const arg of e.args) walk(arg, localBound);
        break;
      case "if":
        walk(e.condition, localBound);
        walk(e.thenBranch, localBound);
        walk(e.elseBranch, localBound);
        break;
      case "match":
        walk(e.scrutinee, localBound);
        for (const c of e.cases) {
          const caseBound = new Set(localBound);
          collectPatternBindings(c.pattern, caseBound);
          walk(c.body, caseBound);
        }
        break;
      case "record":
        for (const f of e.fields) walk(f.value, localBound);
        break;
      case "tuple":
        for (const el of e.elements) walk(el, localBound);
        break;
      case "tuple_get":
        walk(e.target, localBound);
        break;
      case "data":
        for (const f of e.fields) walk(f, localBound);
        break;
      case "prim":
        for (const arg of e.args) walk(arg, localBound);
        break;
      case "literal":
      case "enum_literal":
        break;
    }
  }
  
  walk(expr, bound);
  return Array.from(free);
}

function collectPatternBindings(pattern: CorePattern, bound: Set<string>): void {
  switch (pattern.kind) {
    case "binding":
      bound.add(pattern.name);
      break;
    case "constructor":
      for (const f of pattern.fields) collectPatternBindings(f, bound);
      break;
    case "tuple":
      for (const el of pattern.elements) collectPatternBindings(el, bound);
      break;
  }
}

function emitNamedLambdaWithCaptures(
  expr: CoreExpr & { kind: "lambda" },
  name: string,
  capturedVars: string[],
  ctx: EmitContext,
): string {
  const paramTypes = getParamTypes(expr.type, expr.params.length);
  
  // Create a fresh scope for the function parameters
  const scope = new Map<string, VarRef>();
  
  // Build params list: original params + captured vars
  // Bind each parameter FIRST so we get consistent names
  const params: string[] = [];
  for (let i = 0; i < expr.params.length; i++) {
    const ref = bindLocal(scope, expr.params[i], ctx.state);
    const ptype = paramTypes[i] ? emitType(paramTypes[i], ctx) : "anytype";
    params.push(`${ref.value}: ${ptype}`);
  }
  
  // Add captured vars as anytype parameters
  for (const v of capturedVars) {
    const ref = bindLocal(scope, v, ctx.state);
    params.push(`${ref.value}: anytype`);
  }
  
  const innerCtx = { ...ctx, scope };
  
  // For recursive calls within the body, we need to pass captured vars
  const capturesMap = new Map<string, string[]>();
  capturesMap.set(name, capturedVars);
  const bodyCtx = { ...innerCtx, captureInfo: mergeCaptureInfo(ctx, capturesMap) };
  const body = emitExpr(expr.body, bodyCtx);
  const returnType = emitType(expr.type, ctx);
  
  return `fn ${name}(${params.join(", ")}) ${returnType} { return ${body}; }`;
}

function mergeCaptureInfo(
  ctx: EmitContext,
  localCaptures: Map<string, string[]>,
): Map<string, string[]> {
  if (!ctx.captureInfo) {
    return localCaptures;
  }
  const merged = new Map(ctx.captureInfo);
  for (const [name, captures] of localCaptures.entries()) {
    merged.set(name, captures);
  }
  return merged;
}

function emitType(type: Type, ctx?: EmitContext): string {
  const zigPrimitive = mapZigPrimitive(type);
  if (zigPrimitive) {
    return zigPrimitive;
  }
  switch (type.kind) {
    case "int":
      return "i32"; // Default to i32 for now
    case "bool":
      return "bool";
    case "char":
      return "u8";
    case "string":
      return "[]const u8";
    case "unit":
      return "void";
    case "func":
      // For function types, we need the return type
      return emitType(getReturnType(type), ctx);
    case "constructor":
      // Hole<T, Row> is an unresolved type hole - emit the inner type or anyopaque
      if (type.name === "Hole" && type.args.length >= 1) {
        const inner = emitType(type.args[0], ctx);
        // If inner is also unresolved, fall back to anyopaque
        return inner === "anyopaque" || inner === "anytype" ? "anyopaque" : inner;
      }
      // Optional<T> maps to Zig ?T
      if ((type.name === "Optional" || type.name === "Opt") && type.args.length === 1) {
        return `?${emitType(type.args[0], ctx)}`;
      }
      // Null is a raw-only placeholder that maps to Zig's null-capable type.
      if (type.name === "Null" && type.args.length === 0) {
        return "?anyopaque";
      }
      if (
        (type.name === "Opaque" || type.name === "Anyopaque") &&
        type.args.length === 0
      ) {
        return "anyopaque";
      }
      // Handle Ptr<T, S> -> *T
      if (type.name === "Ptr" && type.args.length >= 1) {
        const base = emitType(type.args[0], ctx);
        const state = type.args[1];
        if (state && state.kind === "effect_row" && state.cases.has("Null")) {
          return `?*${base}`;
        }
        return `*${base}`;
      }
      // Opaque types like i32, u64 etc. - emit directly
      if (type.args.length === 0) {
        // Check if we have a binding for this type (e.g., C types imported from headers)
        if (ctx) {
          const aliased = ctx.typeBindings.get(type.name);
          if (aliased) {
            return aliased;
          }
          // Also check scope for imported type bindings
          const scoped = ctx.scope.get(type.name);
          if (scoped) {
            return scoped.value;
          }
        }
        return type.name;
      }
      // Generic types like List<T> - emit as Type(args)
      const typeArgs = type.args.map(t => emitType(t, ctx)).join(", ");
      return `${type.name}(${typeArgs})`;
    case "tuple":
      const elements = type.elements.map(t => emitType(t, ctx)).join(", ");
      return `struct { ${elements} }`;
    case "array":
      return `[${type.length}]${emitType(type.element, ctx)}`;
    case "record":
      const fields = Array.from(type.fields.entries())
        .map(([name, t]) => `${name}: ${emitType(t, ctx)}`)
        .join(", ");
      return `struct { ${fields} }`;
    case "var":
      return "anyopaque";
    default:
      return "anytype";
  }
}

function mapZigPrimitive(type: Type): string | null {
  if (type.kind === "bool") return "bool";
  if (type.kind !== "constructor" || type.args.length !== 0) return null;
  switch (type.name) {
    case "Bool":
      return "bool";
    case "I8":
      return "i8";
    case "I16":
      return "i16";
    case "I32":
      return "i32";
    case "I64":
      return "i64";
    case "I128":
      return "i128";
    case "Isize":
      return "isize";
    case "U8":
      return "u8";
    case "U16":
      return "u16";
    case "U32":
      return "u32";
    case "U64":
      return "u64";
    case "U128":
      return "u128";
    case "Usize":
      return "usize";
    case "F16":
      return "f16";
    case "F32":
      return "f32";
    case "F64":
      return "f64";
    case "F128":
      return "f128";
    case "Void":
      return "void";
    case "NoReturn":
      return "noreturn";
    case "Anyerror":
      return "anyerror";
    case "ComptimeInt":
      return "comptime_int";
    case "ComptimeFloat":
      return "comptime_float";
    case "CShort":
      return "c_short";
    case "CUShort":
      return "c_ushort";
    case "CInt":
      return "c_int";
    case "CUInt":
      return "c_uint";
    case "CLong":
      return "c_long";
    case "CULong":
      return "c_ulong";
    case "CLongLong":
      return "c_longlong";
    case "CULongLong":
      return "c_ulonglong";
    case "CChar":
      return "c_char";
    default:
      return null;
  }
}

function getReturnType(type: Type): Type {
  if (type.kind === "func") {
    return getReturnType(type.to);
  }
  return type;
}

function getParamTypes(type: Type, count: number): Type[] {
  const types: Type[] = [];
  let current = type;
  for (let i = 0; i < count && current.kind === "func"; i++) {
    types.push(current.from);
    current = current.to;
  }
  return types;
}
