# Canonical Workman Plans

This directory contains planning and specification documents for **canonical
Workman** (the base language definition that future implementations should
conform to).

The reference manual is organized as numbered folders (e.g. `1. Front matter`)
so sections can evolve independently without turning into a single giant file.

Optional combined view:
- `canonical.md` is a generated concatenation of these section files.
- Generate/update it by running: `deno run -A combine_md.ts`
- Treat `plans/workmancanonical/**` as the source of truth.

Start here:
- `plans/workmancanonical/plan.md` (high-level intent and deliverables)
- `plans/workmancanonical/1. Front matter/1-introduction.md` (conformance terms)
