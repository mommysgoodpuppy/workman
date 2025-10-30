import { MatchBundle } from "../ast.ts";
import type { MMatchBundle, MMatchArm, MMatchBundleReferenceArm, MMatchPatternArm } from "../ast_marked.ts";
import { Type } from "../types.ts";
import { Context } from "./context.ts";
import { unknownFromReason, materializePattern, materializeExpr } from "./infer.ts";

export function materializeMatchBundle(ctx: Context, bundle: MatchBundle, inferredType?: Type): MMatchBundle {
  const matchResult = ctx.matchResults.get(bundle);
  const patternInfos = matchResult?.patternInfos ?? [];
  const resolvedBundleType = matchResult?.type ?? inferredType ?? unknownFromReason("match.bundle");
  const arms: MMatchArm[] = [];
  let patternIndex = 0;

  for (const arm of bundle.arms) {
    if (arm.kind === "match_bundle_reference") {
      const marked: MMatchBundleReferenceArm = {
        kind: "match_bundle_reference",
        span: arm.span,
        id: arm.id,
        name: arm.name,
        hasTrailingComma: arm.hasTrailingComma,
      } satisfies MMatchBundleReferenceArm;
      arms.push(marked);
      continue;
    }

    const info = patternInfos[patternIndex++];
    const pattern = info?.marked ?? materializePattern(ctx, arm.pattern);
    const body = materializeExpr(ctx, arm.body);
    const armType = matchResult?.type ?? body.type;

    const marked: MMatchPatternArm = {
      kind: "match_pattern",
      span: arm.span,
      id: arm.id,
      pattern,
      body,
      hasTrailingComma: arm.hasTrailingComma,
      type: armType,
    } satisfies MMatchPatternArm;
    arms.push(marked);
  }

  if (matchResult) {
    ctx.matchResults.delete(bundle);
  }

  return {
    kind: "match_bundle",
    span: bundle.span,
    id: bundle.id,
    arms,
    type: resolvedBundleType,
  } satisfies MMatchBundle;
}
