// lspHandlers.ts

import { fromFileUrl } from "std/path/from_file_url.ts";
import { LSPMessage } from "./server.ts";
import { splitCarrier, typeToString, Type } from "../../../src/types.ts";

import { findNodeAtOffset, } from "../../../src/layer3/mod.ts";

import { renderNodeView } from "./render.ts";
import { getWordAtOffset, offsetToPosition, positionToOffset, spanToRange } from "./util.ts";
import { computeStdRoots, uriToFsPath } from "./fsio.ts";
import type { WorkmanLanguageServer } from "./server.ts";
import { collectIdentifierReferences, computeTopLevelVisibility, findConstructorDeclaration, findGlobalDefinitionLocations, findLetDeclaration, findModuleDefinitionLocations, findNearestLetBeforeOffset, findTopLevelLet, findTypeDeclaration } from "./findcollect.ts";
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
): Type | null {
  const parentIndex = buildParentIndex(context);
  const visited = new Set<number>();
  let currentId: number | undefined = nodeId;

  while (currentId !== undefined) {
    if (visited.has(currentId)) {
      return null;
    }
    visited.add(currentId);
    const parent = parentIndex.get(currentId);
    if (!parent) {
      return null;
    }

    if (parent.kind === "binary") {
      const binaryNode = parent.node as import("../../../src/ast_marked.ts").MBinaryExpr;
      if (binaryNode.right?.id === currentId) {
        const candidate = findRightmostValueNode(binaryNode.left);
        if (candidate?.id !== undefined) {
          const candidateType = getNodeType(context.layer3.nodeViews, candidate.id);
          if (candidateType) {
            return candidateType;
          }
        }
      }
    }

    currentId = typeof parent.node.id === "number" ? parent.node.id : undefined;
  }

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
          triggerCharacters: [" ", ".", "(", ",", "+", "-", "*"]
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

      const hoverText = `\`\`\`workman\n${word} : ${typeStr}\n\`\`\``;

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
    const { env, layer3 } = context;
    const addedHoleHints = new Set<number>();
    for (const [name, scheme] of env.entries()) {
      if (name.startsWith("__op_") || name.startsWith("__prefix_")) {
        continue;
      }
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const regex = new RegExp(
        `\\blet\\s+(?:rec\\s+)?${escapedName}\\b`,
        "g",
      );
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const endPos = match.index + match[0].length;
        const position = offsetToPosition(text, endPos);
        // Use Layer 3 partial types for accurate display
        let typeStr = ctx.formatSchemeWithPartials(
          scheme,
          layer3,
          context.adtEnv,
        );
        // For inlay hints prefer a compact form for Result types: show only the
        // Ok type with the ⚡ prefix (no effect summary). Keep hover unchanged.
        try {
          const substitutedScheme = ctx.applyHoleSolutionsToScheme(
            scheme,
            layer3,
          );

          let returnType = substitutedScheme.type;
          while (returnType.kind === "func") {
            returnType = returnType.to;
          }
          if (
            returnType.kind === "constructor" && returnType.args.length > 0
          ) {
            // Recognize both named Result and IResult forms by checking name
            const name = (returnType as { name?: string }).name;
            if (
              name === "Result" || name === "IResult" ||
              typeStr.includes("IResult<") || typeStr.startsWith("⚡")
            ) {
              typeStr = `⚡${typeToString(returnType.args[0])}`;
            }
          }
        } catch {
          // ignore errors and fall back to full string
        }
        let label = `: ${typeStr}`;
        if (label.length > MAX_LABEL_LENGTH) {
          label = label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
        }
        hints.push({
          position,
          label,
          kind: 1,
          paddingLeft: true,
          paddingRight: false,
        });
        ctx.log(
          `[LSP] Type hint: ${name} : ${label} at line ${position.line}, char ${position.character}`,
        );
      }
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

      let typeStr = "?";
      let summary: string | null = null;
      try {
        const substituted = ctx.substituteTypeWithLayer3(
          view.finalType.type,
          layer3,
        );
        if (substituted) {
          typeStr = ctx.replaceIResultFormats(typeToString(substituted));
          summary = ctx.summarizeEffectRowFromType(substituted, context.adtEnv);
          if (
            summary && substituted.kind === "constructor" &&
            substituted.args.length > 0
          ) {
            typeStr = `⚡${typeToString(substituted.args[0])} <${summary}>`;
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
        ctx.log(`[LSP] Failed to build module context for completion: ${error}`);
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
      ctx.log(`[LSP] ${name} substituted type: ${JSON.stringify(substitutedType)}`);
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

  const previousValueType = deriveExpectedTypeFromPreviousValue(context, nodeId);
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
    const argumentIndex = parent.node.arguments.findIndex((arg) => arg.id === nodeId);
    if (argumentIndex === -1) {
      return null;
    }
    const calleeType = getNodeType(context.layer3.nodeViews, parent.node.callee.id);
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

function getNodeType(
  views: Map<number, import("../../../src/layer3/mod.ts").NodeView>,
  nodeId: number,
): Type | null {
  const view = views.get(nodeId);
  if (!view) {
    return null;
  }
  return view.finalType.type ?? null;
}

function peelFuncType(type: Type, argIndex: number): { from: Type; to: Type } | null {
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
  const substituted = ctx.substituteTypeWithLayer3(paramType, layer3) ?? paramType;
  const display = ctx.replaceIResultFormats(
    typeToString(normalizeCarrierType(substituted)),
  );
  return {
    paramType: substituted,
    paramDisplay: display,
  };
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

  if (typeContainsTypeVar(candidateResolved)) {
    return 2;
  }

  if (typesEqual(expectedResolved, candidateResolved)) {
    return 0;
  }

  const expectedNormalized = normalizeCarrierType(expectedResolved);
  const candidateNormalized = normalizeCarrierType(candidateResolved);
  if (typesEqual(expectedNormalized, candidateNormalized)) {
    return 1;
  }

  if (
    expectedNormalized.kind === "constructor" &&
    candidateNormalized.kind === "constructor" &&
    expectedNormalized.name === candidateNormalized.name
  ) {
    return 1;
  }

  return 4;
}

function normalizeCarrierType(type: Type): Type {
  let current: Type = type;
  while (true) {
    const carrier = splitCarrier(current);
    if (!carrier) {
      break;
    }
    current = carrier.value;
  }
  return current;
}

function typesEqual(a: Type, b: Type): boolean {
  try {
    return typeToString(a) === typeToString(b);
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