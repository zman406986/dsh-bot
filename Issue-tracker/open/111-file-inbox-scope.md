# 111 — File-driven external work intake (inbox): PRD amendment + ADR sign-off gate

**Status:** open
**Labels:** needs-triage, ready-for-human
**Related:** ADR-0018 exception B9 (scope source), ADR-0004 (scope additions), `docs/research/prd-vs-reference-capability-gaps.md` Gap 4, companion ADR-0023 draft filed this session

## Problem

The user-directed adaptation set includes upstream's file-driven inbox (MIT upstream-clone evidence: `.scratch/testing/2026-10-02-grokbot-upstream-compare/upstream-clone/src/inbox.mjs`). Recon verdict: the reference tree has NO file-driven intake (zero protocol-artifact hits; Gap 4 records external wake sources as a PRD gap, not reference behavior) → NOT imitation-covered by ADR-0018; it is a scope addition governed by ADR-0004, requiring a PRD §6.4/§7.1 amendment, an agent-drafted ADR, and human sign-off before code (rulebook: move nothing until signed; draft ADR-0017 deviation-approval discipline).

## What to do

- [ ] Human reviews companion ADR draft `docs/adr/0023-file-driven-external-intake.md` (filed this session, status `draft (nonhuman-approved)`).
- [ ] On sign-off: amend PRD §6.4/§7.1 via this ticket, flip the ADR status to accepted (human-ruled, dated), then implement per the ADR.
- [ ] On rejection: move this ticket to cancelled with the ruling recorded.

## Constraints

- **Hard gate — NO implementation before human sign-off.**
- Design constraints already baked into the ADR: A5 (no second store — dedupe/checkpoint in storageDomain), ADR-0012 (boot rescan flows through `rebuildFromDurability` + redrive), ADR-0003 (dispatcher-only spawning; the inbox never spawns directly — jobs enter as the external-event wake source, ticket 06 vocabulary), C15 (file jobs are ordinary dispatched workers), no client UI (ADR-0014 untouched).

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass. This ticket is deliberately human-gated: the inbox is a scope addition (ADR-0004), not imitation (ADR-0018), so the companion ADR-0023 carries the full design as a draft and nothing moves in `src/` until the human rules. Labelled `needs-triage, ready-for-human` for that reason — the next action belongs to the human, not an agent.
