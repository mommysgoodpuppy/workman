# Loop Expressions

## Goal

Add looping constructs to Workman that maintain the language's "sane
programming" philosophy: explicit state, expression-based, no hidden mutation.

## Background: The `if/else` Precedent

Workman's `if/else` was added with strict rules that teach better programming:

- **It's an expression**: `let thing = if cond { a } else { b }`
- **`else` is always required**: Forces exhaustive handling
- **`else if` is banned**: Use `match` for multi-branch logic
- **Under the hood**: Sugar for a bool match

The question: Can loops achieve similar "teach the user sane programming" goals?

## The Problem

Writing a rasterizer (nested X/Y loops) with pure recursion is painful:

```wm
-- Current: Manual recursion with explicit state threading
let rec eventLoop = (running, event) => {
  if (running) {
    let hasEvent = sdl_PollEvent(event);
    let rec processEvents = (hasEvent, running) => {
      if (hasEvent != false) {
        let eventType = zigField(event, "type");
        let newRunning = if (eventType == SDL_EVENT_QUIT) { false } else { running };
        let nextEvent = sdl_PollEvent(event);
        processEvents(nextEvent, newRunning)
      } else {
        running
      }
    };
    let stillRunning = processEvents(hasEvent, running);
    sdl_Delay(16);
    eventLoop(stillRunning, event)
  } else {
    Void
  };
  event
};
```

This works but is verbose and error-prone. The recursion pattern obscures the
intent.

## Proposal: `while` as an Expression

Zig has an interesting construct:

```zig
while (b < 2) : (b += 1) {
    print("b: {}\n", .{b});
}
```

The `: (step)` part runs on every iteration, even on `continue`. This prevents
"forgot to increment" bugs.

Workman can evolve this from a **side-effect** into a **data-flow**:

```wm
let finalBuffer = while (i = 0, buf = buffer) (i < max) : (i + 1, nextBuf) {
  let nextBuf = setPixel(buf, i, color)
} else {
  buf
};
```

## The Rules (Matching `if/else` Philosophy)

1. **It's an expression**: Returns a value, can be used anywhere
2. **`else` is always required**: Defines the exit value
3. **State is declared in the header**: No hidden mutation
4. **The step clause defines the next iteration's values**: Explicit data flow

## Syntax

```
while (state_bindings) (condition) : (next_state) {
  body
} else {
  exit_value
}
```

### Components

- **`state_bindings`**: `(name = initial, ...)` — loop-local state, scoped to
  the loop
- **`condition`**: Boolean expression checked before each iteration
- **`next_state`**: `(expr, ...)` — values for next iteration (matches
  state_bindings arity)
- **`body`**: Runs each iteration, can define bindings used in `next_state`
- **`else`**: Runs when condition is false, returns the loop's value

## Examples

### Simple Counter

```wm
let finalCount = while (i = 0) (i < 100) : (i + 1) {
  std.debug.print("Counter: {}\n", .{ i })
} else {
  i
};
```

### Sum

```wm
let total = while (i = 0, sum = 0) (i < 100) : (i + 1, sum + i) {
  Void
} else {
  sum
};
```

### Pixel Buffer (Rasterizer Use Case)

```wm
let filledBuffer = while (i = 0, buf = buffer) (i < width * height) : (i + 1, nextBuf) {
  let nextBuf = setPixel(buf, i, red)
} else {
  buf
};
```

### Nested Loops

```wm
let frame = while (y = 0, buf = buffer) (y < height) : (y + 1, rowBuf) {
  let rowBuf = while (x = 0, b = buf) (x < width) : (x + 1, nextB) {
    let nextB = setPixel(b, x, y, color)
  } else {
    b
  }
} else {
  buf
};
```

### Event Loop (Rewritten)

```wm
let finalEvent = while (running = true, event = allocStruct(SDL_Event)) (running) : (stillRunning, event) {
  let hasEvent = sdl_PollEvent(event);
  let stillRunning = while (has = hasEvent, run = running) (has != false) : (sdl_PollEvent(event), nextRun) {
    let eventType = zigField(event, "type");
    let nextRun = if (eventType == SDL_EVENT_QUIT) { false } else { run }
  } else {
    run
  };
  sdl_Delay(16)
} else {
  event
};
free(finalEvent);
```

## Why This Is "Sane Programming"

### 1. No Hidden Mutation

You never write `i = i + 1`. You write `: (i + 1, ...)`. State transformation is
explicit in the grammar.

### 2. Scope Control

`i` is born in the header and dies with the loop. To use the final value, you
must explicitly return it via `else`.

### 3. No Infinite Loop by Accident

If you forget the step, the compiler errors. The step is required syntax, not an
afterthought.

### 4. Linear Types Work Naturally

The "shadowing" problem is solved automatically:

```wm
-- The linear checker sees:
-- 'buf' (iteration 0) -> consumed by setPixel -> 'nextBuf'
-- 'nextBuf' -> passed to step -> becomes 'buf' (iteration 1)
```

### 5. It's Sugar for Tail Recursion

```wm
while (state) (cond) : (update) { body } else { exit }
```

Is equivalent to:

```wm
let rec loop = (state) => if (cond) { body; loop(update) } else { exit }
```

## Compilation to Zig

```wm
let total = while (i = 0, sum = 0) (i < 100) : (i + 1, sum + i) {
  Void
} else {
  sum
};
```

Compiles to:

```zig
const total = blk: {
    var i: i32 = 0;
    var sum: i32 = 0;
    while (i < 100) {
        // body (Void)
        
        // step
        const next_i = i + 1;
        const next_sum = sum + i;
        i = next_i;
        sum = next_sum;
    } else {
        break :blk sum;
    }
};
```

## Addendum: `for` is Banned (With Helpful Error)

If a user tries to write a traditional `for` loop, the compiler rejects it with
a helpful message explaining how to rewrite it.

### The Error

```
error: `for` loops are not supported in Workman

  for (i in items) { ... }
  ^^^

Workman uses `map` for iteration over collections:

  -- Instead of:
  for (item in items) {
    doSomething(item)
  }

  -- Write:
  let results = map(items, (item) => doSomething(item))

  -- Or with explicit index:
  let results = mapIndexed(items, (i, item) => doSomething(i, item))

  -- For side effects only:
  forEach(items, (item) => print(item))

  -- For accumulating a value:
  let total = fold(items, 0, (acc, item) => acc + item)

Why? `for` loops hide mutation and make ownership unclear.
`map`/`fold` make data flow explicit: input -> transform -> output.

See: https://workman-lang.org/docs/iteration
```

### Why This Matters

In imperative languages, `for` loops encourage:

- Mutating variables from outer scope
- Unclear ownership (who owns `item`? is it copied? borrowed?)
- Side effects scattered through the loop body

By banning `for` and pointing to `map`/`fold`, users learn:

- **`map`**: Transform each element, get new collection
- **`fold`**: Accumulate elements into a single value
- **`forEach`**: Side effects only (returns `Void`)
- **`filter`**: Keep elements matching predicate

### The Escape Hatch

For performance-critical code or FFI, `while` with explicit state is available:

```wm
-- When you really need index-based iteration with mutation
let result = while (i = 0, acc = initial) (i < len(items)) : (i + 1, nextAcc) {
  let item = get(items, i);
  let nextAcc = process(acc, item)
} else {
  acc
};
```

This is verbose on purpose — it signals "I'm doing something low-level."

## Open Questions

1. **Syntax for step**: Is `: (next_state)` clear enough? Alternatives:
   - `-> (next_state)`
   - `then (next_state)`
   - `with (next_state)`

2. **Early exit**: Should `break value` be supported? Or is that against the FP
   philosophy?

3. **Continue**: Should `continue` be supported? In this model, you'd just...
   not change the state?

4. **Void body**: When body is just for side effects, is `Void` the right way to
   express it?

## Summary

| Feature            | `if/else`  | `while/else`        |
| ------------------ | ---------- | ------------------- |
| Expression         | ✓          | ✓                   |
| `else` required    | ✓          | ✓                   |
| Explicit state     | N/A        | ✓ (header bindings) |
| No hidden mutation | ✓          | ✓ (step clause)     |
| Sugar for          | bool match | tail recursion      |

By calling it `while`, users understand it immediately. But the required `else`
and explicit state header forces functional thinking. You're teaching them that
**a loop is just a specialized way to fold data over time**.
