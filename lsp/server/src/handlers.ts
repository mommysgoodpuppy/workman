// lspHandlers.ts

import { fromFileUrl } from "std/path/from_file_url.ts";
import { dirname, isAbsolute, normalize, resolve } from "std/path/mod.ts";
import { LSPMessage } from "./server.ts";
import { splitCarrier, Type, type TypeInfo } from "../../../src/types.ts";
import { formatType, formatTypeWithCarriers } from "../../../src/type_printer.ts";
import { createDefaultForeignTypeConfig } from "../../../src/foreign_types/c_header_provider.ts";

import { findNodeAtOffset } from "../../../src/layer3/mod.ts";

import { renderNodeView } from "./render.ts";
import {
  getWordAtOffset,
  offsetToPosition,
  positionToOffset,
  spanToRange,
} from "./util.ts";
import { computeStdRoots, uriToFsPath } from "./fsio.ts";
import type { WorkmanLanguageServer } from "./server.ts";
import {
  collectIdentifierReferences,
  computeTopLevelVisibility,
  findConstructorDeclaration,
  findGlobalDefinitionLocations,
  findLetDeclaration,
  findModuleDefinitionLocations,
  findNearestLetBeforeOffset,
  findRecordFieldDeclaration,
  findRecordFieldDefinitionLocations,
  findTopLevelLet,
  findTypeDeclaration,
} from "./findcollect.ts";
type LspServerContext = WorkmanLanguageServer;

export async function handleMessage(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage | null> {
  ctx.log(`[LSP] Received: ${message.method}`);

  if (!message.method) {
    return null;
  }

  switch (message.method) {
    case "initialize":
      return handleInitialize(ctx, message);

    case "initialized":
      return null;

    case "textDocument/didOpen":
      return await handleDidOpen(ctx, message);

    case "textDocument/didChange":
      return await handleDidChange(ctx, message);

    case "textDocument/hover":
      return await handleHover(ctx, message);

    case "textDocument/definition":
      return await handleDefinition(ctx, message);

    case "textDocument/references":
      return await handleReferences(ctx, message);

    case "textDocument/inlayHint":
      return await handleInlayHint(ctx, message);

    case "textDocument/completion":
      return await handleCompletion(ctx, message);

    case "workspace/didChangeWatchedFiles":
      return await handleDidChangeWatchedFiles(ctx, message);

    case "shutdown":
      return { jsonrpc: "2.0", id: message.id, result: null };

    case "exit":
      Deno.exit(0);
      break;
    default:
      ctx.log(`[LSP] Unhandled method: ${message.method}`);
      return null;
  }
}

function deriveExpectedTypeFromPreviousValue(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
  nodeId: number,
  debugCtx?: LspServerContext,
): Type | null {
  const parentIndex = buildParentIndex(context);
  const nodeIndex = buildNodeIndex(context);
  const visited = new Set<number>();
  const startNodeId = nodeId;
  let currentId: number | undefined = nodeId;
  let incomingChildId: number | undefined = undefined;
  debugCtx?.log(`[LSP] Previous value type from node ${currentId}`);

  outer: while (currentId !== undefined) {
    if (visited.has(currentId)) {
      debugCtx?.log(`[LSP] Previous value type from visited node ${currentId}`);
      return null;
    }
    visited.add(currentId);

    const currentNode = nodeIndex.get(currentId);
    debugCtx?.log(`[LSP] kind ${currentNode?.kind}`);
    if (currentNode?.kind === "block") {
      const blockNode =
        currentNode as import("../../../src/ast_marked.ts").MBlockExpr;
      const candidateId = findPreviousValueInBlock(
        blockNode,
        incomingChildId,
      );

      if (typeof candidateId === "number" && !visited.has(candidateId)) {
        currentId = candidateId;
        incomingChildId = undefined;
        continue outer;
      }
    }

    if (currentNode?.kind === "let") {
      const letNode =
        currentNode as import("../../../src/ast_marked.ts").MLetDeclaration;
      if (
        typeof letNode.body?.id === "number" && !visited.has(letNode.body.id)
      ) {
        currentId = letNode.body.id;
        incomingChildId = undefined;
        continue;
      }
    }

    if (currentNode?.kind === "call") {
      const callNode =
        currentNode as import("../../../src/ast_marked.ts").MCallExpr;
      if (callNode.arguments.length > 0) {
        const firstArg = callNode.arguments[0];
        if (typeof firstArg?.id === "number") {
          const argType = getBestAvailableType(
            context.layer3.nodeViews,
            firstArg.id,
          );
          if (argType) {
            debugCtx?.log(
              `[LSP] Previous value type from call arg ${firstArg.id}`,
            );
            return argType;
          }
          if (!visited.has(firstArg.id)) {
            currentId = firstArg.id;
            continue;
          }
        }
      }
    }

    const parent = parentIndex.get(currentId);
    if (!parent) {
      debugCtx?.log(
        `[LSP] Previous value type reached root at node ${currentId}`,
      );
      return null;
    }

    if (parent.kind === "call") {
      const callNode = parent
        .node as import("../../../src/ast_marked.ts").MCallExpr;
      if (callNode.callee?.id === currentId && callNode.arguments.length > 0) {
        const firstArg = callNode.arguments[0];
        if (typeof firstArg?.id === "number") {
          const argType = getBestAvailableType(
            context.layer3.nodeViews,
            firstArg.id,
          );
          if (argType) {
            debugCtx?.log(
              `[LSP] Previous value type from first arg ${firstArg.id}`,
            );
            return argType;
          }
          if (!visited.has(firstArg.id)) {
            currentId = firstArg.id;
            continue;
          }
        }
      }
      const argIndex = callNode.arguments.findIndex((arg) =>
        arg?.id === currentId
      );
      if (argIndex > 0) {
        const predecessor = callNode.arguments[argIndex - 1];
        if (typeof predecessor?.id === "number") {
          const prevType = getBestAvailableType(
            context.layer3.nodeViews,
            predecessor.id,
          );
          if (prevType) {
            debugCtx?.log(
              `[LSP] Previous value type from sibling arg ${predecessor.id}`,
            );
            return prevType;
          }
          if (!visited.has(predecessor.id)) {
            currentId = predecessor.id;
            continue;
          }
        }
      }
    }

    if (parent.kind === "binary") {
      const binaryNode = parent
        .node as import("../../../src/ast_marked.ts").MBinaryExpr;
      if (binaryNode.right?.id === currentId) {
        const candidate = findRightmostValueNode(binaryNode.left);
        if (candidate?.id !== undefined) {
          const candidateType = getBestAvailableType(
            context.layer3.nodeViews,
            candidate.id,
          );
          if (candidateType) {
            debugCtx?.log(
              `[LSP] Previous value type from binary left ${candidate.id}`,
            );
            return candidateType;
          }
          if (!visited.has(candidate.id)) {
            currentId = candidate.id;
            continue;
          }
        }
      }
    }

    incomingChildId = currentId;
    currentId = typeof parent.node.id === "number" ? parent.node.id : undefined;
  }

  debugCtx?.log(
    `[LSP] Unable to derive previous value type for node ${startNodeId}`,
  );
  return null;
}

function findRightmostValueNode(node: any): { id: number } | null {
  let current: any = node;
  while (current && typeof current === "object") {
    if (current.kind === "binary" && current.right) {
      current = current.right;
      continue;
    }
    if (typeof current.id === "number") {
      return current as { id: number };
    }
    return null;
  }
  return null;
}

function findPreviousValueInBlock(
  block: import("../../../src/ast_marked.ts").MBlockExpr,
  incomingChildId: number | undefined,
): number | undefined {
  const sequence: Array<{ childId: number; valueId: number }> = [];

  for (const stmt of block.statements) {
    if (!stmt || typeof stmt.id !== "number") {
      continue;
    }
    const valueId = extractValueNodeIdFromStatement(stmt);
    if (typeof valueId === "number") {
      sequence.push({ childId: stmt.id, valueId });
    }
  }

  if (typeof block.result?.id === "number") {
    sequence.push({ childId: block.result.id, valueId: block.result.id });
  }

  if (sequence.length === 0) {
    return undefined;
  }

  if (incomingChildId === undefined) {
    return sequence[sequence.length - 1]?.valueId;
  }

  let index = sequence.findIndex((entry) =>
    entry.childId === incomingChildId || entry.valueId === incomingChildId
  );
  if (index === -1) {
    index = sequence.length - 1;
  }

  if (index <= 0) {
    return undefined;
  }

  return sequence[index - 1]?.valueId;
}

function extractValueNodeIdFromStatement(statement: any): number | undefined {
  switch (statement?.kind) {
    case "expr_statement":
      return typeof statement.expression?.id === "number"
        ? statement.expression.id
        : undefined;
    case "pattern_let_statement":
      return typeof statement.initializer?.id === "number"
        ? statement.initializer.id
        : undefined;
    case "let_statement": {
      const decl = statement.declaration;
      if (decl?.body?.result && typeof decl.body.result.id === "number") {
        return decl.body.result.id;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function handleInitialize(
  ctx: LspServerContext,
  message: LSPMessage,
): LSPMessage {
  try {
    const params: any = message.params ?? {};
    const roots: string[] = [];
    if (typeof params.rootUri === "string") {
      try {
        roots.push(fromFileUrl(params.rootUri));
      } catch {
        //noop
      }
    } else if (typeof params.rootPath === "string") {
      roots.push(params.rootPath);
    }
    if (Array.isArray(params.workspaceFolders)) {
      for (const wf of params.workspaceFolders) {
        if (wf && typeof wf.uri === "string") {
          try {
            roots.push(fromFileUrl(wf.uri));
          } catch {
            //noop
          }
        }
      }
    }
    ctx.workspaceRoots = Array.from(new Set(roots));
    ctx.log(`[LSP] Workspace roots: ${ctx.workspaceRoots.join(", ")}`);
    const init = params.initializationOptions ?? {};
    if (init && Array.isArray(init.stdRoots)) {
      ctx.initStdRoots = init.stdRoots.filter((s: unknown) =>
        typeof s === "string"
      );
    }
    if (init && typeof init.preludeModule === "string") {
      ctx.preludeModule = init.preludeModule;
    }
  } catch (e) {
    ctx.log(`[LSP] Failed to parse workspace roots: ${e}`);
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 1, // Full sync
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        inlayHintProvider: true,
        completionProvider: {
          triggerCharacters: [" ", ".", "(", ",", "+", "-", "*"],
        },
        workspace: {
          fileOperations: {
            didChange: {
              filters: [{ pattern: { glob: "**/*.wm" } }],
            },
          },
        },
      },
      serverInfo: {
        name: "workman-language-server",
        version: "0.0.1",
      },
    },
  };
}

function handleDidOpen(
  ctx: LspServerContext,
  message: LSPMessage,
): LSPMessage | null {
  const { textDocument } = message.params;
  const uri = textDocument.uri;
  const text = textDocument.text;

  ctx.documents.set(uri, text);
  ctx.ensureValidation(uri, text);

  return null;
}

async function handleDidChange(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage | null> {
  const { textDocument, contentChanges } = message.params;
  const uri = textDocument.uri;

  if (contentChanges.length > 0) {
    const text = contentChanges[0].text;
    ctx.documents.set(uri, text);
    await ctx.ensureValidation(uri, text);
  }

  return null;
}

async function handleDidChangeWatchedFiles(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage | null> {
  const { changes } = message.params;

  if (!Array.isArray(changes)) {
    return null;
  }

  // Revalidate all changed files that we have open
  for (const change of changes) {
    const uri = change.uri;
    const text = ctx.documents.get(uri);

    if (text !== undefined) {
      // File is open in the editor, revalidate it
      await ctx.ensureValidation(uri, text);
    }
  }

  return null;
}

async function handleHover(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage> {
  const { textDocument, position } = message.params;
  const uri = textDocument.uri;
  const text = ctx.documents.get(uri);

  ctx.log(
    `[LSP] Hover at line ${position.line}, char ${position.character}`,
  );

  if (!text) {
    return { jsonrpc: "2.0", id: message.id, result: null };
  }

  try {
    const entryPath = uriToFsPath(uri);
    const stdRoots = computeStdRoots(ctx, entryPath);
    let context = ctx.moduleContexts.get(uri);
    if (!context) {
      try {
        const sourceOverrides = new Map([[entryPath, text]]);
        context = await ctx.buildModuleContext(
          entryPath,
          stdRoots,
          ctx.preludeModule,
          sourceOverrides,
          true,
        );
        ctx.moduleContexts.set(uri, context);
      } catch (error) {
        ctx.log(`[LSP] Failed to build module context for hover: ${error}`);
        return { jsonrpc: "2.0", id: message.id, result: null };
      }
    }
    const { layer3, env } = context;
    const offset = positionToOffset(text, position);
    const nodeId = findNodeAtOffset(layer3.spanIndex, offset);
    if (nodeId) {
      const nodeIndex = buildNodeIndex(context);
      const node = nodeIndex.get(nodeId);
      if (node?.kind === "identifier") {
        const scheme = env.get(node.name);
        if (scheme) {
          const localParamNames = collectLocalParamNameMap(context);
          const cHeaderImports = collectCHeaderImportMap(context);
          const includeDirs = getCHeaderIncludeDirs(context.entryPath);
          const paramNames =
            localParamNames.get(node.name) ??
            await getCHeaderParamNames(
              cHeaderImports.get(node.name),
              includeDirs,
            );
          const namedSignature = formatNamedFunctionSignature(
            ctx,
            node.name,
            scheme.type,
            layer3,
            context.adtEnv,
            paramNames,
          );
          const typeStr = ctx.formatSchemeWithPartials(
            scheme,
            layer3,
            context.adtEnv,
          );
          const typeInfo = context.adtEnv.get(node.name);
          const typeInfoText = typeInfo
            ? formatTypeInfoHover(
              ctx,
              node.name,
              typeInfo,
              context.adtEnv,
            )
            : null;
          const hoverLines = namedSignature
            ? [namedSignature, `${node.name} : ${typeStr}`]
            : [`${node.name} : ${typeStr}`];
          if (typeInfoText) {
            hoverLines.push("", typeInfoText);
          }
          const hoverText = `\`\`\`workman\n${hoverLines.join("\n")}\n\`\`\``;
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contents: {
                kind: "markdown",
                value: hoverText,
              },
            },
          };
        }
        const typeInfo = context.adtEnv.get(node.name);
        if (typeInfo) {
          const typeText = formatTypeInfoHover(
            ctx,
            node.name,
            typeInfo,
            context.adtEnv,
          );
          if (typeText) {
            const hoverText = `\`\`\`workman\n${typeText}\n\`\`\``;
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                contents: {
                  kind: "markdown",
                  value: hoverText,
                },
              },
            };
          }
        }
      }
      const view = layer3.nodeViews.get(nodeId);
      if (view) {
        const coverage = layer3.matchCoverages.get(nodeId);
        const rendered = renderNodeView(
          ctx,
          view,
          layer3,
          coverage,
          context.adtEnv,
        );
        if (rendered) {
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contents: {
                kind: "markdown",
                value: rendered,
              },
            },
          };
        }
      }
    }
    const { word } = getWordAtOffset(text, offset);
    ctx.log(`[LSP] Word at cursor: '${word}'`);
    const scheme = env.get(word);
    if (scheme) {
      // Use Layer 3 partial types for accurate display
      const typeStr = ctx.formatSchemeWithPartials(
        scheme,
        layer3,
        context.adtEnv,
      );
      ctx.log(`[LSP] Found type for ${word}: ${typeStr}`);

      const localParamNames = collectLocalParamNameMap(context);
      const cHeaderImports = collectCHeaderImportMap(context);
      const includeDirs = getCHeaderIncludeDirs(context.entryPath);
      const paramNames =
        localParamNames.get(word) ??
        await getCHeaderParamNames(cHeaderImports.get(word), includeDirs);
      const namedSignature = formatNamedFunctionSignature(
        ctx,
        word,
        scheme.type,
        layer3,
        context.adtEnv,
        paramNames,
      );
      const typeInfo = context.adtEnv.get(word);
      const typeInfoText = typeInfo
        ? formatTypeInfoHover(
          ctx,
          word,
          typeInfo,
          context.adtEnv,
        )
        : null;
      const hoverLines = namedSignature
        ? [namedSignature, `${word} : ${typeStr}`]
        : [`${word} : ${typeStr}`];
      if (typeInfoText) {
        hoverLines.push("", typeInfoText);
      }
      const hoverText = `\`\`\`workman\n${hoverLines.join("\n")}\n\`\`\``;

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contents: {
            kind: "markdown",
            value: hoverText,
          },
        },
      };
    }
    const typeInfo = context.adtEnv.get(word);
    if (typeInfo) {
      const typeText = formatTypeInfoHover(
        ctx,
        word,
        typeInfo,
        context.adtEnv,
      );
      if (typeText) {
        const hoverText = `\`\`\`workman\n${typeText}\n\`\`\``;
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: {
              kind: "markdown",
              value: hoverText,
            },
          },
        };
      }
    }

    ctx.log(`[LSP] No type found for '${word}'`);
  } catch (error) {
    ctx.log(`[LSP] Hover error: ${error}`);
    return { jsonrpc: "2.0", id: message.id, result: null };
  }
  return { jsonrpc: "2.0", id: message.id, result: null };
}

async function handleDefinition(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage> {
  const { textDocument, position } = message.params;
  const uri = textDocument.uri;
  const text = ctx.documents.get(uri);

  if (!text) {
    return { jsonrpc: "2.0", id: message.id, result: null };
  }

  try {
    const entryPath = uriToFsPath(uri);
    const stdRoots = computeStdRoots(ctx, entryPath);
    let context = ctx.moduleContexts.get(uri);
    if (!context) {
      try {
        const sourceOverrides = new Map([[entryPath, text]]);
        context = await ctx.buildModuleContext(
          entryPath,
          stdRoots,
          ctx.preludeModule,
          sourceOverrides,
          true,
        );
        ctx.moduleContexts.set(uri, context);
      } catch (error) {
        ctx.log(
          `[LSP] Failed to build module context for completion: ${error}`,
        );
        return { jsonrpc: "2.0", id: message.id, result: null };
      }
    }
    const offset = positionToOffset(text, position);
    const { word, start } = getWordAtOffset(text, offset);
    if (!word) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }
    if (start > 0) {
      const prevChar = text[start - 1];
      if (prevChar === `"` || prevChar === `'`) {
        return { jsonrpc: "2.0", id: message.id, result: null };
      }
    }

    const locations: Array<{
      uri: string;
      span: { start: number; end: number };
      sourceText: string;
    }> = [];
    const seen = new Set<string>();
    const pushLocation = (
      targetUri: string,
      span: { start: number; end: number },
      sourceText: string,
    ) => {
      const key = `${targetUri}:${span.start}:${span.end}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      locations.push({ uri: targetUri, span, sourceText });
    };

    // Check if cursor is on a record projection field (e.g., `gpa.init` or `gpa.create(...)`)
    const nodeId = findNodeAtOffset(context.layer3.spanIndex, offset);
    if (nodeId) {
      const nodeIndex = buildNodeIndex(context);
      const node = nodeIndex.get(nodeId);
      
      // Find the record_projection node
      const projectionNode = node?.kind === "record_projection" ? node
        : node?.kind === "call" && node.callee?.kind === "record_projection" ? node.callee
        : null;
      
      if (projectionNode && projectionNode.field === word) {
        const targetType = getBestAvailableType(
          context.layer3.nodeViews,
          projectionNode.target?.id,
        );
        
        let recordName: string | undefined;
        if (targetType?.kind === "constructor") {
          recordName = targetType.name;
        } else if (targetType?.kind === "record") {
          // Find record name by matching fields across all modules
          const targetFields = targetType.fields;
          for (const [, artifact] of context.modules.entries()) {
            const adtEnv = artifact.analysis?.layer1?.adtEnv;
            if (!adtEnv) continue;
            for (const [name, info] of adtEnv.entries()) {
              if (info.recordFields?.size === targetFields.size) {
                let matches = true;
                for (const [fieldName] of info.recordFields) {
                  if (!targetFields.has(fieldName)) { matches = false; break; }
                }
                if (matches) { recordName = name; break; }
              }
            }
            if (recordName) break;
          }
        }
        
        if (recordName) {
          const fieldLocations = findRecordFieldDefinitionLocations(recordName, word, context.modules);
          for (const loc of fieldLocations) {
            pushLocation(loc.uri, loc.span, loc.sourceText);
          }
        }
      }
    }

    let localDecl = findLetDeclaration(
      context.program,
      context.layer3,
      word,
      offset,
    );
    if (!localDecl) {
      localDecl = findNearestLetBeforeOffset(
        context.program,
        context.layer3,
        word,
        offset,
      );
    }
    if (localDecl) {
      const localSpan = context.layer3.spanIndex.get(localDecl.id);
      if (localSpan) {
        pushLocation(uri, localSpan, text);
      }
    }

    const topDecl = findTopLevelLet(context.program, word);
    if (topDecl) {
      const topSpan = context.layer3.spanIndex.get(topDecl.id);
      if (topSpan) {
        pushLocation(uri, topSpan, text);
      }
    }

    const typeDecl = findTypeDeclaration(context.program, word);
    if (typeDecl) {
      pushLocation(uri, typeDecl.span, text);
    }

    const ctorDecl = findConstructorDeclaration(
      context.program,
      word,
    );
    if (ctorDecl) {
      pushLocation(uri, ctorDecl.member.span, text);
    }

    const moduleNode = context.graph.nodes.get(context.entryPath);
    if (moduleNode) {
      for (const record of moduleNode.imports) {
        if (record.kind !== "workman") continue;
        for (const spec of record.specifiers) {
          if (spec.local !== word) continue;
          const moduleLocations = findModuleDefinitionLocations(
            record.sourcePath,
            spec.imported,
            context.modules,
          );
          for (const loc of moduleLocations) {
            pushLocation(loc.uri, loc.span, loc.sourceText);
          }
        }
      }
    }

    if (locations.length === 0 && context.graph.prelude) {
      const preludeLocations = findModuleDefinitionLocations(
        context.graph.prelude,
        word,
        context.modules,
      );
      for (const loc of preludeLocations) {
        pushLocation(loc.uri, loc.span, loc.sourceText);
      }
    }

    if (locations.length === 0) {
      const globalLocations = findGlobalDefinitionLocations(
        word,
        context.modules,
      );
      for (const loc of globalLocations) {
        pushLocation(loc.uri, loc.span, loc.sourceText);
      }
    }

    if (locations.length === 0) {
      return { jsonrpc: "2.0", id: message.id, result: null };
    }

    return {
      jsonrpc: "2.0",
      id: message.id,
      result: locations.map((loc) => ({
        uri: loc.uri,
        range: spanToRange(loc.sourceText, loc.span),
      })),
    };
  } catch (error) {
    ctx.log(`[LSP] Definition error: ${error}`);
    return { jsonrpc: "2.0", id: message.id, result: null };
  }
}

async function handleReferences(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage> {
  const { textDocument, position, context: requestContext } = message.params;
  const uri = textDocument.uri;
  const text = ctx.documents.get(uri);

  if (!text) {
    return { jsonrpc: "2.0", id: message.id, result: [] };
  }

  try {
    const entryPath = uriToFsPath(uri);
    const stdRoots = computeStdRoots(ctx, entryPath);
    let moduleContext = ctx.moduleContexts.get(uri);
    if (!moduleContext) {
      const sourceOverrides = new Map([[entryPath, text]]);
      moduleContext = await ctx.buildModuleContext(
        entryPath,
        stdRoots,
        ctx.preludeModule,
        sourceOverrides,
        true,
      );
      ctx.moduleContexts.set(uri, moduleContext);
    }
    const offset = positionToOffset(text, position);
    const { word } = getWordAtOffset(text, offset);
    if (!word) {
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }
    const decl = findTopLevelLet(moduleContext.program, word);
    if (!decl) {
      return { jsonrpc: "2.0", id: message.id, result: [] };
    }

    const spans = collectIdentifierReferences(
      moduleContext.program,
      word,
    );
    const includeDeclaration = requestContext?.includeDeclaration !== false;
    const results: Array<
      {
        uri: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }
    > = [];
    const seen = new Set<string>();
    const addSpan = (span: { start: number; end: number }) => {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      results.push({
        uri,
        range: spanToRange(text, span),
      });
    };
    if (includeDeclaration) {
      const declSpan = moduleContext.layer3.spanIndex.get(decl.id);
      if (declSpan) {
        addSpan(declSpan);
      }
    }
    for (const span of spans) {
      addSpan(span);
    }
    return { jsonrpc: "2.0", id: message.id, result: results };
  } catch (error) {
    ctx.log(`[LSP] References error: ${error}`);
    return { jsonrpc: "2.0", id: message.id, result: [] };
  }
}

async function handleInlayHint(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage> {
  const { textDocument } = message.params;
  const uri = textDocument.uri;
  const text = ctx.documents.get(uri);

  if (!text) {
    return { jsonrpc: "2.0", id: message.id, result: [] };
  }

  const hints: Array<{
    position: { line: number; character: number };
    label: string;
    kind: number;
    paddingLeft: boolean;
    paddingRight: boolean;
  }> = [];
  const MAX_LABEL_LENGTH = 40;

  try {
    const entryPath = uriToFsPath(uri);
    const stdRoots = computeStdRoots(ctx, entryPath);
    let context = ctx.moduleContexts.get(uri);

    if (!context) {
      try {
        const sourceOverrides = new Map([[entryPath, text]]);
        context = await ctx.buildModuleContext(
          entryPath,
          stdRoots,
          ctx.preludeModule,
          sourceOverrides,
          true,
        );
        ctx.moduleContexts.set(uri, context);
      } catch (error) {
        ctx.log(
          `[LSP] Failed to build module context for inlay hints: ${error}`,
        );
        return { jsonrpc: "2.0", id: message.id, result: [] };
      }
    }

    const { layer3 } = context;
    const addedHoleHints = new Set<number>();

    const letHintTargets = collectLetTargetsFromIndex(context);

    for (const target of letHintTargets) {
      const spanSummary = `${target.nameSpan.start}-${target.nameSpan.end}`;
      const spanText = text.slice(target.nameSpan.start, target.nameSpan.end)
        .replace(/\r?\n/g, "\\n");
      ctx.log(
        `[LSP] Let hint target node ${target.nodeId} span ${spanSummary} text="${spanText}"`,
      );
      const type = getBestAvailableType(layer3.nodeViews, target.nodeId) ??
        target.fallbackType;
      if (!type) {
        ctx.log(
          `[LSP] Let hint target node ${target.nodeId} skipped: no type available`,
        );
        continue;
      }
      const typeStr = formatTypeForInlay(ctx, type, context);
      if (!typeStr) {
        ctx.log(
          `[LSP] Let hint target node ${target.nodeId} skipped: could not format type`,
        );
        continue;
      }
      let label = `: ${typeStr}`;
      if (label.length > MAX_LABEL_LENGTH) {
        label = label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
      }
      const position = offsetToPosition(text, target.nameSpan.end);
      hints.push({
        position,
        label,
        kind: 1,
        paddingLeft: true,
        paddingRight: false,
      });
      ctx.log(
        `[LSP] Type hint: node ${target.nodeId} -> ${label} at line ${position.line}, char ${position.character}`,
      );
    }

    const recordFieldTargets = collectRecordFieldTargets(context);
    for (const target of recordFieldTargets) {
      const type = getBestAvailableType(layer3.nodeViews, target.valueNodeId);
      if (!type) {
        continue;
      }
      const typeStr = formatTypeForInlay(ctx, type, context);
      if (!typeStr) continue;
      let label = `${typeStr}`;
      if (label.length > MAX_LABEL_LENGTH) {
        label = label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
      }
      const colonOffset = findColonOffset(
        text,
        target.fieldSpanStart,
        target.valueSpanStart,
      );
      const position = offsetToPosition(text, colonOffset);
      hints.push({
        position,
        label,
        kind: 1,
        paddingLeft: true,
        paddingRight: true,
      });
      ctx.log(
        `[LSP] Record field hint: ${target.fieldName} -> ${label} at line ${position.line}, char ${position.character}`,
      );
    }

    const callTargets = collectCallArgumentTargets(context);
    const localParamNames = collectLocalParamNameMap(context);
    const cHeaderImports = collectCHeaderImportMap(context);
    const includeDirs = getCHeaderIncludeDirs(context.entryPath);
    for (const target of callTargets) {
      const paramNames =
        localParamNames.get(target.calleeName) ??
        await getCHeaderParamNames(
          cHeaderImports.get(target.calleeName),
          includeDirs,
        );
      if (!paramNames || paramNames.length === 0) {
        continue;
      }
      const paramName = paramNames[target.argIndex];
      if (!paramName) {
        continue;
      }
      const label = `${paramName}:`;
      if (label.length > MAX_LABEL_LENGTH) {
        continue;
      }
      const position = offsetToPosition(text, target.argSpanStart);
      hints.push({
        position,
        label,
        kind: 1,
        paddingLeft: false,
        paddingRight: true,
      });
    }

    for (const view of layer3.nodeViews.values()) {
      if (
        view.finalType.kind !== "unknown" ||
        !view.finalType.type ||
        !view.sourceSpan
      ) {
        continue;
      }
      const holeId = ctx.extractHoleIdFromType(view.finalType.type);
      if (holeId === undefined || holeId !== view.nodeId) {
        continue;
      }
      if (addedHoleHints.has(holeId)) {
        continue;
      }
      addedHoleHints.add(holeId);

      let anchorOffset = view.sourceSpan.start;
      if (anchorOffset > 0) {
        const prevChar = text[anchorOffset - 1];
        if (prevChar === "\n") {
          anchorOffset -= 1;
          if (anchorOffset > 0 && text[anchorOffset - 1] === "\r") {
            anchorOffset -= 1;
          }
        }
      }
      const position = offsetToPosition(text, anchorOffset);

      // Create printing context once for this hint
      const printCtx = { names: new Map(), next: 0 };
      let typeStr = "?";
      let summary: string | null = null;
      try {
        const substituted = ctx.substituteTypeWithLayer3(
          view.finalType.type,
          layer3,
        );
        if (substituted) {
          typeStr = ctx.replaceIResultFormats(
            formatType(substituted, printCtx, 0),
          );
          summary = ctx.summarizeEffectRowFromType(substituted, context.adtEnv);
          if (
            summary && substituted.kind === "constructor" &&
            substituted.args.length > 0
          ) {
            typeStr = `⚡${
              formatType(substituted.args[0], printCtx, 0)
            } [<${summary}>]`;
          }
        }
      } catch {
        // keep fallback type string
      }
      let label = `🕳️ ${typeStr}`;
      if (summary && !label.includes("Errors:")) {
        label += ` · Errors: ${summary}`;
      }
      if (label.length > MAX_LABEL_LENGTH) {
        label = label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
      }
      hints.push({
        position,
        label,
        kind: 1,
        paddingLeft: false,
        paddingRight: false,
      });
    }
    ctx.log(`[LSP] Returning ${hints.length} inlay hints`);
  } catch (error) {
    ctx.log(`[LSP] Inlay hint error: ${error}`);
    return { jsonrpc: "2.0", id: message.id, result: [] };
  }

  return { jsonrpc: "2.0", id: message.id, result: hints };
}

async function handleCompletion(
  ctx: LspServerContext,
  message: LSPMessage,
): Promise<LSPMessage> {
  const { textDocument, position } = message.params;
  const uri = textDocument?.uri;
  if (!uri) {
    return emptyCompletionResult(message.id);
  }

  const text = ctx.documents.get(uri);
  if (!text) {
    return emptyCompletionResult(message.id);
  }

  try {
    const entryPath = uriToFsPath(uri);
    const stdRoots = computeStdRoots(ctx, entryPath);
    let context = ctx.moduleContexts.get(uri);
    if (!context) {
      try {
        const sourceOverrides = new Map([[entryPath, text]]);
        context = await ctx.buildModuleContext(
          entryPath,
          stdRoots,
          ctx.preludeModule,
          sourceOverrides,
          true,
        );
        ctx.moduleContexts.set(uri, context);
      } catch (error) {
        ctx.log(
          `[LSP] Failed to build module context for completion: ${error}`,
        );
        return emptyCompletionResult(message.id);
      }
    }

    const offset = positionToOffset(text, position);
    const { word } = getWordAtOffset(text, offset);
    const filterWord = word ?? "";
    let nodeId = findNodeAtOffset(context.layer3.spanIndex, offset);
    if (!nodeId && offset > 0) {
      nodeId = findNodeAtOffset(context.layer3.spanIndex, offset - 1);
    }
    const expectedInfo = extractExpectedFunctionInfo(
      ctx,
      context,
      nodeId,
    );
    ctx.log(`[LSP] Expected info: ${JSON.stringify(expectedInfo)}`);

    const topLevelVisibility = computeTopLevelVisibility(
      context.program,
      context.layer3,
    );

    const items: Array<any> = [];
    for (const [name, scheme] of context.env.entries()) {
      if (name.startsWith("__op_") || name.startsWith("__prefix_")) {
        continue;
      }
      if (filterWord && !name.startsWith(filterWord)) {
        continue;
      }
      const visibleFrom = topLevelVisibility.get(name);
      if (visibleFrom !== undefined && offset < visibleFrom) {
        continue;
      }

      const formattedType = ctx.formatSchemeWithPartials(
        scheme,
        context.layer3,
        context.adtEnv,
      );
      const substitutedType = ctx.substituteTypeWithLayer3(
        scheme.type,
        context.layer3,
      );
      const compatibility = scoreFunctionCompatibility(
        ctx,
        context.layer3,
        expectedInfo?.paramType ?? null,
        substitutedType,
      );
      ctx.log(`[LSP] ${name} compatibility: ${compatibility}`);
      ctx.log(`[LSP] ${name} expected type: ${expectedInfo}`);
      ctx.log(
        `[LSP] ${name} substituted type: ${JSON.stringify(substitutedType)}`,
      );
      if (expectedInfo && compatibility >= 4) {
        ctx.log(`[LSP] Skipping ${name} due to compatibility ${compatibility}`);
        // Skip clearly incompatible functions when we know the expected type.
        continue;
      }

      const documentationLines = [`**Type**: \`${formattedType}\``];
      if (expectedInfo?.paramDisplay) {
        documentationLines.push(
          `**Argument matches**: \`${expectedInfo.paramDisplay}\``,
        );
      }
      items.push({
        label: name,
        kind: 3,
        detail: formattedType,
        sortText: `${compatibility.toString().padStart(2, "0")}_${name}`,
        filterText: name,
        insertText: name,
        preselect: compatibility === 0,
        documentation: {
          kind: "markdown",
          value: documentationLines.join("\n\n"),
        },
      });
    }

    items.sort((a, b) => a.sortText.localeCompare(b.sortText));

    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isIncomplete: false,
        items,
      },
    };
  } catch (error) {
    ctx.log(`[LSP] Completion error: ${error}`);
    return emptyCompletionResult(message.id);
  }
}

function emptyCompletionResult(id: number | string | undefined): LSPMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isIncomplete: false,
      items: [],
    },
  };
}

function extractExpectedFunctionInfo(
  ctx: LspServerContext,
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
  nodeId: number | undefined,
): {
  paramType: Type | null;
  paramDisplay: string | null;
} | null {
  if (nodeId === undefined) {
    ctx.log(`[LSP] No node ID for expected function info`);
    return null;
  }

  const layer3 = context.layer3;
  const view = layer3.nodeViews.get(nodeId);
  ctx.log(`[LSP] Node view for node ID ${nodeId}: ${JSON.stringify(view)}`);
  if (!view) {
    ctx.log(`[LSP] No node view for node ID ${nodeId}`);
    return null;
  }

  const partial = view.expected ?? view.finalType;
  if (partial?.type && partial.type.kind === "func") {
    return buildExpectedInfo(ctx, layer3, partial.type);
  }

  const derived = deriveExpectedTypeFromParentCall(context, nodeId);
  if (derived) {
    return buildExpectedInfo(ctx, layer3, derived);
  }

  const previousValueType = deriveExpectedTypeFromPreviousValue(
    context,
    nodeId,
    ctx,
  );
  if (!previousValueType) {
    ctx.log(`[LSP] Unable to derive expected type for node ID ${nodeId}`);
    return null;
  }
  ctx.log(`[LSP] Derived previous value type for node ID ${nodeId}`);
  return buildExpectedInfo(ctx, layer3, previousValueType);
}

function deriveExpectedTypeFromParentCall(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
  nodeId: number,
): Type | null {
  const parentIndex = buildParentIndex(context);
  const parent = parentIndex.get(nodeId);
  if (!parent) {
    return null;
  }
  if (parent.kind === "call" && parent.node.arguments) {
    const argumentIndex = parent.node.arguments.findIndex((arg) =>
      arg.id === nodeId
    );
    if (argumentIndex === -1) {
      return null;
    }
    const calleeType = getNodeType(
      context.layer3.nodeViews,
      parent.node.callee.id,
    );
    if (!calleeType) {
      return null;
    }
    return peelFuncType(calleeType, argumentIndex)?.from ?? null;
  }

  if (parent.kind === "binary") {
    const operatorView = getNodeType(context.layer3.nodeViews, parent.node.id);
    if (!operatorView || operatorView.kind !== "func") {
      return null;
    }
    return operatorView.from;
  }

  return null;
}

function buildParentIndex(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Map<number, { kind: string; node: any }> {
  const cacheKey = Symbol.for("parentIndex");
  const cached = (context.layer3 as Record<string, unknown>)[cacheKey] as
    | Map<number, { kind: string; node: any }>
    | undefined;
  if (cached) {
    return cached;
  }
  const parentMap = new Map<number, { kind: string; node: any }>();
  const visit = (node: any, parent: { kind: string; node: any } | null) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (typeof node.id === "number" && parent) {
      parentMap.set(node.id, parent);
    }
    switch (node.kind) {
      case "call": {
        visit(node.callee, { kind: "call", node });
        for (const arg of node.arguments) {
          visit(arg, { kind: "call", node });
        }
        break;
      }
      case "binary": {
        visit(node.left, { kind: "binary", node });
        visit(node.right, { kind: "binary", node });
        break;
      }
      case "unary": {
        visit(node.operand, { kind: "unary", node });
        break;
      }
      case "block": {
        for (const stmt of node.statements) {
          visit(stmt, { kind: "block", node });
        }
        if (node.result) {
          visit(node.result, { kind: "block", node });
        }
        break;
      }
      case "let_statement":
        visit(node.declaration, { kind: "let_statement", node });
        break;
      case "let": {
        for (const param of node.parameters) {
          visit(param.pattern, { kind: "parameter", node: param });
        }
        visit(node.body, { kind: "let", node });
        if (node.mutualBindings) {
          for (const binding of node.mutualBindings) {
            visit(binding, { kind: "let", node });
          }
        }
        break;
      }
      default: {
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") {
            if (Array.isArray(value)) {
              for (const item of value) {
                visit(item, { kind: node.kind ?? "unknown", node });
              }
            } else {
              visit(value, { kind: node.kind ?? "unknown", node });
            }
          }
        }
      }
    }
  };
  for (const decl of context.program.declarations ?? []) {
    visit(decl, null);
  }
  (context.layer3 as Record<string, unknown>)[cacheKey] = parentMap;
  return parentMap;
}

function buildNodeIndex(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Map<number, any> {
  const cacheKey = Symbol.for("nodeIndex");
  const cached = (context.layer3 as Record<string, unknown>)[cacheKey] as
    | Map<number, any>
    | undefined;
  if (cached) {
    return cached;
  }

  const nodeMap = new Map<number, any>();
  const seen = new Set<any>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);

    const maybeId = (node as { id?: number }).id;
    if (typeof maybeId === "number" && !nodeMap.has(maybeId)) {
      nodeMap.set(maybeId, node);
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      if (!value) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      } else if (typeof value === "object") {
        visit(value);
      }
    }
  };

  for (const decl of context.program.declarations ?? []) {
    visit(decl);
  }

  (context.layer3 as Record<string, unknown>)[cacheKey] = nodeMap;
  return nodeMap;
}

function getNodeType(
  views: Map<number, import("../../../src/layer3/mod.ts").NodeView>,
  nodeId: number,
): Type | null {
  return getBestAvailableType(views, nodeId);
}

function getBestAvailableType(
  views: Map<number, import("../../../src/layer3/mod.ts").NodeView>,
  nodeId: number,
): Type | null {
  const view = views.get(nodeId);

  if (!view) {
    return null;
  }
  if (view.expected?.type) {
    return view.expected.type;
  }
  if (view.finalType?.type) {
    return view.finalType.type;
  }
  if (view.observed?.type) {
    return view.observed.type;
  }
  return null;
}

function collectLetTargetsFromIndex(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Array<{
  nodeId: number;
  nameSpan: { start: number; end: number };
  fallbackType?: Type;
}> {
  const nodeIndex = buildNodeIndex(context);
  const targets: Array<{
    nodeId: number;
    nameSpan: { start: number; end: number };
    fallbackType?: Type;
  }> = [];
  for (const node of nodeIndex.values()) {
    if (
      node &&
      node.kind === "let" &&
      typeof node.id === "number" &&
      node.nameSpan &&
      typeof node.nameSpan.start === "number" &&
      typeof node.nameSpan.end === "number"
    ) {
      targets.push({
        nodeId: node.id,
        nameSpan: {
          start: node.nameSpan.start,
          end: node.nameSpan.end,
        },
        fallbackType: node.type,
      });
    }
  }
  return targets;
}

function collectRecordFieldTargets(
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Array<{
  fieldName: string;
  valueNodeId: number;
  fieldSpanStart: number;
  valueSpanStart: number;
}> {
  const nodeIndex = buildNodeIndex(context);
  const targets: Array<{
    fieldName: string;
    valueNodeId: number;
    fieldSpanStart: number;
    valueSpanStart: number;
  }> = [];
  for (const node of nodeIndex.values()) {
    if (
      node &&
      node.kind === "record_field" &&
      typeof node.value?.id === "number" &&
      typeof node.value?.span?.start === "number" &&
      typeof node.span?.start === "number"
    ) {
      targets.push({
        fieldName: node.name ?? "",
        valueNodeId: node.value.id,
        fieldSpanStart: node.span.start,
        valueSpanStart: node.value.span.start,
      });
    }
  }
  return targets;
}

function collectCallArgumentTargets(
  context: {
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Array<{
  calleeName: string;
  argIndex: number;
  argSpanStart: number;
}> {
  const targets: Array<{
    calleeName: string;
    argIndex: number;
    argSpanStart: number;
  }> = [];

  const visitExpr = (expr?: import("../../../src/ast_marked.ts").MExpr) => {
    if (!expr) return;
    switch (expr.kind) {
      case "call": {
        if (expr.callee.kind === "identifier") {
          const calleeName = expr.callee.name;
          expr.arguments.forEach((arg, index) => {
            targets.push({
              calleeName,
              argIndex: index,
              argSpanStart: arg.span.start,
            });
          });
        } else {
          visitExpr(expr.callee);
        }
        expr.arguments.forEach((arg) => visitExpr(arg));
        break;
      }
      case "block":
        expr.statements.forEach((stmt) => {
          if (stmt.kind === "let_statement") {
            visitExpr(stmt.declaration.body);
          } else if (stmt.kind === "expr_statement") {
            visitExpr(stmt.expression);
          }
        });
        if (expr.result) visitExpr(expr.result);
        break;
      case "arrow":
        visitExpr(expr.body);
        break;
      case "constructor":
        expr.args.forEach((arg) => visitExpr(arg));
        break;
      case "tuple":
        expr.elements.forEach((el) => visitExpr(el));
        break;
      case "record_literal":
        expr.fields.forEach((field) => visitExpr(field.value));
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
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      case "match_fn":
        expr.parameters.forEach((param) => visitExpr(param));
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      case "match_bundle_literal":
        expr.bundle.arms.forEach((arm) => {
          if (arm.kind === "match_pattern") {
            visitExpr(arm.body);
          }
        });
        break;
      default:
        break;
    }
  };

  for (const decl of context.program.declarations ?? []) {
    if (decl.kind === "let") {
      visitExpr(decl.body);
    }
  }

  return targets;
}

function collectLocalParamNameMap(
  context: {
    program: import("../../../src/ast_marked.ts").MProgram;
  },
): Map<string, string[]> {
  const names = new Map<string, string[]>();

  const getParamName = (
    param: import("../../../src/ast_marked.ts").MParameter,
  ): string | null => {
    if (param.name) return param.name;
    if (param.pattern?.kind === "variable") return param.pattern.name;
    return null;
  };

  const visitLet = (
    decl?: import("../../../src/ast_marked.ts").MLetDeclaration,
  ) => {
    if (!decl) return;
    const params = decl.parameters
      ?.map((param) => getParamName(param))
      .filter((name): name is string => Boolean(name)) ?? [];
    if (params.length > 0) {
      names.set(decl.name, params);
    }
    if (decl.mutualBindings) {
      decl.mutualBindings.forEach((binding) => visitLet(binding));
    }
    if (decl.body) {
      visitBlock(decl.body);
    }
  };

  const visitBlock = (
    block?: import("../../../src/ast_marked.ts").MBlockExpr,
  ) => {
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

  const visitExpr = (expr?: import("../../../src/ast_marked.ts").MExpr) => {
    if (!expr) return;
    if (expr.kind === "block") {
      visitBlock(expr);
      return;
    }
    if (expr.kind === "arrow") {
      visitBlock(expr.body);
      return;
    }
  };

  for (const decl of context.program.declarations ?? []) {
    if (decl.kind === "let") {
      visitLet(decl);
    }
  }

  return names;
}

function collectCHeaderImportMap(
  context: {
    entryPath: string;
    graph: import("../../../src/module_loader.ts").ModuleGraph;
  },
): Map<string, { headerPath: string; importedName: string }> {
  const map = new Map<
    string,
    { headerPath: string; importedName: string }
  >();
  const node = context.graph.nodes.get(context.entryPath);
  if (!node) return map;
  for (const record of node.imports) {
    if (record.kind !== "c_header") continue;
    for (const spec of record.specifiers) {
      map.set(spec.local, {
        headerPath: record.sourcePath,
        importedName: spec.imported,
      });
    }
  }
  return map;
}

const cHeaderParamCache = new Map<string, Map<string, string[] | null>>();
const cHeaderSourceCache = new Map<string, string>();
const cHeaderIncludeDirCache = new Map<string, string[]>();
const MAX_HEADER_INCLUDE_VISITS = 200;

function getCHeaderIncludeDirs(entryPath: string): string[] {
  const cached = cHeaderIncludeDirCache.get(entryPath);
  if (cached) return cached;
  const config = createDefaultForeignTypeConfig(entryPath);
  const includeDirs = config.includeDirs ?? [];
  cHeaderIncludeDirCache.set(entryPath, includeDirs);
  return includeDirs;
}

async function getCHeaderParamNames(
  importInfo: { headerPath: string; importedName: string } | undefined,
  includeDirs: string[],
): Promise<string[] | null> {
  if (!importInfo) return null;
  const headerPath = importInfo.headerPath;
  const fnName = importInfo.importedName;
  if (!fnName) return null;

  const cacheKey = `${headerPath}::${includeDirs.join(";")}`;
  let table = cHeaderParamCache.get(cacheKey);
  if (!table) {
    table = new Map();
    cHeaderParamCache.set(cacheKey, table);
  }
  if (table.has(fnName)) {
    return table.get(fnName) ?? null;
  }
  const names = await findParamNamesInHeader(
    headerPath,
    fnName,
    includeDirs,
    new Set(),
    { count: 0 },
  );
  table.set(fnName, names);
  return names;
}

async function readHeaderSource(path: string): Promise<string | null> {
  const cached = cHeaderSourceCache.get(path);
  if (cached) return cached;
  try {
    const source = await Deno.readTextFile(path);
    cHeaderSourceCache.set(path, source);
    return source;
  } catch {
    return null;
  }
}

async function findParamNamesInHeader(
  path: string,
  fnName: string,
  includeDirs: string[],
  visited: Set<string>,
  budget: { count: number },
): Promise<string[] | null> {
  const normalized = normalize(path);
  if (visited.has(normalized)) return null;
  if (budget.count >= MAX_HEADER_INCLUDE_VISITS) return null;
  budget.count += 1;
  visited.add(normalized);

  const source = await readHeaderSource(normalized);
  if (!source) return null;
  if (source.includes(fnName)) {
    const names = extractParamNamesFromHeader(source, fnName);
    if (names) return names;
  }
  const includes = extractIncludePaths(source);
  for (const include of includes) {
    const resolved = await resolveIncludePath(normalized, include, includeDirs);
    if (!resolved) continue;
    const names = await findParamNamesInHeader(
      resolved,
      fnName,
      includeDirs,
      visited,
      budget,
    );
    if (names) return names;
  }
  return null;
}

type IncludeSpec = { path: string; isSystem: boolean };

function extractIncludePaths(source: string): IncludeSpec[] {
  const cleaned = stripCComments(source);
  const includes: IncludeSpec[] = [];
  const regex = /^\s*#\s*include\s*([<"])([^">]+)[">]/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    includes.push({ path: match[2].trim(), isSystem: match[1] === "<" });
  }
  return includes;
}

async function resolveIncludePath(
  basePath: string,
  include: IncludeSpec,
  includeDirs: string[],
): Promise<string | null> {
  const candidates: string[] = [];
  if (isAbsolute(include.path)) {
    candidates.push(include.path);
  } else {
    if (!include.isSystem) {
      candidates.push(resolve(dirname(basePath), include.path));
    }
    for (const dir of includeDirs) {
      candidates.push(resolve(dir, include.path));
    }
  }
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function extractParamNamesFromHeader(
  source: string,
  fnName: string,
): string[] | null {
  const cleaned = stripCComments(source);
  const pattern = new RegExp(
    `\\b${escapeRegExp(fnName)}\\s*\\(([^;]*?)\\)\\s*;`,
    "s",
  );
  const match = cleaned.match(pattern);
  if (!match) return null;
  const params = match[1].trim();
  if (!params || params === "void") {
    return [];
  }
  return splitParams(params)
    .map(extractParamName)
    .filter((name) => name.length > 0);
}

function splitParams(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

const C_PARAM_KEYWORDS = new Set([
  "const",
  "volatile",
  "signed",
  "unsigned",
  "short",
  "long",
  "int",
  "char",
  "float",
  "double",
  "void",
  "struct",
  "enum",
  "union",
  "bool",
  "_Bool",
]);

function extractParamName(param: string): string {
  const tokens = param.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (tokens.length === 0) return "";
  const name = tokens[tokens.length - 1];
  if (C_PARAM_KEYWORDS.has(name)) return "";
  return name;
}

function stripCComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findColonOffset(
  text: string,
  fieldSpanStart: number,
  valueSpanStart: number,
): number {
  const start = Math.max(0, Math.min(fieldSpanStart, text.length));
  const end = Math.max(start, Math.min(valueSpanStart, text.length));
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (ch === ":") {
      return i;
    }
  }
  return end;
}

function formatTypeForInlay(
  ctx: LspServerContext,
  type: Type,
  context: {
    layer3: import("../../../src/layer3/mod.ts").Layer3Result;
    adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>;
  },
): string | null {
  try {
    const substituted = ctx.substituteTypeWithLayer3(type, context.layer3);
    const printCtx = { names: new Map(), next: 0 };
    let typeStr = ctx.replaceIResultFormats(
      formatTopLevelType(substituted, printCtx),
    );
    const simplified = simplifyRecordConstructorDisplay(
      substituted,
      context.adtEnv,
    );
    if (simplified) {
      typeStr = simplified;
    }
    const summary = ctx.summarizeEffectRowFromType(
      substituted,
      context.adtEnv,
    );
    if (
      summary && substituted.kind === "constructor" &&
      substituted.args.length > 0
    ) {
      typeStr = `⚡${
        formatType(substituted.args[0], printCtx, 0)
      } [<${summary}>]`;
    }
    return typeStr;
  } catch {
    return null;
  }
}

function formatNamedFunctionSignature(
  ctx: LspServerContext,
  name: string,
  type: Type,
  layer3: import("../../../src/layer3/mod.ts").Layer3Result,
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
  paramNames?: string[] | null,
): string | null {
  if (!paramNames || paramNames.length === 0) {
    return null;
  }
  const substituted = ctx.substituteTypeWithLayer3(type, layer3);
  const parts = collectFunctionTypeParts(substituted);
  if (!parts) return null;
  const params = parts.params.map((paramType, index) => {
    const displayName = paramNames[index] ?? `arg${index + 1}`;
    const typeStr = formatTypeForSignature(
      ctx,
      normalizeCarrierType(paramType),
      adtEnv,
    );
    return `${displayName}: ${typeStr}`;
  });
  const resultStr = formatTypeForSignature(
    ctx,
    normalizeCarrierType(parts.result),
    adtEnv,
  );
  return `fn ${name}(${params.join(", ")}) -> ${resultStr}`;
}

function formatTypeForSignature(
  ctx: LspServerContext,
  type: Type,
  adtEnv: Map<string, import("../../../src/types.ts").TypeInfo>,
): string {
  const printCtx = { names: new Map(), next: 0 };
  let typeStr = ctx.replaceIResultFormats(
    formatType(type, printCtx, 0),
  );
  const simplified = simplifyRecordConstructorDisplay(type, adtEnv);
  if (simplified) {
    typeStr = simplified;
  }
  const carrier = splitCarrier(type);
  if (carrier && carrier.domain === "effect") {
    const summary = ctx.summarizeEffectRowFromType(type, adtEnv);
    if (
      summary && type.kind === "constructor" &&
      type.args.length > 0
    ) {
      typeStr = `?${
        formatType(type.args[0], printCtx, 0)
      } [<${summary}>]`;
    }
  }
  return typeStr;
}

function formatTopLevelType(
  type: Type,
  printCtx: { names: Map<number, string>; next: number },
): string {
  return splitCarrier(type)
    ? formatTypeWithCarriers(type)
    : formatType(type, printCtx, 0);
}

function formatTypeInfoHover(
  ctx: LspServerContext,
  name: string,
  info: TypeInfo,
  adtEnv: Map<string, TypeInfo>,
): string | null {
  if (!info.alias || info.alias.kind !== "record") {
    return null;
  }
  const entries = Array.from(info.alias.fields.entries());
  const order = info.recordFields
    ? Array.from(info.recordFields.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([field]) => field)
    : entries.map(([field]) => field);
  const fieldMap = new Map(entries);
  const fieldLines = order.map((field) => {
    const fieldType = fieldMap.get(field);
    const rendered = fieldType
      ? formatTypeForSignature(ctx, fieldType, adtEnv)
      : "Unknown";
    return `  ${field}: ${rendered}`;
  });
  if (fieldLines.length === 0) {
    return `type ${name} = {}`;
  }
  return `type ${name} = {\n${fieldLines.join("\n")}\n}`;
}

function collectFunctionTypeParts(
  type: Type,
): { params: Type[]; result: Type } | null {
  const params: Type[] = [];
  let current: Type | null = type;
  while (current && current.kind === "func") {
    params.push(current.from);
    current = current.to;
  }
  if (params.length === 0 || !current) {
    return null;
  }
  return { params, result: current };
}

function simplifyRecordConstructorDisplay(
  type: Type,
  adtEnv: Map<string, TypeInfo>,
): string | null {
  if (type.kind !== "constructor" || type.args.length === 0) {
    return null;
  }
  const info = adtEnv.get(type.name);
  if (!info) {
    return null;
  }
  if (info.parameters.length > 0) {
    return null;
  }
  const alias = info.alias;
  if (!alias || alias.kind !== "record") {
    return null;
  }
  return type.name;
}

function peelFuncType(
  type: Type,
  argIndex: number,
): { from: Type; to: Type } | null {
  let current: Type | null = type;
  for (let i = 0; i <= argIndex; i++) {
    if (!current || current.kind !== "func") {
      return null;
    }
    if (i === argIndex) {
      return current;
    }
    current = current.to;
  }
  return null;
}

function buildExpectedInfo(
  ctx: LspServerContext,
  layer3: import("../../../src/layer3/mod.ts").Layer3Result,
  paramType: Type,
) {
  const substituted = ctx.substituteTypeWithLayer3(paramType, layer3) ??
    paramType;
  const display = ctx.replaceIResultFormats(
    formatType(
      normalizeCarrierType(substituted),
      { names: new Map(), next: 0 },
      0,
    ),
  );
  return {
    paramType: substituted,
    paramDisplay: display,
  };
}

function canSpecializeType(candidate: Type, expected: Type): boolean {
  if (candidate.kind === "var" || expected.kind === "var") {
    return true;
  }

  if (candidate.kind !== expected.kind) {
    return false;
  }

  switch (candidate.kind) {
    case "constructor": {
      if (candidate.name !== (expected as Type & { name: string }).name) {
        return false;
      }
      if (candidate.args.length !== expected.args.length) {
        return false;
      }
      return candidate.args.every((candArg, index) =>
        canSpecializeType(candArg, expected.args[index])
      );
    }
    case "func":
      return canSpecializeType(candidate.from, expected.from) &&
        canSpecializeType(candidate.to, expected.to);
    case "tuple":
      if (candidate.elements.length !== expected.elements.length) {
        return false;
      }
      return candidate.elements.every((candElement, index) =>
        canSpecializeType(candElement, expected.elements[index])
      );
    case "record": {
      if (candidate.fields.size !== expected.fields.size) {
        return false;
      }
      for (const [name, candFieldType] of candidate.fields.entries()) {
        const expectedFieldType = expected.fields.get(name);
        if (!expectedFieldType) {
          return false;
        }
        if (!canSpecializeType(candFieldType, expectedFieldType)) {
          return false;
        }
      }
      return true;
    }
    case "effect_row": {
      if (candidate.cases.size !== expected.cases.size) {
        return false;
      }
      for (const [label, candPayload] of candidate.cases.entries()) {
        const expectedPayload = expected.cases.get(label);
        if (!expectedPayload && candPayload) {
          return false;
        }
        if (!candPayload && expectedPayload) {
          return false;
        }
        if (candPayload && expectedPayload) {
          if (!canSpecializeType(candPayload, expectedPayload)) {
            return false;
          }
        }
      }
      if (!candidate.tail && expected.tail) {
        return false;
      }
      if (candidate.tail && expected.tail) {
        return canSpecializeType(candidate.tail, expected.tail);
      }
      return true;
    }
    case "int":
    case "bool":
    case "string":
    case "char":
    case "unit":
      return true;
    default:
      return false;
  }
}

function scoreFunctionCompatibility(
  ctx: LspServerContext,
  layer3: import("../../../src/layer3/mod.ts").Layer3Result,
  expectedParam: Type | null,
  candidateType: Type | null,
): number {
  if (!expectedParam) {
    return 5;
  }
  if (!candidateType || candidateType.kind !== "func") {
    return 8;
  }
  const expectedResolved = ctx.substituteTypeWithLayer3(
    expectedParam,
    layer3,
  ) ?? expectedParam;
  const candidateParam = candidateType.from;
  const candidateResolved = ctx.substituteTypeWithLayer3(
    candidateParam,
    layer3,
  ) ?? candidateParam;
  if (!expectedResolved || !candidateResolved) {
    return 6;
  }

  const expectedNormalized = normalizeCarrierType(expectedResolved);
  const candidateNormalized = normalizeCarrierType(candidateResolved);

  if (
    expectedNormalized.kind !== candidateNormalized.kind &&
    candidateNormalized.kind === "func" &&
    expectedNormalized.kind !== "func" &&
    expectedNormalized.kind !== "var"
  ) {
    return 9;
  }

  if (typesEqual(expectedResolved, candidateResolved)) {
    return 0;
  }

  if (typesEqual(expectedNormalized, candidateNormalized)) {
    return 1;
  }

  if (canSpecializeType(candidateNormalized, expectedNormalized)) {
    return typeContainsTypeVar(candidateNormalized) ? 2 : 1;
  }

  if (
    expectedNormalized.kind === "constructor" &&
    candidateNormalized.kind === "constructor" &&
    expectedNormalized.name === candidateNormalized.name
  ) {
    if (
      typeContainsTypeVar(candidateNormalized) &&
      !typeContainsTypeVar(expectedNormalized)
    ) {
      return 2;
    }
    return 1;
  }

  if (
    typeContainsTypeVar(candidateNormalized) &&
    !typeContainsTypeVar(expectedNormalized)
  ) {
    return 6;
  }

  return 5;
}

function normalizeCarrierType(type: Type): Type {
  let current: Type = type;
  while (true) {
    const carrier = splitCarrier(current);
    if (!carrier) {
      break;
    }
    // Only unwrap holes for display normalization
    if (carrier.domain !== "hole") {
      break;
    }
    current = carrier.value;
  }
  return current;
}

function typesEqual(a: Type, b: Type): boolean {
  try {
    const printCtx = { names: new Map(), next: 0 };
    return formatType(a, printCtx, 0) === formatType(b, printCtx, 0);
  } catch {
    return false;
  }
}

function typeContainsTypeVar(type: Type): boolean {
  switch (type.kind) {
    case "var":
      return true;
    case "func":
      return typeContainsTypeVar(type.from) || typeContainsTypeVar(type.to);
    case "constructor":
      return type.args.some(typeContainsTypeVar);
    case "tuple":
      return type.elements.some(typeContainsTypeVar);
    case "record":
      for (const field of type.fields.values()) {
        if (typeContainsTypeVar(field)) {
          return true;
        }
      }
      return false;
    case "effect_row":
      for (const payload of type.cases.values()) {
        if (payload && typeContainsTypeVar(payload)) {
          return true;
        }
      }
      return type.tail ? typeContainsTypeVar(type.tail) : false;
    default:
      return false;
  }
}
