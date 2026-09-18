# 74 — Clarify A5 ID collision between ADR-0018 exception list and deviations register

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** none
**Related:** ADR-0018 (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md`, accepted human-ruled 2026-09-18), `docs/adr/README.md` (0018 row), `docs/research/dsh-core-loop-deviations.md` (Part A row A-5)

## Problem

The identifier "A5" carries **two different meanings** in and around the same accepted ADR:

1. ADR-0018's exception list, item 3: "**A5** — Persistence stays in dsh's session/job store; no second database."
2. The deviations register (`docs/research/dsh-core-loop-deviations.md`) Part A row "**A-5**" — "Todo list stays the dispatcher's private ledger" (reclassified 2026-09-18 as a conformance, not a deviation).

One ID, two meanings: a reader following "A5" from the ADR's own register-re-base note (which cites A-5/A-6) lands on the wrong item. ADR-0016→0018 renumbered nothing, so the collision is baked into the accepted text.

## Policy constraint

ADR-0018 is an **accepted human ruling** — its text must not be edited, renumbered, or annotated in place. The fix is clarifying notes in the adjacent living documents only.

## Acceptance criteria

- [x] `docs/adr/README.md`'s 0018 section carries a dated clarifying note: exception-list item "A5" (persistence in dsh's store) and register row "A-5" (todo private ledger) are distinct identifiers that happen to collide; the register remains authoritative for deviations. → README.md, dated note directly under the "ADR 0018 … master rule" paragraph
- [x] `docs/research/dsh-core-loop-deviations.md` gains a one-line dated cross-reference at the top noting the same. → new dated blockquote directly under the file title
- [x] The ADR file itself is byte-for-byte untouched (`git diff` shows no change to `docs/adr/0018-*.md`). → this commit's changed-file list contains only README.md, the register, and this ticket

## Comments

### 2026-09-19 — resolved (hygiene pass; filed, triaged, and fixed in the same session)

**Fix:** two clarifying notes, zero edits to the accepted ADR. (1) `docs/adr/README.md` — a dated "identifier note (ticket 74)" appended under its ADR-0018 paragraph stating that exception-list item **A5** (persistence in dsh's session/job store) and register row **A-5** (todo private ledger) are distinct identifiers that happen to collide and that the register remains authoritative for deviations. (2) `docs/research/dsh-core-loop-deviations.md` — a one-line dated blockquote under the title noting the same collision. `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` was read for evidence (line 25 exception item 3; line 46 register re-base note) but not modified — policy: accepted human ADR text is immutable; clarification lives in the adjacent living documents.

**Evidence:** the commit that adds this ticket (fix + resolution land together; locate via `git log --oneline -- Issue-tracker/resolved/74-*`) shows exactly three changed paths: `docs/adr/README.md`, `docs/research/dsh-core-loop-deviations.md`, and this ticket's move to `resolved/`. No product code touched.

**Triage note:** filed `needs-triage` and resolved in-session per the housekeeping ruling — docs-only, zero-risk, no behavioural surface.
