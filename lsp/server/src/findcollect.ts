import { WorkmanModuleArtifacts } from "../../../backends/compiler/frontends/workman.ts";
import { TypeDeclaration, ConstructorAlias } from "../../../src/ast.ts";
import { MProgram, MLetDeclaration, MExpr, MMatchBundle, MBlockExpr, MTopLevel } from "../../../src/ast_marked.ts";
import { Layer3Result } from "../../../src/layer3/mod.ts";
import { pathToUri } from "./fsio.ts";

export function findTopLevelLet(
  program: MProgram,
  name: string,
): MLetDeclaration | undefined {
  for (const decl of program.declarations ?? []) {
    if (decl.kind !== "let") continue;
    if (decl.name === name) {
      return decl;
    }
    if (decl.mutualBindings) {
      for (const binding of decl.mutualBindings) {
        if (binding.name === name) {
          return binding;
        }
      }
    }
  }
  return undefined;
}

export function findTypeDeclaration(
  program: MProgram,
  name: string,
): TypeDeclaration | undefined {
  for (const decl of program.declarations ?? []) {
    if (decl.kind === "type" && decl.node.name === name) {
      return decl.node;
    }
  }
  return undefined;
}

export function findConstructorDeclaration(
  program: MProgram,
  name: string,
): { declaration: TypeDeclaration; member: ConstructorAlias } | undefined {
  for (const decl of program.declarations ?? []) {
    if (decl.kind !== "type") continue;
    for (const member of decl.node.members) {
      if (member.kind === "constructor" && member.name === name) {
        return { declaration: decl.node, member };
      }
    }
  }
  return undefined;
}

export function findModuleDefinitionLocations(
  modulePath: string,
  name: string,
  modules: ReadonlyMap<string, WorkmanModuleArtifacts>,
): Array<{
  uri: string;
  span: { start: number; end: number };
  sourceText: string;
}> {
  const artifact = modules.get(modulePath);
  if (!artifact) {
    return [];
  }
  return collectDefinitionLocationsFromArtifact(
    artifact,
    modulePath,
    name,
  );
}

export function findGlobalDefinitionLocations(
  name: string,
  modules: ReadonlyMap<string, WorkmanModuleArtifacts>,
): Array<{
  uri: string;
  span: { start: number; end: number };
  sourceText: string;
}> {
  const results: Array<{
    uri: string;
    span: { start: number; end: number };
    sourceText: string;
  }> = [];
  for (const [modulePath, artifact] of modules.entries()) {
    results.push(
      ...collectDefinitionLocationsFromArtifact(
        artifact,
        modulePath,
        name,
      ),
    );
  }
  return results;
}

export function collectDefinitionLocationsFromArtifact(
  artifact: WorkmanModuleArtifacts,
  modulePath: string,
  name: string,
): Array<{
  uri: string;
  span: { start: number; end: number };
  sourceText: string;
}> {
  const results: Array<{
    uri: string;
    span: { start: number; end: number };
    sourceText: string;
  }> = [];
  const program = artifact.analysis.layer1.markedProgram;
  const layer3 = artifact.analysis.layer3;
  const sourceText = artifact.node.source;
  const uri = pathToUri(modulePath);
  const pushSpan = (span: { start: number; end: number }) => {
    results.push({
      uri,
      span,
      sourceText,
    });
  };

  const letDecl = findTopLevelLet(program, name);
  if (letDecl) {
    const span = layer3.spanIndex.get(letDecl.id);
    if (span) {
      pushSpan(span);
    }
  }

  const typeDecl = findTypeDeclaration(program, name);
  if (typeDecl) {
    pushSpan(typeDecl.span);
  }

  const ctorDecl = findConstructorDeclaration(program, name);
  if (ctorDecl) {
    pushSpan(ctorDecl.member.span);
  }

  return results;
}

export function collectIdentifierReferences(
  program: MProgram,
  name: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const visitedDecls = new Set<number>();

  const visitExpr = (expr?: MExpr): void => {
    if (!expr) return;
    switch (expr.kind) {
      case "identifier":
        if (expr.name === name) {
          spans.push(expr.span);
        }
        break;
      case "constructor":
        for (const arg of expr.args) visitExpr(arg);
        break;
      case "tuple":
        for (const element of expr.elements) visitExpr(element);
        break;
      case "record_literal":
        for (const field of expr.fields) visitExpr(field.value);
        break;
      case "call":
        visitExpr(expr.callee);
        for (const arg of expr.arguments) visitExpr(arg);
        break;
      case "record_projection":
        visitExpr(expr.target);
        break;
      case "binary":
        visitExpr(expr.left);
        visitExpr(expr.right);
        break;
      case "unary":
        visitExpr(expr.operand);
        break;
      case "arrow":
        visitBlock(expr.body);
        break;
      case "block":
        visitBlock(expr);
        break;
      case "match":
        visitExpr(expr.scrutinee);
        visitMatchBundle(expr.bundle);
        break;
      case "match_fn":
        for (const param of expr.parameters) {
          visitExpr(param);
        }
        visitMatchBundle(expr.bundle);
        break;
      case "match_bundle_literal":
        visitMatchBundle(expr.bundle);
        break;
      case "mark_free_var":
        if (expr.name === name) {
          spans.push(expr.span);
        }
        break;
      case "mark_not_function":
        visitExpr(expr.callee);
        for (const arg of expr.args) visitExpr(arg);
        break;
      case "mark_occurs_check":
        visitExpr(expr.subject);
        break;
      case "mark_inconsistent":
      case "mark_unfillable_hole":
        visitExpr(expr.subject);
        break;
      default:
        break;
    }
  };

  const visitMatchBundle = (bundle: MMatchBundle): void => {
    for (const arm of bundle.arms) {
      if (arm.kind === "match_pattern") {
        visitExpr(arm.body);
      }
    }
  };

  const visitBlock = (block?: MBlockExpr): void => {
    if (!block) return;
    for (const stmt of block.statements) {
      if (stmt.kind === "let_statement") {
        visitLet(stmt.declaration);
      } else if (stmt.kind === "expr_statement") {
        visitExpr(stmt.expression);
      }
    }
    if (block.result) {
      visitExpr(block.result);
    }
  };

  const visitLet = (decl: MLetDeclaration): void => {
    if (visitedDecls.has(decl.id)) {
      return;
    }
    visitedDecls.add(decl.id);
    visitBlock(decl.body);
    if (decl.mutualBindings) {
      for (const binding of decl.mutualBindings) {
        visitLet(binding);
      }
    }
  };

  for (const decl of program.declarations ?? []) {
    if (decl.kind === "let") {
      visitLet(decl);
    }
  }

  return spans;
}

export function findLetDeclaration(
  program: MProgram,
  layer3: Layer3Result,
  name: string,
  offset: number,
): MLetDeclaration | undefined {
  const findInTopLevels = (
    decls: MTopLevel[],
  ): MLetDeclaration | undefined => {
    for (const decl of decls) {
      if (decl.kind === "let") {
        const span = layer3.spanIndex.get(decl.id);
        if (span && span.start <= offset && offset < span.end) {
          if (decl.name === name) return decl;
          if (decl.mutualBindings) {
            for (const b of decl.mutualBindings) {
              if (b.name === name) return b;
            }
          }
          // recurse into body
          const found = findInBlock(decl.body);
          if (found) return found;
        }
      }
    }
    return undefined;
  };

  const findInBlock = (block: MBlockExpr): MLetDeclaration | undefined => {
    for (const stmt of block.statements) {
      if (stmt.kind === "let_statement") {
        const decl = stmt.declaration;
        const span = layer3.spanIndex.get(decl.id);
        if (span && span.start <= offset && offset < span.end) {
          if (decl.name === name) return decl;
          if (decl.mutualBindings) {
            for (const b of decl.mutualBindings) {
              if (b.name === name) return b;
            }
          }
          const found = findInBlock(decl.body);
          if (found) return found;
        }
      } else if (stmt.kind === "expr_statement") {
        const found = findInExpr(stmt.expression);
        if (found) return found;
      }
    }
    if (block.result) {
      const found = findInExpr(block.result);
      if (found) return found;
    }
    return undefined;
  };

  const findInExpr = (expr: MExpr): MLetDeclaration | undefined => {
    switch (expr.kind) {
      case "block":
        return findInBlock(expr);
      case "call": {
        let found = findInExpr(expr.callee);
        if (found) return found;
        for (const arg of expr.arguments) {
          found = findInExpr(arg);
          if (found) return found;
        }
        break;
      }
      case "match": {
        let found = findInExpr(expr.scrutinee);
        if (found) return found;
        for (const arm of expr.bundle.arms) {
          if (arm.kind === "match_pattern") {
            found = findInExpr(arm.body);
            if (found) return found;
          }
        }
        break;
      }
      case "tuple":
        for (const el of expr.elements) {
          const found = findInExpr(el);
          if (found) return found;
        }
        break;
      case "record_literal":
        for (const field of expr.fields) {
          const found = findInExpr(field.value);
          if (found) return found;
        }
        break;
      case "record_projection":
        return findInExpr(expr.target);
      case "constructor":
        for (const arg of expr.args) {
          const found = findInExpr(arg);
          if (found) return found;
        }
        break;
      // add more cases as needed
      default:
        break;
    }
    return undefined;
  };

  return findInTopLevels(program.declarations ?? []);
}

export function findNearestLetBeforeOffset(
  program: MProgram,
  layer3: Layer3Result,
  name: string,
  offset: number,
): MLetDeclaration | undefined {
  let best:
    | { decl: MLetDeclaration; spanStart: number }
    | undefined;

  const considerDecl = (decl: MLetDeclaration | undefined) => {
    if (!decl || decl.name !== name) {
      return;
    }
    const span = layer3.spanIndex.get(decl.id);
    if (!span || span.start > offset) {
      return;
    }
    if (!best || span.start >= best.spanStart) {
      best = { decl, spanStart: span.start };
    }
  };

  const visitTopLevels = (decls: MTopLevel[]) => {
    for (const decl of decls) {
      if (decl.kind === "let") {
        considerDecl(decl);
        if (decl.mutualBindings) {
          for (const binding of decl.mutualBindings) {
            considerDecl(binding);
            visitBlock(binding.body);
          }
        }
        visitBlock(decl.body);
      }
    }
  };

  const visitBlock = (block?: MBlockExpr) => {
    if (!block) return;
    for (const stmt of block.statements) {
      if (stmt.kind === "let_statement") {
        const decl = stmt.declaration;
        considerDecl(decl);
        if (decl.mutualBindings) {
          for (const binding of decl.mutualBindings) {
            considerDecl(binding);
            visitBlock(binding.body);
          }
        }
        visitBlock(decl.body);
      } else if (stmt.kind === "expr_statement") {
        visitExpr(stmt.expression);
      }
    }
    if (block.result) {
      visitExpr(block.result);
    }
  };

  const visitExpr = (expr: MExpr) => {
    switch (expr.kind) {
      case "block":
        visitBlock(expr);
        break;
      case "arrow":
        visitBlock(expr.body);
        break;
      case "call":
        visitExpr(expr.callee);
        for (const arg of expr.arguments) {
          visitExpr(arg);
        }
        break;
      case "constructor":
        for (const arg of expr.args) {
          visitExpr(arg);
        }
        break;
      case "tuple":
        for (const element of expr.elements) {
          visitExpr(element);
        }
        break;
      case "record_literal":
        for (const field of expr.fields) {
          visitExpr(field.value);
        }
        break;
      case "record_projection":
        visitExpr(expr.target);
        break;
      case "binary":
        visitExpr(expr.left);
        visitExpr(expr.right);
        break;
      case "unary":
        visitExpr(expr.operand);
        break;
      case "match":
        visitExpr(expr.scrutinee);
        visitMatchBundle(expr.bundle);
        break;
      case "match_fn":
        for (const param of expr.parameters) {
          visitExpr(param);
        }
        visitMatchBundle(expr.bundle);
        break;
      case "match_bundle_literal":
        visitMatchBundle(expr.bundle);
        break;
      default:
        break;
    }
  };

  const visitMatchBundle = (bundle: MMatchBundle) => {
    for (const arm of bundle.arms) {
      if (arm.kind === "match_pattern") {
        visitExpr(arm.body);
      }
    }
  };

  visitTopLevels(program.declarations ?? []);

  return best?.decl;
}
