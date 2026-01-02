import { dirname, join, resolve } from "std/path/mod.ts";

import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { createDefaultForeignTypeConfig } from "../src/foreign_types/c_header_provider.ts";
import type {
  MBlockExpr,
  MExpr,
  MLetDeclaration,
  MProgram,
} from "../src/ast_marked.ts";
import type { Layer3Result } from "../src/layer3/mod.ts";

interface ModuleInspectionContext {
  layer3: Layer3Result;
  program: MProgram;
}

interface MatchOptions {
  nameFilter?: string;
  nodeId?: number;
}

function parseArgs(): {
  target: string;
  options: MatchOptions;
  extraStdRoots: string[];
} {
  const args = [...Deno.args];
  let target: string | undefined;
  let positionalFilter: string | undefined;
  const options: MatchOptions = {};
  const extraStdRoots: string[] = [];

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--filter" || arg === "-f") {
      options.nameFilter = args.shift();
    } else if (arg === "--node") {
      const nodeValue = args.shift();
      if (nodeValue) {
        options.nodeId = Number(nodeValue);
      }
    } else if (arg === "--std") {
      const root = args.shift();
      if (root) {
        extraStdRoots.push(resolve(root));
      }
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag '${arg}'`);
      Deno.exit(1);
    } else if (!target) {
      target = arg;
    } else if (!positionalFilter) {
      positionalFilter = arg;
    } else {
      console.error(`Unexpected argument '${arg}'`);
      Deno.exit(1);
    }
  }

  if (!target) {
    console.error(
      "Usage: deno run -A debugScripts/inspect_module_context.ts <module.wm> [name-filter] [--node <id>] [--std <path>]",
    );
    Deno.exit(1);
  }

  if (!options.nameFilter && positionalFilter) {
    options.nameFilter = positionalFilter;
  }

  return { target, options, extraStdRoots };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (path) {
      seen.add(resolve(path));
    }
  }
  return Array.from(seen);
}

function computeStdRoots(
  entryPath: string,
  extra: string[],
): string[] {
  const roots = [
    resolve(Deno.cwd(), "std"),
    resolve(dirname(entryPath), "std"),
    ...extra,
  ];
  return uniquePaths(roots);
}

function buildNodeIndex(program: MProgram): Map<number, any> {
  const nodeMap = new Map<number, any>();
  const seen = new Set<any>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    const maybeId = (node as { id?: number }).id;
    if (typeof maybeId === "number" && !nodeMap.has(maybeId)) {
      nodeMap.set(maybeId, node);
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (!value) continue;
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (typeof value === "object") {
        visit(value);
      }
    }
  };
  program.declarations?.forEach(visit);
  return nodeMap;
}

function collectLetDeclarations(program: MProgram): MLetDeclaration[] {
  const results: MLetDeclaration[] = [];
  const visitLet = (decl?: MLetDeclaration) => {
    if (!decl) return;
    results.push(decl);
    visitBlock(decl.body);
    decl.mutualBindings?.forEach((binding) => visitLet(binding));
  };
  const visitBlock = (block?: MBlockExpr) => {
    if (!block) return;
    for (const stmt of block.statements) {
      if (stmt.kind === "let_statement") {
        visitLet(stmt.declaration);
      } else if (stmt.kind === "expr_statement") {
        visitExpr(stmt.expression);
      }
    }
    if (block.result) {
      visitExpr(block.result);
    }
  };
  const visitExpr = (expr?: MExpr) => {
    if (!expr) return;
    switch (expr.kind) {
      case "block":
        visitBlock(expr);
        break;
      case "arrow":
        visitBlock(expr.body);
        break;
      case "call":
        visitExpr(expr.callee);
        expr.arguments.forEach(visitExpr);
        break;
      case "constructor":
        expr.args.forEach(visitExpr);
        break;
      case "tuple":
        expr.elements.forEach(visitExpr);
        break;
      case "record_literal":
        expr.fields.forEach((field) => visitExpr(field.value));
        break;
      case "record_projection":
        visitExpr(expr.target);
        break;
      case "binary":
        visitExpr(expr.left);
        visitExpr(expr.right);
        break;
      case "unary":
        visitExpr(expr.operand);
        break;
      case "match":
        visitExpr(expr.scrutinee);
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      case "match_fn":
        expr.parameters.forEach(visitExpr);
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      case "match_bundle_literal":
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      default:
        break;
    }
  };

  for (const decl of program.declarations ?? []) {
    if (decl.kind === "let") {
      visitLet(decl);
    }
  }
  return results;
}

function shouldInclude(
  decl: MLetDeclaration,
  options: MatchOptions,
): boolean {
  if (options.nodeId !== undefined) {
    return decl.id === options.nodeId;
  }
  if (options.nameFilter) {
    return decl.name.includes(options.nameFilter);
  }
  return true;
}

function formatSpan(span?: { start: number; end: number }): string {
  if (!span) return "n/a";
  return `${span.start}-${span.end}`;
}

function textSlice(
  source: string,
  span?: { start: number; end: number },
): string {
  if (!span) return "<missing>";
  return source.slice(span.start, span.end).replace(/\r?\n/g, "\\n");
}

function describeNode(node: any): string {
  if (!node) return "missing";
  const keys = Object.keys(node);
  return `kind=${node.kind ?? "unknown"}, keys=[${keys.join(", ")}]`;
}

function describeNodeView(
  layer3: Layer3Result,
  nodeId: number | undefined,
): string {
  if (nodeId === undefined) return "nodeId=undefined";
  const view = layer3.nodeViews.get(nodeId);
  if (!view) return "nodeView=missing";
  return `nodeView(finalType=${JSON.stringify(view.finalType)}, expected=${
    JSON.stringify(view.expected)
  })`;
}

async function main() {
  const { target, options, extraStdRoots } = parseArgs();
  const entryPath = resolve(Deno.cwd(), target);
  const entryDir = dirname(entryPath);
  const stdRoots = computeStdRoots(entryPath, extraStdRoots);

  const compileResult = await compileWorkmanGraph(entryPath, {
    loader: {
      stdRoots,
      preludeModule: "std/prelude",
      skipEvaluation: true,
      tolerantParsing: true,
      sourceOverrides: undefined,
      foreignTypes: createDefaultForeignTypeConfig(entryPath),
    },
  });

  const entryKey = compileResult.coreGraph.entry;
  const artifact = compileResult.modules.get(entryKey);
  if (!artifact) {
    console.error(`Entry module '${entryKey}' not found in compile result.`);
    Deno.exit(1);
  }

  const program = artifact.analysis.layer1.markedProgram;
  const layer3 = artifact.analysis.layer3;
  const source = artifact.node.source;
  const context: ModuleInspectionContext = { layer3, program };
  const nodeIndex = buildNodeIndex(program);
  const letDecls = collectLetDeclarations(program).filter((decl) =>
    shouldInclude(decl, options)
  );

  console.log(
    `[CTX] entry=${entryKey} stdRoots=${stdRoots.join(", ")} cwd=${Deno.cwd()} entryDir=${entryDir}`,
  );
  console.log(`[CTX] totalLetCount=${collectLetDeclarations(program).length}`);

  if (letDecls.length === 0) {
    console.log(
      `No let declarations matched filter '${
        options.nameFilter ?? options.nodeId ?? "<none>"
      }'.`,
    );
    return;
  }

  for (const decl of letDecls) {
    const spanText = formatSpan(decl.nameSpan);
    const layer3Span = context.layer3.spanIndex.get(decl.id);
    const idxNode = nodeIndex.get(decl.id);
    console.log(
      `\n[LET] ${decl.name} (id=${decl.id}) span=${spanText} text="${textSlice(
        source,
        decl.nameSpan,
      )}"`,
    );
    console.log(
      `  Layer3 span: ${layer3Span ? formatSpan(layer3Span) : "missing"}`,
    );
    console.log(`  NodeIndex entry: ${describeNode(idxNode)}`);
    console.log(`  Node view: ${describeNodeView(layer3, decl.id)}`);
  }
}

await main();
