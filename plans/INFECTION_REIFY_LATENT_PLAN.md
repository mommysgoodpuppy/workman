# Infection System Enhancement: Reify Latent Error Rows

**Date:** November 14, 2025\
**Goal:** Modify the infection type system to display specific error rows in
reified types, showing the growth of the effect stack (e.g.,
`IResult<T, <NotMul | ExpectedDigit>>` instead of `IResult<T, <ParseResult>>`).

## Executive Summary

The current system reifies the declared error type `E` in `IResult<T, E>`, while
latent constraints track specific errors. To achieve the ideal, reify the latent
error row as the state in the carrier type. This requires changing infectious
type declarations to omit the state parameter and using lazy reification in the
solver.

## Current Issue

- **Reified Type**: `IResult<T, E>` where `E` is declared (e.g., `ParseResult`),
  shown as `<ParseResult>`.
- **Latent Tracking**: Specific errors (e.g., `NotMul`) are added to an
  `error_row` via `refineInfectiousConstructor`, but this doesn't update the
  reified type.
- **Result**: Types show the full union, not the specific errors possible in a
  function.

## Proposed Solution

### Key Changes

1. **Redefine Infectious Types**: Change syntax to
   `infectious error type IResult<T> = @value IOk<T> | @effect IErr;`. Omit the
   state parameter `E`.
2. **Latent State**: The carrier state is always an `error_row`, initialized
   empty, and built via latent constraints.
3. **Lazy Reification**: During solver propagation, apply rewrites to update
   types with the latent row as the state.
4. **Reification Points**: At call returns, boundaries, and constructions,
   insert the latent row into the carrier.

### Architecture

- **Inference**: Emit `constraint_source` and `constraint_rewrite` stubs. Do not
  modify types eagerly.
- **Solver**: Propagate latent rows, apply rewrites to types at reification
  points.
- **Carrier Operations**: `join` uses the latent row as state; `split` extracts
  the latent row.

## Implementation Plan

### Phase 1: Syntax and Parsing Changes

- **Parser (`parser.ts`)**: Modify `parseInfectiousOrTypeDeclaration` to allow
  `infectious error type IResult<T> = ...` without state param.
- **AST**: Update `TypeDeclaration` to not require state param for infectious
  types.
- **Inference**: In `registerInfectiousTypeDeclaration`, handle missing state
  param.

### Phase 2: Carrier Registration Changes

- **Carrier Ops (`types.ts`)**: Update `createAndRegisterCarrier` to:
  - `is`: Check for `IResult<T>` (one arg).
  - `split`: Return `{value: T, state: error_row}` where state is latent.
  - `join`: `IResult<T>` with state as latent row.
  - `unionStates`: `errorRowUnion`.
- **Initialization**: Latent row starts as empty `error_row`.

### Phase 3: Inference Modifications

- **Context (`context.ts`)**: Ensure latent rows are tracked per domain per
  node.
- **Infer Calls**: At call sites, emit `constraint_flow` for Result args,
  accumulate latent states.
- **Constructor Refinement**: `refineInfectiousConstructor` emits
  `constraint_source` with specific cases.
- **No Eager Discharge**: Remove immediate type modifications; use stubs.

### Phase 4: Solver Enhancements

- **Propagation**: Build constraint graph from stubs, propagate latent rows.
- **Rewrite Application**: At reification points (calls, returns, matches),
  update types to `IResult<T, latent_row>`.
- **Reify Law**: Check `latent ⊑ declared` (if any), then set carrier state to
  latent, clear latent.

### Phase 5: Type Printer Updates

- **Display**: Show specific cases in `error_row`, e.g.,
  `<NotMul | ExpectedDigit>`.
- **Expansion**: Optionally expand union tails for clarity.

## Code Changes Summary

- `src/parser.ts`: Allow `infectious error type Name<T> = ...`
- `src/types.ts`: Update carrier ops for no-state-param infectious types.
- `src/layer1/infer.ts`: Emit stubs, no eager changes.
- `src/layer1/context.ts`: Track latent rows.
- `src/layer2/solver.ts`: Propagate and reify latent rows into types.
- `src/type_printer.ts`: Ensure `error_row` shows specific cases.

## Benefits

- **Precise Types**: `parseMulAt` shows
  `IResult<ParseStep, <NotMul | ExpectedDigit | ExpectedComma | ExpectedCloseParen>>`.
- **Unified System**: Aligns with the broader refactor plan.
- **Composability**: Effect stacks grow visibly and accurately.

## Risks

- **Breaking Changes**: Existing code with `IResult<T, E>` needs updates.
- **Complexity**: Solver must handle type updates during propagation.
- **Performance**: Additional propagation steps.

## Timeline

- Phase 1-2: 1-2 weeks (syntax and carriers).
- Phase 3-4: 2-3 weeks (inference and solver).
- Phase 5: 1 week (printer).
- Testing: 1 week.

This plan enables the desired effect stack visibility by bridging latent and
reified levels.</content>
<parameter name="filePath">c:\Git\workman\INFECTION_REIFY_LATENT_PLAN.md
