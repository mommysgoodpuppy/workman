# Layer 1: The Marked Workman Calculus

This document details the plan for Phase 1 of the type system evolution: refactoring the existing type checker into a total, non-failing marking system. The guiding principle is to **replace every thrown type error with the creation of a marked AST node**.

## 1. New and Modified Data Structures

### 1.1. Marked AST (`src/ast_marked.ts` - New File)

A new file will be created to define the structure of the Marked Abstract Syntax Tree (`MExp`). It will be a separate but parallel structure to the existing AST in `src/ast.ts`.

```typescript
// Example structure in src/ast_marked.ts

import * as Unmarked from './ast.ts';
import { Type } from './types.ts';

// --- Base nodes mirror the original AST but contain Marked children ---
type MLetDeclaration = { kind: 'let', name: string, body: MExpr, ... };
type MCall = { kind: 'call', callee: MExpr, args: MExpr[], ... };

// --- New Mark Nodes --- 
type MFreeVariable = { kind: 'mark_free_var', name: string, type: Type };
type MInconsistentTypes = {
  kind: 'mark_inconsistent',
  originalNode: MExpr,        // The node that was being checked
  expectedType: Type,
  actualType: Type,
  type: Type                  // This will be the Unknown Type
};
type MApplicationOfNonFunction = {
  kind: 'mark_not_function',
  calleeNode: MExpr,
  args: MExpr[],
  type: Type
};
// ... and so on for every possible local type error.

type MExpr = MLetDeclaration | MCall | MFreeVariable | MInconsistentTypes | ...;
```

### 1.2. The Unknown Type and Provenance (`src/types.ts`)

The core `Type` definition must be changed.

```typescript
// In src/types.ts

// 1. Define Provenance
export type Provenance =
  | { kind: 'user_hole', id: number } // Corresponds to `?` in source
  | { kind: 'expr_hole', id: number } // Corresponds to `□` in source
  | { kind: 'error_free_var', name: string }
  | { kind: 'error_inconsistent', expected: Type, actual: Type }
  | { kind: 'error_unify_conflict', typeA: Type, typeB: Type }; // To be used in Layer 2

// 2. Add the Unknown type to the main Type union
export type Type =
  | { kind: 'var', ... }
  | { kind: 'unknown', provenance: Provenance }
  | ... ;
```

## 2. Refactoring the Inference Engine (`src/infer.ts`, `src/infermatch.ts`)

This is the bulk of the work for Phase 1. The return types of all core inference functions will change from `Type` to `MExpr`. The `Context` object will no longer be needed to track the source text for error reporting, as errors are now part of the return value.

### Example 1: `lookupEnv` and Free Variables

**Current `inferExpr` for identifiers:**
```typescript
// in src/infer.ts
case "identifier": {
  const scheme = lookupEnv(ctx, expr.name);
  return instantiateAndApply(ctx, scheme);
}

// lookupEnv throws an error if not found
function lookupEnv(ctx: Context, name: string): TypeScheme {
  const scheme = ctx.env.get(name);
  if (!scheme) {
    throw inferError(`Unknown identifier '${name}'`);
  }
  return scheme;
}
```

**New implementation:**

The `lookupEnv` function will now return a `TypeScheme` or `null`.

```typescript
// in src/infer.ts
case "identifier": {
  const scheme = lookupEnv(ctx, expr.name);
  if (!scheme) {
    // If not found, create a Mark node.
    const unknownType: Type = { 
      kind: 'unknown', 
      provenance: { kind: 'error_free_var', name: expr.name } 
    };
    // Return the new Mark node instead of the original identifier.
    return { kind: 'mark_free_var', name: expr.name, type: unknownType };
  }
  const type = instantiateAndApply(ctx, scheme);
  // If found, return a valid MIdentifier node, which now also carries its type.
  return { kind: 'identifier', name: expr.name, type: type };
}
```

### Example 2: `unify` and Inconsistent Types

The `unify` function is currently the source of many thrown errors. It will be completely repurposed.

**Current `unifyTypes`:**
```typescript
// in src/infer.ts
function unifyTypes(a: Type, b: Type, subst: Substitution): Substitution {
  // ... complex logic ...
  if (left.kind !== right.kind) {
    throw inferError(`Type mismatch: ...`);
  }
  // ... more logic ...
}
```

**New `unify` for Layer 1:**

In Layer 1, unification is much simpler. It's not trying to solve a system of equations; it's just checking for immediate consistency. The global `unify` function will be removed and its logic integrated directly into call sites.

```typescript
// Example: inside inferExpr for function calls
case "call": {
  const callee: MExpr = inferExpr(ctx, expr.callee);
  const arg: MExpr = inferExpr(ctx, expr.arguments[0]);

  const calleeType = applyCurrentSubst(ctx, callee.type);

  if (calleeType.kind !== 'func') {
    // If the callee is not a function, create a mark.
    // The result has an Unknown type.
    const resultType: Type = { 
      kind: 'unknown', 
      provenance: { kind: 'error_not_function', calleeType } 
    };
    return { kind: 'mark_not_function', calleeNode: callee, args: [arg], type: resultType };
  }
  
  // Check consistency between argument and parameter types
  if (!typesAreConsistent(calleeType.from, arg.type)) {
     // Here we would create an `InconsistentTypes` mark node around the argument.
     // This is a simplification; the real logic from the paper is more nuanced.
  }
  
  // ... if all good, return a valid MCall node.
  return { kind: 'call', callee: callee, args: [arg], type: calleeType.to }
}
```

The key change is a philosophical one: functions in `infer.ts` will no longer be responsible for unification failures. Their job is to check for local consistency and, if it fails, to report that failure by returning a `Mark` node. The responsibility for global consistency will belong entirely to Layer 2.
