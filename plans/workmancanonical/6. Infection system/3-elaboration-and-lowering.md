# Elaboration and Lowering (Normative Boundary)

This section defines the boundary between:
- what the language **means**
- what a compiler is allowed to **desugar/elaborate**

Canonical Workman allows compilers to elaborate programs into an explicit IR,
but that elaboration must preserve the defined semantics.

---

## Desugaring vs Semantics

Normative:
- If two surface programs are defined as equivalent by this manual, they must
  behave identically in all conforming implementations.
- If the manual does not state an equivalence, compilers must not silently
  change behavior under “desugaring”.

Examples of intended sugar (must be specified elsewhere):
- `if/else` as sugar for boolean `match`
- operator syntax as sugar for function calls

---

## Infection Elaboration

Compilers may implement infection by elaborating into explicit operations
(e.g., carrier call/match helpers), but:

- The manual must define when infection propagation happens.
- Elaborated forms must be observationally equivalent to the surface program.

This chapter is where we prevent “the compiler happens to do X today” from
becoming accidental language behavior.

