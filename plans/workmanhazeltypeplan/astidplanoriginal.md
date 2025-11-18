### Guide: Adding Persistent AST Node IDs for Constraint Tracing

This document outlines the steps to retrofit the Workman compiler front-end with
unique, stable identifiers on AST nodes. These IDs are required so later phases
(constraint generation/solving) can attribute errors and constraints back to
precise syntactic origins.

---

## 1. Requirements Recap

- Every AST node that can participate in typing/inference must expose a unique
  ID.
- IDs must be stable across repeated traversals of the same tree (no
  regenerating on read).
- The parser should assign IDs during construction—later passes read them.
- Transformation passes (e.g., tuple parameter lowering) must preserve IDs.
- Marked AST
  ([ast_marked.ts](cci:7://file:///c:/GIT/workman/src/ast_marked.ts:0:0-0:0))
  needs the same IDs for error reporting continuity.
- Tests should verify IDs exist and remain consistent through transformations.

---

## 2. Affected Modules

1. **[src/ast.ts](cci:7://file:///c:/GIT/workman/src/ast.ts:0:0-0:0)** — Define
   ID fields in base interfaces.
2. **[src/parser.ts](cci:7://file:///c:/GIT/workman/src/parser.ts:0:0-0:0)** —
   Produce IDs when constructing nodes.
3. **`src/layer1/`** modules — Update types or helper code expecting
   [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1).
   - [context.ts](cci:7://file:///c:/GIT/workman/src/layer1/context.ts:0:0-0:0),
     `declarations.ts`, `infermatch.ts`,
     [infer.ts](cci:7://file:///c:/GIT/workman/src/infer.ts:0:0-0:0)
4. **[src/ast_marked.ts](cci:7://file:///c:/GIT/workman/src/ast_marked.ts:0:0-0:0)**
   — Mirror ID fields on marked nodes.
5. **[src/lower_tuple_params.ts](cci:7://file:///c:/GIT/workman/src/lower_tuple_params.ts:0:0-0:0)**
   — Preserve IDs when rewriting AST.
6. **[tests/](cci:7://file:///c:/GIT/workman/tests:0:0-0:0)** — Add regression
   coverage for ID population.
7. **Tooling** (formatters, printers) may need trivial adjustments if they
   assume specific shapes.

---

## 3. Data Model Updates

### 3.1 [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1) and Related Types

- Extend [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1) in
  [ast.ts](cci:7://file:///c:/GIT/workman/src/ast.ts:0:0-0:0) to include
  `id: NodeId`.
- Define `type NodeId = number` (or string) and `interface NodeWithId`.
- Update all interfaces extending
  [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1) to include the
  new property via inheritance.

### 3.2 Marked AST

- Introduce `id: NodeId` in
  [MNodeBase](cci:2://file:///c:/GIT/workman/src/ast_marked.ts:14:0-16:1)
  ([ast_marked.ts](cci:7://file:///c:/GIT/workman/src/ast_marked.ts:0:0-0:0)),
  synchronized with source nodes.
- For mark nodes created during inference, ensure IDs follow source node IDs
  (e.g., mark nodes derived from expressions reuse the offending expression’s
  ID).

### 3.3 Type Definitions

- If passes store nodes in maps keyed by object identity, consider migrating to
  `Map<NodeId, ...>` where appropriate once IDs exist.

---

## 4. Parser Changes

### 4.1 ID Generator

- Add an incremental counter (module-level or parser-instance) in
  [parser.ts](cci:7://file:///c:/GIT/workman/src/parser.ts:0:0-0:0).
- Helper: `private nextNodeId(): NodeId` that increments the counter.

### 4.2 Node Construction

- Whenever the parser constructs a node (e.g., in
  [parseExpression](cci:1://file:///c:/GIT/workman/src/parser.ts:668:2-670:3),
  [parsePattern](cci:1://file:///c:/GIT/workman/src/parser.ts:1026:2-1106:3)),
  include `id: this.nextNodeId()`.
- Ensure nested structures created in helper functions also call the helper
  (avoid manual incremental logic).

### 4.3 Source Span Helpers

- Adjust any helper returning
  [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1) to include IDs.

### 4.4 Comments and Trailing Metadata

- When nodes are mutated after construction (adding comments, blank-line flags),
  do not mutate `id`.

---

## 5. Downstream Consumers

### 5.1 Lowering Passes ([lower_tuple_params.ts](cci:7://file:///c:/GIT/workman/src/lower_tuple_params.ts:0:0-0:0))

- When replacing nodes, ensure the replacement carries the original node’s ID.
  - Example: when wrapping parameters in helper
    [wrapWithMatch](cci:1://file:///c:/GIT/workman/src/lower_tuple_params.ts:200:0-245:1),
    propagate the original parameter’s `id` to the new `Match` node if
    appropriate.
- For entirely new nodes introduced during lowering, decide if they need new IDs
  (probably yes) and assign them via a shared ID generator.
  - Option: pass parser-style context or add utility `allocateNodeId()` exported
    from parser or a dedicated module.

### 5.2 Inference Layer

- Update any maps keyed by node objects (`ctx.nodeTypes`, `ctx.marks`) if they
  assume object identity. With IDs, we can maintain existing approach but ensure
  marks copy IDs from source.
- When creating marked expressions (e.g., in
  [materializeExpr](cci:1://file:///c:/GIT/workman/src/infer.ts:322:0-452:1)),
  set `id` equal to the original AST node’s ID. For synthetic marks (e.g.,
  [markNonExhaustive](cci:1://file:///c:/GIT/workman/src/layer1/context.ts:221:0-236:1)),
  inherit ID from the pattern or expression that triggered it.

### 5.3 Mark Creation Helpers ([context.ts](cci:7://file:///c:/GIT/workman/src/layer1/context.ts:0:0-0:0))

- Functions such as
  [markFreeVariable](cci:1://file:///c:/GIT/workman/src/layer1/context.ts:172:0-185:1)
  should accept the source node ID or infer it from `expr.id`.
- When constructing `MMark...` nodes, include `id`.

---

## 6. Persistence Across Phases

### 6.1 AST Transformations

- Audit all functions that clone or transform AST nodes:
  - [resolveTypeForName](cci:1://file:///c:/GIT/workman/src/infer.ts:179:0-186:1),
    [materializeMarkedLet](cci:1://file:///c:/GIT/workman/src/infer.ts:188:0-234:1),
    [materializeExpr](cci:1://file:///c:/GIT/workman/src/infer.ts:322:0-452:1)
    etc. should propagate `id`.
  - Where new nodes are synthesized (e.g., fallback block expressions), assign
    either a fresh ID or reuse parent’s ID, depending on semantics. Prefer fresh
    IDs for truly synthetic nodes (use dedicated allocator).
- Consider centralizing ID allocation in a module accessible beyond parser:
  - Option A: Introduce `src/node_ids.ts` exporting `nextNodeId()` and
    `resetNodeIdCounter()`.
  - Option B: Track IDs per context (e.g.,
    [Context](cci:2://file:///c:/GIT/workman/src/layer1/context.ts:30:0-40:1)
    stores counter). Ensure resets align with parsing.

### 6.2 Serialization/Printing

- If any tooling serializes ASTs (formatter/reprinter), ensure IDs survive
  round-trips.

---

## 7. Testing Strategy

1. **Parser Unit Tests**
   - Modify existing parser tests to assert `id` is defined on representative
     nodes.
   - Add snapshots or text dumps that show IDs to catch accidental resets.

2. **Lowering Tests**
   - Create tests ensuring nodes before/after lowering share IDs (except
     intentionally new nodes).
   - Option: instrument `lower_tuple_params` tests to collect IDs.

3. **Inference Tests**
   - Extend inference tests to assert marked AST nodes include IDs matching
     original nodes.
   - For error cases, ensure marks reference the same IDs as their source
     expressions.

4. **Regression**
   - Introduce a new fixture capturing AST JSON with IDs for a small program.
   - Add a test verifying ID monotonicity (no duplicates, sorted order strictly
     increasing).

---

## 8. Implementation Steps Summary

1. **Define `NodeId` and extend
   [NodeBase](cci:2://file:///c:/GIT/workman/src/ast.ts:5:0-7:1)
   ([ast.ts](cci:7://file:///c:/GIT/workman/src/ast.ts:0:0-0:0)).**
2. **Update marked AST base interfaces to include IDs.**
3. **Add ID generator in parser; populate IDs on all node creations.**
4. **Provide shared ID allocator for non-parser code (if needed).**
5. **Audit and update transformation passes to preserve or assign IDs.**
6. **Ensure marking helpers carry IDs into marked nodes.**
7. **Adjust context maps if needed, ensuring they key off node identity or ID
   appropriately.**
8. **Update tests across parser/transform/inference to validate ID presence and
   stability.**
9. **Document the new requirement in developer docs
   ([workmanhazeltypeplan](cci:7://file:///c:/GIT/workman/workmanhazeltypeplan:0:0-0:0)
   or README).**

---

## 9. Open Decisions / Considerations

- **Global vs. Per-Program ID scope**: Likely per program; ensure counter resets
  when parsing a new file.
- **ID Type**: Number is simplest; if string is preferred for debugging (e.g.,
  `"node-42"`), adjust accordingly.
- **Synthetic Nodes**: Decide how to differentiate synthetic nodes from
  source-mapped ones (maybe provenance flags).
- **Performance**: Adding numbers should be negligible, but ensure no hotspots
  rely on structural equality that IDs might invalidate (e.g., `Map` keys mixing
  nodes with/without IDs).

---

## 10. Follow-Up Tasks After Implementation

- Update developer docs explaining ID usage and guarantees.
- Ensure future contributors know to assign IDs when adding new node types.
- Plan for more advanced provenance linking once constraints solver arrives.

---

This guide should enable the "faster model" (or any engineer) to implement AST
node IDs comprehensively, preserving the invariants needed for subsequent
constraint-tracing work.
