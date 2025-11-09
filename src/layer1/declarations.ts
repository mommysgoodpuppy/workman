import type { ConstructorAlias, TypeAliasExprMember, TypeDeclaration, TypeExpr } from "../ast.ts";
import type { Context } from "./context.ts";
import { MMarkTypeDeclDuplicate, MMarkTypeDeclInvalidMember } from "../ast_marked.ts";
import {
  ConstructorInfo,
  Type,
  TypeScheme,
  applySubstitution,
  cloneType,
  freshTypeVar,
  unknownType,
} from "../types.ts";
import {
  inferError,
  lookupEnv,
  expectFunctionType,
  markTypeDeclDuplicate,
  markTypeDeclInvalidMember,
  markTypeExprUnknown,
  markTypeExprArity,
  markTypeExprUnsupported,
  markInternal,
} from "./context.ts";

type TypeScope = Map<string, Type>;

function isAliasTypeDeclaration(
  decl: TypeDeclaration,
): decl is TypeDeclaration & { members: [TypeAliasExprMember] } {
  return decl.members.length === 1 && decl.members[0]?.kind === "alias";
}

const typeParamsCache = new Map<string, Type[]>();

export function resetTypeParamsCache(): void {
  typeParamsCache.clear();
}

export type RegisterTypeResult = { success: true } | { success: false; mark: MMarkTypeDeclDuplicate };

export function registerTypeName(ctx: Context, decl: TypeDeclaration): RegisterTypeResult {
  if (ctx.adtEnv.has(decl.name)) {
    return { success: false, mark: markTypeDeclDuplicate(ctx, decl) };
  }

  const parameterTypes = decl.typeParams.map(() => freshTypeVar());
  const parameterIds = parameterTypes
    .map((type) => (type.kind === "var" ? type.id : -1))
    .filter((id) => id >= 0);

  const adtInfo = {
    name: decl.name,
    parameters: parameterIds,
    constructors: [] as ConstructorInfo[],
  };
  ctx.adtEnv.set(decl.name, adtInfo);

  typeParamsCache.set(decl.name, parameterTypes);
  return { success: true };
}

export type RegisterConstructorsResult = { success: true } | { success: false; mark: MMarkTypeDeclInvalidMember };

export function registerTypeConstructors(ctx: Context, decl: TypeDeclaration): RegisterConstructorsResult {
  if (isAliasTypeDeclaration(decl)) {
    return registerTypeAlias(ctx, decl);
  }
  const adtInfo = ctx.adtEnv.get(decl.name);
  if (!adtInfo) {
    // This should not happen if registerTypeName was called first, but handle gracefully
    return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, decl.members[0] || decl) };
  }

  const parameterTypes = typeParamsCache.get(decl.name);
  if (!parameterTypes) {
    // This should not happen if registerTypeName was called first, but handle gracefully
    return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, decl.members[0] || decl) };
  }

  const typeScope: TypeScope = new Map();
  decl.typeParams.forEach((param, index) => {
    typeScope.set(param.name, parameterTypes[index]);
  });

  const stagedConstructors: ConstructorInfo[] = [];
  const stagedEnvEntries: string[] = [];
  const seenConstructorNames = new Set<string>();

  for (const member of decl.members) {
    if (member.kind !== "constructor") {
      // Purge on failure: remove ADT entry and cached params
      ctx.adtEnv.delete(decl.name);
      typeParamsCache.delete(decl.name);
      // Remove any staged env entries
      for (const name of stagedEnvEntries) {
        ctx.env.delete(name);
      }
      return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, member) };
    }

    if (seenConstructorNames.has(member.name)) {
      ctx.adtEnv.delete(decl.name);
      typeParamsCache.delete(decl.name);
      for (const name of stagedEnvEntries) {
        ctx.env.delete(name);
      }
      return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, member) };
    }
    seenConstructorNames.add(member.name);

    // Preflight lookup: check if constructor name already exists
    const existingScheme = lookupEnv(ctx, member.name);
    if (existingScheme) {
      // Purge on failure
      ctx.adtEnv.delete(decl.name);
      typeParamsCache.delete(decl.name);
      for (const name of stagedEnvEntries) {
        ctx.env.delete(name);
      }
      return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, member) };
    }

    const info = buildConstructorInfo(ctx, decl.name, parameterTypes, member, typeScope);

    // Shape validation: ensure the scheme returns the ADT constructor
    let currentType = info.scheme.type;
    let isValidFunction = true;
    while (currentType.kind === "func") {
      const expectResult = expectFunctionType(ctx, currentType, `Constructor ${member.name}`);
      if (!expectResult.success) {
        isValidFunction = false;
        break;
      }
      currentType = expectResult.to;
    }
    // After unwrapping all functions, it should be the ADT constructor
    const returnsAdt = currentType.kind === "constructor" && currentType.name === decl.name;
    if (!isValidFunction || !returnsAdt) {
      // Purge on failure
      ctx.adtEnv.delete(decl.name);
      typeParamsCache.delete(decl.name);
      for (const name of stagedEnvEntries) {
        ctx.env.delete(name);
      }
      return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, member) };
    }

    stagedConstructors.push(info);
    stagedEnvEntries.push(member.name);
  }

  // All validations passed, commit changes
  for (const info of stagedConstructors) {
    ctx.env.set(info.name, info.scheme);
  }
  adtInfo.constructors.push(...stagedConstructors);

  return { success: true };
}

function registerTypeAlias(
  ctx: Context,
  decl: TypeDeclaration & { members: [TypeAliasExprMember] },
): RegisterConstructorsResult {
  const adtInfo = ctx.adtEnv.get(decl.name);
  const parameterTypes = typeParamsCache.get(decl.name);
  if (!adtInfo || !parameterTypes) {
    return { success: false, mark: markTypeDeclInvalidMember(ctx, decl, decl.members[0]) };
  }

  const typeScope: TypeScope = new Map();
  decl.typeParams.forEach((param, index) => {
    typeScope.set(param.name, parameterTypes[index]);
  });

  const aliasType = convertTypeExpr(ctx, decl.members[0].type, typeScope, { allowNewVariables: false });
  adtInfo.alias = cloneType(aliasType);
  adtInfo.constructors = [];
  return { success: true };
}

export interface ConvertTypeOptions {
  allowNewVariables: boolean;
}

export function convertTypeExpr(
  ctx: Context,
  typeExpr: TypeExpr,
  scope: TypeScope = new Map(),
  options: ConvertTypeOptions = { allowNewVariables: true },
): Type {
  switch (typeExpr.kind) {
    case "type_var": {
      const existing = scope.get(typeExpr.name);
      if (existing) {
        return existing;
      }
      if (!options.allowNewVariables) {
        const mark = markTypeExprUnknown(ctx, typeExpr, `Unknown type variable '${typeExpr.name}'`);
        ctx.typeExprMarks.set(typeExpr, mark);
        return unknownType({ kind: "error_type_expr_unknown", name: typeExpr.name });
      }
      const fresh = freshTypeVar();
      scope.set(typeExpr.name, fresh);
      return fresh;
    }
    case "type_fn": {
      if (typeExpr.parameters.length === 0) {
        const mark = markTypeExprArity(ctx, typeExpr, 1, 0);
        ctx.typeExprMarks.set(typeExpr, mark);
        return unknownType({ kind: "error_type_expr_arity", expected: 1, actual: 0 });
      }
      const result = convertTypeExpr(ctx, typeExpr.result, scope, options);
      return typeExpr.parameters.reduceRight<Type>((acc, param) => {
        const paramType = convertTypeExpr(ctx, param, scope, options);
        return {
          kind: "func",
          from: paramType,
          to: acc,
        };
      }, result);
    }
    case "type_ref": {
      const scoped = scope.get(typeExpr.name);
      if (scoped && typeExpr.typeArgs.length === 0) {
        return scoped;
      }
      switch (typeExpr.name) {
        case "Int":
          if (typeExpr.typeArgs.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, 0, typeExpr.typeArgs.length);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: 0, actual: typeExpr.typeArgs.length });
          }
          return { kind: "int" };
        case "Bool":
          if (typeExpr.typeArgs.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, 0, typeExpr.typeArgs.length);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: 0, actual: typeExpr.typeArgs.length });
          }
          return { kind: "bool" };
        case "Char":
          if (typeExpr.typeArgs.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, 0, typeExpr.typeArgs.length);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: 0, actual: typeExpr.typeArgs.length });
          }
          return { kind: "char" };
        case "Unit":
          if (typeExpr.typeArgs.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, 0, typeExpr.typeArgs.length);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: 0, actual: typeExpr.typeArgs.length });
          }
          return { kind: "unit" };
        case "String":
          if (typeExpr.typeArgs.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, 0, typeExpr.typeArgs.length);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: 0, actual: typeExpr.typeArgs.length });
          }
          return { kind: "string" };
      }

      const typeInfo = ctx.adtEnv.get(typeExpr.name);

      if (typeInfo?.alias) {
        if (typeInfo.parameters.length !== typeExpr.typeArgs.length) {
          const mark = markTypeExprArity(ctx, typeExpr, typeInfo.parameters.length, typeExpr.typeArgs.length);
          ctx.typeExprMarks.set(typeExpr, mark);
          return unknownType({
            kind: "error_type_expr_arity",
            expected: typeInfo.parameters.length,
            actual: typeExpr.typeArgs.length,
          });
        }
        const aliasArgs = typeExpr.typeArgs.map((arg) => convertTypeExpr(ctx, arg, scope, options));
        if (aliasArgs.length === 0) {
          return cloneType(typeInfo.alias);
        }
        const substitution = new Map<number, Type>();
        typeInfo.parameters.forEach((paramId, index) => {
          substitution.set(paramId, aliasArgs[index]);
        });
        return applySubstitution(cloneType(typeInfo.alias), substitution);
      }

      if (typeExpr.typeArgs.length === 0) {
        if (typeInfo) {
          if (typeInfo.parameters.length > 0) {
            const mark = markTypeExprArity(ctx, typeExpr, typeInfo.parameters.length, 0);
            ctx.typeExprMarks.set(typeExpr, mark);
            return unknownType({ kind: "error_type_expr_arity", expected: typeInfo.parameters.length, actual: 0 });
          }
          return {
            kind: "constructor",
            name: typeExpr.name,
            args: [],
          };
        }
        if (options.allowNewVariables) {
          const fresh = freshTypeVar();
          scope.set(typeExpr.name, fresh);
          return fresh;
        }
        const mark = markTypeExprUnknown(ctx, typeExpr, `Unknown type constructor '${typeExpr.name}'`);
        ctx.typeExprMarks.set(typeExpr, mark);
        return unknownType({ kind: "error_type_expr_unknown", name: typeExpr.name });
      }

      if (!typeInfo) {
        const mark = markTypeExprUnknown(ctx, typeExpr, `Unknown type constructor '${typeExpr.name}'`);
        ctx.typeExprMarks.set(typeExpr, mark);
        return unknownType({ kind: "error_type_expr_unknown", name: typeExpr.name });
      }

      if (typeInfo.parameters.length !== typeExpr.typeArgs.length) {
        const mark = markTypeExprArity(ctx, typeExpr, typeInfo.parameters.length, typeExpr.typeArgs.length);
        ctx.typeExprMarks.set(typeExpr, mark);
        return unknownType({ kind: "error_type_expr_arity", expected: typeInfo.parameters.length, actual: typeExpr.typeArgs.length });
      }

      const args = typeExpr.typeArgs.map((arg) => convertTypeExpr(ctx, arg, scope, options));
      return {
        kind: "constructor",
        name: typeExpr.name,
        args,
      };
    }
    case "type_tuple": {
      return {
        kind: "tuple",
        elements: typeExpr.elements.map((el) => convertTypeExpr(ctx, el, scope, options)),
      };
    }
    case "type_record": {
      const fields = new Map<string, Type>();
      for (const field of typeExpr.fields) {
        const fieldType = convertTypeExpr(ctx, field.type, scope, options);
        if (!fields.has(field.name)) {
          fields.set(field.name, fieldType);
        }
      }
      return { kind: "record", fields };
    }
    case "type_unit":
      return { kind: "unit" };
    case "type_error_row": {
      const cases = new Map<string, Type | null>();
      for (const entry of typeExpr.cases) {
        const payload = entry.payload
          ? convertTypeExpr(ctx, entry.payload, scope, options)
          : null;
        cases.set(entry.name, payload);
      }
      const tail = typeExpr.hasTailWildcard ? freshTypeVar() : undefined;
      return {
        kind: "error_row",
        cases,
        tail,
      };
    }
    default:
      const mark = markTypeExprUnsupported(ctx, typeExpr);
      ctx.typeExprMarks.set(typeExpr, mark);
      return unknownType({ kind: "error_type_expr_unsupported" });
  }
}

export function registerPrelude(ctx: Context): void {
  registerCmpIntPrimitive(ctx, "nativeCmpInt");
  registerCharEqPrimitive(ctx, "nativeCharEq");
  registerIntBinaryPrimitive(ctx, "nativeAdd");
  registerIntBinaryPrimitive(ctx, "nativeSub");
  registerIntBinaryPrimitive(ctx, "nativeMul");
  registerIntBinaryPrimitive(ctx, "nativeDiv");
  registerPrintPrimitive(ctx, "nativePrint");
  registerStrFromLiteralPrimitive(ctx, "nativeStrFromLiteral");
}

function buildConstructorInfo(
  ctx: Context,
  typeName: string,
  parameterTypes: Type[],
  ctor: ConstructorAlias,
  scope: TypeScope,
): ConstructorInfo {
  const ctorResult = makeDataConstructor(typeName, parameterTypes);
  const args = ctor.typeArgs.map((arg) => convertTypeExpr(ctx, arg, scope, { allowNewVariables: false }));
  const ctorType = args.reduceRight<Type>((acc, argType) => ({
    kind: "func",
    from: argType,
    to: acc,
  }), ctorResult);

  const quantifiers = parameterTypes
    .map((type) => (type.kind === "var" ? type.id : null))
    .filter((id): id is number => id !== null);

  const scheme: TypeScheme = {
    quantifiers,
    type: ctorType,
  };

  return {
    name: ctor.name,
    arity: ctor.typeArgs.length,
    scheme,
  };
}

function makeDataConstructor(name: string, parameters: Type[]): Type {
  return {
    kind: "constructor",
    name,
    args: parameters,
  };
}

function registerCmpIntPrimitive(ctx: Context, name: string, aliasOf?: string): void {
  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: {
        kind: "func",
        from: { kind: "int" },
        to: { kind: "constructor", name: "Ordering", args: [] },
      },
    },
  };
  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerCharEqPrimitive(ctx: Context, name: string, aliasOf?: string): void {
  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "char" },
      to: {
        kind: "func",
        from: { kind: "char" },
        to: { kind: "bool" },
      },
    },
  };
  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerIntBinaryPrimitive(ctx: Context, name: string, aliasOf?: string): void {
  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "int" },
      to: {
        kind: "func",
        from: { kind: "int" },
        to: { kind: "int" },
      },
    },
  };
  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerPrintPrimitive(ctx: Context, name: string, aliasOf?: string): void {
  const typeVar = freshTypeVar();
  if (typeVar.kind !== "var") {
    markInternal(ctx, "fresh_type_var_not_var");
    return;
  }

  const scheme: TypeScheme = {
    quantifiers: [typeVar.id],
    type: {
      kind: "func",
      from: typeVar,
      to: { kind: "unit" },
    },
  };

  bindTypeAlias(ctx, name, scheme, aliasOf);
}

function registerStrFromLiteralPrimitive(ctx: Context, name: string): void {
  const listType: Type = {
    kind: "constructor",
    name: "List",
    args: [{ kind: "int" }],
  };

  const scheme: TypeScheme = {
    quantifiers: [],
    type: {
      kind: "func",
      from: { kind: "string" },
      to: listType,
    },
  };

  ctx.env.set(name, scheme);
}

function bindTypeAlias(ctx: Context, name: string, scheme: TypeScheme, aliasOf?: string): void {
  if (aliasOf && ctx.env.has(name)) {
    return;
  }
  const target = aliasOf ? ctx.env.get(aliasOf) : undefined;
  ctx.env.set(name, aliasOf && target ? target : scheme);
}
