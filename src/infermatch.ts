import { Expr, MatchArm, MatchBundle, MatchBundleLiteralExpr } from "./ast.ts";
import {
  applyCurrentSubst,
  Context,
  ensureExhaustive,
  inferExpr,
  inferPattern,
  unify,
  withScopedEnv,
} from "./infer.ts";
import { freshTypeVar, instantiate, Type, typeToString } from "./types.ts";
import { inferError } from "./infer.ts";

export function inferMatchExpression(
  ctx: Context,
  scrutinee: Expr,
  bundle: MatchBundle,
): Type {
  const scrutineeType = inferExpr(ctx, scrutinee);
  return inferMatchBranches(ctx, scrutineeType, bundle.arms);
}

export function inferMatchFunction(
  ctx: Context,
  parameters: Expr[],
  bundle: MatchBundle,
): Type {
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

export function inferMatchBundleLiteral(
  ctx: Context,
  expr: MatchBundleLiteralExpr,
): Type {
  const param = freshTypeVar();
  const result = inferMatchBranches(ctx, param, expr.bundle.arms, false);
  return {
    kind: "func",
    from: applyCurrentSubst(ctx, param),
    to: applyCurrentSubst(ctx, result),
  };
}

export function inferMatchBranches(
  ctx: Context,
  scrutineeType: Type,
  arms: MatchArm[],
  exhaustive: boolean = true,
): Type {
  let resultType: Type | null = null;
  const coverageMap = new Map<string, Set<string>>();
  const booleanCoverage = new Set<"true" | "false">();
  let hasWildcard = false;

  for (const arm of arms) {
    if (arm.kind === "match_bundle_reference") {
      const scheme = ctx.env.get(arm.name);
      if (!scheme) {
        throw inferError(
          `Unknown match bundle '${arm.name}'`,
          arm.span,
          ctx.source,
        );
      }
      const instantiated = instantiate(scheme);
      const inputType = freshTypeVar();
      const outputType = freshTypeVar();
      unify(ctx, instantiated, {
        kind: "func",
        from: inputType,
        to: outputType,
      });
      unify(ctx, inputType, scrutineeType);
      const bodyType = applyCurrentSubst(ctx, outputType);
      if (!resultType) {
        resultType = bodyType;
      } else {
        unify(ctx, resultType, bodyType);
        resultType = applyCurrentSubst(ctx, resultType);
      }
      // Referenced bundles cover their own cases; treat as wildcard for exhaustiveness.
      hasWildcard = true;
      continue;
    }

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
        ctx.env.set(name, {
          quantifiers: [],
          type: applyCurrentSubst(ctx, type),
        });
      }
      if (
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        ) &&
        resultType
      ) {
        console.log(
          "[debug] expected result before arm",
          arm.pattern.kind === "constructor"
            ? arm.pattern.name
            : arm.pattern.kind,
          ":",
          typeToString(applyCurrentSubst(ctx, resultType)),
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

  if (exhaustive) {
    ensureExhaustive(
      ctx,
      applyCurrentSubst(ctx, scrutineeType),
      hasWildcard,
      coverageMap,
      booleanCoverage,
    );
  }

  if (!resultType) {
    resultType = freshTypeVar();
  }

  return applyCurrentSubst(ctx, resultType);
}
