import type { NodeId, SourceSpan } from "../../../src/ast.ts";
import type { Type } from "../../../src/types.ts";
import { typeToString } from "../../../src/types.ts";

/**
 * Base metadata shared by Core IR nodes.
 */
export interface CoreNodeMeta {
  readonly type: Type;
  readonly origin?: NodeId;
  readonly span?: SourceSpan;
}

/**
 * Literals that can appear in the Core IR.
 */
export type CoreLiteral =
  | { readonly kind: "unit" }
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "char"; readonly value: number }
  | { readonly kind: "string"; readonly value: string };

export interface CoreLiteralExpr extends CoreNodeMeta {
  readonly kind: "literal";
  readonly literal: CoreLiteral;
}

export interface CoreVarExpr extends CoreNodeMeta {
  readonly kind: "var";
  readonly name: string;
}

export interface CoreTupleExpr extends CoreNodeMeta {
  readonly kind: "tuple";
  readonly elements: readonly CoreExpr[];
}

export interface CoreRecordField {
  readonly name: string;
  readonly value: CoreExpr;
}

export interface CoreRecordExpr extends CoreNodeMeta {
  readonly kind: "record";
  readonly fields: readonly CoreRecordField[];
}

export interface CoreTupleGetExpr extends CoreNodeMeta {
  readonly kind: "tuple_get";
  readonly target: CoreExpr;
  readonly index: number;
}

export interface CoreDataExpr extends CoreNodeMeta {
  readonly kind: "data";
  readonly typeName: string;
  readonly constructor: string;
  readonly fields: readonly CoreExpr[];
}

export interface CoreLambdaExpr extends CoreNodeMeta {
  readonly kind: "lambda";
  readonly params: readonly string[];
  readonly body: CoreExpr;
}

export interface CoreCallExpr extends CoreNodeMeta {
  readonly kind: "call";
  readonly callee: CoreExpr;
  readonly args: readonly CoreExpr[];
}

export interface CoreLetExpr extends CoreNodeMeta {
  readonly kind: "let";
  readonly binding: {
    readonly name: string;
    readonly value: CoreExpr;
    readonly isRecursive: boolean;
  };
  readonly body: CoreExpr;
}

export interface CoreLetRecExpr extends CoreNodeMeta {
  readonly kind: "let_rec";
  readonly bindings: readonly {
    readonly name: string;
    readonly value: CoreLambdaExpr;
  }[];
  readonly body: CoreExpr;
}

export interface CoreIfExpr extends CoreNodeMeta {
  readonly kind: "if";
  readonly condition: CoreExpr;
  readonly thenBranch: CoreExpr;
  readonly elseBranch: CoreExpr;
}

export interface CorePrimExpr extends CoreNodeMeta {
  readonly kind: "prim";
  readonly op: CorePrimOp;
  readonly args: readonly CoreExpr[];
}

export interface CoreMatchCoverage {
  readonly row: Type;
  readonly coveredConstructors: readonly string[];
  readonly coversTail: boolean;
  readonly missingConstructors: readonly string[];
  readonly dischargesResult: boolean;
}

export interface CoreMatchExpr extends CoreNodeMeta {
  readonly kind: "match";
  readonly scrutinee: CoreExpr;
  readonly cases: readonly CoreMatchCase[];
  readonly fallback?: CoreExpr;
  readonly effectRowCoverage?: CoreMatchCoverage;
}

export type CoreExpr =
  | CoreLiteralExpr
  | CoreVarExpr
  | CoreTupleExpr
  | CoreRecordExpr
  | CoreTupleGetExpr
  | CoreDataExpr
  | CoreLambdaExpr
  | CoreCallExpr
  | CoreLetExpr
  | CoreLetRecExpr
  | CoreIfExpr
  | CorePrimExpr
  | CoreMatchExpr;

export type CorePrimOp =
  | "int_add"
  | "int_sub"
  | "int_mul"
  | "int_div"
  | "int_eq"
  | "int_ne"
  | "int_lt"
  | "int_le"
  | "int_gt"
  | "int_ge"
  | "int_cmp"
  | "bool_and"
  | "bool_or"
  | "bool_not"
  | "char_eq"
  | "string_length"
  | "string_slice"
  | "record_get"
  | "native_print";

interface CorePatternBase extends CoreNodeMeta {
  readonly kind: string;
}

export interface CoreWildcardPattern extends CorePatternBase {
  readonly kind: "wildcard";
}

export interface CoreBindingPattern extends CorePatternBase {
  readonly kind: "binding";
  readonly name: string;
}

export interface CoreLiteralPattern extends CorePatternBase {
  readonly kind: "literal";
  readonly literal: CoreLiteral;
}

export interface CoreTuplePattern extends CorePatternBase {
  readonly kind: "tuple";
  readonly elements: readonly CorePattern[];
}

export interface CoreConstructorPattern extends CorePatternBase {
  readonly kind: "constructor";
  readonly typeName: string;
  readonly constructor: string;
  readonly fields: readonly CorePattern[];
}

export interface CoreAllErrorsPattern extends CorePatternBase {
  readonly kind: "all_errors";
  readonly resultTypeName: string;
}

export interface CorePinnedPattern extends CorePatternBase {
  readonly kind: "pinned";
  readonly name: string;
}

export type CorePattern =
  | CoreWildcardPattern
  | CoreBindingPattern
  | CoreLiteralPattern
  | CoreTuplePattern
  | CoreConstructorPattern
  | CoreAllErrorsPattern
  | CorePinnedPattern;

export interface CoreMatchCase {
  readonly pattern: CorePattern;
  readonly body: CoreExpr;
  readonly guard?: CoreExpr;
}

export interface CoreTypeConstructor {
  readonly name: string;
  readonly arity: number;
  readonly exported: boolean;
}

export interface CoreTypeDeclaration {
  readonly name: string;
  readonly constructors: readonly CoreTypeConstructor[];
  readonly exported: boolean;
  readonly origin?: NodeId;
  readonly infectious?: {
    readonly domain: string;
    readonly valueConstructor?: string;
    readonly effectConstructors?: readonly string[];
  };
}

export type CoreImportSpecifier = {
  readonly kind: "value";
  readonly imported: string;
  readonly local: string;
};

export interface CoreImport {
  readonly source: string;
  readonly specifiers: readonly CoreImportSpecifier[];
}

export type CoreExport =
  | {
    readonly kind: "value";
    readonly local: string;
    readonly exported: string;
  }
  | {
    readonly kind: "constructor";
    readonly typeName: string;
    readonly ctor: string;
    readonly exported: string;
  }
  | {
    readonly kind: "type";
    readonly typeName: string;
    readonly exported: string;
  };

export interface CoreValueBinding {
  readonly name: string;
  readonly value: CoreExpr;
  readonly exported: boolean;
  readonly origin?: NodeId;
}

export type CoreModuleMode = "runtime" | "raw";

export interface CoreModule {
  readonly path: string;
  readonly imports: readonly CoreImport[];
  readonly typeDeclarations: readonly CoreTypeDeclaration[];
  readonly values: readonly CoreValueBinding[];
  readonly exports: readonly CoreExport[];
  readonly mode?: CoreModuleMode;
}

export interface CoreModuleGraph {
  readonly entry: string;
  readonly order: readonly string[];
  readonly modules: ReadonlyMap<string, CoreModule>;
  readonly prelude?: string;
}

export interface CoreFormatOptions {
  readonly indent?: string;
  readonly showTypes?: boolean;
}

const DEFAULT_INDENT = "  ";

const DEFAULT_OPTIONS: Required<CoreFormatOptions> = {
  indent: DEFAULT_INDENT,
  showTypes: true,
};

export function formatCoreExpr(
  expr: CoreExpr,
  options: CoreFormatOptions = {},
): string {
  const resolved = resolveFormatOptions(options);
  const lines = formatExprLines(expr, resolved, 0);
  return lines.join("\n");
}

export function formatCoreModule(
  module: CoreModule,
  options: CoreFormatOptions = {},
): string {
  const resolved = resolveFormatOptions(options);
  const lines: string[] = [];
  lines.push(`module ${module.path}`);

  if (module.imports.length > 0) {
    lines.push(`${resolved.indent}imports:`);
    for (const entry of module.imports) {
      const specifiers = entry.specifiers
        .map((spec) =>
          spec.imported === spec.local
            ? spec.imported
            : `${spec.imported} as ${spec.local}`
        )
        .join(", ");
      lines.push(
        `${resolved.indent}${resolved.indent}from ${entry.source} import { ${specifiers} }`,
      );
    }
  }

  if (module.typeDeclarations.length > 0) {
    lines.push(`${resolved.indent}types:`);
    for (const decl of module.typeDeclarations) {
      const ctorParts: string[] = [];
      for (const ctor of decl.constructors) {
        const payload = ctor.arity === 0 ? "" : `/${ctor.arity}`;
        const flag = ctor.exported ? " (exported)" : "";
        ctorParts.push(`${ctor.name}${payload}${flag}`);
      }
      const flag = decl.exported ? " (exported)" : "";
      const joined = ctorParts.join(", ");
      lines.push(
        `${resolved.indent}${resolved.indent}${decl.name}${flag}: ${joined}`,
      );
    }
  }

  if (module.values.length > 0) {
    lines.push(`${resolved.indent}values:`);
    for (const value of module.values) {
      const exportTag = value.exported ? " (exported)" : "";
      lines.push(
        `${resolved.indent}${resolved.indent}${value.name}${exportTag} =`,
      );
      const exprLines = formatExprLines(value.value, resolved, 3);
      lines.push(...exprLines);
    }
  }

  if (module.exports.length > 0) {
    lines.push(`${resolved.indent}exports:`);
    for (const exp of module.exports) {
      if (exp.kind === "value") {
        const alias = exp.local === exp.exported
          ? exp.exported
          : `${exp.local} as ${exp.exported}`;
        lines.push(`${resolved.indent}${resolved.indent}${alias}`);
      } else if (exp.kind === "constructor") {
        lines.push(
          `${resolved.indent}${resolved.indent}${exp.typeName}.${exp.ctor} as ${exp.exported}`,
        );
      } else {
        lines.push(
          `${resolved.indent}${resolved.indent}type ${exp.typeName} as ${exp.exported}`,
        );
      }
    }
  }

  return lines.join("\n");
}

export function formatCoreGraph(
  graph: CoreModuleGraph,
  options: CoreFormatOptions = {},
): string {
  const resolved = resolveFormatOptions(options);
  const separator = "-".repeat(40);
  const lines: string[] = [
    `entry: ${graph.entry}`,
    `order: ${graph.order.join(", ")}`,
    separator,
  ];
  for (const path of graph.order) {
    const module = graph.modules.get(path);
    if (!module) continue;
    lines.push(formatCoreModule(module, resolved));
    lines.push(separator);
  }
  return lines.join("\n");
}

function resolveFormatOptions(
  options: CoreFormatOptions,
): Required<CoreFormatOptions> {
  return {
    indent: options.indent ?? DEFAULT_OPTIONS.indent,
    showTypes: options.showTypes ?? DEFAULT_OPTIONS.showTypes,
  };
}

function formatExprLines(
  expr: CoreExpr,
  options: Required<CoreFormatOptions>,
  depth: number,
): string[] {
  const indent = options.indent.repeat(depth);
  const typeSuffix = options.showTypes ? ` : ${typeToString(expr.type)}` : "";
  switch (expr.kind) {
    case "literal":
      return [`${indent}literal ${formatLiteral(expr.literal)}${typeSuffix}`];
    case "var":
      return [`${indent}var ${expr.name}${typeSuffix}`];
    case "tuple": {
      if (expr.elements.length === 0) {
        return [`${indent}tuple []${typeSuffix}`];
      }
      const lines = [`${indent}tuple${typeSuffix} [`];
      for (const element of expr.elements) {
        lines.push(
          ...formatExprLines(
            element,
            options,
            depth + 1,
          ),
        );
      }
      lines.push(`${indent}]`);
      return lines;
    }
    case "record": {
      if (expr.fields.length === 0) {
        return [`${indent}{ }${typeSuffix}`];
      }
      const lines = [`${indent}record${typeSuffix}`];
      for (const field of expr.fields) {
        lines.push(`${indent}${options.indent}${field.name}:`);
        lines.push(
          ...formatExprLines(field.value, options, depth + 2),
        );
      }
      return lines;
    }
    case "tuple_get": {
      const lines = [`${indent}tuple_get #${expr.index}${typeSuffix}`];
      lines.push(
        ...formatExprLines(expr.target, options, depth + 1),
      );
      return lines;
    }
    case "data": {
      const lines = [
        `${indent}data ${expr.typeName}.${expr.constructor}${typeSuffix}`,
      ];
      for (const field of expr.fields) {
        lines.push(...formatExprLines(field, options, depth + 1));
      }
      return lines;
    }
    case "lambda": {
      const params = expr.params.join(", ");
      const lines = [`${indent}lambda (${params})${typeSuffix} {`];
      lines.push(...formatExprLines(expr.body, options, depth + 1));
      lines.push(`${indent}}`);
      return lines;
    }
    case "call": {
      const lines = [`${indent}call${typeSuffix}`];
      lines.push(...formatExprLines(expr.callee, options, depth + 1));
      for (const arg of expr.args) {
        lines.push(...formatExprLines(arg, options, depth + 1));
      }
      return lines;
    }
    case "let": {
      const bindingType = options.showTypes
        ? ` : ${typeToString(expr.binding.value.type)}`
        : "";
      const lines = [
        `${indent}let ${expr.binding.name}${bindingType}${
          expr.binding.isRecursive ? " (rec)" : ""
        }`,
      ];
      lines.push(...formatExprLines(expr.binding.value, options, depth + 1));
      lines.push(`${indent}in${typeSuffix}`);
      lines.push(...formatExprLines(expr.body, options, depth + 1));
      return lines;
    }
    case "let_rec": {
      const lines = [`${indent}let_rec${typeSuffix}`];
      for (const binding of expr.bindings) {
        lines.push(
          `${options.indent.repeat(depth + 1)}${binding.name} : ${
            typeToString(binding.value.type)
          }`,
        );
        lines.push(
          ...formatExprLines(binding.value, options, depth + 2),
        );
      }
      lines.push(`${indent}in`);
      lines.push(...formatExprLines(expr.body, options, depth + 1));
      return lines;
    }
    case "if": {
      const lines = [`${indent}if${typeSuffix}`];
      lines.push(`${indent}${options.indent}cond:`);
      lines.push(...formatExprLines(expr.condition, options, depth + 2));
      lines.push(`${indent}${options.indent}then:`);
      lines.push(...formatExprLines(expr.thenBranch, options, depth + 2));
      lines.push(`${indent}${options.indent}else:`);
      lines.push(...formatExprLines(expr.elseBranch, options, depth + 2));
      return lines;
    }
    case "prim": {
      const argCount = expr.args.length;
      if (argCount === 0) {
        return [`${indent}prim ${expr.op}${typeSuffix}`];
      }
      const lines = [`${indent}prim ${expr.op}${typeSuffix}`];
      for (const arg of expr.args) {
        lines.push(...formatExprLines(arg, options, depth + 1));
      }
      return lines;
    }
    case "match": {
      const lines = [`${indent}match${typeSuffix}`];
      lines.push(`${indent}${options.indent}scrutinee:`);
      lines.push(...formatExprLines(expr.scrutinee, options, depth + 2));
      for (const kase of expr.cases) {
        const pattern = formatPattern(kase.pattern, options);
        lines.push(`${indent}${options.indent}case ${pattern}:`);
        if (kase.guard) {
          lines.push(`${indent}${options.indent}${options.indent}guard:`);
          lines.push(
            ...formatExprLines(kase.guard, options, depth + 3),
          );
        }
        lines.push(
          ...formatExprLines(kase.body, options, depth + 2),
        );
      }
      if (expr.fallback) {
        lines.push(`${indent}${options.indent}else:`);
        lines.push(
          ...formatExprLines(expr.fallback, options, depth + 2),
        );
      }
      return lines;
    }
  }
}

function formatPattern(
  pattern: CorePattern,
  options: Required<CoreFormatOptions>,
): string {
  const suffix = options.showTypes ? ` : ${typeToString(pattern.type)}` : "";
  switch (pattern.kind) {
    case "wildcard":
      return `_` + suffix;
    case "binding":
      return pattern.name + suffix;
    case "literal":
      return `${formatLiteral(pattern.literal)}${suffix}`;
    case "tuple": {
      if (pattern.elements.length === 0) {
        return `[]${suffix}`;
      }
      const inner = pattern.elements.map((el) => formatPattern(el, options))
        .join(", ");
      return `[${inner}]${suffix}`;
    }
    case "constructor": {
      const parts = pattern.fields.map((field) => formatPattern(field, options))
        .join(", ");
      return `${pattern.typeName}.${pattern.constructor}(${parts})${suffix}`;
    }
    case "pinned":
      return `^${pattern.name}${suffix}`;
    default:
      return `<unknown pattern>${suffix}`;
  }
}

function formatLiteral(literal: CoreLiteral): string {
  switch (literal.kind) {
    case "unit":
      return "unit";
    case "int":
      return literal.value.toString();
    case "bool":
      return literal.value ? "true" : "false";
    case "char":
      return `char(${literal.value})`;
    case "string":
      return JSON.stringify(literal.value);
  }
}
