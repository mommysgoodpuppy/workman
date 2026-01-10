# Formatter Rewrite Plan

## Current Problems

The existing `tools/fmt.ts` (2191 lines) has several architectural issues:

1. **Monolithic class** - Single `Formatter` class with 100+ methods
2. **Mixed concerns** - Formatting logic, layout decisions, comment handling, indentation all intertwined
3. **Special cases everywhere** - Complex conditionals for multi-line vs single-line decisions
4. **Hard to test** - Private methods, tightly coupled state
5. **Hard to extend** - Adding new formatting rules requires modifying the class
6. **Source preservation logic** - Mixed with formatting logic (checking original source for hints)

## Goals for Workman Rewrite

1. **Modular** - Separate files for different concerns
2. **Declarative** - Use pattern matching for AST nodes
3. **Composable** - Small, testable functions
4. **Clear pipeline** - AST → Layout → Format → Output
5. **Maintainable** - Easy to understand and modify

## Proposed Architecture

### Module Structure

```
tools/fmt/
├── fmt.wm              # Main entry point, CLI handling
├── format/
│   ├── expr.wm         # Expression formatting
│   ├── decl.wm         # Declaration formatting
│   ├── pattern.wm      # Pattern formatting
│   ├── type.wm         # Type expression formatting
│   └── comment.wm      # Comment handling
├── layout/
│   ├── decision.wm     # Multi-line vs single-line decisions
│   └── indent.wm       # Indentation management
├── output/
│   ├── context.wm     # Output context (replaces FormatContext)
│   └── builder.wm     # String building utilities
└── preserve/
    └── source.wm      # Source preservation hints
```

### Core Design Principles

#### 1. Separation of Concerns

**Formatting** (what to format):
- Pure functions that take AST nodes and return formatted strings
- No knowledge of layout decisions
- No knowledge of indentation

**Layout** (how to arrange):
- Functions that decide multi-line vs single-line
- Functions that decide spacing/blank lines
- Based on AST structure and size, not source

**Output** (how to write):
- Context management (indentation, newlines)
- String building
- No knowledge of AST structure

#### 2. Pattern Matching

Use Workman's match expressions extensively:

```workman
let formatExpr = (expr: Expr) => {
  match expr {
    .{ kind = "identifier", name = n } => n
    | .{ kind = "literal", literal = lit } => formatLiteral(lit)
    | .{ kind = "call", callee = c, args = args } => formatCall(c, args)
    | .{ kind = "binary", left = l, operator = op, right = r } => 
        formatBinary(l, op, r)
    | ...
  }
};
```

#### 3. Composable Functions

Small, focused functions that can be combined:

```workman
let formatCall = (callee: Expr, args: List<Expr>) => {
  let calleeStr = formatExpr(callee);
  let argsStr = formatArgs(args);
  let layout = decideCallLayout(calleeStr, argsStr);
  match layout {
    Inline => formatCallInline(calleeStr, argsStr)
    | Multiline => formatCallMultiline(calleeStr, argsStr)
  }
};
```

#### 4. Layout Decision Types

Create types for layout decisions:

```workman
type Layout =
  | Inline
  | Multiline
  | ForceInline
  | ForceMultiline;

type BlockLayout = {
  needsBraces: Bool,
  layout: Layout
};
```

### Detailed Module Breakdown

#### `format/expr.wm`

Format expressions. Pure functions, no side effects.

```workman
export let formatExpr = (expr: Expr) => {
  match expr {
    .{ kind = "identifier", name = n } => n
    | .{ kind = "literal", literal = lit } => formatLiteral(lit)
    | .{ kind = "call", callee = c, args = args } => 
        formatCall(c, args)
    | .{ kind = "binary", left = l, operator = op, right = r } => 
        formatBinary(l, op, r)
    | .{ kind = "block", ... } => formatBlock(expr)
    | .{ kind = "if", ... } => formatIf(expr)
    | .{ kind = "match", ... } => formatMatch(expr)
    | ...
  }
};

let formatLiteral = (lit: Literal) => {
  match lit {
    .{ kind = "int", value = v } => toString(v)
    | .{ kind = "bool", value = v } => toString(v)
    | .{ kind = "string", value = v } => formatString(v)
    | .{ kind = "unit" } => "()"
    | ...
  }
};
```

#### `layout/decision.wm`

Decide layout based on AST structure and size.

```workman
export type LayoutDecision =
  | Inline
  | Multiline
  | ForceInline
  | ForceMultiline;

export let decideCallLayout = (callee: String, args: List<String>) => {
  let totalLength = length(callee) + sum(map(length, args)) + 
                    (length(args) * 2); -- commas and spaces
  if totalLength > 80 {
    Multiline
  } else {
    Inline
  }
};

export let decideBlockLayout = (block: BlockExpr) => {
  if block.statements.length > 0 {
    Multiline
  } else if block.result {
    let resultStr = formatExpr(block.result);
    if containsNewline(resultStr) {
      Multiline
    } else {
      Inline
    }
  } else {
    Inline
  }
};
```

#### `output/context.wm`

Manage output state (indentation, newlines).

```workman
export record OutputContext = {
  indentLevel: Int,
  indentSize: Int,
  newline: String,
  buffer: List<String>
};

export let write = (ctx: OutputContext, text: String) => {
  -- Add text with proper indentation
  ...
};

export let writeLine = (ctx: OutputContext, text: String) => {
  -- Add text and newline
  ...
};

export let withIndent = (ctx: OutputContext, f: (OutputContext) => OutputContext) => {
  -- Temporarily increase indent
  ...
};
```

#### `format/comment.wm`

Handle all comment-related formatting.

```workman
export let formatLeadingComments = (comments: List<CommentBlock>) => {
  map(formatCommentBlock, comments)
};

export let formatInlineComment = (text: String) => {
  if startsWith(text, "--") {
    " " ++ text
  } else {
    " -- " ++ text
  }
};

export let formatCommentBlock = (block: CommentBlock) => {
  match block {
    .{ rawText = Some(raw) } => raw
    | .{ text = t } => "-- " ++ t
  }
};
```

### Pipeline Flow

```
1. Parse AST (existing parser)
   ↓
2. Format AST nodes (format/*.wm)
   - Each node type has a formatter
   - Returns formatted strings
   ↓
3. Make layout decisions (layout/decision.wm)
   - Decide inline vs multiline
   - Decide spacing
   ↓
4. Build output (output/context.wm)
   - Apply indentation
   - Join with newlines
   - Handle comments
   ↓
5. Verify (preserve/source.wm)
   - Check only whitespace changed
   - Optional: preserve some formatting hints
```

### Key Simplifications

1. **Remove source preservation complexity**
   - Don't check original source for formatting hints
   - Format purely based on AST structure
   - Simpler, more predictable

2. **Unified layout decisions**
   - Single place for "should this be multiline?"
   - Based on length, structure, not source

3. **Pattern matching everywhere**
   - No big if/else chains
   - Exhaustive matching (compiler checks)

4. **Functional composition**
   - Small functions compose into larger ones
   - Easy to test in isolation

### Migration Strategy

1. **Phase 1: Core infrastructure**
   - Create module structure
   - Implement `output/context.wm`
   - Implement basic `format/expr.wm` for simple expressions

2. **Phase 2: Expression formatting**
   - Implement all expression formatters
   - Add layout decisions
   - Test against existing formatter

3. **Phase 3: Declaration formatting**
   - Implement declaration formatters
   - Handle imports, exports
   - Handle comments

4. **Phase 4: Integration**
   - Replace TypeScript formatter
   - Update CLI
   - Full test suite

5. **Phase 5: Cleanup**
   - Remove old TypeScript code
   - Optimize
   - Documentation

### Testing Strategy

1. **Unit tests** for each formatter function
2. **Integration tests** comparing output with TypeScript formatter
3. **Regression tests** using existing format test fixtures
4. **Property tests** (format then parse should be idempotent)

### Estimated Size Reduction

Current: ~2191 lines in one file

Expected breakdown:
- `fmt.wm`: ~100 lines (CLI)
- `format/expr.wm`: ~300 lines
- `format/decl.wm`: ~200 lines
- `format/pattern.wm`: ~100 lines
- `format/type.wm`: ~150 lines
- `format/comment.wm`: ~100 lines
- `layout/decision.wm`: ~150 lines
- `layout/indent.wm`: ~50 lines
- `output/context.wm`: ~150 lines
- `output/builder.wm`: ~50 lines
- `preserve/source.wm`: ~100 lines

**Total: ~1450 lines** across 11 focused modules

Benefits:
- Each module is <300 lines (much more manageable)
- Clear separation of concerns
- Easy to find and modify specific formatting rules
- Better testability

### Open Questions

1. **Source preservation**: How much original formatting should we preserve?
   - Option A: None (pure AST-based formatting)
   - Option B: Preserve some hints (blank lines, some spacing)
   - Recommendation: Start with A, add B if needed

2. **Operator formatting**: How to handle custom operators?
   - Need operator info from module graph (like current formatter)
   - Can we simplify this?

3. **Comment preservation**: How to handle comment formatting?
   - Current: Preserve raw text when possible
   - Alternative: Always reformat comments
   - Recommendation: Preserve raw text for now

4. **Error handling**: How to handle parse errors during formatting?
   - Current: Format what we can, error on parse failures
   - Keep same approach?

### Next Steps

1. Review and refine this plan
2. Create module structure
3. Start with `output/context.wm` (simplest, most foundational)
4. Implement basic expression formatting
5. Iterate and test
