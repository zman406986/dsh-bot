# 98 — Wrapper-frame approval answering + persisted-open-turn reconcile on activation

**Status:** deferred
**Labels:** needs-info
**Deferred (2026-09-20, W27):** no operator impact under current defaults after the W27 wedge
cleanup — the one wedged session (cf5249cf, our own test artifact) is repaired at the data layer
(`.scratch/_overnight-2026-09-20/wedge-cleanup-W27.md`), and the wedge family can only re-arm
through the same test pattern that created it (an unanswered host approval ask under the ADR-0020
wrapper). Design input needed on wrapper-frame approval rendering before either fix is shaped;
revisit when wrapper-frame staging (ADR-0020) is next touched.

**Related:** 69 (L3 dispatch-approval round-trip; FINDING 3 recorded there), 30 (approval prompt
UX — needs a live answer surface), 31 (restart honesty / rebuild-on-activation — the reconcile
half is its territory), 81 (wrapper cards), 33 (Session B-3/B-4/C finding records), ADR-0020
(wrapper root frame), ADR-0008 (timeout deny).

## Problem (two systemic gaps behind the wedge family, both evidenced live 2026-09-20)

1. **The shipped host approval composer does not answer under our wrapper root frame.** Session
   B-3: under preset `workspace-write` (approval = `ask`, verified via `/permission`), an
   escalation-shaped dispatcher task raised a host approval waterfall that never rendered any
   answer surface — zero approval/dialog/modal/toast elements including hidden DOM over a
   ~3-minute window; the turn stayed open and the wedge was born. The composer ships in the
   served bundle (`dsh-client-ui-approval` ×4) but does not answer under the wrapper root frame
   (ticket 33, Session B-3 record). FINDING 3: an unanswered host approval ask wedges the
   dispatcher turn — the offline fail-closed pins assume the approval service RETURNS; live it
   can be absent-and-silent.
2. **A persisted open turn with no live turn parks sends forever, silently.** Session B-4/C:
   the wedged turn PERSISTED across restarts (checkpoint `openTurnStartSeq: 415` + parked inbox
   `next-turn` message); any new send to that session was eaten silently (transport green, no
   turn ever ran). Nothing narrates the state or reconciles it on activation (ticket 33, Session
   B-4/C records; FINDING 5). W27 repaired the one live instance at the data layer with the host
   stopped — see the cleanup record for the store layout, schema pins, and hash evidence.

## What to do (when un-deferred)

- [ ] (a) Wrapper-frame approval answering: make host-level approval prompts render and answer
      inside the wrapper frame (ADR-0020 root-frame staging), or honestly surface that they
      cannot be answered (visible refusal, not silence). Design input needed on where the host
      approval surface mounts under the wrapper before this is shaped.
- [ ] (b) Activation-time open-turn reconcile (31's territory): on activation, a persisted open
      turn with no live turn should be narrated honestly to the user and closed (the host's
      `interruptedTurnClosers` already closes the log tail — the gap is the narration and the
      parked-inbox disposition, including not silently driving a parked send).
- [ ] Both fixes' acceptance should be pinable offline against the store semantics recorded in
      the W27 cleanup record (checkpoint seed-skip, fold `turn/end` shapes, log watermark).

## Comments

### 2026-09-20 — W27 (filed at creation; born deferred)

Filed per the repo rule (log an issue before implementing) to carry the wedge-family future work
out of tonight's scope. Evidence: ticket 33's Session B-3 (FINDING 3) and B-4/C (FINDING 5)
records; repair evidence: `.scratch/_overnight-2026-09-20/wedge-cleanup-W27.md` (before/after
hashes, minimal-diff table, residual risk). Labels line set to `needs-info` per the triage
vocabulary's five-role rule: the ticket cannot be shaped until design input lands on
wrapper-frame approval rendering (the Deferred line above names the revisit trigger; flip to
`ready-for-agent` when that input exists).

### 2026-09-20 — team-leader session

Vehicle changed by ADR-0021 (human-ruled): addon coexistence — stock dsh stays the primary UI
and the ADR-0020 root-frame election leaves the default posture (open ticket 99). Gap (1) (the
host approval composer ships but does not answer under the root frame) is expected-moot under
the new vehicle: the stock frame is no longer displaced, so the shipped composer should render
and answer natively — this stays deferred pending live confirmation under the new vehicle; the
revisit trigger above now routes through ADR-0021/ticket 99 instead of ADR-0020 staging. Gap
(2) (persisted open-turn reconcile on activation) is unaffected by the vehicle change. Status
and Labels untouched by this comment.
