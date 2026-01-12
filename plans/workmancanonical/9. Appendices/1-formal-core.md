# Formal Core (Appendix, Draft)

This appendix will define a small “core calculus” for canonical Workman.

Purpose:
- Provide a canonical meaning for tricky features (match coverage, infection).
- Serve as a target for conformance tests and future executable/reference
  semantics.

Non-goal:
- Fully formalize the entire surface syntax. The surface can be desugared into
  this core.

---

## Planned Core Constructs

Expressions:
- literals, variables
- lambda/application
- let / let-rec
- tuples, records (or a simpler product encoding)
- algebraic data + match
- explicit infection/carrier operations (or explicit typing judgements)

Typing:
- HM scheme rules for `let`
- pattern typing rules
- infection constraint rules

Evaluation:
- small-step or big-step semantics with fixed evaluation order

---

## Relationship to Match Design

The rigorous match model (inverse clauses, conjunction, coverage proofs) should
be captured here once stabilized.

See:
- `plans/coreirRefactor/match_refactor_plan.md`

