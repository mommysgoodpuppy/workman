import type { CoreExpr, CoreMatchCase, CoreModule, CoreModuleGraph, CorePattern, CoreTypeConstructor, CoreTypeDeclaration } from "../ir/core.ts";
import type { Type } from "../../../src/types.ts";
import { applySubstitution, cloneType, createEffectRow } from "../../../src/types.ts";

type Instantiation = {
  typeName: string;
  args: Type[];
  declModulePath: string;
  emitModulePath: string;
  newName: string;
  usedIn: Set<string>;
};

const RAW_MONOMORPH_SKIP = new Set<string>([
  "Ptr",
  "ManyPtr",
  "Array",
]);

export function monomorphizeRawAdtsGraph(graph: CoreModuleGraph): CoreModuleGraph {
  const entryModule = graph.modules.get(graph.entry);
  const isRawEntry = entryModule?.mode === "raw";

  const declIndex = new Map<string, { modulePath: string; decl: CoreTypeDeclaration }>();
  for (const [path, module] of graph.modules.entries()) {
    for (const decl of module.typeDeclarations) {
      if (decl.constructors.length > 0 || decl.aliasType) {
        declIndex.set(decl.name, { modulePath: path, decl });
      }
    }
  }

  const instantiations = new Map<string, Instantiation>();
  const usedZeroArg = new Set<string>();
  const importIndex = buildImportIndex(graph.modules);
  const extraImportsForDeclModule = new Map<string, CoreModule["imports"]>();

  for (const [path, module] of graph.modules.entries()) {
    const useRaw = module.mode === "raw" || (isRawEntry && module.core === true);
    if (!useRaw) continue;
    for (const binding of module.values) {
      collectTypesInExpr(binding.value, path, declIndex, instantiations, usedZeroArg, importIndex);
    }
    for (const decl of module.typeDeclarations) {
      for (const ctor of decl.constructors) {
        if (ctor.fields) {
          for (const field of ctor.fields) {
            collectTypesInType(field, path, declIndex, instantiations, usedZeroArg, importIndex);
          }
        }
      }
      if (decl.aliasType) {
        collectTypesInType(decl.aliasType, path, declIndex, instantiations, usedZeroArg, importIndex);
      }
    }
  }

  if (instantiations.size === 0) {
    return graph;
  }

  for (const inst of instantiations.values()) {
    const requiredNames = new Set<string>();
    inst.args.forEach((arg) => collectTypeNames(arg, requiredNames));
    if (inst.emitModulePath === inst.declModulePath) {
      for (const usedInPath of inst.usedIn) {
        const byName = importIndex.get(usedInPath);
        if (!byName) continue;
        for (const name of requiredNames) {
          const imp = byName.get(name);
          if (!imp) continue;
          addImportForDecl(extraImportsForDeclModule, inst.declModulePath, imp.source, name);
        }
      }
    }
  }

  const modules = new Map<string, CoreModule>();
  for (const [path, module] of graph.modules.entries()) {
    const useRaw = module.mode === "raw" || (isRawEntry && module.core === true);
    if (!useRaw) {
      modules.set(path, module);
      continue;
    }

    const rewrittenValues = module.values.map((binding) => ({
      ...binding,
      value: rewriteExpr(binding.value, instantiations, path),
    }));

    const rewrittenTypes = module.typeDeclarations.flatMap((decl) => {
      if (decl.constructors.length === 0 && !decl.aliasType) {
        return [decl];
      }
      const instForDecl = Array.from(instantiations.values()).filter((inst) =>
        inst.typeName === decl.name && inst.emitModulePath === path
      );
      const hasZeroArgUse = usedZeroArg.has(decl.name);
      const shouldEmitGeneric = decl.typeParams && decl.typeParams.length > 0 && !hasZeroArgUse;
      const baseDecls = shouldEmitGeneric ? [] : [decl];

      const monoDecls = instForDecl.map((inst) =>
        createMonomorphDecl(decl, inst, instantiations, path)
      );
      return [...baseDecls, ...monoDecls];
    });

    const extraMonomorphs: CoreTypeDeclaration[] = [];
    const existingNames = new Set(rewrittenTypes.map((decl) => decl.name));
    for (const inst of instantiations.values()) {
      if (inst.emitModulePath !== path) continue;
      if (existingNames.has(inst.newName)) continue;
      const declInfo = declIndex.get(inst.typeName);
      if (!declInfo) continue;
      if (declInfo.modulePath === path) continue;
      extraMonomorphs.push(
        createMonomorphDecl(declInfo.decl, inst, instantiations, path),
      );
    }

    const rewrittenExports = module.exports.filter((exp) => {
      if (exp.kind === "type") {
        const decl = declIndex.get(exp.typeName)?.decl;
        if (decl?.typeParams && decl.typeParams.length > 0 && !usedZeroArg.has(exp.typeName)) {
          return false;
        }
      }
      return true;
    });

    const extraImports = buildMonomorphImports(
      module,
      path,
      instantiations,
    );

    const declImports = extraImportsForDeclModule.get(path);
    const mergedImports = declImports ? mergeImports(module.imports, declImports) : module.imports;

    modules.set(path, {
      ...module,
      values: rewrittenValues,
      typeDeclarations: [...rewrittenTypes, ...extraMonomorphs],
      exports: rewrittenExports,
      imports: [...mergedImports, ...extraImports],
    });
  }

  return { ...graph, modules };
}

function collectTypesInExpr(
  expr: CoreExpr,
  modulePath: string,
  declIndex: Map<string, { modulePath: string; decl: CoreTypeDeclaration }>,
  instantiations: Map<string, Instantiation>,
  usedZeroArg: Set<string>,
  importIndex: Map<string, Map<string, CoreModule["imports"][number]>>,
): void {
  collectTypesInType(expr.type, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
  switch (expr.kind) {
    case "literal":
    case "var":
    case "enum_literal":
      return;
    case "tuple":
      expr.elements.forEach((el) =>
        collectTypesInExpr(el, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "record":
      expr.fields.forEach((field) =>
        collectTypesInExpr(field.value, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "tuple_get":
      collectTypesInExpr(expr.target, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "data":
      expr.fields.forEach((field) =>
        collectTypesInExpr(field, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "lambda":
      collectTypesInExpr(expr.body, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "call":
      collectTypesInExpr(expr.callee, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      expr.args.forEach((arg) =>
        collectTypesInExpr(arg, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "let":
      collectTypesInExpr(expr.binding.value, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      collectTypesInExpr(expr.body, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "let_rec":
      expr.bindings.forEach((binding) =>
        collectTypesInExpr(binding.value, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      collectTypesInExpr(expr.body, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "if":
      collectTypesInExpr(expr.condition, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      collectTypesInExpr(expr.thenBranch, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      collectTypesInExpr(expr.elseBranch, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "prim":
      expr.args.forEach((arg) =>
        collectTypesInExpr(arg, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "match":
      collectTypesInExpr(expr.scrutinee, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      expr.cases.forEach((kase) => collectTypesInCase(kase, modulePath, declIndex, instantiations, usedZeroArg, importIndex));
      if (expr.fallback) {
        collectTypesInExpr(expr.fallback, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      }
      return;
    case "carrier_unwrap":
    case "carrier_wrap":
      collectTypesInExpr(expr.target, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "carrier_match":
      collectTypesInExpr(expr.scrutinee, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      expr.cases.forEach((kase) => collectTypesInCase(kase, modulePath, declIndex, instantiations, usedZeroArg, importIndex));
      if (expr.fallback) {
        collectTypesInExpr(expr.fallback, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      }
      return;
    case "coerce":
      collectTypesInExpr(expr.expr, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
  }
}

function collectTypesInCase(
  kase: CoreMatchCase,
  modulePath: string,
  declIndex: Map<string, { modulePath: string; decl: CoreTypeDeclaration }>,
  instantiations: Map<string, Instantiation>,
  usedZeroArg: Set<string>,
  importIndex: Map<string, Map<string, CoreModule["imports"][number]>>,
): void {
  collectTypesInPattern(kase.pattern, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
  collectTypesInExpr(kase.body, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
  if (kase.guard) {
    collectTypesInExpr(kase.guard, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
  }
}

function collectTypesInPattern(
  pattern: CorePattern,
  modulePath: string,
  declIndex: Map<string, { modulePath: string; decl: CoreTypeDeclaration }>,
  instantiations: Map<string, Instantiation>,
  usedZeroArg: Set<string>,
  importIndex: Map<string, Map<string, CoreModule["imports"][number]>>,
): void {
  collectTypesInType(pattern.type, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
  switch (pattern.kind) {
    case "tuple":
      pattern.elements.forEach((el) =>
        collectTypesInPattern(el, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "constructor":
      pattern.fields.forEach((field) =>
        collectTypesInPattern(field, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "binding":
    case "wildcard":
    case "literal":
    case "pinned":
    case "all_errors":
      return;
  }
}

function collectTypesInType(
  type: Type,
  modulePath: string,
  declIndex: Map<string, { modulePath: string; decl: CoreTypeDeclaration }>,
  instantiations: Map<string, Instantiation>,
  usedZeroArg: Set<string>,
  importIndex: Map<string, Map<string, CoreModule["imports"][number]>>,
): void {
  switch (type.kind) {
    case "constructor": {
      const decl = declIndex.get(type.name);
      if (decl) {
        if (RAW_MONOMORPH_SKIP.has(type.name)) {
          type.args.forEach((arg) =>
            collectTypesInType(arg, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
          );
          return;
        }
        if (type.args.length === 0) {
          usedZeroArg.add(type.name);
        } else {
          const shouldLocalize = shouldLocalizeInstantiation(
            type,
            decl.modulePath,
            modulePath,
            importIndex,
            declIndex,
          );
          const emitModulePath = shouldLocalize ? modulePath : decl.modulePath;
          const key = shouldLocalize ? instKeyWithModule(type, modulePath) : instKey(type);
          if (!instantiations.has(key)) {
            instantiations.set(key, {
              typeName: type.name,
              args: type.args,
              declModulePath: decl.modulePath,
              emitModulePath,
              newName: `${type.name}__${mangleTypeArgs(type.args)}`,
              usedIn: new Set([modulePath]),
            });
          } else {
            instantiations.get(key)!.usedIn.add(modulePath);
          }
        }
      }
      type.args.forEach((arg) =>
        collectTypesInType(arg, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    }
    case "func":
      collectTypesInType(type.from, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      collectTypesInType(type.to, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "tuple":
      type.elements.forEach((el) =>
        collectTypesInType(el, modulePath, declIndex, instantiations, usedZeroArg, importIndex)
      );
      return;
    case "array":
      collectTypesInType(type.element, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      return;
    case "record":
      for (const field of type.fields.values()) {
        collectTypesInType(field, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      }
      return;
    case "effect_row":
      for (const payload of type.cases.values()) {
        if (payload) {
          collectTypesInType(payload, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
        }
      }
      if (type.tail) {
        collectTypesInType(type.tail, modulePath, declIndex, instantiations, usedZeroArg, importIndex);
      }
      return;
    case "var":
    case "int":
    case "bool":
    case "char":
    case "string":
    case "unit":
      return;
  }
}

function rewriteExpr(
  expr: CoreExpr,
  instantiations: Map<string, Instantiation>,
  modulePath: string,
): CoreExpr {
  const updatedType = rewriteType(expr.type, instantiations, modulePath);
  switch (expr.kind) {
    case "literal":
    case "var":
    case "enum_literal":
      return { ...expr, type: updatedType };
    case "tuple":
      return { ...expr, type: updatedType, elements: expr.elements.map((el) => rewriteExpr(el, instantiations, modulePath)) };
    case "record":
      return {
        ...expr,
        type: updatedType,
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewriteExpr(field.value, instantiations, modulePath),
        })),
      };
    case "tuple_get":
      return { ...expr, type: updatedType, target: rewriteExpr(expr.target, instantiations, modulePath) };
    case "data": {
      const rewritten = rewriteType(expr.type, instantiations, modulePath);
      const moduleKey = instKeyWithModule(expr.type, modulePath);
      const inst = instantiations.get(moduleKey) ?? instantiations.get(instKey(expr.type));
      return {
        ...expr,
        type: rewritten,
        typeName: inst ? inst.newName : expr.typeName,
        fields: expr.fields.map((field) => rewriteExpr(field, instantiations, modulePath)),
      };
    }
    case "lambda":
      return { ...expr, type: updatedType, body: rewriteExpr(expr.body, instantiations, modulePath) };
    case "call":
      return {
        ...expr,
        type: updatedType,
        callee: rewriteExpr(expr.callee, instantiations, modulePath),
        args: expr.args.map((arg) => rewriteExpr(arg, instantiations, modulePath)),
      };
    case "let":
      return {
        ...expr,
        type: updatedType,
        binding: { ...expr.binding, value: rewriteExpr(expr.binding.value, instantiations, modulePath) },
        body: rewriteExpr(expr.body, instantiations, modulePath),
      };
    case "let_rec":
      return {
        ...expr,
        type: updatedType,
        bindings: expr.bindings.map((binding) => ({
          ...binding,
          value: rewriteExpr(binding.value, instantiations, modulePath) as CoreExpr & { kind: "lambda" },
        })),
        body: rewriteExpr(expr.body, instantiations, modulePath),
      };
    case "if":
      return {
        ...expr,
        type: updatedType,
        condition: rewriteExpr(expr.condition, instantiations, modulePath),
        thenBranch: rewriteExpr(expr.thenBranch, instantiations, modulePath),
        elseBranch: rewriteExpr(expr.elseBranch, instantiations, modulePath),
      };
    case "prim":
      return {
        ...expr,
        type: updatedType,
        args: expr.args.map((arg) => rewriteExpr(arg, instantiations, modulePath)),
      };
    case "match":
      return {
        ...expr,
        type: updatedType,
        scrutinee: rewriteExpr(expr.scrutinee, instantiations, modulePath),
        cases: expr.cases.map((kase) => rewriteCase(kase, instantiations, modulePath)),
        fallback: expr.fallback ? rewriteExpr(expr.fallback, instantiations, modulePath) : undefined,
      };
    case "carrier_unwrap":
    case "carrier_wrap":
      return {
        ...expr,
        type: updatedType,
        target: rewriteExpr(expr.target, instantiations, modulePath),
      };
    case "carrier_match":
      return {
        ...expr,
        type: updatedType,
        scrutinee: rewriteExpr(expr.scrutinee, instantiations, modulePath),
        cases: expr.cases.map((kase) => rewriteCase(kase, instantiations, modulePath)),
        fallback: expr.fallback ? rewriteExpr(expr.fallback, instantiations, modulePath) : undefined,
      };
    case "coerce":
      return {
        ...expr,
        type: updatedType,
        fromType: rewriteType(expr.fromType, instantiations, modulePath),
        toType: rewriteType(expr.toType, instantiations, modulePath),
        expr: rewriteExpr(expr.expr, instantiations, modulePath),
      };
  }
}

function rewriteCase(
  kase: CoreMatchCase,
  instantiations: Map<string, Instantiation>,
  modulePath: string,
): CoreMatchCase {
  return {
    ...kase,
    pattern: rewritePattern(kase.pattern, instantiations, modulePath),
    body: rewriteExpr(kase.body, instantiations, modulePath),
    guard: kase.guard ? rewriteExpr(kase.guard, instantiations, modulePath) : undefined,
  };
}

function rewritePattern(
  pattern: CorePattern,
  instantiations: Map<string, Instantiation>,
  modulePath: string,
): CorePattern {
  const updatedType = rewriteType(pattern.type, instantiations, modulePath);
  switch (pattern.kind) {
    case "wildcard":
    case "binding":
    case "literal":
    case "pinned":
    case "all_errors":
      return { ...pattern, type: updatedType };
    case "tuple":
      return {
        ...pattern,
        type: updatedType,
        elements: pattern.elements.map((el) => rewritePattern(el, instantiations, modulePath)),
      };
    case "constructor": {
      const moduleKey = instKeyWithModule(pattern.type, modulePath);
      const inst = instantiations.get(moduleKey) ?? instantiations.get(instKey(pattern.type));
      return {
        ...pattern,
        type: updatedType,
        typeName: inst ? inst.newName : pattern.typeName,
        fields: pattern.fields.map((field) => rewritePattern(field, instantiations, modulePath)),
      };
    }
  }
}

function rewriteType(
  type: Type,
  instantiations: Map<string, Instantiation>,
  modulePath?: string,
): Type {
  const key = instKey(type);
  const moduleKey = modulePath ? instKeyWithModule(type, modulePath) : null;
  switch (type.kind) {
    case "constructor": {
      const rewrittenArgs = type.args.map((arg) => rewriteType(arg, instantiations, modulePath));
      const inst = (moduleKey ? instantiations.get(moduleKey) : undefined) ??
        instantiations.get(key);
      if (inst) {
        if (modulePath) {
          inst.usedIn.add(modulePath);
        }
        return { kind: "constructor", name: inst.newName, args: [] };
      }
      return { kind: "constructor", name: type.name, args: rewrittenArgs };
    }
    case "func":
      return {
        kind: "func",
        from: rewriteType(type.from, instantiations, modulePath),
        to: rewriteType(type.to, instantiations, modulePath),
      };
    case "tuple":
      return { kind: "tuple", elements: type.elements.map((el) => rewriteType(el, instantiations, modulePath)) };
    case "array":
      return { kind: "array", length: type.length, element: rewriteType(type.element, instantiations, modulePath) };
    case "record": {
      const fields = new Map<string, Type>();
      for (const [name, fieldType] of type.fields.entries()) {
        fields.set(name, rewriteType(fieldType, instantiations, modulePath));
      }
      return { kind: "record", fields };
    }
    case "effect_row": {
      const cases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        cases.set(label, payload ? rewriteType(payload, instantiations, modulePath) : null);
      }
      return {
        kind: "effect_row",
        cases,
        tail: type.tail ? rewriteType(type.tail, instantiations, modulePath) : undefined,
      };
    }
    case "var":
    case "int":
    case "bool":
    case "char":
    case "string":
    case "unit":
      return type;
  }
}

function collectTypeNames(type: Type, names: Set<string>): void {
  switch (type.kind) {
    case "constructor":
      names.add(type.name);
      type.args.forEach((arg) => collectTypeNames(arg, names));
      return;
    case "func":
      collectTypeNames(type.from, names);
      collectTypeNames(type.to, names);
      return;
    case "tuple":
      type.elements.forEach((el) => collectTypeNames(el, names));
      return;
    case "array":
      collectTypeNames(type.element, names);
      return;
    case "record":
      for (const field of type.fields.values()) {
        collectTypeNames(field, names);
      }
      return;
    case "effect_row":
      for (const payload of type.cases.values()) {
        if (payload) {
          collectTypeNames(payload, names);
        }
      }
      if (type.tail) {
        collectTypeNames(type.tail, names);
      }
      return;
    case "var":
    case "int":
    case "bool":
    case "char":
    case "string":
    case "unit":
      return;
  }
}

function buildImportIndex(
  modules: ReadonlyMap<string, CoreModule>,
): Map<string, Map<string, CoreModule["imports"][number]>> {
  const index = new Map<string, Map<string, CoreModule["imports"][number]>>();
  for (const [path, module] of modules.entries()) {
    const byName = new Map<string, CoreModule["imports"][number]>();
    for (const imp of module.imports) {
      for (const spec of imp.specifiers) {
        byName.set(spec.local, imp);
      }
    }
    index.set(path, byName);
  }
  return index;
}

function addImportForDecl(
  target: Map<string, CoreModule["imports"]>,
  declModulePath: string,
  sourcePath: string,
  localName: string,
): void {
  const existing = target.get(declModulePath) ?? [];
  const next = mergeImports(existing, [{
    source: sourcePath,
    specifiers: [{
      kind: "value",
      imported: localName,
      local: localName,
    }],
  }]);
  target.set(declModulePath, next);
}

function mergeImports(
  base: CoreModule["imports"],
  extra: CoreModule["imports"],
): CoreModule["imports"] {
  const merged = new Map<string, CoreModule["imports"][number]>();
  for (const imp of base) {
    merged.set(imp.source, imp);
  }
  for (const imp of extra) {
    const existing = merged.get(imp.source);
    if (!existing) {
      merged.set(imp.source, imp);
      continue;
    }
    const names = new Set(existing.specifiers.map((s) => s.local));
    const newSpecs = imp.specifiers.filter((s) => !names.has(s.local));
    if (newSpecs.length === 0) continue;
    merged.set(imp.source, {
      source: existing.source,
      specifiers: [...existing.specifiers, ...newSpecs],
    });
  }
  return Array.from(merged.values());
}

function createMonomorphDecl(
  base: CoreTypeDeclaration,
  inst: Instantiation,
  instantiations: Map<string, Instantiation>,
  modulePath: string,
): CoreTypeDeclaration {
  if (!base.typeParams || base.typeParams.length !== inst.args.length) {
    return {
      ...base,
      name: inst.newName,
      monomorphized: true,
    };
  }
  const subst = new Map<number, Type>();
  for (let i = 0; i < base.typeParams.length; i += 1) {
    subst.set(base.typeParams[i], inst.args[i]);
  }
  const aliasType = base.aliasType
    ? rewriteSelfRecursion(
      rewriteType(
        applySubstitution(cloneType(base.aliasType), subst),
        instantiations,
        modulePath,
      ),
      inst.newName,
    )
    : undefined;
  const constructors: CoreTypeConstructor[] = base.constructors.map((ctor) => {
    const fields = ctor.fields
      ? ctor.fields.map((field) =>
        rewriteSelfRecursion(
          rewriteType(
            applySubstitution(cloneType(field), subst),
            instantiations,
            modulePath,
          ),
          inst.newName,
        )
      )
      : undefined;
    return {
      ...ctor,
      fields,
    };
  });
  return {
    ...base,
    name: inst.newName,
    constructors,
    typeParams: [],
    exported: true,
    monomorphized: true,
    aliasType,
  };
}

function rewriteSelfRecursion(type: Type, selfName: string, underPointer = false): Type {
  if (underPointer) return type;
  switch (type.kind) {
    case "constructor": {
      if (type.name === selfName) {
        return {
          kind: "constructor",
          name: "Ptr",
          args: [type, createEffectRow()],
        };
      }
      if (type.name === "Ptr" || type.name === "ManyPtr") {
        return type;
      }
      if (type.args.length === 0) return type;
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map((arg) => rewriteSelfRecursion(arg, selfName)),
      };
    }
    case "func":
      return type;
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((el) => rewriteSelfRecursion(el, selfName)),
      };
    case "array":
      return {
        kind: "array",
        length: type.length,
        element: rewriteSelfRecursion(type.element, selfName),
      };
    case "record": {
      const fields = new Map<string, Type>();
      for (const [name, fieldType] of type.fields.entries()) {
        fields.set(name, rewriteSelfRecursion(fieldType, selfName));
      }
      return { kind: "record", fields };
    }
    case "effect_row": {
      const cases = new Map<string, Type | null>();
      for (const [label, payload] of type.cases.entries()) {
        cases.set(label, payload ? rewriteSelfRecursion(payload, selfName) : null);
      }
      return {
        kind: "effect_row",
        cases,
        tail: type.tail ? rewriteSelfRecursion(type.tail, selfName) : undefined,
      };
    }
    case "var":
    case "int":
    case "bool":
    case "char":
    case "string":
    case "unit":
      return type;
  }
}

function shouldLocalizeInstantiation(
  type: Type,
  declModulePath: string,
  modulePath: string,
  importIndex: Map<string, Map<string, CoreModule["imports"][number]>>,
  declIndex: Map<string, { modulePath: string; decl: CoreTypeDeclaration }>,
): boolean {
  if (declModulePath === modulePath) return false;
  const byName = importIndex.get(modulePath);
  const argNames = new Set<string>();
  type.args.forEach((arg) => collectTypeNames(arg, argNames));
  for (const name of argNames) {
    if (!declIndex.has(name)) {
      return true;
    }
  }
  if (!byName || byName.size === 0) return false;
  const declByName = importIndex.get(declModulePath);
  for (const name of argNames) {
    if (byName.has(name) && !declByName?.has(name)) {
      return true;
    }
  }
  return false;
}

function instKey(type: Type): string {
  if (type.kind !== "constructor") return typeKey(type);
  const argsKey = type.args.map(typeKey).join(",");
  return `${type.name}<${argsKey}>`;
}

function instKeyWithModule(type: Type, modulePath: string): string {
  return `${modulePath}::${instKey(type)}`;
}

function typeKey(type: Type): string {
  switch (type.kind) {
    case "var":
      return `T${type.id}`;
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "string":
      return "String";
    case "unit":
      return "Unit";
    case "func":
      return `Fn(${typeKey(type.from)}->${typeKey(type.to)})`;
    case "constructor":
      return `${type.name}(${type.args.map(typeKey).join(",")})`;
    case "tuple":
      return `Tuple(${type.elements.map(typeKey).join(",")})`;
    case "array":
      return `Arr${type.length}(${typeKey(type.element)})`;
    case "record": {
      const fields = Array.from(type.fields.entries())
        .map(([name, field]) => `${name}:${typeKey(field)}`)
        .join(",");
      return `Rec(${fields})`;
    }
    case "effect_row": {
      const cases = Array.from(type.cases.entries())
        .map(([label, payload]) =>
          payload ? `${label}:${typeKey(payload)}` : label
        )
        .join(",");
      const tail = type.tail ? `|${typeKey(type.tail)}` : "";
      return `Row(${cases}${tail})`;
    }
  }
}

function mangleTypeArgs(args: Type[]): string {
  const raw = args.map(typeKey).join("_");
  return raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
}

function buildMonomorphImports(
  module: CoreModule,
  modulePath: string,
  instantiations: Map<string, Instantiation>,
): CoreModule["imports"] {
  const imports: CoreModule["imports"] = [];
  const existingBySource = new Map<string, Set<string>>();
  for (const imp of module.imports) {
    const set = new Set<string>();
    for (const spec of imp.specifiers) {
      set.add(spec.local);
    }
    existingBySource.set(imp.source, set);
  }

  for (const inst of instantiations.values()) {
    if (inst.emitModulePath === modulePath) continue;
    if (!inst.usedIn.has(modulePath)) continue;
    const source = inst.emitModulePath;
    const existing = existingBySource.get(source) ?? new Set<string>();
    if (existing.has(inst.newName)) continue;
    existing.add(inst.newName);
    existingBySource.set(source, existing);
    imports.push({
      source,
      specifiers: [{
        kind: "value",
        imported: inst.newName,
        local: inst.newName,
      }],
    });
  }

  return imports;
}
