# Workman Infection Guide

A practical guide to Workman's infectious/carrier type system. This guide
focuses on the **effect domain** (Option, IResult) which covers most everyday
programming needs.

> **Note:** The infection system is actually a general-purpose constraint solver
> DSL that can model many things beyond error handling: async/await, memory
> safety (non-linear types), typeclass-like constraints, and Hazel-style typed
> holes. Each domain has its own semantics defined in
> `std/infection/domains.wm`. This guide focuses on practical usage; see
> [Advanced: The General System](#advanced-the-general-system) for the bigger
> picture.

---

## Table of Contents

- [What Are Infectious Types?](#what-are-infectious-types)
- [Core Concepts](#core-concepts)
- [Built-in Infectious Types](#built-in-infectious-types)
- [Defining Custom Infectious Types](#defining-custom-infectious-types)
- [Programming Patterns](#programming-patterns)
- [Discharging Infection](#discharging-infection)
- [Common Pitfalls](#common-pitfalls)
- [Advanced: The General System](#advanced-the-general-system)

---

## What Are Infectious Types?

Infectious types are Workman's approach to effect tracking. They automatically
propagate through computations without requiring explicit `bind`, `flatMap`, or
`>>=` operations.

```workman
-- In other languages, you'd write:
let result = parseNumber(input).flatMap(n => validate(n)).flatMap(n => process(n));

-- In Workman, effects propagate automatically:
let result = process(validate(parseNumber(input)));
```

The key insight: when a value is "infected" with an effect (like an error or
taint), that effect automatically propagates through any function that uses the
value.

---

## Core Concepts

### Carriers and Domains

An **infectious type** is a "carrier" that wraps a value along with effect
information. Each carrier belongs to a **domain** that defines its behavior:

| Domain   | Purpose                  | Example Types                |
| -------- | ------------------------ | ---------------------------- |
| `effect` | Error handling           | `IResult<T, E>`, `Option<T>` |
| `taint`  | Data flow tracking       | `Tainted<T, S>`              |
| `async`  | Async operations         | `Promise<T, E>`              |
| `mem`    | Memory/resource tracking | `Mem<T, S>`                  |
| `hole`   | Incomplete code          | `Hole<T, H>`                 |

### Value vs Effect Constructors

Each infectious type has two kinds of constructors:

- **`@value` constructor**: Carries the "happy path" value (e.g., `Some`, `IOk`)
- **`@effect` constructor**: Carries the effect/error (e.g., `None`, `IErr`)

```workman
-- Option: Some is @value, None is @effect
infectious effect type Option<T> = @value Some<T> | @effect None;

-- IResult: IOk is @value, IErr is @effect  
infectious effect type IResult<T, E> = @value IOk<T> | @effect IErr<E>;
```

### Auto-Unwrap and Short-Circuit

When you pass an infectious value to a function:

1. **If `@value`**: The payload is automatically extracted and passed
2. **If `@effect`**: The computation short-circuits, returning the effect

```workman
let double = (x) => { x * 2 };

-- With Some(5): extracts 5, computes 10, re-wraps as Some(10)
double(Some(5))  -- => Some(10)

-- With None: short-circuits immediately
double(None)     -- => None
```

---

## Built-in Infectious Types

### Option<T>

For values that may or may not exist.

```workman
from "std/coretypes" import { Some, None };

let safeDivide = (a, b) => {
  if (b == 0) {
    None
  } else {
    Some(a / b)
  }
};

-- None propagates automatically
let result = safeDivide(10, 0);  -- None
let doubled = double(result);     -- Still None (short-circuited)
```

### IResult<T, E>

For operations that can fail with typed errors.

```workman
from "std/coretypes" import { IOk, IErr };

type ParseError = InvalidFormat | EmptyInput;

let parseNumber = (input) => {
  match(input) {
    "" => { IErr(EmptyInput) },
    _ => { IOk(42) }  -- simplified
  }
};

-- Errors propagate through the pipeline
let process = (input) => {
  let n = parseNumber(input);  -- IResult<Int, ParseError>
  let doubled = n * 2;         -- Still IResult (infection propagates)
  doubled + 10                 -- Still IResult
};
```

### Promise<T, E>

For async operations (integrates with JavaScript promises).

```workman
from "std/coretypes" import { Resolved, Rejected };

infectious async type Promise<T, E> = 
    | @value Resolved<T>
    | @effect Rejected<E>;
```

---

## Defining Custom Infectious Types

Use the `infectious` keyword with a domain:

```workman
-- Syntax: infectious <domain> type Name<T, S> = @value Ctor<T> | @effect Ctor<S>;

-- Taint tracking for security
infectious taint type Tainted<T, S> = @value Clean<T> | @effect Dirty<S>;

type TaintSource = UserInput | NetworkData | FileData;

let readUserInput = () => {
  Dirty(UserInput)  -- Mark as tainted
};

let sanitize = (data) => {
  -- Taint automatically propagates through operations on data
  data
};
```

---

## Programming Patterns

### Sequential Composition (Then)

When each step depends on the previous, infection handles it automatically:

```workman
-- Parse, validate, then process - errors propagate automatically
let pipeline = (input) => {
  let parsed = parseNumber(input);      -- IResult<Int, ParseError>
  let validated = validate(parsed);      -- IResult<Int, ValidationError>
  let processed = process(validated);    -- IResult<Int, ProcessError>
  processed
};
```

This is like monadic `bind`/`>>=` but without the syntax overhead.

### Alternative Composition (Or)

When you want to try alternatives until one succeeds, use `alt`:

```workman
from "std/option" import { alt };

-- alt: try first, if None then try fallback
-- Signature: (Option<T>, () -> Option<T>) -> Option<T>

let findConfig = () => {
  loadFromEnv()
    :> alt( => { loadFromFile() })
    :> alt( => { loadDefaults() })
};
```

**Important**: `alt` uses pattern matching internally to discharge the infection
before checking, preventing premature short-circuiting.

```workman
-- How alt works (from std/option):
let alt = match(option, fallback) => {
  (Some(value), fallback) => { Some(value) },
  (None, fallback) => { fallback() }
};
```

### Pipe Operator with Infection

The `:>` pipe operator works naturally with infectious types:

```workman
-- Value flows through, infection propagates
let result = input
  :> parseNumber
  :> validate
  :> process;

-- With alternatives using alt
let symbol = tryMatch2(state, "=>", TkArrow)
  :> alt( => { tryMatch2(state, "->", TkThinArrow) })
  :> alt( => { tryMatch1(state, ".", TkDot) });
```

### Accumulating Effects

Effects from multiple branches are automatically merged:

```workman
let combine = (a, b) => {
  let x = parseA(a);  -- IResult with error row <ParseError|...>
  let y = parseB(b);  -- IResult with error row <OtherError|...>
  x + y               -- Error rows are unioned: <ParseError|OtherError|...>
};
```

---

## Discharging Infection

To "discharge" or handle an infection, use pattern matching:

```workman
-- Pattern matching on the carrier discharges the infection
let handleResult = (result) => {
  match(result) {
    IOk(value) => { 
      -- value is now plain Int, not IResult<Int, E>
      print(value)
    },
    IErr(error) => {
      print("Error occurred")
    }
  }
};

-- The return type is no longer infectious (both branches return Void)
```

### Partial Discharge

You can handle some cases and let others propagate:

```workman
let retryOnEmpty = (result) => {
  match(result) {
    IErr(EmptyInput) => { parseNumber(getDefault()) },  -- Retry
    other => { other }  -- Let other errors propagate
  }
};
```

### Using withDefault / getOrElse

For Option types, extract with a default:

```workman
from "std/option" import { withDefault };

let value = maybeNumber :> withDefault(0);  -- Int, not Option<Int>
```

---

## Common Pitfalls

### 1. Forgetting That Infection Propagates

```workman
-- ❌ This still returns IResult, not Int!
let process = (input) => {
  let n = parseNumber(input);
  n * 2  -- Infection propagates
};

-- ✅ Discharge if you need a plain value
let process = (input) => {
  match(parseNumber(input)) {
    IOk(n) => { n * 2 },
    IErr(_) => { 0 }
  }
};
```

### 1b. Accessing Error Payload Fields

The `@effect` payload is still a normal value. You can project fields from it
after matching, as long as the record definition is in scope:

```workman
from "./parser.wm" import { parseProgram };
from "./ast.wm" import { ParseError };

match (parseProgram(source)) {
  IOk(_) => { () },
  IErr(err) => { err.message }
};
```

### 2. Using orElse Instead of alt for Piping

The standard `orElse` has signature `(fallback, option)` - fallback first. For
piping, use `alt` which has `(option, fallback)`:

```workman
-- ❌ Wrong order for piping
tryA() :> orElse( => { tryB() })  -- Type error!

-- ✅ Use alt for pipe-friendly alternative
tryA() :> alt( => { tryB() })
```

### 3. Short-Circuit Happens Before Function Call

When passing an infected value to a function, short-circuit happens at the call
site, not inside the function:

```workman
let log = (x) => {
  print("Processing...");  -- This won't print if x is None/IErr!
  x
};

log(None)  -- Short-circuits before print executes
```

### 4. Nested Infectious Types

Be careful with nested carriers - they don't automatically flatten:

```workman
let nested = () => {
  let outer = parseOuter(input);   -- IResult<T, E1>
  let inner = parseInner(outer);   -- IResult<IResult<T, E2>, E1> ← nested!
  inner
};

-- Use flatMap or explicit matching to flatten
```

---

## Quick Reference

| Pattern     | Use Case              | Example                                          |
| ----------- | --------------------- | ------------------------------------------------ |
| Sequential  | A then B then C       | `let c = doC(doB(doA(x)))`                       |
| Alternative | A or else B           | `doA() :> alt( => { doB() })`                    |
| Discharge   | Handle infection      | `match(x) { IOk(v) => {...}, IErr(e) => {...} }` |
| Default     | Extract with fallback | `x :> withDefault(0)`                            |
| Transform   | Map over value        | `x :> map(fn)`                                   |

| Function      | Signature                                    | Purpose                      |
| ------------- | -------------------------------------------- | ---------------------------- |
| `alt`         | `(Option<T>, () -> Option<T>) -> Option<T>`  | Pipe-friendly alternative    |
| `orElse`      | `(() -> Option<T>, Option<T>) -> Option<T>`  | Alternative (fallback first) |
| `withDefault` | `(T, Option<T>) -> T`                        | Extract or use default       |
| `map`         | `((T -> U), Option<T>) -> Option<U>`         | Transform inner value        |
| `flatMap`     | `((T -> Option<U>), Option<T>) -> Option<U>` | Chain with flattening        |

---

## Advanced: The General System

The infection system is far more general than just error handling. Under the
hood, it's a **constraint solver DSL** where each domain defines its own
semantics for how "state" (the second type parameter) propagates and merges.

### Domain Definitions

Domains are declared in `std/infection/domains.wm` with properties like:

```workman
domain effect {
  stateKind rowSet;      -- State is a set of error tags
  merge singleton;       -- Single carrier per expression
  mergeRow union;        -- Merge states via set union
  boundary mustBeCarrier; -- At function boundaries, must be wrapped
  conflict none;         -- No conflict detection
};

domain mem {
  stateKind rowBag;      -- State is a bag (multiset) of tags
  merge singleton;
  mergeRow bagUnion;
  infectsReturn false;   -- Doesn't auto-wrap return values
  default {
    target arg0;
    requiresNot [Closed]; -- Can't use closed resources
  };
};
```

### Beyond Error Handling

| Domain   | Models                  | Key Semantics                                     |
| -------- | ----------------------- | ------------------------------------------------- |
| `effect` | Result/Option monads    | Short-circuit on `@effect`, union error rows      |
| `async`  | Promises/Futures        | Await integration, rejection propagation          |
| `mem`    | Resource tracking       | Scope-based constraints (not linear/affine types) |
| `taint`  | Information flow        | Security labels propagate through data flow       |
| `hole`   | Hazel-style typed holes | `?` expressions carry incomplete-code markers     |

### Memory Safety Example

The `mem` domain enables resource tracking via **scope-based constraints**
rather than linear/affine types. Resources are tracked with state tags, and
policies enforce constraints at scope boundaries:

```workman
from "std/zig/rawmem" import { allocStruct, free };

-- Ptr<T, S> is infectious in the mem domain
-- S tracks state: <Opened|Closed|...>

let example = () => {
  let ptr = allocStruct(MyType);  -- Ptr<MyType, <Opened>>
  use(ptr);                        -- Works: ptr is Opened
  free(ptr);                       -- Ptr<MyType, <Opened|Closed>>
  use(ptr);                        -- Error! requiresNot [Closed] fails
};

-- Policy enforcement at function boundaries
policy noLeakMem {
  domain mem;
  requireAtReturn [Closed];  -- All allocations must be freed by scope exit
};
```

This is intentionally **not** linear types - you can freely alias and copy
pointers. Instead, the constraint system tracks what operations have been
performed and enforces policies at scope boundaries (local) or module boundaries
(global).

### Typed Holes

The `hole` domain powers Workman's `?` syntax (inspired by Hazel):

```workman
let incomplete = (x: Int): String => {
  ?  -- Type hole: compiler knows this must be String
};

-- Holes propagate through expressions
let result = incomplete(42) ++ " suffix";  -- Still has hole infection
```

Holes let you write incomplete programs that still typecheck, enabling
incremental development and better IDE support.

### Defining Custom Domains

For advanced use cases, you can define custom domains with specific semantics:

```workman
-- Hypothetical permission tracking domain
domain permission {
  stateKind rowSet;
  merge singleton;
  mergeRow intersection;  -- Permissions narrow, not widen
  boundary mustBeCarrier;
};

infectious permission type Permitted<T, P> = @value Allowed<T> | @effect Denied<P>;
```

### Operations and Policies

Domains can have associated operations with custom state transitions:

```workman
-- Operation metadata (affects type inference)
export op mem.allocStruct {
  domain mem;
  adds [Opened];  -- Adds Opened tag to state
};

export op mem.free {
  domain mem;
  target arg0;    -- Operates on first argument
  adds [Closed];  -- Adds Closed tag
};

-- Policies enforce constraints at boundaries
policy pure {
  rejectsAllDomains;  -- No effects allowed
};
```

---

## Further Reading

- `std/coretypes.wm` - Built-in infectious type definitions
- `std/infection/domains.wm` - Domain semantics declarations
- `std/zig/rawmem.wm` - Memory domain usage example
- `plans/INFECTION_REFACTOR_PLAN_V3.md` - Design documentation
