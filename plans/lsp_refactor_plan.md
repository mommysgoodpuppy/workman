# LSP Refactor Plan

## Goals
- Reduce ad-hoc formatting paths so inlay/hover/signature share one source of truth.
- Centralize type rendering (records, effects, carriers, nominal names) with clear options.
- Isolate protocol handling from compiler integration so diagnostics and type display are testable.

## Current Pain Points
- Multiple formatting pipelines (`formatTypeForInlay`, `formatSchemeWithPartials`, `renderNodeView`) diverge.
- Result/effect display and nominal record naming are post-processed in several places.
- Hover vs inlay formatting uses different helpers and can disagree.
- Ad-hoc string rewriting makes regressions easy.

## Proposed Structure
1) `lsp/server/src/format/`
   - `type_format.ts`: core formatting with options (showEffects, showState, showNominalDetails).
   - `nominal.ts`: lookup helpers for record/alias display; no string replacements.
   - `result.ts`: effect row formatting and summary rendering.
   - All LSP surfaces call into `type_format.ts` only.

2) `lsp/server/src/hover/`
   - Build hover content from typed model (type + optional typeInfo + coverage).
   - Avoid string surgery in handlers.

3) `lsp/server/src/inlay/`
   - Use a single entrypoint `formatInlayType(type, ctx)`.
   - Enforce no carrier state in inlays unless explicitly requested.

4) `lsp/server/src/context/`
   - Module graph / Layer3 build lives here.
   - Cache keys and invalidation are centralized.

## Cleanup Steps
- Replace `replaceIResultFormats` string manipulation with structured formatting in `type_format.ts`.
- Delete `replaceNominalRecordTypes` once nominal formatting is handled by the formatter.
- Remove duplicate `formatTopLevelType` helpers.
- Add a single `formatTypeForLsp(surface, ...)` with surface enum: hover/inlay/signature/diagnostic.

## Tests / Validation
- Add snapshot tests for type formatting:
  - nominal record display
  - infected Result display with/without state
  - hover vs inlay consistency
- Add a regression test for Direction hover showing `Direction = L | R`.

## Incremental Strategy
- Phase 1: Extract formatting into new module; keep behavior identical.
- Phase 2: Migrate inlay/hover/signature to use the new module.
- Phase 3: Delete old helpers and string rewrites.

