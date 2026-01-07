import type {
  BlockExpr,
  BlockStatement,
  ConstructorExpr,
  Expr,
  InfixDeclaration,
  LetDeclaration,
  MatchBundle,
  MatchBundleLiteralExpr,
  NodeId,
  Parameter,
  Pattern,
  PrefixDeclaration,
  Program,
  RecordDeclaration,
  TypeDeclaration,
  TypeExpr,
} from "../ast.ts";
import { lowerTupleParameters } from "../lower_tuple_params.ts";
import { canonicalizeMatch } from "../passes/canonicalize_match.ts";
import { desugarListLiterals } from "../passes/desugar_list_literals.ts";
import { lowerIndexAccess } from "../passes/lower_index_access.ts";
import {
  applySubstitution,
  applySubstitutionScheme,
  type CarrierInfo,
  type CarrierOperations,
  cloneType,
  cloneTypeScheme,
  collapseCarrier,
  collapseResultType,
  createEffectRow,
  effectLabel,
  type EffectRowType,
  effectRowUnion,
  ensureRow,
  flattenHoleType,
  flattenResultType,
  freeTypeVars,
  freshResource,
  freshTypeVar,
  getCarrier,
  instantiate,
  isHoleType,
  joinCarrier,
  type Provenance,
  registerCarrier,
  rowLabel,
  splitCarrier,
  type Type,
  type TypeEnv,
  type TypeInfo,
  type TypeScheme,
  typeToString,
  unionCarrierStates,
  unknownType,
} from "../types.ts";
import { formatScheme } from "../type_printer.ts";
import type {
  MExpr,
  MMarkPattern,
  MPattern,
  MProgram,
  MTopLevel,
  MTypeExpr,
} from "../ast_marked.ts";
import {
  applyCurrentSubst,
  type Context,
  createContext,
  createUnknownAndRegister,
  emitAddStateTags,
  emitCallRejectsDomains,
  emitCallRejectsInfection,
  emitConstraintFlow,
  emitConstraintRewrite,
  emitConstraintSource,
  emitRequireAnyState,
  emitRequireAtReturn,
  emitRequireExactState,
  emitRequireNotState,
  expectFunctionType,
  generalizeInContext,
  holeOriginFromExpr,
  holeOriginFromPattern,
  inferError,
  type InferOptions,
  type InferResult,
  instantiateAndApply,
  literalType,
  lookupEnv,
  markFreeVariable,
  markInconsistent,
  markNonExhaustive,
  markNotFunction,
  markOccursCheck,
  markUnsupportedExpr,
  recordAnnotationConstraint,
  recordBooleanConstraint,
  recordBranchJoinConstraint,
  recordCallConstraint,
  recordHasFieldConstraint,
  recordLayer1Diagnostic,
  recordNumericConstraint,
  registerHoleForType,
  unify,
  withScopedEnv,
} from "./context.ts";
import {
  convertTypeExpr,
  registerPrelude,
  registerRawPrelude,
  registerRecordDeclaration,
  registerTypeConstructors,
  registerTypeName,
  resetTypeParamsCache,
} from "./declarations.ts";
import { materializeExpr, materializeMarkedLet } from "./materialize.ts";
import { resetNodeIds } from "../node_ids.ts";
import { unknownFromReason } from "./infer_utils.ts";
import type {
  EffectRowCoverage,
  MatchBranchesResult,
  MatchEffectRowCoverage,
  PatternInfo,
} from "./infer_types.ts";
import type { HoleOrigin } from "./context_types.ts";
import {
  collectInfectionDeclarations,
  type OpRuleDefinition,
  type PolicyDefinition,
} from "../infection_registry.ts";

export type { Context, InferOptions, InferResult } from "./context.ts";
export { InferError } from "../error.ts";
export { inferError } from "./context.ts";

const NUMERIC_BINARY_OPERATORS = new Set(["+", "-", "*", "/", "%"]);

const COMPARISON_OPERATORS = new Set(["<", "<=", ">", ">=", "==", "!="]);

const ORDERING_COMPARISON_OPERATORS = new Set(["<", "<=", ">", ">="]);

const BOOLEAN_BINARY_OPERATORS = new Set(["&&", "||"]);

const NUMERIC_UNARY_OPERATORS = new Set(["+", "-"]);

const BOOLEAN_UNARY_OPERATORS = new Set(["!"]);

type IdentitySetByDomain = Map<string, Set<number>>;

function normalizeStateKind(stateKind?: string): string {
  return stateKind?.replaceAll("_", "").toLowerCase() ?? "";
}

function isRowBagDomain(
  registry: Context["infectionRegistry"],
  domain: string,
) {
  const rule = registry.domains.get(domain);
  return normalizeStateKind(rule?.stateKind) === "rowbag";
}

function shouldInfectReturn(
  registry: Context["infectionRegistry"],
  domain: string,
): boolean {
  const rule = registry.domains.get(domain);
  // Default to true for backwards compatibility; only skip if explicitly false
  return rule?.infectsReturn !== false;
}

function cloneIdentitySetByDomain(
  source: IdentitySetByDomain,
): IdentitySetByDomain {
  const cloned = new Map<string, Set<number>>();
  for (const [domain, ids] of source.entries()) {
    cloned.set(domain, new Set(ids));
  }
  return cloned;
}

function tagWithIdentity(tag: string, identityId: number): string {
  return `${tag}#r${identityId}`;
}

function getIdentityTags(
  ctx: Context,
  domain: string,
  identityId: number,
): string[] {
  const domainTags = ctx.identityStates.get(identityId)?.get(domain);
  if (!domainTags || domainTags.size === 0) return [];
  const tags: string[] = [];
  for (const [tag, originNodes] of domainTags.entries()) {
    for (const originNode of originNodes) {
      tags.push(`${tagWithIdentity(tag, identityId)}@${originNode}`);
    }
  }
  return tags;
}

function addIdentityTags(
  ctx: Context,
  domain: string,
  identityId: number,
  tags: string[],
  originNodeId: number,
): string[] {
  let domainTags = ctx.identityStates.get(identityId);
  if (!domainTags) {
    domainTags = new Map<string, Map<string, number[]>>();
    ctx.identityStates.set(identityId, domainTags);
  }
  let tagOrigins = domainTags.get(domain);
  if (!tagOrigins) {
    tagOrigins = new Map<string, number[]>();
    domainTags.set(domain, tagOrigins);
  }
  const tagged: string[] = [];
  for (const tag of tags) {
    const origins = tagOrigins.get(tag) ?? [];
    origins.push(originNodeId);
    tagOrigins.set(tag, origins);
    tagged.push(`${tagWithIdentity(tag, identityId)}@${originNodeId}`);
  }
  return tagged;
}

function getBindingIdForVar(ctx: Context, varName: string): number {
  return ctx.variableBindingIds.get(varName) ?? 0;
}

function createNewBindingForVar(ctx: Context, varName: string): number {
  const newId = ctx.nextBindingId++;
  ctx.variableBindingIds.set(varName, newId);
  return newId;
}

function recordMutableBinding(
  ctx: Context,
  varName: string,
  isMutable?: boolean,
): void {
  ctx.mutableBindings.set(varName, Boolean(isMutable));
}

function checkMutableShadowing(ctx: Context, decl: LetDeclaration): void {
  if (!decl.isMutable) return;
  if (ctx.mutableBindings.get(decl.name) === true) {
    recordLayer1Diagnostic(ctx, decl.id, "mutable_shadowing", {
      name: decl.name,
    });
  }
}

function recordIdentityUsage(
  ctx: Context,
  domain: string,
  identityId: number,
  nodeId: NodeId,
  varName: string | null = null,
): void {
  let domainUsage = ctx.identityUsage.get(identityId);
  if (!domainUsage) {
    domainUsage = new Map<
      string,
      Map<NodeId, { scopeId: number; bindingId: number | null }>
    >();
    ctx.identityUsage.set(identityId, domainUsage);
  }
  const nodes = domainUsage.get(domain) ??
    new Map<NodeId, { scopeId: number; bindingId: number | null }>();
  // Record the binding ID for this variable at the time of usage
  const bindingId = varName ? getBindingIdForVar(ctx, varName) : null;
  nodes.set(nodeId, { scopeId: getCurrentScopeId(ctx), bindingId });
  domainUsage.set(domain, nodes);
}

function getPreviousIdentityUses(
  ctx: Context,
  domain: string,
  identityId: number,
): NodeId[] {
  const domainUsage = ctx.identityUsage.get(identityId);
  if (!domainUsage) return [];
  const nodes = domainUsage.get(domain);
  if (!nodes) return [];
  return Array.from(nodes.keys());
}

function emitIdentityTagsToUsage(
  ctx: Context,
  domain: string,
  identityId: number,
  tagged: string[],
  sourceVarName: string | null = null,
): void {
  const domainUsage = ctx.identityUsage.get(identityId);
  const nodes = domainUsage?.get(domain);
  if (!nodes) return;
  const currentScopeId = getCurrentScopeId(ctx);
  const identityCreationScope = ctx.identityCreationScope.get(identityId) ?? 0;
  // Get the current binding ID for the source variable
  const sourceBindingId = sourceVarName
    ? getBindingIdForVar(ctx, sourceVarName)
    : null;
  for (const [nodeId, usageInfo] of nodes.entries()) {
    const { scopeId: nodeScopeId, bindingId: nodeBindingId } = usageInfo;
    // Non-linear semantics: propagate to usages based on scope and variable binding.
    //
    // For SAME SCOPE propagation (non-linear within a binding context):
    // Only propagate if the usage is from the SAME variable binding (same bindingId).
    // This ensures that shadowed variables don't see state changes from each other.
    // Example: let buffer = alloc(); let buffer = f(buffer); free(buffer);
    // The free on the shadowed buffer shouldn't affect the original buffer's usages.
    //
    // For NESTED SCOPE propagation (closure capture):
    // Propagate to all nested scopes that capture the identity, regardless of binding.
    // This handles the case where a closure captures a variable before it's freed.
    //
    // Propagate if:
    // 1. Usage is in the same scope AND from the same binding (same bindingId), OR
    // 2. Usage is in a nested scope AND the identity was created in current or outer scope
    const isSameScopeAndBinding = nodeScopeId === currentScopeId &&
      sourceBindingId !== null &&
      nodeBindingId === sourceBindingId;
    const isNestedCapture = nodeScopeId > currentScopeId &&
      identityCreationScope <= currentScopeId;
    if (isSameScopeAndBinding || isNestedCapture) {
      emitAddStateTags(ctx, nodeId, domain, tagged);
    }
  }
}

function getExprIdentities(
  ctx: Context,
  expr: Expr,
): IdentitySetByDomain | undefined {
  return ctx.exprIdentities.get(expr.id);
}

function splitIdentityTag(tag: string): number | null {
  const match = /#r(\d+)(?:@(\d+))?$/.exec(tag);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

function collectIdentitiesFromType(
  type: Type | undefined,
): IdentitySetByDomain | undefined {
  if (!type) return undefined;
  const carrier = splitCarrier(type);
  if (!carrier || carrier.state.kind !== "effect_row") {
    return undefined;
  }
  const identities: IdentitySetByDomain = new Map();
  for (const tag of carrier.state.cases.keys()) {
    const identityId = splitIdentityTag(tag);
    if (identityId === null) continue;
    let domainIds = identities.get(carrier.domain);
    if (!domainIds) {
      domainIds = new Set<number>();
      identities.set(carrier.domain, domainIds);
    }
    domainIds.add(identityId);
  }
  return identities.size > 0 ? identities : undefined;
}

function getIdentitiesForExpr(
  ctx: Context,
  expr: Expr,
): IdentitySetByDomain | undefined {
  return (
    getExprIdentities(ctx, expr) ??
      collectIdentitiesFromType(ctx.nodeTypes.get(expr.id))
  );
}

function setExprIdentities(
  ctx: Context,
  expr: Expr,
  identities: IdentitySetByDomain,
): void {
  ctx.exprIdentities.set(expr.id, cloneIdentitySetByDomain(identities));
}

function parseTargetIndex(target: string): number | null {
  const match = /^arg(\d+)$/i.exec(target);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return Number.isNaN(index) ? null : index;
}

function removeTagFromRow(state: Type, tag: string): Type {
  if (state.kind !== "effect_row") {
    return state;
  }
  if (!state.cases.has(tag)) {
    return state;
  }
  const cases = new Map(state.cases);
  cases.delete(tag);
  return { kind: "effect_row", cases, tail: state.tail };
}

function addTagToRow(state: Type, tag: string): Type {
  const row = ensureRow(state);
  if (row.cases.has(tag)) {
    return row;
  }
  const cases = new Map(row.cases);
  cases.set(tag, null);
  return { kind: "effect_row", cases, tail: row.tail };
}

function refineNullabilityType(
  type: Type,
  mode: "nonnull" | "null",
): Type | null {
  const carrierInfo = splitCarrier(type);
  if (carrierInfo && carrierInfo.domain === "mem") {
    const refinedState = mode === "nonnull"
      ? removeTagFromRow(carrierInfo.state, "Null")
      : addTagToRow(carrierInfo.state, "Null");
    const rejoined = joinCarrier(
      carrierInfo.domain,
      carrierInfo.value,
      refinedState,
    );
    if (rejoined) return rejoined;
  }

  if (type.kind === "constructor" && type.args.length >= 2) {
    const state = type.args[1];
    if (state.kind !== "effect_row") {
      return null;
    }
    const refinedState = mode === "nonnull"
      ? removeTagFromRow(state, "Null")
      : addTagToRow(state, "Null");
    const nextArgs = type.args.slice();
    nextArgs[1] = refinedState;
    return {
      kind: "constructor",
      name: type.name,
      args: nextArgs,
    };
  }

  if (
    type.kind === "constructor" &&
    (type.name === "Optional" || type.name === "Opt") &&
    type.args.length === 1
  ) {
    return mode === "nonnull" ? type.args[0] : type;
  }

  return null;
}

function getCurrentFunctionScope(ctx: Context) {
  if (ctx.functionParamStack.length === 0) return null;
  return ctx.functionParamStack[ctx.functionParamStack.length - 1];
}

function getCurrentScopeId(ctx: Context): number {
  return getCurrentFunctionScope(ctx)?.scopeId ?? 0;
}

function recordParamEffect(
  ctx: Context,
  paramIndex: number,
  domain: string,
  kind: "requiresExact" | "requiresAny" | "requiresNot" | "adds",
  tags: string[],
): void {
  const scope = getCurrentFunctionScope(ctx);
  if (!scope) return;
  let functionEffects = ctx.functionParamEffects.get(scope.name);
  if (!functionEffects) {
    functionEffects = new Map();
    ctx.functionParamEffects.set(scope.name, functionEffects);
  }
  let paramEffects = functionEffects.get(paramIndex);
  if (!paramEffects) {
    paramEffects = new Map();
    functionEffects.set(paramIndex, paramEffects);
  }
  let rule = paramEffects.get(domain);
  if (!rule) {
    rule = {
      requiresExact: new Set(),
      requiresAny: new Set(),
      requiresNot: new Set(),
      adds: new Set(),
    };
    paramEffects.set(domain, rule);
  }
  const target = rule[kind];
  for (const tag of tags) {
    target.add(tag);
  }
}

function applyParamEffectsToCall(
  ctx: Context,
  calleeName: string,
  args: Expr[],
): void {
  const functionEffects = ctx.functionParamEffects.get(calleeName);
  if (!functionEffects) return;
  for (const [paramIndex, domainEffects] of functionEffects.entries()) {
    const argExpr = args[paramIndex];
    if (!argExpr) continue;
    for (const [domain, effects] of domainEffects.entries()) {
      if (effects.requiresExact.size > 0) {
        emitRequireExactState(
          ctx,
          argExpr.id,
          domain,
          Array.from(effects.requiresExact),
        );
      }
      if (effects.requiresAny.size > 0) {
        emitRequireAnyState(
          ctx,
          argExpr.id,
          domain,
          Array.from(effects.requiresAny),
        );
      }
      if (effects.requiresNot.size > 0) {
        emitRequireNotState(
          ctx,
          argExpr.id,
          domain,
          Array.from(effects.requiresNot),
        );
      }
      if (effects.adds.size > 0) {
        const addTags = Array.from(effects.adds);
        if (isRowBagDomain(ctx.infectionRegistry, domain)) {
          const identities = getIdentitiesForExpr(ctx, argExpr);
          const domainIds = identities?.get(domain);
          if (domainIds && domainIds.size > 0) {
            const tagged: string[] = [];
            const argVarName = argExpr.kind === "identifier"
              ? argExpr.name
              : null;
            for (const identityId of domainIds) {
              const identityTags = addIdentityTags(
                ctx,
                domain,
                identityId,
                addTags,
                argExpr.id,
              );
              tagged.push(...identityTags);
              emitIdentityTagsToUsage(
                ctx,
                domain,
                identityId,
                identityTags,
                argVarName,
              );
            }
            emitAddStateTags(ctx, argExpr.id, domain, tagged);
            continue;
          }
        }
        emitAddStateTags(ctx, argExpr.id, domain, addTags);
      }
    }
  }
}

function expectParameterName(param: Parameter): string {
  if (!param.name) {
    throw inferError(
      "Internal error: missing parameter name after tuple lowering",
    );
  }
  return param.name;
}

function normalizeMatchScrutineeType(ctx: Context, type: Type): Type {
  const resolved = applyCurrentSubst(ctx, type);
  const holeInfo = flattenHoleType(resolved);
  if (!holeInfo) {
    return resolved;
  }
  const inner = applyCurrentSubst(ctx, holeInfo.value);
  const carrierInfo = splitCarrier(inner);
  if (!carrierInfo) {
    return resolved;
  }
  return inner;
}

function recordExprType(ctx: Context, expr: Expr, type: Type): Type {
  const resolved = applyCurrentSubst(ctx, type);
  if (isHoleType(resolved)) {
    registerHoleForType(ctx, holeOriginFromExpr(expr), resolved);
  }
  ctx.nodeTypes.set(expr.id, resolved);
  return resolved;
}

function instantiateRecordAlias(
  info: TypeInfo,
): Extract<Type, { kind: "record" }> | null {
  if (!info.alias || info.alias.kind !== "record") {
    return null;
  }
  const aliasClone = cloneType(info.alias) as Extract<Type, { kind: "record" }>;
  if (info.parameters.length === 0) {
    return aliasClone;
  }
  const substitution: Map<number, Type> = new Map();
  for (const paramId of info.parameters) {
    substitution.set(paramId, freshTypeVar());
  }
  const applied = applySubstitution(aliasClone, substitution);
  return applied.kind === "record" ? applied : null;
}

function buildRecordConstructorType(
  recordName: string,
  recordInfo: TypeInfo,
  fields: Map<string, Type>,
): Type {
  const args: (Type | null)[] = Array(recordInfo.recordFields!.size).fill(null);
  for (const [fieldName, fieldType] of fields.entries()) {
    const index = recordInfo.recordFields!.get(fieldName);
    if (index !== undefined) {
      args[index] = fieldType;
    }
  }
  if (recordInfo.alias?.kind === "record") {
    for (const [fieldName, index] of recordInfo.recordFields!.entries()) {
      if (!args[index]) {
        const aliasFieldType = recordInfo.alias.fields.get(fieldName);
        if (aliasFieldType) {
          args[index] = aliasFieldType;
        }
      }
    }
  }
  for (let index = 0; index < args.length; index++) {
    if (!args[index]) {
      args[index] = unknownType({
        kind: "incomplete",
        reason: "record_missing_field",
      });
    }
  }
  return {
    kind: "constructor",
    name: recordName,
    args: args.map((arg) => arg!),
  };
}

function storeAnnotationType(
  ctx: Context,
  annotation: TypeExpr,
  type: Type,
): void {
  ctx.annotationTypes.set(annotation.id, applyCurrentSubst(ctx, type));
}

function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "var":
      return b.kind === "var" && a.id === b.id;
    case "func":
      return (
        typesEqual(a.from, (b as Type & { kind: "func" }).from) &&
        typesEqual(a.to, (b as Type & { kind: "func" }).to)
      );
    case "constructor": {
      if (
        b.kind !== "constructor" ||
        a.name !== b.name ||
        a.args.length !== b.args.length
      ) {
        return false;
      }
      for (let i = 0; i < a.args.length; i++) {
        if (!typesEqual(a.args[i], b.args[i])) return false;
      }
      return true;
    }
    case "tuple": {
      if (b.kind !== "tuple" || a.elements.length !== b.elements.length) {
        return false;
      }
      for (let i = 0; i < a.elements.length; i++) {
        if (!typesEqual(a.elements[i], b.elements[i])) return false;
      }
      return true;
    }
    case "record": {
      if (b.kind !== "record" || a.fields.size !== b.fields.size) {
        return false;
      }
      for (const [field, typeA] of a.fields.entries()) {
        const typeB = b.fields.get(field);
        if (!typeB || !typesEqual(typeA, typeB)) return false;
      }
      return true;
    }
    case "effect_row": {
      if (b.kind !== "effect_row" || a.cases.size !== b.cases.size) {
        return false;
      }
      for (const [label, payloadA] of a.cases.entries()) {
        const payloadB = b.cases.get(label);
        if (payloadB === undefined) return false;
        if (payloadA === null || payloadB === null) {
          if (payloadA !== payloadB) return false;
          continue;
        }
        if (!typesEqual(payloadA, payloadB)) return false;
      }
      return a.tail === b.tail;
    }
    default:
      return true;
  }
}

function resolveTypeForName(ctx: Context, name: string): Type | undefined {
  const scheme = ctx.env.get(name) ?? ctx.allBindings.get(name);
  if (!scheme) {
    return undefined;
  }
  const applied = applySubstitutionScheme(scheme, ctx.subst);
  return applied.type;
}

function getCalleeName(expr: Expr): string | undefined {
  if (expr.kind === "identifier") {
    return expr.name;
  }
  return undefined;
}

function resolveOpRule(
  registry: Context["infectionRegistry"],
  name: string,
): OpRuleDefinition | undefined {
  const direct = registry.opRules.get(name);
  if (direct) return direct;
  const suffixMatches = Array.from(registry.opRules.values()).filter((rule) =>
    rule.name.endsWith(`.${name}`)
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  return undefined;
}

function resolveDefaultOpRule(
  ctx: Context,
  args: Expr[],
): OpRuleDefinition | undefined {
  for (const domainRule of ctx.infectionRegistry.domains.values()) {
    const defaultRule = domainRule.defaultRule;
    if (!defaultRule?.domain) {
      continue;
    }
    const targetIndex = defaultRule.target
      ? parseTargetIndex(defaultRule.target)
      : 0;
    if (targetIndex === null) {
      continue;
    }
    const targetExpr = args[targetIndex];
    if (!targetExpr) {
      continue;
    }
    const targetType = ctx.nodeTypes.get(targetExpr.id);
    if (!targetType) {
      continue;
    }
    const resolvedTarget = applyCurrentSubst(ctx, targetType);
    const carrierInfo = splitCarrier(resolvedTarget);
    if (carrierInfo && carrierInfo.domain === defaultRule.domain) {
      return defaultRule;
    }
  }
  return undefined;
}

function getPoliciesForTarget(
  registry: Context["infectionRegistry"],
  target: string,
): PolicyDefinition[] {
  const annotation = registry.annotations.get(target);
  if (!annotation) return [];
  const policies: PolicyDefinition[] = [];
  for (const policyName of annotation.policies) {
    const policy = registry.policies.get(policyName);
    if (policy) {
      policies.push(policy);
    }
  }
  return policies;
}

function registerInfixDeclaration(ctx: Context, decl: InfixDeclaration) {
  // Register the operator's implementation function in the environment
  // with a special name so binary expressions can look it up
  const opFuncName = `__op_${decl.operator}`;

  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  if (!implScheme) {
    // Implementation not found - will be marked as free variable during inference
    return;
  }

  // Register it under the operator name
  ctx.env.set(opFuncName, implScheme);
}

function registerPrefixDeclaration(ctx: Context, decl: PrefixDeclaration) {
  // Register the prefix operator's implementation function
  const opFuncName = `__prefix_${decl.operator}`;

  // Look up the actual implementation function
  const implScheme = lookupEnv(ctx, decl.implementation);
  if (!implScheme) {
    // Implementation not found - will be marked as free variable during inference
    return;
  }

  // Register it under the operator name
  ctx.env.set(opFuncName, implScheme);
}

function expandErrorRowTail(
  ctx: Context,
  effectRow: EffectRowType,
): EffectRowType {
  // If the tail is a concrete ADT type, expand it into its constructors
  // BUT: Keep type variable tails - they represent unknown errors
  if (!effectRow.tail) {
    return effectRow;
  }

  // Don't expand type variables - they need to stay as tails for unification
  if (effectRow.tail.kind === "var") {
    return effectRow;
  }

  // Only expand concrete constructor types (ADTs)
  if (effectRow.tail.kind !== "constructor") {
    return effectRow;
  }

  const tailType = effectRow.tail;
  const adtInfo = ctx.adtEnv.get(tailType.name);
  if (!adtInfo || adtInfo.isAlias) {
    return effectRow;
  }

  // Expand the ADT constructors into the error_row cases
  const expandedCases = new Map(effectRow.cases);
  for (const ctor of adtInfo.constructors) {
    if (!expandedCases.has(ctor.name)) {
      // Add constructor with null payload for now (we'd need to track actual payload types)
      expandedCases.set(ctor.name, null);
    }
  }

  return {
    kind: "effect_row",
    cases: expandedCases,
    tail: undefined, // Remove tail since we've expanded it completely
  };
}

function refineInfectiousConstructor(
  ctx: Context,
  expr: ConstructorExpr,
  type: Type,
): Type {
  // Check if this type is an infectious carrier type
  const carrierInfo = splitCarrier(type);
  if (!carrierInfo || carrierInfo.domain !== "effect") {
    return type;
  }

  // Check if the state is an effect_row with just a tail (no specific cases yet)
  if (carrierInfo.state.kind !== "effect_row") {
    return type;
  }

  let effectRow = carrierInfo.state;

  // Check if any argument is a constructor expression
  // For infectious types like IResult<T, E>, we care about the error constructor
  // which is typically the last (or only) argument
  if (expr.args.length > 0) {
    const lastArg = expr.args[expr.args.length - 1];
    if (lastArg.kind === "constructor") {
      // The argument is a constructor! Add it as a specific case in the error_row
      const constructorName = lastArg.name;
      const newCases = new Map(effectRow.cases);

      // Add the constructor as a case with null payload (nullary constructor)
      // TODO: Track payload types for constructors with arguments
      newCases.set(constructorName, null);

      effectRow = {
        kind: "effect_row",
        cases: newCases,
        tail: effectRow.tail,
      };

      // Emit a constraint source to track this specific error constructor
      // This allows the constraint system to track error propagation
      emitConstraintSource(ctx, expr.id, effectLabel(effectRow));
    }
  }

  // Don't expand the tail here - keep it for unification

  // Reconstruct the carrier type with the refined error_row
  const refinedType = joinCarrier(
    carrierInfo.domain,
    carrierInfo.value,
    effectRow,
  );

  return refinedType ?? type;
}

function registerInfectiousTypeDeclaration(
  ctx: Context,
  decl: import("../ast.ts").TypeDeclaration,
) {
  // New combined syntax: infectious error type IResult<T, E> = @value IOk<T> | @effect IErr<E>;
  if (!decl.infectious) return;

  const domain = decl.infectious.domain;
  const typeName = decl.name;

  // Extract constructor annotations from the type declaration
  const valueCtors = decl.members.filter(
    (m): m is import("../ast.ts").ConstructorAlias =>
      m.kind === "constructor" && m.annotation === "value",
  );
  const effectCtors = decl.members.filter(
    (m): m is import("../ast.ts").ConstructorAlias =>
      m.kind === "constructor" && m.annotation === "effect",
  );

  const valueConstructor = valueCtors.length > 0
    ? valueCtors[0].name
    : undefined;
  const effectConstructors = effectCtors.length > 0
    ? effectCtors.map((c) => c.name)
    : undefined;

  // Create and register the carrier
  createAndRegisterCarrier(
    ctx,
    domain,
    typeName,
    valueConstructor,
    effectConstructors,
  );
}

function registerInfectiousDeclaration(
  ctx: Context,
  decl: import("../ast.ts").InfectiousDeclaration,
  program: import("../ast.ts").Program,
) {
  // Old standalone syntax: infectious error IResult<T, E>; (separate from type declaration)
  const { domain, typeName, valueParam, stateParam } = decl;

  // Find the corresponding type declaration to extract constructor annotations
  const typeDecl = program.declarations.find(
    (d): d is import("../ast.ts").TypeDeclaration =>
      d.kind === "type" && d.name === typeName,
  );

  let valueConstructor: string | undefined;
  let effectConstructors: string[] | undefined;

  if (typeDecl) {
    // Extract constructor annotations
    const valueCtors = typeDecl.members.filter(
      (m): m is import("../ast.ts").ConstructorAlias =>
        m.kind === "constructor" && m.annotation === "value",
    );
    const effectCtors = typeDecl.members.filter(
      (m): m is import("../ast.ts").ConstructorAlias =>
        m.kind === "constructor" && m.annotation === "effect",
    );

    if (valueCtors.length > 0) {
      valueConstructor = valueCtors[0].name;
    }
    if (effectCtors.length > 0) {
      effectConstructors = effectCtors.map((c) => c.name);
    }
  }

  // Create and register the carrier
  createAndRegisterCarrier(
    ctx,
    domain,
    typeName,
    valueConstructor,
    effectConstructors,
  );
}

function createAndRegisterCarrier(
  ctx: Context,
  domain: string,
  typeName: string,
  valueConstructor: string | undefined,
  effectConstructors: string[] | undefined,
) {
  // Register the infectious type as a carrier in the type system

  // Create carrier operations for this infectious type
  const carrier: CarrierOperations = {
    is: (type: Type): boolean => {
      return (
        type.kind === "constructor" &&
        type.name === typeName &&
        type.args.length === 2
      );
    },

    split: (type: Type): CarrierInfo | null => {
      if (!carrier.is(type)) {
        return null;
      }
      const carrierType = type as Extract<Type, { kind: "constructor" }>;
      const value = carrierType.args[0];
      const state = carrierType.args[1]; // Don't wrap in ensureRow - keep as-is

      // Handle nested carriers by flattening
      const inner = carrier.split(value);
      if (!inner) {
        return { value, state };
      }
      // If we have nested carriers, union the states
      const unionedState = state.kind === "effect_row"
        ? effectRowUnion(inner.state, state)
        : ensureRow(state); // Only wrap if needed for union
      return {
        value: inner.value,
        state: unionedState,
      };
    },

    join: (value: Type, state: Type): Type => {
      const stateRow = ensureRow(state);
      return {
        kind: "constructor",
        name: typeName,
        args: [value, stateRow],
      };
    },

    collapse: (type: Type): Type => {
      const info = carrier.split(type);
      if (!info) {
        return type;
      }
      const collapsedValue = carrier.collapse(info.value);
      return carrier.join(collapsedValue, info.state);
    },

    unionStates: (left: Type, right: Type): Type => {
      return effectRowUnion(left, right);
    },

    // Store constructor metadata for runtime
    valueConstructor,
    effectConstructors,
  };

  // Register the carrier for this domain
  registerCarrier(domain, carrier);
}

function inferLetDeclaration(
  ctx: Context,
  decl: LetDeclaration,
): { name: string; scheme: TypeScheme }[] {
  // Non-recursive case
  if (!decl.isRecursive) {
    checkMutableShadowing(ctx, decl);
    let fnType = inferLetBinding(
      ctx,
      decl.parameters,
      decl.body,
      decl.annotation,
      decl.returnAnnotation,
      decl.name,
      decl.isArrowSyntax,
    );

    // Zero-parameter arrow functions () => { ... } should have type Void -> T
    // But block expressions { ... } and block let statements should NOT be wrapped
    if (decl.isArrowSyntax && decl.parameters.length === 0) {
      fnType = {
        kind: "func",
        from: { kind: "unit" },
        to: fnType,
      };
    }

    const resolvedType = applyCurrentSubst(ctx, fnType);
    ctx.nodeTypes.set(decl.id, resolvedType);
    const scheme = generalizeInContext(ctx, fnType);
    ctx.env.set(decl.name, scheme);
    recordMutableBinding(ctx, decl.name, decl.isMutable);
    ctx.allBindings.set(decl.name, scheme); // Track in allBindings
    if (decl.annotation) {
      recordAnnotationConstraint(
        ctx,
        decl.id,
        decl.annotation,
        decl.body.result ?? decl.body,
      );
    }
    if (decl.parameters.length === 0 && !decl.isArrowSyntax) {
      // Create a new binding ID for this variable (handles shadowing)
      createNewBindingForVar(ctx, decl.name);
      // Clear any existing identity bindings for this name before binding new ones
      // This prevents shadowed variables from sharing identities with their shadows
      ctx.identityBindings.delete(decl.name);
      bindIdentitiesFromExpr(ctx, decl.name, decl.body.result ?? decl.body);
    }
    applyReturnPolicies(ctx, decl);
    return [{ name: decl.name, scheme }];
  }

  // Recursive case (with optional mutual bindings)
  const allBindings = [decl, ...(decl.mutualBindings || [])];

  // STEP 1: Pre-bind all names with fresh type variables
  const preBoundTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    checkMutableShadowing(ctx, binding);
    const freshVar = freshTypeVar();
    preBoundTypes.set(binding.name, freshVar);
    // Add to environment with empty quantifiers so recursive calls can find it
    ctx.env.set(binding.name, { quantifiers: [], type: freshVar });
    recordMutableBinding(ctx, binding.name, binding.isMutable);
  }

  // STEP 2: Infer each body with all names in scope
  const inferredTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    const inferredType = inferLetBinding(
      ctx,
      binding.parameters,
      binding.body,
      binding.annotation,
      binding.returnAnnotation,
      binding.name,
      binding.isArrowSyntax,
    );
    inferredTypes.set(binding.name, inferredType);
  }

  // STEP 3: Unify pre-bound types with inferred types
  for (const binding of allBindings) {
    const preBound = preBoundTypes.get(binding.name)!;
    const inferred = inferredTypes.get(binding.name)!;
    unify(ctx, preBound, inferred);

    // Also check annotation if present
    if (binding.annotation) {
      const annotationType = convertTypeExpr(
        ctx,
        binding.annotation,
        new Map(),
      );
      storeAnnotationType(ctx, binding.annotation, annotationType);
      unify(ctx, inferred, annotationType);
    }
  }

  // STEP 4: Apply substitutions and generalize
  // Remove bindings from environment before generalization to avoid capturing their own type vars
  for (const binding of allBindings) {
    const existing = ctx.env.get(binding.name);
    if (existing) {
      ctx.env.delete(binding.name);
    }
  }

  const results: { name: string; scheme: TypeScheme }[] = [];
  for (const binding of allBindings) {
    let inferredType = inferredTypes.get(binding.name)!;
    let resolvedType = applyCurrentSubst(ctx, inferredType);

    // Zero-parameter arrow functions () => { ... } should have type Void -> T
    // But block expressions { ... } and block let statements should NOT be wrapped
    if (binding.isArrowSyntax && binding.parameters.length === 0) {
      resolvedType = {
        kind: "func",
        from: { kind: "unit" },
        to: resolvedType,
      };
    }

    ctx.nodeTypes.set(binding.id, resolvedType);
    const scheme = generalizeInContext(ctx, resolvedType);
    ctx.env.set(binding.name, scheme);
    recordMutableBinding(ctx, binding.name, binding.isMutable);
    ctx.allBindings.set(binding.name, scheme); // Track in allBindings
    results.push({ name: binding.name, scheme });
  }

  for (const binding of allBindings) {
    if (binding.annotation) {
      recordAnnotationConstraint(
        ctx,
        binding.id,
        binding.annotation,
        binding.body.result ?? binding.body,
      );
    }
  }
  for (const binding of allBindings) {
    applyReturnPolicies(ctx, binding);
  }

  return results;
}

function applyReturnPolicies(ctx: Context, decl: LetDeclaration): void {
  const policies = getPoliciesForTarget(ctx.infectionRegistry, decl.name);
  if (policies.length === 0) return;
  const returnNodeId = decl.body.result?.id ?? decl.body.id;
  for (const policy of policies) {
    if (policy.domain && policy.requireAtReturn?.length) {
      emitRequireAtReturn(
        ctx,
        returnNodeId,
        policy.domain,
        policy.requireAtReturn,
        policy.name,
      );
    }
  }
}

function bindIdentitiesFromExpr(
  ctx: Context,
  name: string,
  expr: Expr | undefined,
): void {
  if (!expr) return;

  const identities = getIdentitiesForExpr(ctx, expr);
  if (identities) {
    // Bind identities from the expression to this variable name.
    // This enables same-scope non-linear propagation for operations on this variable.
    //
    // Note: We bind even for non-alloc calls because:
    // 1. The identity already exists in the type system
    // 2. We need to track which variable name is associated with which identity
    //    for same-scope propagation to work correctly
    // 3. The binding ID system (createNewBindingForVar) handles shadowing
    ctx.identityBindings.set(name, cloneIdentitySetByDomain(identities));
    return;
  }
  if (expr.kind === "identifier") {
    const bound = ctx.identityBindings.get(expr.name);
    if (bound) {
      // Don't copy identities from another variable - creates cross-shadow issues
      // Only fresh allocations should propagate identities
      return;
    }
  }
}

function inferLetBinding(
  ctx: Context,
  parameters: Parameter[],
  body: BlockExpr,
  annotation: TypeExpr | undefined,
  returnAnnotation?: TypeExpr,
  functionName?: string,
  isArrowSyntax?: boolean,
): Type {
  const annotationScope = new Map<string, Type>();
  const paramTypes = parameters.map((param) =>
    param.annotation
      ? convertTypeExpr(ctx, param.annotation, annotationScope)
      : freshTypeVar()
  );

  const paramNameToIndex = new Map<string, number>();
  for (let index = 0; index < parameters.length; index += 1) {
    const paramName = expectParameterName(parameters[index]);
    paramNameToIndex.set(paramName, index);
  }
  // Push a function scope for actual functions (with parameters) or arrow functions.
  // Simple value bindings like `let x = expr` should not create a new scope.
  const isActualFunction = parameters.length > 0 || isArrowSyntax === true;
  if (functionName && isActualFunction) {
    ctx.functionParamStack.push({
      name: functionName,
      params: paramNameToIndex,
      scopeId: ctx.functionScopeCounter++,
    });
  }

  let result: Type;
  try {
    result = withScopedEnv(ctx, () => {
      parameters.forEach((param, index) => {
        const paramName = expectParameterName(param);
        ctx.env.set(paramName, {
          quantifiers: [],
          type: paramTypes[index],
        });
        recordMutableBinding(ctx, paramName, false);
        // Parameters shadow outer variables, so clear any identity bindings
        ctx.identityBindings.delete(paramName);
      });

      let bodyType = applyCurrentSubst(ctx, inferBlockExpr(ctx, body));

      if (returnAnnotation) {
        const returnType = convertTypeExpr(
          ctx,
          returnAnnotation,
          annotationScope,
        );
        storeAnnotationType(ctx, returnAnnotation, returnType);
        const alignedReturn = alignAnnotationWithCarrier(bodyType, returnType);
        if (isHoleType(bodyType) && !isHoleType(alignedReturn)) {
          bodyType = applyCurrentSubst(ctx, alignedReturn);
        } else if (unify(ctx, bodyType, alignedReturn)) {
          bodyType = applyCurrentSubst(ctx, alignedReturn);
        } else {
          const failure = ctx.lastUnifyFailure;
          const subject = materializeExpr(ctx, body.result ?? body);
          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              body,
              subject,
              failure.left,
              failure.right,
            );
            bodyType = mark.type;
          } else {
            const expected = applyCurrentSubst(ctx, alignedReturn);
            const actual = applyCurrentSubst(ctx, bodyType);
            const mark = markInconsistent(ctx, body, subject, expected, actual);
            bodyType = mark.type;
          }
        }
      }

      let fnType: Type;
      // Note: Zero-parameter bindings are NOT treated as functions here
      // They are just value bindings. Top-level zero-parameter functions
      // are handled separately in inferLetDeclaration.
      if (parameters.length === 0) {
        fnType = bodyType;
      } else {
        fnType = paramTypes.reduceRight<Type>(
          (acc, paramType) => ({
            kind: "func",
            from: applyCurrentSubst(ctx, paramType),
            to: acc,
          }),
          bodyType,
        );
      }

      if (annotation) {
        const annotated = convertTypeExpr(ctx, annotation, annotationScope);
        storeAnnotationType(ctx, annotation, annotated);
        if (unify(ctx, fnType, annotated)) {
          fnType = applyCurrentSubst(ctx, annotated);
        } else {
          const failure = ctx.lastUnifyFailure;
          const subject = materializeExpr(ctx, body.result ?? body);
          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              body,
              subject,
              failure.left,
              failure.right,
            );
            fnType = mark.type;
          } else {
            const expected = applyCurrentSubst(ctx, annotated);
            const actual = applyCurrentSubst(ctx, fnType);
            const mark = markInconsistent(ctx, body, subject, expected, actual);
            fnType = mark.type;
          }
        }
      }

      return fnType;
    });
  } finally {
    if (functionName && isActualFunction) {
      ctx.functionParamStack.pop();
    }
  }

  return result;
}

function inferBlockExpr(ctx: Context, block: BlockExpr): Type {
  return withScopedEnv(ctx, () => {
    for (const statement of block.statements) {
      inferBlockStatement(ctx, statement);
    }

    if (block.result) {
      const resultType = inferExpr(ctx, block.result);
      const resolved = applyCurrentSubst(ctx, resultType);
      ctx.nodeTypes.set(block.result.id, resolved);
      ctx.nodeTypes.set(block.id, resolved);
      return resolved;
    }

    const unitType: Type = { kind: "unit" };
    ctx.nodeTypes.set(block.id, unitType);
    return unitType;
  });
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function inferBlockStatement(ctx: Context, statement: BlockStatement): void {
  switch (statement.kind) {
    case "let_statement": {
      const { declaration } = statement;
      inferLetDeclaration(ctx, declaration);
      break;
    }
    case "pattern_let_statement": {
      const valueType = inferExpr(ctx, statement.initializer);
      const patternInfo = inferPattern(ctx, statement.pattern, valueType);
      for (const [name, type] of patternInfo.bindings.entries()) {
        // Create a new binding ID for this variable (handles shadowing)
        createNewBindingForVar(ctx, name);
        const scheme = generalizeInContext(ctx, type);
        ctx.env.set(name, scheme);
        recordMutableBinding(ctx, name, false);
        ctx.allBindings.set(name, scheme);
      }
      if (statement.pattern.kind === "variable") {
        bindIdentitiesFromExpr(
          ctx,
          statement.pattern.name,
          statement.initializer,
        );
      }
      break;
    }
    case "expr_statement": {
      inferExpr(ctx, statement.expression);
      break;
    }
    default:
      // Unknown block statement kind - skip
      break;
  }
}

function inferArrowFunction(
  ctx: Context,
  parameters: Parameter[],
  body: BlockExpr,
  returnAnnotation?: TypeExpr,
): Type {
  // Push an anonymous function scope to track nested scope for identity propagation
  const anonymousScopeId = ctx.functionScopeCounter++;
  ctx.functionParamStack.push({
    name: `__anonymous_${anonymousScopeId}`,
    params: new Map(),
    scopeId: anonymousScopeId,
  });

  try {
    return withScopedEnv(ctx, () => {
      const annotationScope = new Map<string, Type>();
      const paramTypes = parameters.map((param) =>
        param.annotation
          ? convertTypeExpr(ctx, param.annotation, annotationScope)
          : freshTypeVar()
      );

      parameters.forEach((param, index) => {
        const paramName = expectParameterName(param);
        ctx.env.set(paramName, {
          quantifiers: [],
          type: paramTypes[index],
        });
        recordMutableBinding(ctx, paramName, false);
        // Parameters shadow outer variables, so clear any identity bindings
        ctx.identityBindings.delete(paramName);
      });

      let bodyType = applyCurrentSubst(ctx, inferBlockExpr(ctx, body));

      if (returnAnnotation) {
        const annotated = convertTypeExpr(
          ctx,
          returnAnnotation,
          annotationScope,
        );
        storeAnnotationType(ctx, returnAnnotation, annotated);
        const aligned = alignAnnotationWithCarrier(bodyType, annotated);
        if (isHoleType(bodyType) && !isHoleType(aligned)) {
          bodyType = applyCurrentSubst(ctx, aligned);
        } else if (unify(ctx, bodyType, aligned)) {
          bodyType = applyCurrentSubst(ctx, aligned);
        } else {
          const failure = ctx.lastUnifyFailure;
          const subject = materializeExpr(ctx, body.result ?? body);
          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              body,
              subject,
              failure.left,
              failure.right,
            );
            bodyType = mark.type;
          } else {
            const expected = applyCurrentSubst(ctx, aligned);
            const actual = applyCurrentSubst(ctx, bodyType);
            const mark = markInconsistent(ctx, body, subject, expected, actual);
            bodyType = mark.type;
          }
        }
      }

      if (parameters.length === 0) {
        // Zero-parameter function: () => body has type Void -> bodyType
        return {
          kind: "func",
          from: { kind: "unit" },
          to: bodyType,
        };
      }

      return paramTypes.reduceRight<Type>(
        (acc, paramType) => ({
          kind: "func",
          from: applyCurrentSubst(ctx, paramType),
          to: acc,
        }),
        bodyType,
      );
    });
  } finally {
    ctx.functionParamStack.pop();
  }
}

function alignAnnotationWithCarrier(actual: Type, annotation: Type): Type {
  const actualCarrier = splitCarrier(actual);
  if (!actualCarrier) {
    if (actual.kind === "record" && annotation.kind === "record") {
      const alignedFields = new Map<string, Type>();
      for (const [name, annField] of annotation.fields.entries()) {
        const actualField = actual.fields.get(name);
        if (actualField) {
          alignedFields.set(
            name,
            alignAnnotationWithCarrier(actualField, annField),
          );
        } else {
          alignedFields.set(name, annField);
        }
      }
      return { kind: "record", fields: alignedFields };
    }
    return annotation;
  }
  if (actualCarrier.domain === "hole") {
    const alignedInner = alignAnnotationWithCarrier(
      actualCarrier.value,
      annotation,
    );
    const annotationCarrier = splitCarrier(annotation);
    if (!annotationCarrier || annotationCarrier.domain !== "hole") {
      return alignedInner;
    }
    const rejoinedHole = joinCarrier(
      actualCarrier.domain,
      alignedInner,
      actualCarrier.state,
    );
    return rejoinedHole ?? alignedInner;
  }
  const annotationCarrier = splitCarrier(annotation);
  if (annotationCarrier && annotationCarrier.domain === actualCarrier.domain) {
    const alignedValue = alignAnnotationWithCarrier(
      actualCarrier.value,
      annotationCarrier.value,
    );
    const rejoined = joinCarrier(
      actualCarrier.domain,
      alignedValue,
      actualCarrier.state,
    );
    return rejoined ?? annotation;
  }
  const alignedInner = alignAnnotationWithCarrier(
    actualCarrier.value,
    annotation,
  );
  const rejoined = joinCarrier(
    actualCarrier.domain,
    alignedInner,
    actualCarrier.state,
  );
  return rejoined ?? annotation;
}

function mergeBindings(target: Map<string, Type>, source: Map<string, Type>) {
  for (const [name, type] of source.entries()) {
    if (!target.has(name)) {
      target.set(name, type);
    }
    // If duplicate, skip (already marked the pattern)
  }
}

export function inferExpr(ctx: Context, expr: Expr): Type {
  switch (expr.kind) {
    case "identifier": {
      const scheme = ctx.env.get(expr.name);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, expr.name);
        ctx.nodeTypes.set(expr.id, mark.type);
        return mark.type;
      }
      if (
        expr.name === "formatRuntimeValue" &&
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier formatRuntimeValue scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "listMap" &&
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier listMap scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      if (
        expr.name === "fromLiteral" &&
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        )
      ) {
        console.log(
          "[debug] identifier fromLiteral scheme:",
          formatScheme(applySubstitutionScheme(scheme, ctx.subst)),
        );
      }
      const instantiated = instantiateAndApply(ctx, scheme);
      if (isHoleType(instantiated)) {
        registerHoleForType(ctx, holeOriginFromExpr(expr), instantiated);
      }
      const carrierInfo = splitCarrier(instantiated);
      if (
        carrierInfo &&
        carrierInfo.domain === "mem" &&
        carrierInfo.state.kind === "effect_row"
      ) {
        emitConstraintSource(
          ctx,
          expr.id,
          rowLabel(carrierInfo.domain, carrierInfo.state),
        );
      }
      const boundIdentities = ctx.identityBindings.get(expr.name);
      if (boundIdentities) {
        setExprIdentities(ctx, expr, boundIdentities);
        for (const [domain, identities] of boundIdentities.entries()) {
          for (const identityId of identities) {
            // Don't add flow edges here - emitIdentityTagsToUsage handles
            // propagation to nested scopes when tags are added
            recordIdentityUsage(ctx, domain, identityId, expr.id, expr.name);
            const tagged = getIdentityTags(ctx, domain, identityId);
            if (tagged.length > 0) {
              emitAddStateTags(ctx, expr.id, domain, tagged);
            }
          }
        }
      }
      return recordExprType(ctx, expr, instantiated);
    }
    case "literal": {
      let litType = literalType(expr.literal);
      // In raw mode, numeric literals are polymorphic (like Zig's comptime_int)
      if (ctx.rawMode && expr.literal.kind === "int") {
        litType = freshTypeVar();
      }
      // In raw mode, treat string literals as Zig slices (u8 + len).
      if (ctx.rawMode && expr.literal.kind === "string") {
        litType = {
          kind: "constructor",
          name: "Slice",
          args: [
            { kind: "constructor", name: "U8", args: [] },
            freshTypeVar(),
          ],
        };
      }
      // Check if it's an incomplete hole for unsupported literal
      const holeInfo = isHoleType(litType) ? splitCarrier(litType) : null;
      if (holeInfo) {
        // Check if it's the specific "literal.unsupported" reason
        for (const label of (holeInfo.state as any).cases?.keys() || []) {
          if (label.includes("literal.unsupported")) {
            const mark = markUnsupportedExpr(ctx, expr, "literal");
            return recordExprType(ctx, expr, mark.type);
          }
        }
      }
      return recordExprType(ctx, expr, litType);
    }
    case "hole": {
      // Explicit hole expression - create unknown type with expr_hole provenance
      const origin: HoleOrigin = {
        kind: "expr",
        nodeId: expr.id,
        span: expr.span,
      };
      const provenance: Provenance = {
        kind: "expr_hole",
        id: expr.id,
      };
      const holeType = createUnknownAndRegister(ctx, origin, provenance);
      return recordExprType(ctx, expr, holeType);
    }
    case "enum_literal": {
      // Enum literal like .static - in raw mode, return a fresh type variable
      // The actual enum type will be inferred from context in Zig
      const enumType = freshTypeVar();
      return recordExprType(ctx, expr, enumType);
    }
    case "panic": {
      // Panic("message") has type `forall a. a` (bottom type)
      // First, check that the message is a String
      const messageType = inferExpr(ctx, expr.message);
      unify(ctx, messageType, {
        kind: "constructor",
        name: "String",
        args: [],
      });
      // Return a fresh type variable - Panic can have any type
      const resultType = freshTypeVar();
      return recordExprType(ctx, expr, resultType);
    }
    case "constructor": {
      const scheme = lookupEnv(ctx, expr.name);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, expr.name);
        return recordExprType(ctx, expr, mark.type);
      }
      const ctorType = instantiateAndApply(ctx, scheme);
      let result = ctorType;
      for (const arg of expr.args) {
        const argType = inferExpr(ctx, arg);
        const fnType = expectFunctionType(
          ctx,
          result,
          `Constructor ${expr.name}`,
        );
        if (!fnType.success) {
          // This should be handled by marking, but for now continue with unknown
          return recordExprType(
            ctx,
            expr,
            unknownType({
              kind: "incomplete",
              reason: "constructor_not_function",
            }),
          );
        }
        if (!unify(ctx, fnType.from, argType)) {
          const failure = ctx.lastUnifyFailure;
          const subject = materializeExpr(ctx, arg);
          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              expr,
              subject,
              failure.left,
              failure.right,
            );
            return recordExprType(ctx, expr, mark.type);
          }
          const resolvedFn = applyCurrentSubst(ctx, fnType.from);
          const resolvedArg = applyCurrentSubst(ctx, argType);
          const mark = markInconsistent(
            ctx,
            expr,
            subject,
            resolvedFn,
            resolvedArg,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        result = fnType.to;
      }
      const applied = applyCurrentSubst(ctx, result);
      if (applied.kind === "func") {
        const calleeMarked = materializeExpr(ctx, expr);
        const argsMarked = expr.args.map((arg) => materializeExpr(ctx, arg));
        const mark = markNotFunction(
          ctx,
          expr,
          calleeMarked,
          argsMarked,
          applied,
        );
        return recordExprType(ctx, expr, mark.type);
      }

      // Special handling for infectious type constructors:
      // If this is a constructor of an infectious type and the argument is a constructor,
      // refine the error_row to include the specific constructor as a case
      const refinedType = refineInfectiousConstructor(ctx, expr, applied);
      return recordExprType(ctx, expr, refinedType);
    }
    case "tuple": {
      const elements = expr.elements.map((el) => inferExpr(ctx, el));
      const tupleType = applyCurrentSubst(ctx, {
        kind: "tuple",
        elements: elements.map((t) => applyCurrentSubst(ctx, t)),
      });
      return recordExprType(ctx, expr, tupleType);
    }
    case "record_literal": {
      // If there's a spread, infer its type first to determine the record type
      let spreadType: Type | undefined;
      if (expr.spread) {
        spreadType = inferExpr(ctx, expr.spread);
        spreadType = applyCurrentSubst(ctx, spreadType);
      }

      const fields = new Map<string, Type>();
      const fieldNames = new Set<string>();
      for (const field of expr.fields) {
        if (fieldNames.has(field.name)) {
          recordLayer1Diagnostic(ctx, expr.id, "duplicate_record_field", {
            field: field.name,
          });
          const unknown = unknownType({
            kind: "incomplete",
            reason: "duplicate_record_field",
          });
          return recordExprType(ctx, expr, unknown);
        }
        fieldNames.add(field.name);
        const fieldType = inferExpr(ctx, field.value);
        fields.set(field.name, applyCurrentSubst(ctx, fieldType));
      }

      // If we have a spread, the result type should match the spread's record type
      if (spreadType) {
        // Unify field types with the spread's field types
        if (spreadType.kind === "constructor") {
          const spreadInfo = ctx.adtEnv.get(spreadType.name);
          if (spreadInfo?.recordFields) {
            const aliasInstance = instantiateRecordAlias(spreadInfo);
            if (aliasInstance) {
              for (const [fieldName, fieldType] of fields.entries()) {
                const spreadFieldType = aliasInstance.fields.get(fieldName);
                if (spreadFieldType) {
                  unify(ctx, spreadFieldType, fieldType);
                }
              }
            }
          }
        } else if (spreadType.kind === "record") {
          for (const [fieldName, fieldType] of fields.entries()) {
            const spreadFieldType = spreadType.fields.get(fieldName);
            if (spreadFieldType) {
              unify(ctx, spreadFieldType, fieldType);
            }
          }
        }
        return recordExprType(ctx, expr, spreadType);
      }

      const candidateRecords = Array.from(ctx.adtEnv.entries()).filter(
        ([name, info]) => {
          if (!info.recordFields) return false;
          if (info.recordFields.size < fields.size) return false;
          for (const fieldName of fieldNames) {
            if (!info.recordFields.has(fieldName)) {
              return false;
            }
          }
          return true;
        },
      );

      // Filter candidates to those where all missing fields have defaults
      // This prevents empty record literals from incorrectly matching records without defaults
      const effectiveCandidates = candidateRecords.filter(([name, info]) => {
        const availableDefaults = ctx.recordDefaultFields.get(name);
        for (const fieldName of info.recordFields!.keys()) {
          if (!fields.has(fieldName) && !availableDefaults?.has(fieldName)) {
            return false;
          }
        }
        return true;
      });

      if (effectiveCandidates.length === 1) {
        const [recordName, recordInfo] = effectiveCandidates[0];
        const missingFields = Array.from(
          recordInfo.recordFields!.keys(),
        ).filter((fieldName) => !fields.has(fieldName));
        const availableDefaults = ctx.recordDefaultFields.get(recordName);
        for (const missingField of missingFields) {
          if (availableDefaults?.has(missingField)) {
            continue;
          }
          recordLayer1Diagnostic(ctx, expr.id, "missing_field", {
            field: missingField,
          });
        }

        const aliasInstance = instantiateRecordAlias(recordInfo);
        if (aliasInstance) {
          for (const [fieldName, fieldType] of fields.entries()) {
            const aliasFieldType = aliasInstance.fields.get(fieldName);
            if (aliasFieldType) {
              unify(ctx, aliasFieldType, fieldType);
            }
          }
        }
        const constructorType = buildRecordConstructorType(
          recordName,
          recordInfo,
          fields,
        );
        return recordExprType(ctx, expr, constructorType);
      }

      const matches = candidateRecords.length;
      const structuralRecord: Type = {
        kind: "record",
        fields: new Map(fields),
      };
      // In raw mode, use structural record type - type annotation will disambiguate via unification
      if (ctx.rawMode) {
        return recordExprType(ctx, expr, structuralRecord);
      }
      if (matches > 1) {
        const candidateNames = candidateRecords.map(([name]) => name);
        recordLayer1Diagnostic(ctx, expr.id, "ambiguous_record", {
          matches,
          candidates: candidateNames,
        });
      }
      const fallbackUnknown = unknownType({
        kind: "incomplete",
        reason: matches > 1 ? "record_ambiguous" : "record_unmatched",
      });
      return recordExprType(ctx, expr, fallbackUnknown);
    }
    case "record_projection": {
      const targetExpr = expr.target;
      let targetType: Type;
      if (targetExpr.kind === "identifier") {
        const scheme = ctx.env.get(targetExpr.name);
        if (!scheme) {
          const markType = unknownType({
            kind: "incomplete",
            reason: "free_variable",
          });
          ctx.nodeTypes.set(expr.id, markType);
          markFreeVariable(ctx, targetExpr, targetExpr.name);
          ctx.nodeTypes.set(targetExpr.id, markType);
          registerHoleForType(ctx, holeOriginFromExpr(targetExpr), markType);
          registerHoleForType(ctx, holeOriginFromExpr(expr), markType);
          return recordExprType(ctx, expr, markType);
        }
        targetType = scheme.type;
      } else {
        targetType = inferExpr(ctx, targetExpr);
      }
      const resolvedTarget = collapseCarrier(
        applyCurrentSubst(ctx, targetType),
      );
      const targetCarrierInfo = splitCarrier(resolvedTarget);
      let recordSubject = targetCarrierInfo?.value ?? resolvedTarget;

      if (targetCarrierInfo?.domain === "mem") {
        emitRequireNotState(ctx, targetExpr.id, "mem", ["Null", "Closed"]);
      }

      const wrapWithCarrier = (value: Type): Type => {
        if (!targetCarrierInfo) {
          return value;
        }
        return (
          joinCarrier(
            targetCarrierInfo.domain,
            value,
            targetCarrierInfo.state,
          ) ?? value
        );
      };

      if (recordSubject.kind === "array" && expr.field === "len") {
        const lenType = ctx.rawMode ? freshTypeVar() : { kind: "int" };
        const projectionType = wrapWithCarrier(lenType);
        ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
        registerHoleForType(
          ctx,
          holeOriginFromExpr(targetExpr),
          applyCurrentSubst(ctx, targetType),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), projectionType);
        return recordExprType(ctx, expr, projectionType);
      }

      // First check if the subject type (either direct or carrier payload) is a nominal record
      if (recordSubject.kind === "constructor") {
        const info = ctx.adtEnv.get(recordSubject.name);

        // In raw mode, allow field projection on opaque/unknown constructor types
        // This handles cases like std.Build from zigImport where we don't know the fields
        if (ctx.rawMode && !info) {
          const fieldType = freshTypeVar();
          ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
          registerHoleForType(
            ctx,
            holeOriginFromExpr(targetExpr),
            applyCurrentSubst(ctx, targetType),
          );
          registerHoleForType(ctx, holeOriginFromExpr(expr), fieldType);
          return recordExprType(ctx, expr, fieldType);
        }

        // In raw mode, if the type is known but opaque, allow field projection anyway.
        if (ctx.rawMode && info && !info.recordFields) {
          const fieldType = freshTypeVar();
          ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
          registerHoleForType(
            ctx,
            holeOriginFromExpr(targetExpr),
            applyCurrentSubst(ctx, targetType),
          );
          registerHoleForType(ctx, holeOriginFromExpr(expr), fieldType);
          return recordExprType(ctx, expr, fieldType);
        }

        if (info && info.recordFields) {
          const index = info.recordFields.get(expr.field);
          if (index !== undefined) {
            let projectedValueType = recordSubject.args[index];
            if (!projectedValueType && info.alias?.kind === "record") {
              const aliasInstance = instantiateRecordAlias(info);
              projectedValueType = aliasInstance?.fields.get(expr.field);
            }
            if (!projectedValueType) {
              const unknown = unknownType({
                kind: "incomplete",
                reason: "missing_field",
              });
              return recordExprType(ctx, expr, unknown);
            }
            const projectionType = wrapWithCarrier(projectedValueType);
            recordHasFieldConstraint(
              ctx,
              expr,
              expr.target,
              expr.field,
              expr,
              projectedValueType,
            );
            ctx.nodeTypes.set(
              targetExpr.id,
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(
              ctx,
              holeOriginFromExpr(targetExpr),
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(ctx, holeOriginFromExpr(expr), projectionType);
            return recordExprType(ctx, expr, projectionType);
          } else {
            recordLayer1Diagnostic(ctx, expr.id, "missing_field", {
              field: expr.field,
            });
            const unknown = unknownType({
              kind: "incomplete",
              reason: "missing_field",
            });
            return recordExprType(ctx, expr, unknown);
          }
        }
      }

      if (recordSubject.kind === "record") {
        const fieldType = recordSubject.fields.get(expr.field);
        if (fieldType) {
          const projectionType = wrapWithCarrier(fieldType);
          recordHasFieldConstraint(
            ctx,
            expr,
            expr.target,
            expr.field,
            expr,
            fieldType,
          );
          ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
          registerHoleForType(
            ctx,
            holeOriginFromExpr(targetExpr),
            applyCurrentSubst(ctx, targetType),
          );
          registerHoleForType(ctx, holeOriginFromExpr(expr), projectionType);
          return recordExprType(ctx, expr, projectionType);
        }
        recordLayer1Diagnostic(ctx, expr.id, "missing_field", {
          field: expr.field,
        });
        const unknown = unknownType({
          kind: "incomplete",
          reason: "missing_field",
        });
        return recordExprType(ctx, expr, unknown);
      }

      // If targetType or carrier subject is a type variable (so unresolved), unify to exactly one nominal record
      if (targetType.kind === "var" || recordSubject.kind === "var") {
        const subjectVar = recordSubject.kind === "var"
          ? recordSubject
          : targetType;
        const possibleRecords = Array.from(ctx.adtEnv.entries()).filter(
          ([name, info]) => info.recordFields?.has(expr.field),
        );
        if (possibleRecords.length === 1) {
          // HM nominal record unification: exactly one record type has this field
          const [, info] = possibleRecords[0];
          const aliasInstance = instantiateRecordAlias(info);
          if (aliasInstance) {
            unify(ctx, subjectVar, aliasInstance);
            const projectedValueType = aliasInstance.fields.get(expr.field)!;
            const projectionType = targetCarrierInfo
              ? (joinCarrier(
                targetCarrierInfo.domain,
                projectedValueType,
                targetCarrierInfo.state,
              ) ?? projectedValueType)
              : projectedValueType;
            recordHasFieldConstraint(
              ctx,
              expr,
              expr.target,
              expr.field,
              expr,
              projectedValueType,
            );
            ctx.nodeTypes.set(
              targetExpr.id,
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(
              ctx,
              holeOriginFromExpr(targetExpr),
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(ctx, holeOriginFromExpr(expr), projectionType);
            return recordExprType(ctx, expr, projectionType);
          }
          const [name, fallbackInfo] = possibleRecords[0];
          const args = Array.from(
            { length: fallbackInfo.recordFields!.size },
            () => freshTypeVar(),
          );
          const constructorType: Type = { kind: "constructor", name, args };
          unify(ctx, subjectVar, constructorType);
          const index = fallbackInfo.recordFields!.get(expr.field)!;
          const projectedValueType = constructorType.args[index];
          const projectionType = targetCarrierInfo
            ? (joinCarrier(
              targetCarrierInfo.domain,
              projectedValueType,
              targetCarrierInfo.state,
            ) ?? projectedValueType)
            : projectedValueType;
          recordHasFieldConstraint(
            ctx,
            expr,
            expr.target,
            expr.field,
            expr,
            projectedValueType,
          );
          ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
          registerHoleForType(
            ctx,
            holeOriginFromExpr(targetExpr),
            applyCurrentSubst(ctx, targetType),
          );
          registerHoleForType(ctx, holeOriginFromExpr(expr), projectionType);
          return recordExprType(ctx, expr, projectionType);
        } else {
          // In raw mode, allow field projection on type variables without nominal matching
          // Return a fresh type variable - the field is assumed to exist
          if (ctx.rawMode) {
            const fieldType = freshTypeVar();
            ctx.nodeTypes.set(
              targetExpr.id,
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(
              ctx,
              holeOriginFromExpr(targetExpr),
              applyCurrentSubst(ctx, targetType),
            );
            registerHoleForType(ctx, holeOriginFromExpr(expr), fieldType);
            return recordExprType(ctx, expr, fieldType);
          }
          const matches = possibleRecords.length;
          const candidateNames = possibleRecords.map(([name]) => name);
          recordLayer1Diagnostic(ctx, expr.id, "ambiguous_record", {
            matches,
            candidates: candidateNames,
          });
          const unknown = unknownType({
            kind: "incomplete",
            reason: "ambiguous_record",
          });
          return recordExprType(ctx, expr, unknown);
        }
      }

      // Field projection must be on nominal record types (HM requirement)
      if (ctx.rawMode) {
        const fieldType = freshTypeVar();
        ctx.nodeTypes.set(targetExpr.id, applyCurrentSubst(ctx, targetType));
        registerHoleForType(
          ctx,
          holeOriginFromExpr(targetExpr),
          applyCurrentSubst(ctx, targetType),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), fieldType);
        return recordExprType(ctx, expr, fieldType);
      }
      recordLayer1Diagnostic(ctx, expr.id, "not_record", {
        actual: resolvedTarget.kind,
      });
      return recordExprType(
        ctx,
        expr,
        unknownType({
          kind: "incomplete",
          reason: "not_record",
        }),
      );
    }
    case "call": {
      if (ctx.rawMode && expr.callee.kind === "identifier") {
        const calleeName = expr.callee.name;
        if (
          calleeName === "allocArrayUninit" && expr.arguments.length === 2
        ) {
          const elementType = inferExpr(ctx, expr.arguments[0]);
          const lengthArg = expr.arguments[1];
          if (
            lengthArg.kind === "literal" && lengthArg.literal.kind === "int"
          ) {
            const arrayType: Type = {
              kind: "array",
              length: lengthArg.literal.value,
              element: elementType,
            };
            ctx.nodeTypes.set(
              expr.callee.id,
              applyCurrentSubst(ctx, elementType),
            );
            registerHoleForType(
              ctx,
              holeOriginFromExpr(expr.arguments[0]),
              applyCurrentSubst(ctx, elementType),
            );
            registerHoleForType(
              ctx,
              holeOriginFromExpr(expr),
              arrayType,
            );
            return recordExprType(ctx, expr, arrayType);
          }
        }
      }
      const rawCalleeType = inferExpr(ctx, expr.callee);
      let fnType = collapseCarrier(applyCurrentSubst(ctx, rawCalleeType));

      // Track accumulated states per domain (generic for any carrier)
      const accumulatedStates = new Map<string, Type>();

      const calleeCarrierInfo = splitCarrier(fnType);
      if (calleeCarrierInfo) {
        accumulatedStates.set(
          calleeCarrierInfo.domain,
          calleeCarrierInfo.state,
        );
        fnType = calleeCarrierInfo.value;
      }

      // Handle zero-argument calls: f() should unify with Void -> T
      if (expr.arguments.length === 0) {
        const resultType = freshTypeVar();
        registerHoleForType(
          ctx,
          holeOriginFromExpr(expr.callee),
          applyCurrentSubst(ctx, rawCalleeType),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), resultType);

        const unifySucceeded = unify(ctx, fnType, {
          kind: "func",
          from: { kind: "unit" },
          to: resultType,
        });

        if (!unifySucceeded) {
          const resolvedFn = applyCurrentSubst(ctx, fnType);
          // Check if it's an incomplete hole
          if (isHoleType(resolvedFn)) {
            fnType = applyCurrentSubst(ctx, resultType);
            return recordExprType(ctx, expr, fnType);
          }
          if (resolvedFn.kind !== "func") {
            const calleeMarked = materializeExpr(ctx, expr.callee);
            const mark = markNotFunction(
              ctx,
              expr,
              calleeMarked,
              [],
              resolvedFn,
            );
            return recordExprType(ctx, expr, mark.type);
          }
        }
        fnType = applyCurrentSubst(ctx, resultType);
        let finalType = collapseCarrier(fnType);

        // Reconstruct carrier types with accumulated states (generic for all domains)
        for (const [domain, state] of accumulatedStates.entries()) {
          const flattened = splitCarrier(finalType);
          if (flattened && flattened.domain === domain) {
            // Merge states if finalType already has this domain's state
            const mergedState = unionCarrierStates(
              domain,
              flattened.state,
              state,
            );
            if (mergedState) {
              finalType = joinCarrier(domain, flattened.value, mergedState) ??
                finalType;
            }
          } else {
            // Wrap with carrier if finalType doesn't have this domain
            finalType = joinCarrier(domain, finalType, state) ?? finalType;
          }
          finalType = collapseCarrier(finalType);
        }
        return recordExprType(ctx, expr, finalType);
      }

      for (let index = 0; index < expr.arguments.length; index++) {
        const argExpr = expr.arguments[index];
        const argType = inferExpr(ctx, argExpr);
        const resultType = freshTypeVar();
        // Ensure participating expressions are tracked as potential holes
        registerHoleForType(
          ctx,
          holeOriginFromExpr(expr.callee),
          applyCurrentSubst(ctx, fnType),
        );
        registerHoleForType(
          ctx,
          holeOriginFromExpr(argExpr),
          collapseCarrier(applyCurrentSubst(ctx, argType)),
        );
        registerHoleForType(ctx, holeOriginFromExpr(expr), resultType);
        const calleeIdentifierName = expr.callee.kind === "identifier"
          ? expr.callee.name
          : null;
        const calleeName = calleeIdentifierName ?? "<expression>";
        const shouldLogFormatter = calleeIdentifierName === "formatter";
        if (
          calleeIdentifierName === "listMap" &&
          ctx.source?.includes(
            "Runtime value printer for Workman using std library",
          )
        ) {
          /* console.debug("[debug] listMap arg type:", typeToString(applyCurrentSubst(ctx, argType)));
          console.log(
            "[debug] fnType before unify:",
            typeToString(applyCurrentSubst(ctx, fnType)),
          ); */
        }
        if (
          ctx.source?.includes(
            "Runtime value printer for Workman using std library",
          )
        ) {
          /* console.debug("[debug] call callee:", calleeName); */
        }
        if (shouldLogFormatter) {
          /* console.debug("[debug] formatter call before unify", {
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
            argType: typeToString(applyCurrentSubst(ctx, argType)),
          }); */
        }
        fnType = applyCurrentSubst(ctx, fnType);
        const resolvedArg = collapseCarrier(applyCurrentSubst(ctx, argType));
        const argCarrierInfo = splitCarrier(resolvedArg);
        const argBareValueType = argCarrierInfo
          ? argCarrierInfo.value
          : resolvedArg;

        const expectedParamType = fnType.kind === "func"
          ? applyCurrentSubst(ctx, fnType.from)
          : undefined;
        const expectsCarrier = expectedParamType
          ? splitCarrier(expectedParamType) !== null
          : false;

        let argumentValueType = resolvedArg;
        if (!expectsCarrier && argCarrierInfo) {
          argumentValueType = argBareValueType;
          // Accumulate carrier state using generic union (only if domain infects return)
          const domain = argCarrierInfo.domain;
          if (shouldInfectReturn(ctx.infectionRegistry, domain)) {
            const existingState = accumulatedStates.get(domain);
            if (existingState) {
              const merged = unionCarrierStates(
                domain,
                existingState,
                argCarrierInfo.state,
              );
              if (merged) {
                accumulatedStates.set(domain, merged);
              }
            } else {
              accumulatedStates.set(domain, argCarrierInfo.state);
            }
          }
        }

        // Try to pass the preferred argument shape through. If that fails and
        // the argument is a carrier, fall back to infectious semantics by unwrapping.
        let unifySucceeded = unify(ctx, fnType, {
          kind: "func",
          from: argumentValueType,
          to: resultType,
        });
        if (!unifySucceeded && argCarrierInfo && !expectsCarrier) {
          const fallbackSucceeded = unify(ctx, fnType, {
            kind: "func",
            from: argBareValueType,
            to: resultType,
          });
          if (fallbackSucceeded) {
            argumentValueType = argBareValueType;
            // Accumulate carrier state using generic union (only if domain infects return)
            const domain = argCarrierInfo.domain;
            if (shouldInfectReturn(ctx.infectionRegistry, domain)) {
              const existingState = accumulatedStates.get(domain);
              if (existingState) {
                const merged = unionCarrierStates(
                  domain,
                  existingState,
                  argCarrierInfo.state,
                );
                if (merged) {
                  accumulatedStates.set(domain, merged);
                }
              } else {
                accumulatedStates.set(domain, argCarrierInfo.state);
              }
            }
            unifySucceeded = true;
          }
        }

        recordCallConstraint(
          ctx,
          expr,
          expr.callee,
          argExpr,
          expr,
          resultType,
          index,
          argumentValueType,
        );
        if (!unifySucceeded) {
          const resolvedFn = applyCurrentSubst(ctx, fnType);
          // Check if it's an incomplete hole
          if (isHoleType(resolvedFn)) {
            fnType = applyCurrentSubst(ctx, resultType);
            continue;
          }

          const failure = ctx.lastUnifyFailure;
          const calleeMarked = materializeExpr(ctx, expr.callee);
          const argsMarked = expr.arguments.map((argument) =>
            materializeExpr(ctx, argument)
          );
          const subject = argsMarked[index];

          if (failure?.kind === "occurs_check") {
            const mark = markOccursCheck(
              ctx,
              expr,
              subject,
              failure.left,
              failure.right,
            );
            return recordExprType(ctx, expr, mark.type);
          }

          if (resolvedFn.kind !== "func") {
            const mark = markNotFunction(
              ctx,
              expr,
              calleeMarked,
              argsMarked,
              resolvedFn,
            );
            return recordExprType(ctx, expr, mark.type);
          }

          // Use the actual types from the unification failure when available,
          // since post-substitution types can look identical even when the
          // actual failure was between different types (e.g., Ptr<T> vs T)
          const expectedArg = failure?.left ??
            applyCurrentSubst(ctx, resolvedFn.from);
          const actualArg = failure?.right ?? applyCurrentSubst(ctx, argType);
          const mark = markInconsistent(
            ctx,
            expr,
            subject,
            expectedArg,
            actualArg,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        if (shouldLogFormatter) {
          /* console.debug("[debug] formatter call after unify", {
            resultType: typeToString(applyCurrentSubst(ctx, resultType)),
            fnType: typeToString(applyCurrentSubst(ctx, fnType)),
          }); */
        }

        fnType = applyCurrentSubst(ctx, resultType);
      }
      let callType = collapseCarrier(applyCurrentSubst(ctx, fnType));

      // Reconstruct carrier types with accumulated states (generic for all domains)
      for (const [domain, state] of accumulatedStates.entries()) {
        const flattened = splitCarrier(callType);
        if (flattened && flattened.domain === domain) {
          // Merge states if callType already has this domain's state
          const mergedState = unionCarrierStates(
            domain,
            flattened.state,
            state,
          );
          if (mergedState) {
            callType = joinCarrier(domain, flattened.value, mergedState) ??
              callType;
          }
        } else {
          // Wrap with carrier if callType doesn't have this domain
          callType = joinCarrier(domain, callType, state) ?? callType;
        }
        callType = collapseCarrier(callType);
      }

      // PHASE 2: Emit constraint stubs (generic for any carrier domain)
      const calleeName = getCalleeName(expr.callee);
      let opRule = calleeName
        ? resolveOpRule(ctx.infectionRegistry, calleeName)
        : undefined;
      if (!opRule) {
        opRule = resolveDefaultOpRule(ctx, expr.arguments);
      }
      const targetIndex = opRule?.target
        ? parseTargetIndex(opRule.target)
        : null;
      const targetExpr = targetIndex !== null
        ? expr.arguments[targetIndex]
        : undefined;
      const requireTargetIndex = targetIndex === null &&
          ((opRule?.requiresExact?.length ?? 0) > 0 ||
            (opRule?.requiresAny?.length ?? 0) > 0 ||
            (opRule?.requiresNot?.length ?? 0) > 0)
        ? 0
        : targetIndex;
      const requireTargetExpr = requireTargetIndex !== null
        ? expr.arguments[requireTargetIndex]
        : undefined;
      const isRowBag = opRule?.domain
        ? isRowBagDomain(ctx.infectionRegistry, opRule.domain)
        : false;
      let callIdentityTags: string[] | null = null;

      const currentScope = getCurrentFunctionScope(ctx);
      if (currentScope && opRule?.domain) {
        if (
          requireTargetExpr?.kind === "identifier" &&
          (opRule.requiresExact?.length || opRule.requiresAny?.length ||
            opRule.requiresNot?.length)
        ) {
          const paramIndex = currentScope.params.get(requireTargetExpr.name);
          if (paramIndex !== undefined) {
            if (opRule.requiresExact?.length) {
              recordParamEffect(
                ctx,
                paramIndex,
                opRule.domain,
                "requiresExact",
                opRule.requiresExact,
              );
            }
            if (opRule.requiresAny?.length) {
              recordParamEffect(
                ctx,
                paramIndex,
                opRule.domain,
                "requiresAny",
                opRule.requiresAny,
              );
            }
            if (opRule.requiresNot?.length) {
              recordParamEffect(
                ctx,
                paramIndex,
                opRule.domain,
                "requiresNot",
                opRule.requiresNot,
              );
            }
          }
        }
        if (targetExpr?.kind === "identifier" && opRule.adds?.length) {
          const paramIndex = currentScope.params.get(targetExpr.name);
          if (paramIndex !== undefined) {
            recordParamEffect(
              ctx,
              paramIndex,
              opRule.domain,
              "adds",
              opRule.adds,
            );
          }
        }
      }

      if (opRule?.domain && opRule.adds?.length && !targetExpr) {
        const carrierInfo = splitCarrier(callType);
        if (carrierInfo && carrierInfo.domain === opRule.domain) {
          let addedTags = opRule.adds;
          if (isRowBag) {
            const identity = freshResource();
            // Record the scope where this identity was created
            ctx.identityCreationScope.set(identity.id, getCurrentScopeId(ctx));
            addedTags = addIdentityTags(
              ctx,
              opRule.domain,
              identity.id,
              opRule.adds,
              expr.id,
            );
            callIdentityTags = addedTags;
            setExprIdentities(
              ctx,
              expr,
              new Map([[opRule.domain, new Set([identity.id])]]),
            );
            recordIdentityUsage(ctx, opRule.domain, identity.id, expr.id);
          }
          const addedRow = createEffectRow(addedTags.map((tag) => [tag, null]));
          let baseState = carrierInfo.state;
          if (carrierInfo.domain === "mem") {
            const row = ensureRow(carrierInfo.state);
            if (row.cases.size === 0 && row.tail?.kind === "var") {
              baseState = createEffectRow();
            }
          }
          const mergedState =
            unionCarrierStates(carrierInfo.domain, baseState, addedRow) ??
              effectRowUnion(baseState, addedRow);
          const rejoined = joinCarrier(
            carrierInfo.domain,
            carrierInfo.value,
            mergedState,
          );
          if (rejoined) {
            callType = rejoined;
          }
        }
      }

      const finalCarrierInfo = splitCarrier(callType);
      if (finalCarrierInfo) {
        // Emit constraint source with the carrier's state
        if (finalCarrierInfo.state.kind === "effect_row") {
          emitConstraintSource(
            ctx,
            expr.id,
            rowLabel(finalCarrierInfo.domain, finalCarrierInfo.state),
          );
        }
        // TODO: Add taintLabel when taint domaineffectLabelimplemented
        // if (finalCarrierInfo.domain === "taint" && finalCarrierInfo.state.kind === "effect_row") {
        //   emitConstraintSource(ctx, expr.id, taintLabel(finalCarrierInfo.state));
        // }

        // Emit flow constraints from callee and arguments to result
        // NOTE: Following the plan's "selective optimization" - only emit explicit
        // flow edges for call sites. Other expressions use implicit propagation via types.
        emitConstraintFlow(ctx, expr.callee.id, expr.id);
        for (const arg of expr.arguments) {
          emitConstraintFlow(ctx, arg.id, expr.id);
        }
      }

      if (calleeName) {
        if (opRule?.domain) {
          const targetNode = requireTargetExpr?.id ?? expr.id;
          if (opRule.requiresExact?.length) {
            emitRequireExactState(
              ctx,
              targetNode,
              opRule.domain,
              opRule.requiresExact,
            );
          }
          if (opRule.requiresAny?.length) {
            emitRequireAnyState(
              ctx,
              targetNode,
              opRule.domain,
              opRule.requiresAny,
            );
          }
          if (opRule.requiresNot?.length) {
            emitRequireNotState(
              ctx,
              targetNode,
              opRule.domain,
              opRule.requiresNot,
            );
          }
          if (opRule.adds?.length) {
            let addTags = opRule.adds;
            if (targetExpr && isRowBag) {
              const identities = getIdentitiesForExpr(ctx, targetExpr);
              const domainIds = identities?.get(opRule.domain);
              if (domainIds && domainIds.size > 0) {
                const tagged: string[] = [];
                const targetVarName = targetExpr.kind === "identifier"
                  ? targetExpr.name
                  : null;
                for (const identityId of domainIds) {
                  const identityTags = addIdentityTags(
                    ctx,
                    opRule.domain,
                    identityId,
                    opRule.adds,
                    expr.id,
                  );
                  tagged.push(...identityTags);
                  emitIdentityTagsToUsage(
                    ctx,
                    opRule.domain,
                    identityId,
                    identityTags,
                    targetVarName,
                  );
                }
                addTags = tagged;
              }
            } else if (!targetExpr && isRowBag && callIdentityTags) {
              addTags = callIdentityTags;
            }
            emitAddStateTags(ctx, targetNode, opRule.domain, addTags);
          }
        }
        if (opRule?.callPolicy === "pure") {
          emitCallRejectsInfection(ctx, expr.id, opRule.callPolicy);
        }
        if (opRule?.rejectDomains?.length) {
          emitCallRejectsDomains(
            ctx,
            expr.id,
            opRule.rejectDomains,
            opRule.name,
          );
        }

        const policies = getPoliciesForTarget(
          ctx.infectionRegistry,
          calleeName,
        );
        for (const policy of policies) {
          if (policy.rejectsAllDomains) {
            emitCallRejectsInfection(ctx, expr.id, policy.name);
          }
          if (policy.rejectDomains?.length) {
            emitCallRejectsDomains(
              ctx,
              expr.id,
              policy.rejectDomains,
              policy.name,
            );
          }
        }

        applyParamEffectsToCall(ctx, calleeName, expr.arguments);
      }

      if (
        opRule?.target &&
        opRule.domain &&
        targetExpr &&
        isRowBag &&
        !ctx.exprIdentities.has(expr.id)
      ) {
        const targetIdentities = getExprIdentities(ctx, targetExpr);
        const domainIds = targetIdentities?.get(opRule.domain);
        if (domainIds && domainIds.size > 0) {
          setExprIdentities(
            ctx,
            expr,
            new Map([[opRule.domain, new Set(domainIds)]]),
          );
        }
      }

      if (
        ctx.source?.includes(
          "Runtime value printer for Workman using std library",
        ) &&
        ctx.source.slice(expr.span.start, expr.span.end).includes("listMap")
      ) {
        /* console.debug("[debug] listMap call type:", typeToString(callType));
        const fmtScheme = ctx.env.get("formatRuntimeValue");
        if (fmtScheme) {
          console.log(
            "[debug] formatRuntimeValue scheme after listMap:",
            formatScheme(applySubstitutionScheme(fmtScheme, ctx.subst)),
          );
        } */
      }
      return recordExprType(ctx, expr, callType);
    }
    case "arrow":
      return recordExprType(
        ctx,
        expr,
        inferArrowFunction(
          ctx,
          expr.parameters,
          expr.body,
          expr.returnAnnotation,
        ),
      );
    case "block": {
      const type = inferBlockExpr(ctx, expr);
      return recordExprType(ctx, expr, type);
    }
    case "match":
      return recordExprType(
        ctx,
        expr,
        inferMatchExpression(ctx, expr, expr.scrutinee, expr.bundle),
      );
    case "match_fn":
      return recordExprType(
        ctx,
        expr,
        inferMatchFunction(ctx, expr, expr.parameters, expr.bundle),
      );
    case "match_bundle_literal":
      return recordExprType(ctx, expr, inferMatchBundleLiteral(ctx, expr));
    case "binary": {
      // Binary operators are desugared to function calls
      // e.g., `a + b` becomes `add(a, b)` where `add` is the implementation function
      // The operator itself should have been registered with its implementation function
      // For type inference, we treat it as a call to the implementation function
      const leftType = inferExpr(ctx, expr.left);
      const rightType = inferExpr(ctx, expr.right);

      // Look up the operator's implementation function in the environment
      // This will be set during the declaration phase
      const opFuncName = `__op_${expr.operator}`;
      const scheme = lookupEnv(ctx, opFuncName);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, opFuncName);
        return recordExprType(ctx, expr, mark.type);
      }
      const opType = instantiateAndApply(ctx, scheme);
      let fnType = collapseCarrier(applyCurrentSubst(ctx, opType));

      // Track accumulated states per domain (generic for any carrier)
      const accumulatedStates = new Map<string, Type>();

      const calleeCarrierInfo = splitCarrier(fnType);
      if (calleeCarrierInfo) {
        accumulatedStates.set(
          calleeCarrierInfo.domain,
          calleeCarrierInfo.state,
        );
        fnType = calleeCarrierInfo.value;
      }

      // Apply the function to both arguments
      const resultType1 = freshTypeVar();
      const resolvedLeft = collapseCarrier(applyCurrentSubst(ctx, leftType));
      const leftCarrierInfo = splitCarrier(resolvedLeft);
      const leftArgType = leftCarrierInfo
        ? leftCarrierInfo.value
        : resolvedLeft;
      if (leftCarrierInfo) {
        const domain = leftCarrierInfo.domain;
        if (shouldInfectReturn(ctx.infectionRegistry, domain)) {
          const existingState = accumulatedStates.get(domain);
          if (existingState) {
            const merged = unionCarrierStates(
              domain,
              existingState,
              leftCarrierInfo.state,
            );
            if (merged) {
              accumulatedStates.set(domain, merged);
            }
          } else {
            accumulatedStates.set(domain, leftCarrierInfo.state);
          }
        }
      }
      const resolvedRight = collapseCarrier(applyCurrentSubst(ctx, rightType));
      const rightCarrierInfo = splitCarrier(resolvedRight);
      const rightArgType = rightCarrierInfo
        ? rightCarrierInfo.value
        : resolvedRight;
      if (rightCarrierInfo) {
        const domain = rightCarrierInfo.domain;
        if (shouldInfectReturn(ctx.infectionRegistry, domain)) {
          const existingState = accumulatedStates.get(domain);
          if (existingState) {
            const merged = unionCarrierStates(
              domain,
              existingState,
              rightCarrierInfo.state,
            );
            if (merged) {
              accumulatedStates.set(domain, merged);
            }
          } else {
            accumulatedStates.set(domain, rightCarrierInfo.state);
          }
        }
      }
      // Skip numeric constraints in raw mode - operators are polymorphic
      if (!ctx.rawMode && NUMERIC_BINARY_OPERATORS.has(expr.operator)) {
        recordNumericConstraint(
          ctx,
          expr,
          [expr.left, expr.right],
          expr.operator,
        );
      }
      if (COMPARISON_OPERATORS.has(expr.operator)) {
        // Skip numeric constraints for ordering comparisons in raw mode
        if (!ctx.rawMode && ORDERING_COMPARISON_OPERATORS.has(expr.operator)) {
          recordNumericConstraint(
            ctx,
            expr,
            [expr.left, expr.right],
            expr.operator,
          );
        }
        unify(ctx, resultType1, { kind: "bool" });
      }
      if (BOOLEAN_BINARY_OPERATORS.has(expr.operator)) {
        recordBooleanConstraint(
          ctx,
          expr,
          [expr.left, expr.right],
          expr.operator,
        );
      }
      if (
        !unify(ctx, fnType, {
          kind: "func",
          from: leftArgType,
          to: { kind: "func", from: rightArgType, to: resultType1 },
        })
      ) {
        const failure = ctx.lastUnifyFailure;
        if (failure?.kind === "occurs_check") {
          const mark = markOccursCheck(
            ctx,
            expr,
            materializeExpr(ctx, expr.left),
            failure.left,
            failure.right,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        const expected = applyCurrentSubst(ctx, opType);
        const mark = markInconsistent(
          ctx,
          expr,
          materializeExpr(ctx, expr.left),
          expected,
          applyCurrentSubst(ctx, leftArgType),
        );
        return recordExprType(ctx, expr, mark.type);
      }

      let callType = collapseCarrier(applyCurrentSubst(ctx, resultType1));

      // Comparison operators always yield Bool and should not inherit carriers
      if (!COMPARISON_OPERATORS.has(expr.operator)) {
        // Reconstruct carrier types with accumulated states (generic for all domains)
        for (const [domain, state] of accumulatedStates.entries()) {
          const flattened = splitCarrier(callType);
          if (flattened && flattened.domain === domain) {
            // Merge states if callType already has this domain's state
            const mergedState = unionCarrierStates(
              domain,
              flattened.state,
              state,
            );
            if (mergedState) {
              callType = joinCarrier(domain, flattened.value, mergedState) ??
                callType;
            }
          } else {
            // Wrap with carrier if callType doesn't have this domain
            callType = joinCarrier(domain, callType, state) ?? callType;
          }
          callType = collapseCarrier(callType);
        }
      }
      return recordExprType(ctx, expr, callType);
    }
    case "unary": {
      // Unary operators are desugared to function calls
      // e.g., `!x` becomes `not(x)` where `not` is the implementation function
      const operandType = inferExpr(ctx, expr.operand);

      // In raw mode, & is address-of - returns Ptr<T, S>
      if (ctx.rawMode && expr.operator === "&") {
        const pointerTarget = operandType.kind === "array"
          ? operandType.element
          : operandType;
        const ptrType: Type = {
          kind: "constructor",
          name: "Ptr",
          args: [pointerTarget, freshTypeVar()],
        };
        return recordExprType(ctx, expr, ptrType);
      }

      // Look up the prefix operator's implementation function
      const opFuncName = `__prefix_${expr.operator}`;
      const scheme = lookupEnv(ctx, opFuncName);
      if (!scheme) {
        const mark = markFreeVariable(ctx, expr, opFuncName);
        return recordExprType(ctx, expr, mark.type);
      }
      const opType = instantiateAndApply(ctx, scheme);
      let fnType = collapseCarrier(applyCurrentSubst(ctx, opType));

      // Track accumulated states per domain (generic for any carrier)
      const accumulatedStates = new Map<string, Type>();

      const calleeCarrierInfo = splitCarrier(fnType);
      if (calleeCarrierInfo) {
        accumulatedStates.set(
          calleeCarrierInfo.domain,
          calleeCarrierInfo.state,
        );
        fnType = calleeCarrierInfo.value;
      }

      // Apply the function to the operand
      const resultType = freshTypeVar();
      const resolvedOperand = collapseCarrier(
        applyCurrentSubst(ctx, operandType),
      );
      const operandCarrierInfo = splitCarrier(resolvedOperand);
      const operandArgType = operandCarrierInfo
        ? operandCarrierInfo.value
        : resolvedOperand;
      if (operandCarrierInfo) {
        const domain = operandCarrierInfo.domain;
        if (shouldInfectReturn(ctx.infectionRegistry, domain)) {
          const existingState = accumulatedStates.get(domain);
          if (existingState) {
            const merged = unionCarrierStates(
              domain,
              existingState,
              operandCarrierInfo.state,
            );
            if (merged) {
              accumulatedStates.set(domain, merged);
            }
          } else {
            accumulatedStates.set(domain, operandCarrierInfo.state);
          }
        }
      }
      // Skip numeric constraints in raw mode - operators are polymorphic
      if (!ctx.rawMode && NUMERIC_UNARY_OPERATORS.has(expr.operator)) {
        recordNumericConstraint(ctx, expr, [expr.operand], expr.operator);
      }
      if (BOOLEAN_UNARY_OPERATORS.has(expr.operator)) {
        recordBooleanConstraint(ctx, expr, [expr.operand], expr.operator);
      }
      if (
        !unify(ctx, fnType, {
          kind: "func",
          from: operandArgType,
          to: resultType,
        })
      ) {
        const failure = ctx.lastUnifyFailure;
        if (failure?.kind === "occurs_check") {
          const mark = markOccursCheck(
            ctx,
            expr,
            materializeExpr(ctx, expr.operand),
            failure.left,
            failure.right,
          );
          return recordExprType(ctx, expr, mark.type);
        }
        const expected = applyCurrentSubst(ctx, opType);
        const mark = markInconsistent(
          ctx,
          expr,
          materializeExpr(ctx, expr.operand),
          expected,
          applyCurrentSubst(ctx, operandArgType),
        );
        return recordExprType(ctx, expr, mark.type);
      }

      let callType = collapseCarrier(applyCurrentSubst(ctx, resultType));

      // Reconstruct carrier types with accumulated states (generic for all domains)
      for (const [domain, state] of accumulatedStates.entries()) {
        const flattened = splitCarrier(callType);
        if (flattened && flattened.domain === domain) {
          // Merge states if callType already has this domain's state
          const mergedState = unionCarrierStates(
            domain,
            flattened.state,
            state,
          );
          if (mergedState) {
            callType = joinCarrier(domain, flattened.value, mergedState) ??
              callType;
          }
        } else {
          // Wrap with carrier if callType doesn't have this domain
          callType = joinCarrier(domain, callType, state) ?? callType;
        }
        callType = collapseCarrier(callType);
      }
      return recordExprType(ctx, expr, callType);
    }
    default:
      const mark = markUnsupportedExpr(ctx, expr, (expr as Expr).kind);
      return recordExprType(ctx, expr, mark.type);
  }
}

export function inferProgram(
  program: Program,
  options: InferOptions = {},
): InferResult {
  resetNodeIdsToProgramMax(program);
  lowerIndexAccess(program);
  desugarListLiterals(program);
  const canonicalProgram = canonicalizeMatch(program);
  lowerTupleParameters(canonicalProgram);
  const ctx = createContext({
    initialEnv: options.initialEnv,
    initialAdtEnv: options.initialAdtEnv,
    registerPrelude: options.registerPrelude,
    resetCounter: options.resetCounter,
    source: options.source ?? undefined,
    infectionRegistry: options.infectionRegistry,
    rawMode: options.rawMode,
  });
  const summaries: { name: string; scheme: TypeScheme }[] = [];
  const markedDeclarations: MTopLevel[] = [];
  const successfulTypeDecls = new Set<number>();
  const skippedTypeDecls = new Set<number>(); // Types from initialAdtEnv
  const recordDefaultExprs = new Map<string, Map<string, MExpr>>();
  const infectiousTypes = new Map<
    string,
    import("../ast.ts").InfectiousDeclaration
  >(); // Track infectious declarations

  // Clear the type params cache for this program
  resetTypeParamsCache();

  const infectionSummary = collectInfectionDeclarations(canonicalProgram);
  ctx.infectionRegistry.mergeSummary(infectionSummary);

  if (options.registerPrelude !== false) {
    if (options.rawMode) {
      registerRawPrelude(ctx);
    } else {
      registerPrelude(ctx);
    }
  }

  // Pass 0: Collect infectious declarations (before type registration)
  const seenTypeDeclsPass0 = new Set<number>();
  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "infectious") {
      // Old standalone syntax: infectious error IResult<T, E>;
      infectiousTypes.set(decl.typeName, decl);
      registerInfectiousDeclaration(ctx, decl, canonicalProgram);
    } else if (decl.kind === "type" && decl.infectious) {
      if (seenTypeDeclsPass0.has(decl.id)) continue;
      seenTypeDeclsPass0.add(decl.id);
      // New combined syntax: infectious error type IResult<T, E> = ...
      registerInfectiousTypeDeclaration(ctx, decl);
    }
  }

  // Pass 1: Register all type names (allows forward references)
  const seenTypeDeclsPass1 = new Set<number>();
  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "type" || decl.kind === "record_decl") {
      if (seenTypeDeclsPass1.has(decl.id)) {
        continue;
      }
      seenTypeDeclsPass1.add(decl.id);
      const result = registerTypeName(ctx, decl);
      if (!result.success) {
        // Duplicate detected - mark it and skip further processing
        markedDeclarations.push(result.mark);
        skippedTypeDecls.add(decl.id);
      } else {
        successfulTypeDecls.add(decl.id);
      }
    }
  }

  if (ctx.topLevelMarks.length > 0) {
    markedDeclarations.push(...ctx.topLevelMarks);
  }

  // Pass 2: Register constructors (now all type names are known)
  const seenTypeDeclsPass2 = new Set<number>();
  for (const decl of canonicalProgram.declarations) {
    if (
      (decl.kind === "type" || decl.kind === "record_decl") &&
      successfulTypeDecls.has(decl.id) &&
      !skippedTypeDecls.has(decl.id)
    ) {
      if (seenTypeDeclsPass2.has(decl.id)) continue;
      seenTypeDeclsPass2.add(decl.id);
      const infectiousDecl = infectiousTypes.get(decl.name);
      const result = decl.kind === "record_decl"
        ? registerRecordDeclaration(ctx, decl)
        : registerTypeConstructors(ctx, decl, infectiousDecl);
      if (!result.success) {
        markedDeclarations.push(result.mark);
        successfulTypeDecls.delete(decl.id); // Remove from successful set
      }
    }
  }

  for (const decl of canonicalProgram.declarations) {
    if (decl.kind === "let") {
      const results = inferLetDeclaration(ctx, decl);
      for (const { name, scheme } of results) {
        const finalScheme = applySubstitutionScheme(scheme, ctx.subst);
        summaries.push({
          name,
          scheme: finalScheme,
        });
      }
      const resolvedType = resolveTypeForName(ctx, decl.name);
      const marked = materializeMarkedLet(ctx, decl, resolvedType);
      markedDeclarations.push(marked);
    } else if (decl.kind === "infix") {
      registerInfixDeclaration(ctx, decl);
      markedDeclarations.push({ kind: "infix", node: decl });
    } else if (decl.kind === "prefix") {
      registerPrefixDeclaration(ctx, decl);
      markedDeclarations.push({ kind: "prefix", node: decl });
    } else if (decl.kind === "infectious") {
      // Already registered in Pass 0
      markedDeclarations.push({ kind: "infectious", node: decl });
    } else if (decl.kind === "domain") {
      markedDeclarations.push({ kind: "domain", node: decl });
    } else if (decl.kind === "op") {
      markedDeclarations.push({ kind: "op", node: decl });
    } else if (decl.kind === "policy") {
      markedDeclarations.push({ kind: "policy", node: decl });
    } else if (decl.kind === "annotate") {
      markedDeclarations.push({ kind: "annotate", node: decl });
    } else if (decl.kind === "type" && successfulTypeDecls.has(decl.id)) {
      markedDeclarations.push({ kind: "type", node: decl });
    } else if (
      decl.kind === "record_decl" && successfulTypeDecls.has(decl.id)
    ) {
      inferRecordDeclaration(ctx, decl, recordDefaultExprs);
      markedDeclarations.push({ kind: "record_decl", node: decl });
    }
  }

  const finalEnv: TypeEnv = new Map();
  for (const [name, scheme] of ctx.env.entries()) {
    finalEnv.set(name, applySubstitutionScheme(scheme, ctx.subst));
  }

  const finalSummaries = summaries.map(({ name, scheme }) => ({
    name,
    scheme: applySubstitutionScheme(scheme, ctx.subst),
  }));

  const nodeTypeById: Map<NodeId, Type> = new Map();
  for (const [nodeId, type] of ctx.nodeTypes.entries()) {
    nodeTypeById.set(nodeId, applyCurrentSubst(ctx, type));
  }

  const markedProgram: MProgram = {
    imports: canonicalProgram.imports,
    reexports: canonicalProgram.reexports,
    declarations: markedDeclarations,
  };

  const typeExprMarks: Map<NodeId, MTypeExpr> = new Map();
  for (const [typeExpr, mark] of ctx.typeExprMarks.entries()) {
    typeExprMarks.set(typeExpr.id, mark);
  }

  /* console.debug("[debug] final substitution entries", Array.from(ctx.subst.entries()).map(([id, type]) => [id, formatScheme({ quantifiers: [], type })]));
  console.debug("[debug] final summaries", finalSummaries.map(({ name, scheme }) => ({ name, type: formatScheme(scheme) })));
 */
  // Expose only real ADTs to downstream layers; aliases live only for type expansion.
  const filteredAdtEnv: Map<string, import("../types.ts").TypeInfo> = new Map();
  for (const [name, info] of ctx.adtEnv.entries()) {
    if ((info as any).isAlias) continue;
    filteredAdtEnv.set(name, info);
  }
  return {
    env: finalEnv,
    adtEnv: filteredAdtEnv,
    summaries: finalSummaries,
    allBindings: ctx.allBindings,
    markedProgram,
    marks: ctx.marks,
    typeExprMarks,
    holes: ctx.holes,
    constraintStubs: ctx.constraintStubs,
    nodeTypeById,
    marksVersion: 1,
    layer1Diagnostics: ctx.layer1Diagnostics,
    infectionRegistry: ctx.infectionRegistry,
    recordDefaultExprs,
  };
}

function inferRecordDeclaration(
  ctx: Context,
  decl: RecordDeclaration,
  defaults: Map<string, Map<string, MExpr>>,
): void {
  const info = ctx.adtEnv.get(decl.name);
  const alias = info?.alias;
  if (!info || !alias || alias.kind !== "record") {
    return;
  }

  const defaultExprs = new Map<string, MExpr>();

  withScopedEnv(ctx, () => {
    for (const [fieldName, fieldType] of alias.fields.entries()) {
      ctx.env.set(fieldName, { quantifiers: [], type: fieldType });
    }
    for (const member of decl.members) {
      if (member.kind !== "record_value_field") continue;
      const inferred = inferExpr(ctx, member.value);
      const fieldType = alias.fields.get(member.name);
      if (fieldType) {
        unify(ctx, fieldType, inferred);
      }
      defaultExprs.set(member.name, materializeExpr(ctx, member.value));
    }
  });

  if (defaultExprs.size > 0) {
    defaults.set(decl.name, defaultExprs);
  }
}

export function inferPattern(
  ctx: Context,
  pattern: Pattern,
  expected: Type,
  options: {
    allowPinning?: boolean;
    requireExplicitBinding?: boolean;
    autoPinBlacklist?: Set<string>;
  } = {},
): PatternInfo {
  const allowAutoPin = options.allowPinning ?? false;
  const requireExplicitBinding = options.requireExplicitBinding ?? false;
  const autoPinBlacklist = options.autoPinBlacklist ?? new Set<string>();
  switch (pattern.kind) {
    case "wildcard": {
      const target = applyCurrentSubst(ctx, expected);
      return {
        type: target,
        bindings: new Map(),
        coverage: { kind: "wildcard" },
        marked: {
          kind: "wildcard",
          span: pattern.span,
          id: pattern.id,
          type: target,
        },
      };
    }
    case "variable": {
      const target = applyCurrentSubst(ctx, expected);
      const existingScheme = ctx.env.get(pattern.name);

      if (pattern.isExplicitBinding) {
        const bindings = new Map<string, Type>();
        bindings.set(pattern.name, target);
        return {
          type: target,
          bindings,
          coverage: { kind: "wildcard" },
          marked: {
            kind: "variable",
            span: pattern.span,
            id: pattern.id,
            type: target,
            name: pattern.name,
          },
        };
      }

      const shouldAutoPin = allowAutoPin && !!existingScheme &&
        !autoPinBlacklist.has(pattern.name);
      if (shouldAutoPin && existingScheme) {
        const existingType = instantiateAndApply(ctx, existingScheme);
        if (!unify(ctx, target, existingType)) {
          const markType = createUnknownAndRegister(
            ctx,
            holeOriginFromPattern(pattern),
            { kind: "incomplete", reason: "pattern.pinned.unify_failed" },
          );
          const mark: MMarkPattern = {
            kind: "mark_pattern",
            span: pattern.span,
            id: pattern.id,
            reason: "other",
            data: {
              issue: "pinned_unify_failed",
              expected: typeToString(target),
              actual: typeToString(existingType),
            },
            type: markType,
          } satisfies MMarkPattern;
          return {
            type: markType,
            bindings: new Map(),
            coverage: { kind: "none" },
            marked: mark,
          };
        }

        return {
          type: target,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: {
            kind: "pinned",
            span: pattern.span,
            id: pattern.id,
            type: target,
            name: pattern.name,
          },
        };
      }

      if (!requireExplicitBinding) {
        const bindings = new Map<string, Type>();
        bindings.set(pattern.name, target);
        return {
          type: target,
          bindings,
          coverage: { kind: "wildcard" },
          marked: {
            kind: "variable",
            span: pattern.span,
            id: pattern.id,
            type: target,
            name: pattern.name,
          },
        };
      }

      const markType = createUnknownAndRegister(
        ctx,
        holeOriginFromPattern(pattern),
        { kind: "incomplete", reason: "pattern.binding_required" },
      );
      const mark: MMarkPattern = {
        kind: "mark_pattern",
        span: pattern.span,
        id: pattern.id,
        reason: "other",
        data: { issue: "binding_required", name: pattern.name },
        type: markType,
      } satisfies MMarkPattern;
      recordLayer1Diagnostic(ctx, pattern.id, "pattern_binding_required", {
        name: pattern.name,
      });
      return {
        type: markType,
        bindings: new Map(),
        coverage: { kind: "none" },
        marked: mark,
      };
    }
    case "literal": {
      const litType = literalType(pattern.literal);
      if (!unify(ctx, expected, litType)) {
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.literal.unify_failed" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: { issue: "literal_unify_failed" },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const resolved = applyCurrentSubst(ctx, litType);
      return {
        type: resolved,
        bindings: new Map(),
        coverage: pattern.literal.kind === "bool"
          ? { kind: "bool", value: pattern.literal.value }
          : { kind: "none" },
        marked: {
          kind: "literal",
          span: pattern.span,
          id: pattern.id,
          type: resolved,
          literal: pattern.literal,
        },
      };
    }
    case "tuple": {
      if (expected.kind !== "tuple") {
        unify(ctx, expected, {
          kind: "tuple",
          elements: pattern.elements.map(() => freshTypeVar()),
        });
      }
      const resolved = applyCurrentSubst(ctx, expected);
      if (resolved.kind !== "tuple") {
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.tuple.expected_tuple" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: {
            issue: "expected_tuple",
            actual: typeToString(resolved),
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      if (resolved.elements.length !== pattern.elements.length) {
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.tuple.arity_mismatch" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "other",
          data: {
            issue: "tuple_arity",
            expected: resolved.elements.length,
            actual: pattern.elements.length,
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const bindings = new Map<string, Type>();
      const markedElements: MPattern[] = [];
      for (let i = 0; i < pattern.elements.length; i++) {
        const subPattern = pattern.elements[i];
        const elementType = resolved.elements[i];
        let info = inferPattern(ctx, subPattern, elementType);
        for (const [name, type] of info.bindings.entries()) {
          if (bindings.has(name)) {
            // Duplicate variable, mark the sub-pattern
            const markType = createUnknownAndRegister(
              ctx,
              holeOriginFromPattern(subPattern),
              {
                kind: "incomplete",
                reason: `pattern.duplicate_variable:${name}`,
              },
            );
            const mark: MMarkPattern = {
              kind: "mark_pattern",
              span: subPattern.span,
              id: subPattern.id,
              reason: "other",
              data: { issue: "duplicate_variable", name },
              type: markType,
            } satisfies MMarkPattern;
            info = {
              type: markType,
              bindings: new Map(),
              coverage: { kind: "none" },
              marked: mark,
            };
            break; // mark the whole sub-pattern
          }
        }
        mergeBindings(bindings, info.bindings);
        markedElements.push(info.marked);
      }
      return {
        type: resolved,
        bindings,
        coverage: { kind: "none" },
        marked: {
          kind: "tuple",
          span: pattern.span,
          id: pattern.id,
          type: resolved,
          elements: markedElements,
        },
      };
    }
    case "constructor": {
      const resolvedExpected = applyCurrentSubst(ctx, expected);

      const nullabilityMode = pattern.name === "NonNull" ? "nonnull" : "null";
      const refinedNullability = (pattern.name === "Null" ||
          pattern.name === "NonNull")
        ? refineNullabilityType(resolvedExpected, nullabilityMode)
        : null;
      if (
        (pattern.name === "Null" || pattern.name === "NonNull") &&
        refinedNullability
      ) {
        if (
          (pattern.name === "Null" && pattern.args.length > 0) ||
          (pattern.name === "NonNull" && pattern.args.length !== 1)
        ) {
          const markType = createUnknownAndRegister(
            ctx,
            holeOriginFromPattern(pattern),
            {
              kind: "incomplete",
              reason: "pattern.constructor.arity_mismatch",
            },
          );
          const mark: MMarkPattern = {
            kind: "mark_pattern",
            span: pattern.span,
            id: pattern.id,
            reason: "wrong_constructor",
            data: { constructor: pattern.name, issue: "arity_mismatch" },
            type: markType,
          } satisfies MMarkPattern;
          return {
            type: markType,
            bindings: new Map(),
            coverage: { kind: "none" },
            marked: mark,
          };
        }
        let bindings = new Map<string, Type>();
        const markedArgs: MPattern[] = [];
        if (pattern.name === "NonNull") {
          const refined = refinedNullability ?? resolvedExpected;
          const argPattern = pattern.args[0];
          const bindingPattern = argPattern.kind === "variable"
            ? { ...argPattern, isExplicitBinding: true }
            : argPattern;
          let info = inferPattern(ctx, bindingPattern, refined, {
            allowPinning: false,
            requireExplicitBinding: false,
            autoPinBlacklist,
          });
          bindings = info.bindings;
          if (argPattern.kind === "variable") {
            if (!bindings) {
              bindings = new Map();
            }
            bindings.set(argPattern.name, refined);
          }
          markedArgs.push(info.marked);
        }
        return {
          type: resolvedExpected,
          bindings,
          coverage: {
            kind: "constructor",
            typeName: "__mem_nullability",
            ctor: pattern.name,
          },
          marked: {
            kind: "constructor",
            span: pattern.span,
            id: pattern.id,
            type: resolvedExpected,
            name: pattern.name,
            args: markedArgs,
          },
        };
      }
      if (
        (pattern.name === "Null" || pattern.name === "NonNull") &&
        (isHoleType(resolvedExpected) || resolvedExpected.kind === "var")
      ) {
        if (
          (pattern.name === "Null" && pattern.args.length > 0) ||
          (pattern.name === "NonNull" && pattern.args.length !== 1)
        ) {
          const markType = createUnknownAndRegister(
            ctx,
            holeOriginFromPattern(pattern),
            {
              kind: "incomplete",
              reason: "pattern.constructor.arity_mismatch",
            },
          );
          const mark: MMarkPattern = {
            kind: "mark_pattern",
            span: pattern.span,
            id: pattern.id,
            reason: "wrong_constructor",
            data: { constructor: pattern.name, issue: "arity_mismatch" },
            type: markType,
          } satisfies MMarkPattern;
          return {
            type: markType,
            bindings: new Map(),
            coverage: { kind: "none" },
            marked: mark,
          };
        }
        let bindings = new Map<string, Type>();
        const markedArgs: MPattern[] = [];
        if (pattern.name === "NonNull") {
          const holeInfo = isHoleType(resolvedExpected)
            ? flattenHoleType(resolvedExpected)
            : null;
          const refined = holeInfo?.value ?? resolvedExpected;
          const argPattern = pattern.args[0];
          const bindingPattern = argPattern.kind === "variable"
            ? { ...argPattern, isExplicitBinding: true }
            : argPattern;
          const info = inferPattern(ctx, bindingPattern, refined, {
            allowPinning: false,
            requireExplicitBinding: false,
            autoPinBlacklist,
          });
          bindings = info.bindings;
          if (argPattern.kind === "variable") {
            bindings.set(argPattern.name, refined);
          }
          markedArgs.push(info.marked);
        }
        return {
          type: resolvedExpected,
          bindings,
          coverage: {
            kind: "constructor",
            typeName: "__mem_nullability",
            ctor: pattern.name,
          },
          marked: {
            kind: "constructor",
            span: pattern.span,
            id: pattern.id,
            type: resolvedExpected,
            name: pattern.name,
            args: markedArgs,
          },
        };
      }
      const scheme = lookupEnv(ctx, pattern.name);
      if (!scheme) {
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.not_found" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            issue: "not_found",
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings: new Map(),
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const ctorType = instantiateAndApply(ctx, scheme);
      let current = ctorType;
      const bindings = new Map<string, Type>();
      const markedArgs: MPattern[] = [];
      for (const argPattern of pattern.args) {
        const fnType = expectFunctionType(
          ctx,
          current,
          `Constructor ${pattern.name}`,
        );
        if (!fnType.success) {
          // Handle non-function constructor type
          const markType = createUnknownAndRegister(
            ctx,
            holeOriginFromPattern(pattern),
            { kind: "incomplete", reason: "pattern.constructor.not_function" },
          );
          const mark: MMarkPattern = {
            kind: "mark_pattern",
            span: pattern.span,
            id: pattern.id,
            reason: "wrong_constructor",
            data: {
              constructor: pattern.name,
              issue: "not_function",
            },
            type: markType,
          } satisfies MMarkPattern;
          return {
            type: markType,
            bindings: new Map(),
            coverage: { kind: "none" },
            marked: mark,
          };
        }
        let info = inferPattern(ctx, argPattern, fnType.from);
        for (const [name, type] of info.bindings.entries()) {
          if (bindings.has(name)) {
            // Duplicate variable, mark the arg pattern
            const markType = unknownFromReason(
              `pattern.duplicate_variable:${name}`,
            );
            const mark: MMarkPattern = {
              kind: "mark_pattern",
              span: argPattern.span,
              id: argPattern.id,
              reason: "other",
              data: { issue: "duplicate_variable", name },
              type: markType,
            } satisfies MMarkPattern;
            info = {
              type: markType,
              bindings: new Map(),
              coverage: { kind: "none" },
              marked: mark,
            };
            break;
          }
        }
        mergeBindings(bindings, info.bindings);
        markedArgs.push(info.marked);
        current = fnType.to;
      }
      if (!unify(ctx, expected, current)) {
        recordLayer1Diagnostic(ctx, pattern.id, "type_mismatch", {
          expected: applyCurrentSubst(ctx, expected),
          actual: applyCurrentSubst(ctx, current),
        });
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.unify_failed" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            issue: "unify_failed",
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings,
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const final = applyCurrentSubst(ctx, current);
      if (final.kind !== "constructor") {
        const markType = createUnknownAndRegister(
          ctx,
          holeOriginFromPattern(pattern),
          { kind: "incomplete", reason: "pattern.constructor.invalid_result" },
        );
        const mark: MMarkPattern = {
          kind: "mark_pattern",
          span: pattern.span,
          id: pattern.id,
          reason: "wrong_constructor",
          data: {
            constructor: pattern.name,
            actual: typeToString(final),
          },
          type: markType,
        } satisfies MMarkPattern;
        return {
          type: markType,
          bindings,
          coverage: { kind: "none" },
          marked: mark,
        };
      }
      const effectRow = extractErrConstructorCoverage(pattern, final);
      return {
        type: final,
        bindings,
        coverage: {
          kind: "constructor",
          typeName: final.name,
          ctor: pattern.name,
          effectRow,
        },
        marked: {
          kind: "constructor",
          span: pattern.span,
          id: pattern.id,
          type: final,
          name: pattern.name,
          args: markedArgs,
        },
      };
    }
    case "all_errors": {
      const target = applyCurrentSubst(ctx, expected);
      return {
        type: target,
        bindings: new Map(),
        coverage: { kind: "all_errors" },
        marked: {
          kind: "all_errors",
          span: pattern.span,
          id: pattern.id,
          type: target,
        },
      };
    }
    default:
      const markType = createUnknownAndRegister(
        ctx,
        holeOriginFromPattern(pattern as Pattern),
        { kind: "incomplete", reason: "pattern.unsupported_kind" },
      );
      const mark: MMarkPattern = {
        kind: "mark_pattern",
        span: (pattern as Pattern).span,
        id: (pattern as Pattern).id,
        reason: "other",
        data: { issue: "unsupported_kind", kind: (pattern as Pattern).kind },
        type: markType,
      } satisfies MMarkPattern;
      return {
        type: markType,
        bindings: new Map(),
        coverage: { kind: "none" },
        marked: mark,
      };
  }
}

function extractErrConstructorCoverage(
  pattern: Pattern,
  final: Type,
): EffectRowCoverage | undefined {
  if (pattern.kind !== "constructor") {
    return undefined;
  }
  const carrier = getCarrier("effect", final);
  if (!carrier || !carrier.effectConstructors?.includes(pattern.name)) {
    return undefined;
  }
  if (pattern.args.length === 0) {
    return {
      constructors: new Set([pattern.name]),
      coversTail: true,
    };
  }
  const inner = collectEffectRowCoverage(pattern.args[0]);
  if (!inner) {
    return undefined;
  }
  return {
    constructors: new Set([pattern.name, ...inner.constructors]),
    coversTail: inner.coversTail,
  };
}

function collectEffectRowCoverage(
  pattern: Pattern,
): EffectRowCoverage | undefined {
  if (pattern.kind === "constructor") {
    return { constructors: new Set([pattern.name]), coversTail: false };
  }
  if (pattern.kind === "wildcard" || pattern.kind === "variable") {
    return { constructors: new Set(), coversTail: true };
  }
  // Any other pattern form matches all remaining constructors, so treat as tail coverage.
  return { constructors: new Set(), coversTail: true };
}

export function ensureExhaustive(
  ctx: Context,
  expr: Expr,
  scrutineeType: Type,
  hasWildcard: boolean,
  coverageMap: Map<string, Set<string>>,
  booleanCoverage: Set<"true" | "false">,
  hasEqualityPattern: boolean,
): void {
  if (hasWildcard) return;
  const resolved = applyCurrentSubst(ctx, scrutineeType);

  if (resolved.kind === "bool") {
    const missing: string[] = [];
    if (!booleanCoverage.has("true")) missing.push("true");
    if (!booleanCoverage.has("false")) missing.push("false");
    if (missing.length > 0) {
      markNonExhaustive(ctx, expr, expr.span, missing);
    }
    return;
  }
  if (resolved.kind !== "constructor") {
    if (hasEqualityPattern) {
      const typeLabel = resolved.kind === "var"
        ? "this type"
        : typeToString(resolved);
      const hint =
        `Literal or pinned patterns only cover specific values of ${typeLabel}. Add a '_' arm (or equivalent catch-all) to handle the rest.`;
      markNonExhaustive(
        ctx,
        expr,
        expr.span,
        ["_"],
        resolved.kind === "var" ? undefined : resolved,
        hint,
      );
    }
    return;
  }
  const info = ctx.adtEnv.get(resolved.name);
  if (!info) return;

  const seenForType = coverageMap.get(resolved.name) ?? new Set();
  const missing = info.constructors
    .map((ctor) => ctor.name)
    .filter((name) => !seenForType.has(name));

  if (missing.length > 0) {
    markNonExhaustive(ctx, expr, expr.span, missing, resolved);
  }
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

type MatchBranchKind = "ok" | "err" | "all_errors" | "other";

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
  let effectRowCoverage: MatchEffectRowCoverage | undefined;
  const branchMetadata: {
    kind: MatchBranchKind;
    type: Type;
    skipJoin?: boolean;
  }[] = [];
  let dischargedResult = false;
  let hasEqualityPattern = false;
  const autoPinBlacklist = new Set<string>();
  if (scrutineeExpr && scrutineeExpr.kind === "identifier") {
    autoPinBlacklist.add(scrutineeExpr.name);
  }

  for (const arm of bundle.arms) {
    if (arm.kind === "match_bundle_reference") {
      const existingScheme = ctx.env.get(arm.name);
      const scheme = existingScheme
        ? cloneTypeScheme(existingScheme)
        : undefined;
      if (!scheme) {
        markUnsupportedExpr(ctx, expr, "match_bundle_reference");
        hasWildcard = true;
        continue;
      }
      let instantiated = instantiateAndApply(ctx, scheme);
      const resultVar = freshTypeVar();
      // Ensure the referenced bundle accepts the current scrutinee type exactly
      if (
        !unify(ctx, instantiated, {
          kind: "func",
          from: applyCurrentSubst(ctx, scrutineeType),
          to: resultVar,
        })
      ) {
        // If unification fails, it might be because the bundle is generic (e.g. T -> ...)
        // and we are passing a concrete type (e.g. Int).
        // We should try to unify the *from* type of the bundle with the scrutinee.
        if (instantiated.kind === "func") {
          unify(ctx, instantiated.from, scrutineeType);
          unify(ctx, instantiated.to, resultVar);
        }
      }
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

    if (arm.kind !== "match_pattern") {
      continue;
    }

    const expected = normalizeMatchScrutineeType(ctx, scrutineeType);
    const patternInfo = inferPattern(ctx, arm.pattern, expected, {
      allowPinning: true,
      requireExplicitBinding: true,
      autoPinBlacklist,
    });
    patternInfos.push(patternInfo);
    const branchKind = classifyBranchKind(patternInfo);
    if (
      patternInfo.marked.kind === "literal" ||
      patternInfo.marked.kind === "pinned"
    ) {
      hasEqualityPattern = true;
    }

    // Populate handledErrorConstructors from effectRow if present
    if (
      patternInfo.coverage.kind === "constructor" &&
      (patternInfo.coverage as any).effectRow
    ) {
      hasErrConstructor = true;
      const effectRow = (patternInfo.coverage as any)
        .effectRow as EffectRowCoverage;
      for (const ctor of effectRow.constructors) {
        handledErrorConstructors.add(ctor);
      }
      if (effectRow.coversTail) {
        handledErrorConstructors.add("_");
      }
    }

    if (patternInfo.coverage.kind === "wildcard") {
      // A guarded wildcard doesn't guarantee coverage since the guard might fail
      if (!arm.guard) {
        hasWildcard = true;
      }
    } else if (patternInfo.coverage.kind === "all_errors") {
      hasAllErrors = true;
      handledErrorConstructors.add("_");
      // If the scrutinee is an error-domain carrier, mark it as having error handling
      if (expected.kind === "constructor") {
        const carrierInfo = splitCarrier(expected);
        if (carrierInfo && carrierInfo.domain === "effect") {
          // Find the error constructor name for this carrier type
          const typeInfo = ctx.adtEnv.get(expected.name);
          if (typeInfo) {
            // Find which constructor is the error constructor (has error row payload)
            for (const ctor of typeInfo.constructors) {
              // Heuristic: error constructors typically have one parameter
              // TODO: Make this more robust by checking constructor signatures
              if (ctor.arity === 1) {
                const set = coverageMap.get(expected.name) ?? new Set<string>();
                set.add(ctor.name);
                coverageMap.set(expected.name, set);
                break;
              }
            }
          }
        }
      }
    } else if (patternInfo.coverage.kind === "constructor") {
      // Guarded patterns don't guarantee constructor coverage
      if (!arm.guard) {
        const key = patternInfo.coverage.typeName;
        const set = coverageMap.get(key) ?? new Set<string>();
        set.add(patternInfo.coverage.ctor);
        coverageMap.set(key, set);
      }
    } else if (patternInfo.coverage.kind === "bool") {
      // Guarded patterns don't guarantee bool coverage
      if (!arm.guard) {
        booleanCoverage.add(patternInfo.coverage.value ? "true" : "false");
      }
    }

    const bodyType = withScopedEnv(ctx, () => {
      if (
        scrutineeExpr?.kind === "identifier" &&
        arm.pattern.kind === "constructor" &&
        (arm.pattern.name === "Null" || arm.pattern.name === "NonNull")
      ) {
        const refined = refineNullabilityType(
          expected,
          arm.pattern.name === "NonNull" ? "nonnull" : "null",
        );
        if (refined) {
          ctx.env.set(scrutineeExpr.name, {
            quantifiers: [],
            type: applyCurrentSubst(ctx, refined),
          });
        }
      }
      for (const [name, type] of patternInfo.bindings.entries()) {
        ctx.env.set(name, {
          quantifiers: [],
          type: applyCurrentSubst(ctx, type),
        });
        recordMutableBinding(ctx, name, false);
      }
      // Type check guard expression if present - must be Bool
      if (arm.guard) {
        const guardType = inferExpr(ctx, arm.guard);
        unify(ctx, guardType, { kind: "bool" });
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
    const resolvedBodyType = applyCurrentSubst(ctx, bodyType);
    const skipJoin = (branchKind === "err" || branchKind === "all_errors") &&
      arm.body.kind === "block" &&
      !arm.body.result;
    bodyTypes.push(resolvedBodyType);
    branchMetadata.push({ kind: branchKind, type: resolvedBodyType, skipJoin });

    if (!skipJoin) {
      branchBodies.push(arm.body);
      if (!resultType) {
        resultType = bodyType;
      } else {
        unify(ctx, resultType, bodyType);
        resultType = applyCurrentSubst(ctx, resultType);
      }
    }
  }

  const resolvedScrutinee = normalizeMatchScrutineeType(ctx, scrutineeType);
  const okBranchesReturnResult = branchMetadata.some(
    (branch) => branch.kind === "ok" && flattenResultType(branch.type) !== null,
  );
  const errBranchesReturnResult = branchMetadata.some(
    (branch) =>
      (branch.kind === "err" || branch.kind === "all_errors") &&
      flattenResultType(branch.type) !== null,
  );
  const preventsDischarge = okBranchesReturnResult || errBranchesReturnResult;

  if (exhaustive) {
    // If we have all_errors pattern and scrutinee is an error-domain carrier,
    // mark the error constructor as covered
    if (hasAllErrors && resolvedScrutinee.kind === "constructor") {
      const carrierInfo = splitCarrier(resolvedScrutinee);
      if (carrierInfo && carrierInfo.domain === "effect") {
        const typeInfo = ctx.adtEnv.get(resolvedScrutinee.name);
        if (typeInfo) {
          // Find the error constructor (heuristic: has arity 1)
          for (const ctor of typeInfo.constructors) {
            if (ctor.arity === 1) {
              const set = coverageMap.get(resolvedScrutinee.name) ??
                new Set<string>();
              set.add(ctor.name);
              coverageMap.set(resolvedScrutinee.name, set);
              break;
            }
          }
        }
      }
    }
    ensureExhaustive(
      ctx,
      expr,
      resolvedScrutinee,
      hasWildcard,
      coverageMap,
      booleanCoverage,
      hasEqualityPattern,
    );
  }

  if (!resultType) {
    resultType = freshTypeVar();
  }

  let resolvedResult = applyCurrentSubst(ctx, resultType);
  const scrutineeInfo = flattenResultType(resolvedScrutinee);
  const scrutineeCarrier = splitCarrier(resolvedScrutinee);
  let scrutineeFullyCovered = hasWildcard;
  if (!scrutineeFullyCovered && resolvedScrutinee.kind === "constructor") {
    const coverage = coverageMap.get(resolvedScrutinee.name);
    const adtInfo = ctx.adtEnv.get(resolvedScrutinee.name);
    if (coverage && adtInfo) {
      scrutineeFullyCovered = coverage.size >= adtInfo.constructors.length;
    }
  }

  const dischargeEffectRow = () => {
    const currentInfo = flattenResultType(resolvedResult);
    if (currentInfo) {
      resolvedResult = applyCurrentSubst(
        ctx,
        collapseResultType(currentInfo.value),
      );
    }
  };

  const snapshotErrorCoverage = (row: Type, missing: string[]) => {
    effectRowCoverage = {
      effectRow: row,
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
    } else if (preventsDischarge) {
      snapshotErrorCoverage(scrutineeInfo.effect, []);
    } else {
      dischargedResult = true;
      dischargeEffectRow();
      snapshotErrorCoverage(scrutineeInfo.effect, []);

      // PHASE 2.3: Emit constraint rewrite (parallel to existing eager discharge)
      // Only emit rewrites if we have a concrete effect row
      if (scrutineeInfo.effect.kind === "effect_row") {
        // Emit rewrite for Ok branches to remove error labels
        for (let i = 0; i < bundle.arms.length; i++) {
          const arm = bundle.arms[i];
          const branchKind = branchMetadata[i]?.kind;
          if (arm.kind === "match_pattern" && branchKind === "ok") {
            // Ok branch: remove error constraints
            emitConstraintRewrite(
              ctx,
              arm.body.id,
              [effectLabel(scrutineeInfo.effect)], // remove
              [], // add (nothing)
            );
          }
        }
      }
    }
  } else if (scrutineeInfo && hasErrConstructor) {
    // Only compute missing constructors if we have a concrete effect row
    let missingConstructors: string[] = [];
    if (scrutineeInfo.effect.kind === "effect_row") {
      missingConstructors = findMissingErrorConstructors(
        scrutineeInfo.effect,
        handledErrorConstructors,
      );
    }
    if (missingConstructors.length === 0) {
      if (preventsDischarge) {
        snapshotErrorCoverage(scrutineeInfo.effect, []);
      } else {
        dischargedResult = true;
        dischargeEffectRow();
        snapshotErrorCoverage(scrutineeInfo.effect, []);

        // PHASE 2.3: Emit constraint rewrite (parallel to existing eager discharge)
        // Only emit rewrites if we have a concrete effect row
        if (scrutineeInfo.effect.kind === "effect_row") {
          // Emit rewrite for Ok branches to remove error labels
          for (let i = 0; i < bundle.arms.length; i++) {
            const arm = bundle.arms[i];
            const branchKind = branchMetadata[i]?.kind;
            if (arm.kind === "match_pattern" && branchKind === "ok") {
              // Ok branch: remove error constraints
              emitConstraintRewrite(
                ctx,
                arm.body.id,
                [effectLabel(scrutineeInfo.effect)], // remove
                [], // add (nothing)
              );
            }
          }
        }
      }
    } else {
      // Only report partial coverage if we have a concrete effect row
      if (scrutineeInfo.effect.kind === "effect_row") {
        ctx.layer1Diagnostics.push({
          origin: expr.id,
          reason: "error_row_partial_coverage",
          details: { constructors: missingConstructors },
        });
      }
      snapshotErrorCoverage(scrutineeInfo.effect, missingConstructors);
    }
  }
  if (branchBodies.length > 0 && scrutineeExpr) {
    recordBranchJoinConstraint(ctx, expr, branchBodies, scrutineeExpr, {
      dischargesResult: dischargedResult,
      effectRowCoverage,
    });
  }

  const shouldRewrapCarrier = scrutineeCarrier &&
    ((scrutineeCarrier.domain === "effect" &&
      handledErrorConstructors.size === 0) ||
      (scrutineeCarrier.domain !== "effect" && !scrutineeFullyCovered));

  if (shouldRewrapCarrier && scrutineeCarrier) {
    const resultCarrier = splitCarrier(resolvedResult);
    const baseValue = resultCarrier ? resultCarrier.value : resolvedResult;
    let combinedState = scrutineeCarrier.state;
    if (resultCarrier && resultCarrier.domain === scrutineeCarrier.domain) {
      const unioned = unionCarrierStates(
        scrutineeCarrier.domain,
        resultCarrier.state,
        scrutineeCarrier.state,
      );
      combinedState = unioned ?? resultCarrier.state;
    }
    const rejoined = joinCarrier(
      scrutineeCarrier.domain,
      baseValue,
      combinedState,
    );
    if (rejoined) {
      resolvedResult = applyCurrentSubst(ctx, rejoined);
    }
  }

  const resultVars = freeTypeVars(resolvedResult);
  const scrutineeVars = freeTypeVars(resolvedScrutinee);
  for (const id of resultVars) {
    if (!scrutineeVars.has(id)) {
      ctx.nonGeneralizable.add(id);
    }
  }

  const result: MatchBranchesResult = {
    type: resolvedResult,
    patternInfos,
    bodyTypes,
    effectRowCoverage: effectRowCoverage,
    dischargesResult: dischargedResult,
  };
  ctx.matchResults.set(bundle, result);
  return result;
}

function resetNodeIdsToProgramMax(program: Program): void {
  let maxId = -1;
  const seen = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const maybeId = (value as { id?: unknown }).id;
    if (typeof maybeId === "number") {
      if (maybeId > maxId) {
        maxId = maybeId;
      }
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(program);
  resetNodeIds(maxId + 1);
}

function findMissingErrorConstructors(
  effectRow: EffectRowType,
  covered: Set<string>,
): string[] {
  if (covered.has("_")) {
    return [];
  }
  const missing: string[] = [];
  for (const label of effectRow.cases.keys()) {
    if (!covered.has(label)) {
      missing.push(label);
    }
  }
  if (effectRow.tail) {
    missing.push("_");
  }
  return missing;
}

function classifyBranchKind(info: PatternInfo): MatchBranchKind {
  const coverage = info.coverage;
  if (coverage.kind === "all_errors") {
    return "all_errors";
  }
  if (coverage.kind === "constructor") {
    const carrier = getCarrier("effect", info.type);
    if (carrier) {
      if (coverage.ctor === carrier.valueConstructor) {
        return "ok";
      }
      if (carrier.effectConstructors?.includes(coverage.ctor)) {
        return "err";
      }
    }
  }
  return "other";
}
