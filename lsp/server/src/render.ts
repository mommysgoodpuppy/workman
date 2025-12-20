import type { WorkmanLanguageServer } from "./server.ts";
import {
  Layer3Result,
  MatchCoverageView,
  NodeView,
  PartialType,
} from "../../../src/layer3/mod.ts";
import { formatScheme, formatType } from "../../../src/type_printer.ts";
import {
  getCarrierRegistrySize,
  getRegisteredCarrierInfo,
  Type,
} from "../../../src/types.ts";

type LspServerContext = WorkmanLanguageServer;

export function renderNodeView(
  ctx: LspServerContext,
  view: NodeView,
  layer3: Layer3Result,
  coverage?: MatchCoverageView,
  adtEnv?: Map<string, import("../../../src/types.ts").TypeInfo>,
): string | null {
  // Create printing context once and reuse it throughout
  const printCtx = { names: new Map(), next: 0 };

  let typeStr = partialTypeToString(ctx, view.finalType, layer3, printCtx);
  if (!typeStr) {
    return null;
  }

  let summary: string | null = null;
  let t: Type | undefined = undefined;
  // If the type is a Result, append an error summary grouped by ADT
  try {
    const resolved = ctx.substituteTypeWithLayer3(
      (view.finalType.kind === "unknown" && view.finalType.type)
        ? view.finalType.type
        : (view.finalType as any).type ?? (view as any),
      layer3,
    );
    t = (view.finalType.kind === "concrete") ? view.finalType.type : resolved;
    summary = ctx.summarizeEffectRowFromType(t, adtEnv ?? new Map());
    if (summary && t && t.kind === "constructor" && t.args.length > 0) {
      // Format infected Result types specially
      typeStr = `⚡${formatType(t.args[0], printCtx, 0)} <${summary}>`;
    }
  } catch {
    // ignore
  }

  let result = "```workman\n" + typeStr + "\n```";
  if (summary) {
    result += `\n\nErrors: ${summary}`;
  }

  if (coverage) {
    const rowStr = formatScheme({ quantifiers: [], type: coverage.row });
    const handled = [...coverage.coveredConstructors];
    if (coverage.coversTail) {
      handled.push("_");
    }
    const handledLabel = handled.length > 0 ? handled.join(", ") : "(none)";
    if (coverage.missingConstructors.length === 0) {
      if (coverage.dischargesResult) {
        result +=
          `\n\n⚡ Discharges Err row ${rowStr}; constructors: ${handledLabel}`;
      } else {
        result +=
          `\n\n⚠️ Err row ${rowStr} still infectious (handled: ${handledLabel})`;
      }
    } else {
      const missingLabel = coverage.missingConstructors.join(", ");
      result +=
        `\n\n⚠️ Missing Err constructors ${missingLabel} for row ${rowStr} (handled: ${handledLabel})`;
    }
  }

  // Check if this node references a hole with solution information
  const holeSolutions = layer3.holeSolutions;
  if (
    holeSolutions && view.finalType.kind === "unknown" && view.finalType.type
  ) {
    // Extract the actual hole ID from the type
    const holeId = ctx.extractHoleIdFromType(view.finalType.type);
    if (holeId !== undefined) {
      const solution = holeSolutions.get(holeId);
      if (solution) {
        // Show provenance for unknown types
        if (solution.provenance && solution.provenance.provenance) {
          const prov = solution.provenance.provenance;
          if (prov.kind === "incomplete" && prov.reason) {
            result += `\n\n_${prov.reason}_`;
          } else if (prov.kind === "expr_hole") {
            result += "\n\n_Explicit type hole_";
          } else if (prov.kind === "user_hole") {
            result += "\n\n_User-specified type hole_";
          }
        }

        if (solution.state === "partial" && solution.partial) {
          result += "\n\n**Partial Type Information:**\n";
          if (solution.partial.known) {
            result += `- Known: \`${
              formatType(solution.partial.known, printCtx, 0)
            }\`\n`;
          }
          if (
            solution.partial.possibilities &&
            solution.partial.possibilities.length > 0
          ) {
            result +=
              `- Possibilities: ${solution.partial.possibilities.length}\n`;
            // Show first few possibilities
            const maxShow = 3;
            for (
              let i = 0;
              i < Math.min(maxShow, solution.partial.possibilities.length);
              i++
            ) {
              result += `  - \`${
                formatType(solution.partial.possibilities[i], printCtx, 0)
              }\`\n`;
            }
            if (solution.partial.possibilities.length > maxShow) {
              result += `  - ... and ${
                solution.partial.possibilities.length - maxShow
              } more\n`;
            }
          }
          result +=
            "\n_Some type information is inferred, but not everything is known yet._";
        } else if (solution.state === "conflicted" && solution.conflicts) {
          result += "\n\n**⚠️ Type Conflict Detected:**\n";
          for (const conflict of solution.conflicts) {
            const types = conflict.types.map((t: any) =>
              formatType(t, printCtx, 0)
            )
              .join(" vs ");
            result += `- Conflicting types: \`${types}\`\n`;
            result += `- Reason: ${conflict.reason}\n`;
          }
          result += "\n_This type hole has incompatible constraints._";
        } else if (solution.state === "unsolved") {
          result += "\n\n_Type is not fully determined yet._";
        }
      }
    }
  }

  return result;
}

function partialTypeToString(
  ctx: LspServerContext,
  partial: PartialType,
  layer3: Layer3Result,
  printCtx: { names: Map<number, string>; next: number },
): string | null {
  switch (partial.kind) {
    case "unknown": {
      if (!partial.type) return "?";
      const substituted = ctx.substituteTypeWithLayer3(
        partial.type,
        layer3,
      );
      let str = substituted ? formatType(substituted, printCtx, 0) : "?";
      // Post-process to format Result types using a robust replacer
      str = ctx.replaceIResultFormats(str);
      return str;
    }
    case "concrete": {
      let str = partial.type
        ? formatType(
          ctx.substituteTypeWithLayer3(partial.type, layer3),
          printCtx,
          0,
        )
        : null;
      if (str) {
        // Post-process to format Result types using a robust replacer
        str = ctx.replaceIResultFormats(str);
      }
      return str;
    }
    default:
      return null;
  }
}
