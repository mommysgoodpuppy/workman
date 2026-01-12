# Standard Library Surface (Semi-Normative)

This section defines only the standard library behaviors that affect program
semantics.

The full stdlib API reference should live elsewhere. This chapter should remain
small and focused.

---

## Core Types

At minimum, canonical Workman expects standard definitions for:
- `Option<T>`
- `Result<T, E>` and infectious `IResult<T, E>`
- infectious `IOption<T>`

These definitions are semantically significant because they interact with:
- pattern matching (coverage)
- infection propagation/discharge (carriers)

### Result vs IResult (Normative)

- `Result<T, E>` behaves like a conventional algebraic result type in other
  languages (explicit success/failure value).
- `IResult<T, E>` is identical in shape and meaning to `Result<T, E>`, but is
  **infectious**: it propagates through expressions according to the infection
  rules.

Guidance:
- Use `Result` when you want explicit, local handling and no automatic
  propagation.
- Use `IResult` when you want automatic propagation through ordinary
  expressions.

### Option vs IOption (Normative)

- `Option<T>` behaves like a conventional option type in other languages.
- `IOption<T>` is identical in shape and meaning to `Option<T>`, but is
  **infectious**: it propagates through expressions according to the infection
  rules.

---

## IO and Effects

If IO is exposed, the manual must specify:
- what is considered observable output
- how IO interacts with infection domains (if at all)

This chapter is intentionally incomplete until the IO surface is stabilized.
