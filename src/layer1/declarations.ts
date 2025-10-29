import type { ConstructorAlias, TypeDeclaration, TypeExpr } from "../ast.ts";
import type { Context } from "./context.ts";
import {
  ConstructorInfo,
  Type,
  TypeScheme,
  freshTypeVar,
} from "../types.ts";
import { inferError } from "./context.ts";

type TypeScope = Map<string, Type>;

const typeParamsCache = new Map<string, Type[]>();

export function resetTypeParamsCache(): void {
  typeParamsCache.clear();
}

export function registerTypeName(ctx: Context, decl: TypeDeclaration): void {
  if (ctx.adtEnv.has(decl.name)) {
    throw inferError(`Type '${decl.name}' is already defined`, decl.span, ctx.source);
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
}

export function registerTypeConstructors(ctx: Context, decl: TypeDeclaration): void {
  const adtInfo = ctx.adtEnv.get(decl.name);
  if (!adtInfo) {
    throw inferError(`Internal error: Type '${decl.name}' not pre-registered`);
  }

  const parameterTypes = typeParamsCache.get(decl.name);
  if (!parameterTypes) {
    throw inferError(`Internal error: Type parameters not cached for '${decl.name}'`);
  }

  const typeScope: TypeScope = new Map();
  decl.typeParams.forEach((param, index) => {
    typeScope.set(param.name, parameterTypes[index]);
  });

  const constructors: ConstructorInfo[] = [];
  for (const member of decl.members) {
    if (member.kind !== "constructor") {
      throw inferError(
        `Type '${decl.name}' only supports constructor members in this version (found alias member)`,
        member.span,
        ctx.source,
      );
    }
    const info = buildConstructorInfo(ctx, decl.name, parameterTypes, member, typeScope);
    constructors.push(info);
    ctx.env.set(member.name, info.scheme);
  }

  adtInfo.constructors.push(...constructors);
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
        throw inferError(`Unknown type variable '${typeExpr.name}'`, typeExpr.span, ctx.source);
      }
      const fresh = freshTypeVar();
      scope.set(typeExpr.name, fresh);
      return fresh;
    }
    case "type_fn": {
      if (typeExpr.parameters.length === 0) {
        throw inferError("Function type must include at least one parameter", typeExpr.span, ctx.source);
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
            throw inferError("Type constructor 'Int' does not accept arguments", typeExpr.span, ctx.source);
          }
          return { kind: "int" };
        case "Bool":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Bool' does not accept arguments", typeExpr.span, ctx.source);
          }
          return { kind: "bool" };
        case "Char":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Char' does not accept arguments", typeExpr.span, ctx.source);
          }
          return { kind: "char" };
        case "Unit":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'Unit' does not accept arguments", typeExpr.span, ctx.source);
          }
          return { kind: "unit" };
        case "String":
          if (typeExpr.typeArgs.length > 0) {
            throw inferError("Type constructor 'String' does not accept arguments", typeExpr.span, ctx.source);
          }
          return { kind: "string" };
      }

      const typeInfo = ctx.adtEnv.get(typeExpr.name);

      if (typeExpr.typeArgs.length === 0) {
        if (typeInfo) {
          if (typeInfo.parameters.length > 0) {
            throw inferError(
              `Type constructor '${typeExpr.name}' expects ${typeInfo.parameters.length} type argument(s)`,
              typeExpr.span,
              ctx.source,
            );
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
        throw inferError(`Unknown type constructor '${typeExpr.name}'`, typeExpr.span, ctx.source);
      }

      if (!typeInfo) {
        throw inferError(`Unknown type constructor '${typeExpr.name}'`, typeExpr.span, ctx.source);
      }

      if (typeInfo.parameters.length !== typeExpr.typeArgs.length) {
        throw inferError(
          `Type constructor '${typeExpr.name}' expects ${typeInfo.parameters.length} type argument(s)`,
          typeExpr.span,
          ctx.source,
        );
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
    case "type_unit":
      return { kind: "unit" };
    default:
      throw inferError("Unsupported type expression", (typeExpr as any).span, ctx.source);
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
    throw inferError("Expected fresh type variable");
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
