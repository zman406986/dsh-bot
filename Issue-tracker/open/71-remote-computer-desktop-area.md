# 71 — Remote computer / bots' desktop area (ADR-0018 in-scope area)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 67 (approval/monitoring surfaces are wrapper surfaces)
**Related:** ADR-0018 (in scope: "the remote computer / bots' desktop area (dedicated computer/browser worker types, remote-box approval surfaces with location labels, recording/teaching, remote/cloud jobs)"; exceptions C15, U-D), `docs/research/always-on-dispatcher-behavior.md` area 6 (remote-box cards), 30 (location-line re-base), `docs/research/prd-vs-reference-capability-gaps.md` (remote-box notes)

## Problem

The reference ships a desktop/computer area: dedicated computer and browser worker types, actions
that run on "the product's computer" (remote box) with location-labeled approval cards,
recording/teaching flows, and remote/cloud jobs. ADR-0018 brings the area in scope — with the
exception list constraining it.

## What to do (research/design ticket)

- [ ] Verify the reference's remote-box surfaces from the research notes (computer/browser worker
      types, location labels, recording/teaching — cite file:line; never open the reference tree)
      and reconcile with `prd-vs-reference-capability-gaps.md`'s remote-box rows.
- [ ] Sort the area against the exception list, explicitly:
      - **C15 is binding:** remote/cloud jobs are NOT wake kinds — the single wake kind stays
        dispatched workers; if computer/browser workers exist, they flow through the same
        dispatched-worker wake pipeline or the conflict goes to the human.
      - **U-D is binding:** remote-box "always allow" stays session-scoped.
      - Location labels are IN (they are named in ADR-0018's in-scope sentence) — ticket 30's
        constant "Runs on your computer." line re-bases to per-producer-kind honest labels.
- [ ] Recording/teaching: scope what "recording a computer session for replay/teaching" means on
      dsh; mark what has no honest seam rather than inventing one.
- [ ] Draft implementation ACs once 67's vehicle is decided.

## Constraints

- The remote box is dsh/host capability first: if the host offers no remote execution surface,
  the finding is recorded as a blocker — do not spec against fantasy.
- New or adapted copy only.
