# 111 — File-driven external work intake (inbox): PRD amendment + ADR sign-off gate

**Status:** resolved
**Labels:** needs-triage, ready-for-human
**Related:** ADR-0018 exception B9 (scope source), ADR-0004 (scope additions), `docs/research/prd-vs-reference-capability-gaps.md` Gap 4, ADR-0023 (accepted 2026-10-02, human-ruled — companion ADR)

## Problem

The user-directed adaptation set includes upstream's file-driven inbox (MIT upstream-clone evidence: `.scratch/testing/2026-10-02-grokbot-upstream-compare/upstream-clone/src/inbox.mjs`). Recon verdict: the reference tree has NO file-driven intake (zero protocol-artifact hits; Gap 4 records external wake sources as a PRD gap, not reference behavior) → NOT imitation-covered by ADR-0018; it is a scope addition governed by ADR-0004, requiring a PRD §6.4/§7.1 amendment, an agent-drafted ADR, and human sign-off before code (rulebook: move nothing until signed; draft ADR-0017 deviation-approval discipline).

## What was decided/done

- [x] Human reviewed companion ADR `docs/adr/0023-file-driven-external-intake.md` — **APPROVED by the human in session, 2026-10-02**; ADR-0023 status flipped to `accepted (human-ruled, 2026-10-02 in-session directive)` (body untouched per the accepted-ADR immutability convention).
- [x] On sign-off: PRD §6.4/§7.1 amended via this ticket (minimal dated ticket-111 amendments referencing ADR-0023); implementation proceeds per the ADR.
- [ ] On rejection: move this ticket to cancelled with the ruling recorded — **moot: the human approved**.

## Constraints

- **Hard gate — NO implementation before human sign-off.** (Satisfied 2026-10-02.)
- Design constraints already baked into the ADR: A5 (no second store — dedupe/checkpoint in storageDomain), ADR-0012 (boot rescan flows through `rebuildFromDurability` + redrive), ADR-0003 (dispatcher-only spawning; the inbox never spawns directly — jobs enter as the external-event wake source, ticket 06 vocabulary), C15 (file jobs are ordinary dispatched workers), no client UI (ADR-0014 untouched).

## Implementation notes

- Accepted ADR: `docs/adr/0023-file-driven-external-intake.md` (status line dated 2026-10-02; ADR README row updated; `node tools/adr-index.mjs` fresh).
- PRD amendment: `PRD-dsh-multitask-dispatcher.md` — §6.4 (wake model: external-event source's first producer, the opt-in file inbox) and §7.1 (component map: adapter-owned inbox watcher), both marked ticket-111 / 2026-10-02 / referencing the ADR path.
- Implementation ticketed separately as ticket 113 per repo rule.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass. This ticket is deliberately human-gated: the inbox is a scope addition (ADR-0004), not imitation (ADR-0018), so the companion ADR-0023 carries the full design as a draft and nothing moves in `src/` until the human rules. Labelled `needs-triage, ready-for-human` for that reason — the next action belongs to the human, not an agent.

### 2026-10-02 — resolution (human ruling recorded)

The human approved ADR-0023 in session on 2026-10-02 — the sign-off gate this ticket guarded is satisfied. Actions taken under this ticket:

- ADR-0023 (`docs/adr/0023-file-driven-external-intake.md`): Status `draft (nonhuman-approved)` → `accepted (human-ruled, 2026-10-02 in-session directive)`, following the ADR-0021/0022 accepted-format convention; the body is untouched (accepted-ADR bodies are immutable; the draft-approval discipline is satisfied by the dated status line). The ADR README row was updated to match and `node tools/adr-index.mjs --check` reports fresh.
- PRD (`PRD-dsh-multitask-dispatcher.md`): §6.4 gains the external-event wake row — the opt-in file inbox is the first producer of the `external-event` wake source (ticket 06 vocabulary), and wake-on-external-job joins the existing coalescing/batching semantics unchanged; §7.1 gains a dated amendment note — the component map now includes the inbox watcher, adapter-owned (`fs.watch` + rescan-interval fallback; config `inbox.enabled` / `inbox.dir` / `inbox.rescanIntervalMs`), jobs enter the dispatcher wake path, replies written per ADR-0023. Both amendments carry the ticket-111 mark, dated 2026-10-02, referencing `docs/adr/0023-file-driven-external-intake.md`; design detail stays in the ADR, the PRD carries only product-level truth.
- Implementation is ticketed separately as ticket 113 (`Issue-tracker/open/113-implement-file-inbox-per-adr-0023.md`) per repo rule.
