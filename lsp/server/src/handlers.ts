// lspHandlers.ts

import { fromFileUrl } from "std/path/from_file_url.ts";
import { LSPMessage } from "./server.ts";
import {  typeToString } from "../../../src/types.ts";

import { findNodeAtOffset, } from "../../../src/layer3/mod.ts";

import { renderNodeView } from "./render.ts";
import { getWordAtOffset, offsetToPosition, positionToOffset, spanToRange } from "./util.ts";
import { computeStdRoots, uriToFsPath } from "./fsio.ts";
import type { WorkmanLanguageServer } from "./server.ts";
import { collectIdentifierReferences, findConstructorDeclaration, findGlobalDefinitionLocations, findLetDeclaration, findModuleDefinitionLocations, findNearestLetBeforeOffset, findTopLevelLet, findTypeDeclaration } from "./findcollect.ts";
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
      let label = `? ${typeStr}`;
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