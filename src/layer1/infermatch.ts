import { Expr, MatchBundle, MatchBundleLiteralExpr } from "../ast.ts";
import {
  Context,
  ensureExhaustive,
  inferExpr,
  inferPattern,
} from "./infer.ts";
import {
  applyCurrentSubst,
  markUnsupportedExpr,
  recordBranchJoinConstraint,
  unify,
  withScopedEnv,
} from "./context.ts";
import {
  cloneTypeScheme,
  freeTypeVars,
  freshTypeVar,
  instantiate,
  Type,
  typeToString,
  unknownType
} from "../types.ts";
import { PatternInfo } from "./infer.ts";


export interface MatchBranchesResult {
  type: Type;
  patternInfos: PatternInfo[];
  bodyTypes: Type[];
}

export function inferMatchExpression(
  ctx: Context,
  expr: Expr,
  scrutinee: Expr,
  bundle: MatchBundle,
): Type {
  const scrutineeType = inferExpr(ctx, scrutinee);
  const result = inferMatchBranches(
    ctx,
    expr,
    scrutineeType,
    bundle,
    true,
    scrutinee,
  );
  return result.type;
}

export function inferMatchFunction(
  ctx: Context,
  expr: Expr,
  parameters: Expr[],
  bundle: MatchBundle,
): Type {
  if (parameters.length !== 1) {
    markUnsupportedExpr(ctx, expr, "match_fn_arity");
    return unknownType({ kind: "incomplete", reason: "match_fn_arity" });
  }
  const parameterType = inferExpr(ctx, parameters[0]);
  const { type: resultType } = inferMatchBranches(
    ctx,
    expr,
    parameterType,
    bundle,
    true,
    parameters[0],
  );
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
  const { type: result } = inferMatchBranches(
    ctx,
    expr,
    param,
    expr.bundle,
    false,
  );
  return {
    kind: "func",
    from: applyCurrentSubst(ctx, param),
    to: applyCurrentSubst(ctx, result),
  };
}

export function inferMatchBranches(
  ctx: Context,
  expr: Expr,
  scrutineeType: Type,
  bundle: MatchBundle,
  exhaustive: boolean = true,
  scrutineeExpr?: Expr,
): MatchBranchesResult {
  let resultType: Type | null = null;
  const coverageMap = new Map<string, Set<string>>();
  const booleanCoverage = new Set<"true" | "false">();
  let hasWildcard = false;
  const patternInfos: PatternInfo[] = [];
  const bodyTypes: Type[] = [];
  const branchBodies: Expr[] = [];

  for (const arm of bundle.arms) {
    if (arm.kind === "match_bundle_reference") {
      const existingScheme = ctx.env.get(arm.name);
      const scheme = existingScheme ? cloneTypeScheme(existingScheme) : undefined;
      if (!scheme) {
        markUnsupportedExpr(ctx, expr, "match_bundle_reference");
        hasWildcard = true;
        continue;
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
    patternInfos.push(patternInfo);
    if (arm.kind === "match_pattern") {
      branchBodies.push(arm.body);
    }
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
    bodyTypes.push(applyCurrentSubst(ctx, bodyType));

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
      expr,
      applyCurrentSubst(ctx, scrutineeType),
      hasWildcard,
      coverageMap,
      booleanCoverage,
    );
  }

  if (!resultType) {
    resultType = freshTypeVar();
  }

  if (branchBodies.length > 0 && scrutineeExpr) {
    recordBranchJoinConstraint(ctx, expr, branchBodies, scrutineeExpr);
  }

  const resolvedResult = applyCurrentSubst(ctx, resultType);
  const resolvedScrutinee = applyCurrentSubst(ctx, scrutineeType);
  const resultVars = freeTypeVars(resolvedResult);
  const scrutineeVars = freeTypeVars(resolvedScrutinee);
  /* console.debug("[debug] match result", {
    scrutinee: typeToString(resolvedScrutinee),
    result: typeToString(resolvedResult),
    resultVars: Array.from(resultVars),
    scrutineeVars: Array.from(scrutineeVars),
  }); */
  for (const id of resultVars) {
    if (!scrutineeVars.has(id)) {
      ctx.nonGeneralizable.add(id);
    }
  }
  const result: MatchBranchesResult = {
    type: resolvedResult,
    patternInfos,
    bodyTypes,
  };
  ctx.matchResults.set(bundle, result);
  return result;
}
