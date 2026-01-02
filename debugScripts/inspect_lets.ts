import { resolve } from "std/path/mod.ts";

import { compileWorkmanGraph } from "../backends/compiler/frontends/workman.ts";
import { createDefaultForeignTypeConfig } from "../src/foreign_types/c_header_provider.ts";
import type {
  MBlockExpr,
  MExpr,
  MLetDeclaration,
  MMatchBundle,
  MProgram,
} from "../src/ast_marked.ts";

async function main() {
  const args = Deno.args.slice();
  const showLegacy = args.includes("--legacy");
  const targetIndex = args.findIndex((arg) => !arg.startsWith("--"));
  const target = targetIndex === -1 ? undefined : args[targetIndex];
  const filter = targetIndex === -1 ? undefined : args[targetIndex + 1]?.startsWith("--")
    ? undefined
    : args[targetIndex + 1];

  if (!target) {
    console.error(
      "Usage: deno run -A debugScripts/inspect_lets.ts <module.wm> [name-filter] [--legacy]",
    );
    Deno.exit(1);
  }

  const entryPath = resolve(Deno.cwd(), target);
  const compileResult = await compileWorkmanGraph(entryPath, {
    loader: {
      stdRoots: [resolve(Deno.cwd(), "std")],
      preludeModule: "std/prelude",
      foreignTypes: createDefaultForeignTypeConfig(entryPath),
      tolerantParsing: true,
    },
  });

  const entryKey = compileResult.loader.entry;
  const artifact = compileResult.modules.get(entryKey);
  if (!artifact) {
    console.error(`Entry module '${entryKey}' not found in compile result.`);
    Deno.exit(1);
  }

  const program = artifact.analysis.layer1.markedProgram as MProgram;
  const source = artifact.node.source;
  const visitedDecls = new Set<number>();

  const shouldInclude = (name: string) =>
    filter ? name.includes(filter) : true;

  function buildNodeIndex(program: MProgram) {
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

  function recordDecl(decl: MLetDeclaration, context: string) {
    if (typeof decl.id !== "number") {
      return;
    }
    if (visitedDecls.has(decl.id)) {
      return;
    }
    visitedDecls.add(decl.id);
    const span = decl.nameSpan;
    const text = span ? source.slice(span.start, span.end) : "<missing>";
    if (shouldInclude(decl.name)) {
      const spanText = span ? `${span.start}-${span.end}` : "n/a";
      console.log(
        `[LET] ${decl.name} (id=${decl.id}) span=${spanText} ctx=${context}`,
      );
      console.log(`  text="${text}"`);
    }
  }

  function visitLet(decl: MLetDeclaration, context: string) {
    if (!decl) return;
    const nextContext = `${context} > let(${decl.name})`;
    recordDecl(decl, nextContext);
    visitBlock(decl.body, `${nextContext}.body`);
    if (decl.mutualBindings) {
      decl.mutualBindings.forEach((binding, index) =>
        visitLet(binding, `${nextContext}.mutual[${index}]`)
      );
    }
  }

  function visitBlock(block: MBlockExpr | undefined, context: string) {
    if (!block) return;
    block.statements.forEach((stmt, index) => {
      const stmtCtx = `${context}.stmt[${index}]:${stmt.kind}`;
      if (stmt.kind === "let_statement") {
        visitLet(stmt.declaration, stmtCtx);
      } else if (stmt.kind === "expr_statement") {
        visitExpr(stmt.expression, stmtCtx);
      }
    });
    if (block.result) {
      visitExpr(block.result, `${context}.result`);
    }
  }

  function visitMatchBundle(bundle: MMatchBundle, context: string) {
    bundle.arms.forEach((arm, index) => {
      if (arm.kind === "match_pattern") {
        visitExpr(arm.body, `${context}.arm[${index}]`);
      }
    });
  }

  function visitExpr(expr: MExpr | undefined, context: string) {
    if (!expr) return;
    switch (expr.kind) {
      case "block":
        visitBlock(expr, `${context}.block`);
        break;
      case "arrow":
        visitBlock(expr.body, `${context}.arrow`);
        break;
      case "call":
        visitExpr(expr.callee, `${context}.call.callee`);
        expr.arguments.forEach((arg, index) =>
          visitExpr(arg, `${context}.call.args[${index}]`)
        );
        break;
      case "constructor":
        expr.args.forEach((arg, index) =>
          visitExpr(arg, `${context}.ctor.args[${index}]`)
        );
        break;
      case "tuple":
        expr.elements.forEach((element, index) =>
          visitExpr(element, `${context}.tuple[${index}]`)
        );
        break;
      case "record_literal":
        expr.fields.forEach((field, index) =>
          visitExpr(field.value, `${context}.record.fields[${index}]`)
        );
        break;
      case "record_projection":
        visitExpr(expr.target, `${context}.record_projection`);
        break;
      case "binary":
        visitExpr(expr.left, `${context}.binary.left`);
        visitExpr(expr.right, `${context}.binary.right`);
        break;
      case "unary":
        visitExpr(expr.operand, `${context}.unary`);
        break;
      case "match":
        visitExpr(expr.scrutinee, `${context}.match.scrutinee`);
        visitMatchBundle(expr.bundle, `${context}.match.bundle`);
        break;
      case "match_fn":
        expr.parameters.forEach((param, index) =>
          visitExpr(param, `${context}.match_fn.param[${index}]`)
        );
        visitMatchBundle(expr.bundle, `${context}.match_fn.bundle`);
        break;
      case "match_bundle_literal":
        visitMatchBundle(expr.bundle, `${context}.match_bundle_literal`);
        break;
      default:
        break;
    }
  }

  for (const decl of program.declarations ?? []) {
    if (decl.kind === "let") {
      visitLet(decl, "<top>");
    }
  }

  if (showLegacy) {
    console.log("\n=== Legacy nodeIndex collector ===");
    const nodeIndex = buildNodeIndex(program);
    for (const node of nodeIndex.values()) {
      if (
        node &&
        node.kind === "let" &&
        typeof node.id === "number" &&
        node.nameSpan &&
        typeof node.nameSpan.start === "number" &&
        typeof node.nameSpan.end === "number"
      ) {
        const name = (node as MLetDeclaration).name;
        if (!shouldInclude(name)) continue;
        const span = node.nameSpan;
        const spanText = `${span.start}-${span.end}`;
        console.log(
          `[LEGACY] ${name} (id=${node.id}) span=${spanText}`,
        );
      }
    }
  }
}

await main();
