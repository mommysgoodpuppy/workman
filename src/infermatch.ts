import { Expr, MatchArm, MatchBundle, MatchBundleLiteralExpr } from "./ast.ts";
import {
  applyCurrentSubst,
  Context,
  ensureExhaustive,
  inferExpr,
  inferPattern,
  unify,
  withScopedEnv,
} from "./layer1infer.ts";
import { cloneTypeScheme, freeTypeVars, freshTypeVar, instantiate, Type, typeToString } from "./types.ts";
import { inferError } from "./layer1infer.ts";

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
      const existingScheme = ctx.env.get(arm.name);
      const scheme = existingScheme ? cloneTypeScheme(existingScheme) : undefined;
      if (!scheme) {
        throw inferError(
          `Unknown match bundle '${arm.name}'`,
          arm.span,
          ctx.source,
        );
      }
      let instantiated = instantiate(scheme);
      instantiated = applyCurrentSubst(ctx, instantiated);
      if (instantiated.kind === "func" && scheme.quantifiers.length > 0) {
        // Instantiate result with fresh variables so it can specialize per use.
        const freshResult = freshTypeVar();
        unify(ctx, instantiated.to, freshResult);
        instantiated = {
          kind: "func",
          from: instantiated.from,
          to: freshResult,
        };
      }
      const resultVar = freshTypeVar();
      // Ensure the referenced bundle accepts the current scrutinee type exactly
      unify(ctx, instantiated, {
        kind: "func",
        from: applyCurrentSubst(ctx, scrutineeType),
        to: resultVar,
      });
      const bodyType = applyCurrentSubst(ctx, resultVar);
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

  const resolvedResult = applyCurrentSubst(ctx, resultType);
  const resolvedScrutinee = applyCurrentSubst(ctx, scrutineeType);
  const resultVars = freeTypeVars(resolvedResult);
  const scrutineeVars = freeTypeVars(resolvedScrutinee);
  console.log("[debug] match result", {
    scrutinee: typeToString(resolvedScrutinee),
    result: typeToString(resolvedResult),
    resultVars: Array.from(resultVars),
    scrutineeVars: Array.from(scrutineeVars),
  });
  for (const id of resultVars) {
    if (!scrutineeVars.has(id)) {
      ctx.nonGeneralizable.add(id);
    }
  }
  return resolvedResult;
}
