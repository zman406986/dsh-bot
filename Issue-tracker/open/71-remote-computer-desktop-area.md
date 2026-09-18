# 71 — Remote computer / bots' desktop area (ADR-0018 in-scope area)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none for the gated research pass — 67 resolved (ADR-0020). The dsh-host capability check is AC 1 of the brief (see the 2026-09-19 triage comment); if it comes back absent, the ticket halts into a recorded blocker + a ready-for-human escalation, per its own no-fantasy constraint.
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

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

Vehicle decided (draft): **ADR-0020**. Your surfaces land inside the wrapper: remote-box
approval cards are ticket 81's card system with your location labels; computer/browser worker
monitoring renders in 80's conversation surface and 79's sidebar presence. C15 binding
unchanged: computer/browser workers must flow the dispatched-worker wake pipeline or escalate
to the human. The dsh-host capability check remains your first AC — the wrapper adds no
execution capability of its own.

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent, capability-gated)

Verdict (a) — as a bounded research pass whose FIRST AC is the capability gate. The gate is
agent-doable read-only work, which is why this is (a) rather than (b); the escalation it may
produce is pre-sanctioned by this ticket's own constraint ("do not spec against fantasy").
Triage pre-read of the research notes: **no dsh remote-execution / computer-use face is
recorded anywhere** — `dsh-extension-surface.md`'s facility inventory has none;
`dsh-adapter-api-notes.md:296-305`'s sandbox modes are LOCAL. Reference-side depth is also
limited: `always-on-dispatcher-behavior.md` Status lists the remote-box/computer area as
"covered shallowly". Both honesty limits bind the brief. Expected branch: the gate fails →
record the blocker, escalate to the human (request a dsh host seam, or descope with recorded
gaps); the location-label re-base (AC 4) proceeds either way.

**Agent-ready brief**

- **Scope-in:** the capability gate (read-only installed host, file:line); reference
  verification from the notes with the shallow-depth caveat; the explicit exception sort
  (C15 / U-D / location-labels-IN); recording-teaching scope-or-gap; implementation ACs ONLY
  for capabilities that verified.
- **Scope-out:** spec against an unverified host face; remote/cloud jobs as wake kinds
  (C15 — conform or escalate); persisted always-allow (U-D); retry/reconnect-style failure
  UX on unreachable-box states (the conservative U-A reading of ticket 82's interim rule:
  honest copy, no retry affordance); inventing host seams (that request belongs to the
  human).
- **Builds on:** `docs/research/dsh-extension-surface.md` (facility inventory — the
  negative-evidence starting point), `dsh-adapter-api-notes.md` (sandbox = local),
  `always-on-dispatcher-behavior.md:51` + `:32` (remote-box card labels; typed running-tasks
  rows incl. remote/cloud jobs — C15-excluded), `reference-behavior-notes.md:60` (dedicated
  computer/browser worker types and their tool exclusion set),
  `prd-vs-reference-capability-gaps.md` ("deliberately out of scope" remote-box rows),
  `src/adapter/access-prompt.ts:104` (ticket 30's constant location line this ticket
  supersedes), rendering homes per ADR-0020's hand-off: 81's cards + 80/79 surfaces.
- **ACs:**
  1. **GATE — dsh host capability verification** (read-only, file:line): does any
     remote-execution / computer-use / browser-automation face exist? Outcome (i) absent →
     STOP: record the blocker here, draft the ready-for-human escalation (host-seam request
     vs descope-with-gaps), proceed only with AC 4. Outcome (ii) present → proceed to ACs
     2–3, 5.
  2. Reference verification table with the shallow-depth caveat; reconciled against the
     capability-gaps remote-box rows; no invented reference detail.
  3. Exception sort recorded: C15 (computer/browser worker types flow the dispatched-worker
     wake pipeline or the conflict escalates), U-D (remote-box always-allow stays
     session-scoped), location labels IN (named in ADR-0018's in-scope sentence).
  4. Location-label re-base design (capability-independent): per-producer-kind honest
     labels superseding 30's constant "Runs on your computer." line
     (`APPROVAL_LOCATION_LOCAL`), hooked into 81's card contract; offline-testable.
  5. Recording/teaching scope-or-gap record; implementation ACs for branch (ii) only;
     live-only ACs marked for the 45/33 lane.
- **Risks:** the likely branch is the blocker (pre-recorded so dispatch is not surprised);
  the reference research here is inventory-grade, not walkthrough-grade — cite or omit.
- **Size:** S for the gated research pass + AC 4; the remainder is contingent — do not
  estimate until AC 1 resolves.
