import type { MatchArm, MatchBundle, MatchBundleLiteralExpr } from "../ast.ts";
import type { MExpr, MMatchArm, MMatchBundle, MMatchBundleReferenceArm, MMatchPatternArm } from "../ast_marked.ts";
import type { Context } from "./context.ts";
import type { MatchBranchesResult } from "../infermatch.ts";

export interface MatchLoweringResult {
  bundle: MMatchBundle;
  arms: { original: MatchArm; marked: MMatchArm }[];
  scrutinee: MExpr;
}

export function lowerMatchExpression(
  ctx: Context,
  scrutinee: MExpr,
  bundle: MatchBundle,
  branches: MatchBranchesResult,
): MatchLoweringResult {
  const markedArms: { original: MatchArm; marked: MMatchArm }[] = [];
  const patternInfos = branches.patternInfos;
  let idx = 0;
  for (const arm of bundle.arms) {
    if (arm.kind === "match_bundle_reference") {
      const marked: MMatchBundleReferenceArm = {
        kind: "match_bundle_reference",
        span: arm.span,
        id: arm.id,
        name: arm.name,
        hasTrailingComma: arm.hasTrailingComma,
      };
      markedArms.push({ original: arm, marked });
    } else {
      const info = patternInfos[idx++];
      const marked: MMatchPatternArm = {
        kind: "match_pattern",
        span: arm.span,
        id: arm.id,
        pattern: info.marked,
        body: scrutinee, // placeholder; real lowering will replace this later
        hasTrailingComma: arm.hasTrailingComma,
        type: branches.type,
      };
      markedArms.push({ original: arm, marked });
    }
  }
  const markedBundle: MMatchBundle = {
    kind: "match_bundle",
    span: bundle.span,
    id: bundle.id,
    type: branches.type,
    arms: markedArms.map((entry) => entry.marked),
  };
  return {
    bundle: markedBundle,
    arms: markedArms,
    scrutinee,
  };
}
