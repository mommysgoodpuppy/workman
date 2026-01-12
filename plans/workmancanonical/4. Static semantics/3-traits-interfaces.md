# Traits / Interfaces (Reserved)

Canonical Workman may eventually support trait/typeclass-style constraints, but
this is currently reserved and not part of the minimal canonical core.

If traits are added:
- They must integrate with HM inference without ad hoc backend hooks.
- They should likely reuse the infection domain registry concepts, but remain
  constraints/evidence (not value-wrapping).

This section is intentionally incomplete.

