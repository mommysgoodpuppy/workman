import { Expr, MatchBundle } from "./ast.ts";
import { Context, applyCurrentSubst, inferPattern, withScopedEnv, inferExpr, unify, ensureExhaustive } from "./infer.ts";
import { Type, typeToString, freshTypeVar } from "./types.ts";
import { inferError } from "./infer.ts";

export function inferMatchExpression(ctx: Context, scrutinee: Expr, bundle: MatchBundle): Type {
  const scrutineeType = inferExpr(ctx, scrutinee);
  return inferMatchBranches(ctx, scrutineeType, bundle.arms);
}

export function inferMatchFunction(ctx: Context, parameters: Expr[], bundle: MatchBundle): Type {
  if (parameters.length !== 1) {
    throw inferError("Match functions currently support exactly one argument");
  }
  const parameterType = inferExpr(ctx, parameters[0]);
  const resultType = inferMatchBranches(ctx, parameterType, bundle.arms);
  return {
    kind: "func",
    from: applyCurrentSubst(ctx, parameterType),
    to: applyCurrentSubst(ctx, resultType),
  };
}

export function inferMatchBranches(
  ctx: Context,
  scrutineeType: Type,
  arms: MatchArm[]
): Type {
  let resultType: Type | null = null;
  const coverageMap = new Map<string, Set<string>>();
  const booleanCoverage = new Set<"true" | "false">();
  let hasWildcard = false;

  for (const arm of arms) {
    const expected = applyCurrentSubst(ctx, scrutineeType);
    const patternInfo = inferPattern(ctx, arm.pattern, expected);
    if (patternInfo.coverage.kind === "wildcard") {
      hasWildcard = true;
    } else if (patternInfo.coverage.kind === "constructor") {
      const key = patternInfo.coverage.typeName;
      const set = coverageMap.get(key) ?? new Set<string>();
      set.add(patternInfo.coverage.ctor);
      coverageMap.set(key, set);
    } else if (patternInfo.coverage.kind === "bool") {
      booleanCoverage.add(patternInfo.coverage.value ? "true" : "false");
    }

    const bodyType = withScopedEnv(ctx, () => {
      for (const [name, type] of patternInfo.bindings.entries()) {
        ctx.env.set(name, { quantifiers: [], type: applyCurrentSubst(ctx, type) });
      }
      if (ctx.source?.includes("Runtime value printer for Workman using std library") &&
        resultType) {
        console.log(
          "[debug] expected result before arm",
          arm.pattern.kind === "constructor" ? arm.pattern.name : arm.pattern.kind,
          ":",
          typeToString(applyCurrentSubst(ctx, resultType))
        );
      }
      return inferExpr(ctx, arm.body);
    });

    if (!resultType) {
      resultType = bodyType;
    } else {
      unify(ctx, resultType, bodyType);
      resultType = applyCurrentSubst(ctx, resultType);
    }
  }

  ensureExhaustive(ctx, applyCurrentSubst(ctx, scrutineeType), hasWildcard, coverageMap, booleanCoverage);

  if (!resultType) {
    resultType = freshTypeVar();
  }

  return applyCurrentSubst(ctx, resultType);
}

