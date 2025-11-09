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
  collapseResultType,
  ErrorRowType,
  flattenResultType,
  freeTypeVars,
  freshTypeVar,
  instantiate,
  Type,
  typeToString,
  unknownType,
} from "../types.ts";
import { PatternInfo } from "./infer.ts";


export interface MatchBranchesResult {
  type: Type;
  patternInfos: PatternInfo[];
  bodyTypes: Type[];
  errorRowCoverage?: MatchErrorRowCoverage;
}

export interface MatchErrorRowCoverage {
  errorRow: ErrorRowType;
  coveredConstructors: Set<string>;
  coversTail: boolean;
  missingConstructors: string[];
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
  let hasAllErrors = false;
  let hasErrConstructor = false;
  const handledErrorConstructors = new Set<string>();
  const patternInfos: PatternInfo[] = [];
  const bodyTypes: Type[] = [];
  const branchBodies: Expr[] = [];
  let errorRowCoverage: MatchErrorRowCoverage | undefined;

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
    } else if (patternInfo.coverage.kind === "all_errors") {
      hasAllErrors = true;
      handledErrorConstructors.add("_");
      if (
        expected.kind === "constructor" &&
        expected.name === "Result"
      ) {
        const set = coverageMap.get(expected.name) ?? new Set<string>();
        set.add("Err");
        coverageMap.set(expected.name, set);
      }
    } else if (patternInfo.coverage.kind === "constructor") {
      if (
        patternInfo.coverage.typeName === "Result" &&
        patternInfo.coverage.ctor === "Err"
      ) {
        hasErrConstructor = true;
        const errorRow = patternInfo.coverage.errorRow;
        if (errorRow) {
          for (const ctor of errorRow.constructors) {
            handledErrorConstructors.add(ctor);
          }
          if (errorRow.coversTail) {
            handledErrorConstructors.add("_");
          }
        }
      }
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

  const resolvedScrutinee = applyCurrentSubst(ctx, scrutineeType);

  if (exhaustive) {
    if (
      hasAllErrors &&
      resolvedScrutinee.kind === "constructor" &&
      resolvedScrutinee.name === "Result"
    ) {
      const set = coverageMap.get(resolvedScrutinee.name) ?? new Set<string>();
      set.add("Err");
      coverageMap.set(resolvedScrutinee.name, set);
    }
    ensureExhaustive(
      ctx,
      expr,
      resolvedScrutinee,
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

  let resolvedResult = applyCurrentSubst(ctx, resultType);
  const scrutineeInfo = flattenResultType(resolvedScrutinee);

  const dischargeErrorRow = (okValueType: Type) => {
    const currentInfo = flattenResultType(resolvedResult);
    const targetResult = currentInfo
      ? collapseResultType(currentInfo.value)
      : resolvedResult;
    unify(ctx, okValueType, targetResult);
    resolvedResult = applyCurrentSubst(ctx, okValueType);
  };

  const snapshotErrorCoverage = (
    row: ErrorRowType,
    missing: string[],
  ) => {
    errorRowCoverage = {
      errorRow: row,
      coveredConstructors: new Set(handledErrorConstructors),
      coversTail: handledErrorConstructors.has("_"),
      missingConstructors: missing,
    };
  };

  if (hasAllErrors) {
    if (!scrutineeInfo) {
      ctx.layer1Diagnostics.push({
        origin: expr.id,
        reason: "all_errors_outside_result",
      });
    } else if (!hasErrConstructor) {
      ctx.layer1Diagnostics.push({
        origin: expr.id,
        reason: "all_errors_requires_err",
      });
    } else {
      dischargeErrorRow(scrutineeInfo.value);
      snapshotErrorCoverage(scrutineeInfo.error, []);
    }
  } else if (scrutineeInfo && hasErrConstructor) {
    const missingConstructors = findMissingErrorConstructors(
      scrutineeInfo.error,
      handledErrorConstructors,
    );
    if (missingConstructors.length === 0) {
      dischargeErrorRow(scrutineeInfo.value);
      snapshotErrorCoverage(scrutineeInfo.error, []);
    } else {
      ctx.layer1Diagnostics.push({
        origin: expr.id,
        reason: "error_row_partial_coverage",
        details: { constructors: missingConstructors },
      });
      snapshotErrorCoverage(scrutineeInfo.error, missingConstructors);
    }
  }
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
    errorRowCoverage,
  };
  ctx.matchResults.set(bundle, result);
  return result;
}

function findMissingErrorConstructors(
  errorRow: ErrorRowType,
  covered: Set<string>,
): string[] {
  if (covered.has("_")) {
    return [];
  }
  const missing: string[] = [];
  for (const label of errorRow.cases.keys()) {
    if (!covered.has(label)) {
      missing.push(label);
    }
  }
  if (errorRow.tail) {
    missing.push("_");
  }
  return missing;
}
