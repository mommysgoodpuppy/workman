# Recursive Let Implementation Plan

## Overview
Implement `let rec` and `and` for single and mutually recursive bindings with proper HM type inference.

## Syntax Examples

```javascript
// Single recursion
let rec length = match(list) {
  Cons(_, rest) => { length(rest) + 1 },
  Nil => { 0 }
};

// Mutual recursion
let rec isEven = match(n) {
  0 => { true },
  _ => { isOdd(n - 1) }
}
and isOdd = match(n) {
  0 => { false },
  _ => { isEven(n - 1) }
};
```

## Implementation Phases

### Phase 1: AST Changes ✅ (Simple)

**File:** `src/ast.ts`

```typescript
export interface LetDeclaration extends NodeBase {
  kind: "let";
  name: string;
  parameters: Parameter[];
  annotation?: TypeExpr;
  body: BlockExpr;
  isRecursive: boolean;              // NEW: true for "let rec"
  mutualBindings?: LetDeclaration[]; // NEW: bindings from "and" clauses
}
```

**Rationale:**
- `isRecursive`: Distinguishes `let` from `let rec`
- `mutualBindings`: Stores all `and` bindings in first declaration
- All bindings in a mutual group must be recursive

---

### Phase 2: Lexer Changes ✅ (Trivial)

**File:** `src/token.ts`

```typescript
export const keywords = new Set([
  "let",
  "rec",   // NEW
  "and",   // NEW
  "type",
  "match",
]);
```

---

### Phase 3: Parser Changes 🔧 (Medium Complexity)

**File:** `src/parser.ts`

#### 3.1 Update `parseTopLevel()`

```typescript
private parseTopLevel(): TopLevel {
  const token = this.peek();
  if (token.kind === "keyword") {
    switch (token.value) {
      case "let":
        return this.parseLetDeclaration();
      case "type":
        return this.parseTypeDeclaration();
      default:
        throw this.error(`Unexpected keyword '${token.value}' at top-level`, token);
    }
  }
  throw this.error("Expected top-level declaration");
}
```

#### 3.2 Update `parseLetDeclaration()`

**Current signature:**
```typescript
private parseLetDeclaration(): LetDeclaration
```

**New implementation:**
```typescript
private parseLetDeclaration(): LetDeclaration {
  const letToken = this.expectKeyword("let");
  
  // Check for "rec" keyword
  const isRecursive = this.matchKeyword("rec");
  
  // Parse first binding
  const nameToken = this.expectIdentifier();
  const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
  this.expectSymbol("=");
  const initializer = this.parseExpression();
  
  // Handle first-class match or arrow function
  let parameters: Parameter[];
  let body: BlockExpr;
  
  if (initializer.kind === "match") {
    // First-class match desugaring
    const scrutinee = initializer.scrutinee;
    if (scrutinee.kind !== "identifier") {
      throw this.error("First-class match scrutinee must be a simple parameter name", this.previous());
    }
    parameters = [{
      kind: "parameter",
      name: scrutinee.name,
      annotation: undefined,
      span: scrutinee.span,
    }];
    body = {
      kind: "block",
      statements: [],
      result: initializer,
      span: initializer.span,
    };
  } else if (initializer.kind === "arrow") {
    parameters = initializer.parameters;
    body = initializer.body;
  } else {
    throw this.error("Let declarations must be assigned an arrow function or first-class match", this.previous());
  }
  
  const firstBinding: LetDeclaration = {
    kind: "let",
    name: nameToken.value,
    parameters,
    annotation,
    body,
    isRecursive,
    span: this.spanFrom(letToken.start, body.span.end),
  };
  
  // Parse mutual bindings with "and"
  const mutualBindings: LetDeclaration[] = [];
  while (this.matchKeyword("and")) {
    const andBinding = this.parseAndBinding();
    mutualBindings.push(andBinding);
  }
  
  if (mutualBindings.length > 0) {
    firstBinding.mutualBindings = mutualBindings;
  }
  
  return firstBinding;
}
```

#### 3.3 Add `parseAndBinding()` helper

```typescript
private parseAndBinding(): LetDeclaration {
  const andStart = this.previous().start; // "and" token
  
  const nameToken = this.expectIdentifier();
  const annotation = this.matchSymbol(":") ? this.parseTypeExpr() : undefined;
  this.expectSymbol("=");
  const initializer = this.parseExpression();
  
  // Same logic as parseLetDeclaration for handling match/arrow
  let parameters: Parameter[];
  let body: BlockExpr;
  
  if (initializer.kind === "match") {
    const scrutinee = initializer.scrutinee;
    if (scrutinee.kind !== "identifier") {
      throw this.error("First-class match scrutinee must be a simple parameter name", this.previous());
    }
    parameters = [{
      kind: "parameter",
      name: scrutinee.name,
      annotation: undefined,
      span: scrutinee.span,
    }];
    body = {
      kind: "block",
      statements: [],
      result: initializer,
      span: initializer.span,
    };
  } else if (initializer.kind === "arrow") {
    parameters = initializer.parameters;
    body = initializer.body;
  } else {
    throw this.error("And bindings must be assigned an arrow function or first-class match", this.previous());
  }
  
  return {
    kind: "let",
    name: nameToken.value,
    parameters,
    annotation,
    body,
    isRecursive: true, // All "and" bindings are recursive
    span: this.spanFrom(andStart, body.span.end),
  };
}
```

**Key Points:**
- `and` bindings are always recursive (no need for explicit `rec`)
- Reuse match/arrow parsing logic
- Store all `and` bindings in first declaration's `mutualBindings`

---

### Phase 4: Type Inference Changes 🔥 (Complex)

**File:** `src/infer.ts`

#### 4.1 Current `inferProgram` structure

```typescript
export function inferProgram(program: Program): InferResult {
  resetTypeVarCounter();
  const env: TypeEnv = new Map();
  const adtEnv: TypeEnvADT = new Map();
  const ctx: Context = { env, adtEnv, subst: new Map() };
  const summaries: { name: string; scheme: TypeScheme }[] = [];

  registerPrelude(ctx);

  // Register all type declarations first
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeDeclaration(ctx, decl);
    }
  }

  // Infer all let bindings
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const bindingType = applyCurrentSubst(
        ctx,
        inferLetBinding(ctx, decl.parameters, decl.body, decl.annotation),
      );
      const scheme = generalize(ctx.env, bindingType);
      ctx.env.set(decl.name, scheme);
      summaries.push({ name: decl.name, scheme });
    }
  }

  return { summaries };
}
```

#### 4.2 Update `inferProgram` to handle mutual recursion

```typescript
export function inferProgram(program: Program): InferResult {
  resetTypeVarCounter();
  const env: TypeEnv = new Map();
  const adtEnv: TypeEnvADT = new Map();
  const ctx: Context = { env, adtEnv, subst: new Map() };
  const summaries: { name: string; scheme: TypeScheme }[] = [];

  registerPrelude(ctx);

  // Register all type declarations first
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      registerTypeDeclaration(ctx, decl);
    }
  }

  // Infer all let bindings (now handles recursion)
  for (const decl of program.declarations) {
    if (decl.kind === "let") {
      const results = inferLetDeclaration(ctx, decl); // NEW: returns array
      for (const { name, scheme } of results) {
        ctx.env.set(name, scheme);
        summaries.push({ name, scheme });
      }
    }
  }

  return { summaries };
}
```

#### 4.3 New `inferLetDeclaration` function

**Signature:**
```typescript
function inferLetDeclaration(
  ctx: Context,
  decl: LetDeclaration
): { name: string; scheme: TypeScheme }[]
```

**Algorithm (4 steps):**

```typescript
function inferLetDeclaration(
  ctx: Context,
  decl: LetDeclaration
): { name: string; scheme: TypeScheme }[] {
  
  // === CASE 1: Non-recursive binding ===
  if (!decl.isRecursive) {
    const bindingType = applyCurrentSubst(
      ctx,
      inferLetBinding(ctx, decl.parameters, decl.body, decl.annotation),
    );
    const scheme = generalize(ctx.env, bindingType);
    return [{ name: decl.name, scheme }];
  }
  
  // === CASE 2: Recursive binding(s) ===
  const allBindings = [decl, ...(decl.mutualBindings || [])];
  
  // STEP 1: Pre-bind all names with fresh type variables
  const preBoundTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    const freshVar = freshTypeVar();
    preBoundTypes.set(binding.name, freshVar);
    // Add to environment so recursive calls can find it
    ctx.env.set(binding.name, { quantifiers: [], type: freshVar });
  }
  
  // STEP 2: Infer each body with all names in scope
  const inferredTypes = new Map<string, Type>();
  for (const binding of allBindings) {
    const inferredType = applyCurrentSubst(
      ctx,
      inferLetBinding(ctx, binding.parameters, binding.body, binding.annotation),
    );
    inferredTypes.set(binding.name, inferredType);
  }
  
  // STEP 3: Unify pre-bound types with inferred types
  for (const binding of allBindings) {
    const preBound = preBoundTypes.get(binding.name)!;
    const inferred = inferredTypes.get(binding.name)!;
    unify(ctx, preBound, inferred);
  }
  
  // STEP 4: Apply substitutions and generalize
  const results: { name: string; scheme: TypeScheme }[] = [];
  for (const binding of allBindings) {
    const inferredType = inferredTypes.get(binding.name)!;
    const resolvedType = applyCurrentSubst(ctx, inferredType);
    const scheme = generalize(ctx.env, resolvedType);
    results.push({ name: binding.name, scheme });
  }
  
  return results;
}
```

**Why this works:**

1. **Pre-binding** allows recursive references to resolve
2. **Inference** happens with all names visible
3. **Unification** ensures consistency between assumed and actual types
4. **Generalization** happens after all unification (crucial for mutual recursion)

#### 4.4 Handle type annotations

If a recursive binding has a type annotation, we need to unify with it:

```typescript
// In STEP 3, after unifying pre-bound with inferred:
for (const binding of allBindings) {
  const preBound = preBoundTypes.get(binding.name)!;
  const inferred = inferredTypes.get(binding.name)!;
  unify(ctx, preBound, inferred);
  
  // NEW: Also check annotation if present
  if (binding.annotation) {
    const annotationType = convertTypeExpr(ctx, binding.annotation, new Map());
    unify(ctx, inferred, annotationType);
  }
}
```

---

## Edge Cases & Error Handling

### 1. Non-recursive function calling itself
```javascript
let bad = match(n) {
  0 => { 1 },
  _ => { bad(n - 1) }  // Error: "Unknown identifier 'bad'"
};
```
**Handled by:** Not pre-binding non-recursive functions

### 2. Type mismatch in recursive call
```javascript
let rec bad = match(n) {
  0 => { true },
  _ => { bad(true) }  // Error: unification failure
};
```
**Handled by:** Unification in STEP 3 will fail

### 3. Mutual recursion without `and`
```javascript
let rec isEven = match(n) {
  0 => { true },
  _ => { isOdd(n - 1) }  // Error: "Unknown identifier 'isOdd'"
};
let rec isOdd = ...;
```
**Handled by:** `isOdd` not in scope when inferring `isEven`

### 4. Occurs check in recursive types
```javascript
let rec infinite = () => { infinite };
// Type: T where T = () -> T (infinite type)
```
**Handled by:** Occurs check in unification should catch this

---

## Testing Strategy

### Phase 1: Parser tests
- Parse `let rec` correctly
- Parse `and` bindings
- Reject `and` without `rec`

### Phase 2: Simple recursion
- Factorial
- List length
- Map over list

### Phase 3: Mutual recursion
- Even/odd
- Tree traversal with helper

### Phase 4: Error cases
- Non-recursive calling itself
- Type mismatches
- Missing mutual binding

---

## Implementation Order

1. ✅ AST changes (`ast.ts`)
2. ✅ Lexer changes (`token.ts`)
3. 🔧 Parser changes (`parser.ts`)
   - Update `parseLetDeclaration()`
   - Add `parseAndBinding()`
4. 🔥 Inference changes (`infer.ts`)
   - Update `inferProgram()`
   - Add `inferLetDeclaration()`
   - Update `inferLetBinding()` signature if needed
5. ✅ Enable tests in `recursion_test.ts`
6. 🐛 Debug and fix issues

---

## Known Challenges

### Challenge 1: Generalization timing
**Problem:** When to generalize in mutual recursion?
**Solution:** Generalize AFTER all unification (STEP 4)

### Challenge 2: Environment scoping
**Problem:** Pre-bound types need to be visible during inference
**Solution:** Add to `ctx.env` in STEP 1, update in STEP 4

### Challenge 3: Substitution application
**Problem:** Need to apply substitutions accumulated during inference
**Solution:** Use `applyCurrentSubst()` before generalization

### Challenge 4: First-class match with recursion
**Problem:** First-class match desugars to arrow, need to preserve recursion
**Solution:** Parser already handles this, just pass through `isRecursive`

---

## Success Criteria

- [ ] All 8 recursion tests pass
- [ ] Can write factorial, length, map
- [ ] Mutual recursion (even/odd) works
- [ ] Proper error messages for common mistakes
- [ ] No regression in existing tests (26 tests still pass)
