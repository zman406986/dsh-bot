# 68 — Onboarding first-run flow (ADR-0018 in-scope area)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 67 (the wrapper vehicle decision — onboarding is a wrapper surface)
**Related:** ADR-0018 (in scope: "onboarding first-run flow"), `docs/research/always-on-dispatcher-behavior.md` area 1 (first-run sequence), 32 (composition polish — its coherence goal re-bases here)

## Problem

The reference runs a guided first-run sequence (sign-in, an intro beat, computer-readiness demo,
background-jobs explainer, tools beat, first agent creation, hand-off into the shell), with
re-entry suppressed once seen or once the user owns an agent, and probe failures failing open.
Under the old model this was excluded (no dormant/onboarding state); ADR-0018 brings it in scope.

## What to do (research/design ticket)

- [ ] Verify the reference's onboarding beat structure and re-entry rules from the research notes
      (cite file:line; never open the reference tree).
- [ ] Map each beat to our reality on dsh (what we can honestly show; where dsh differs).
- [ ] Persistence of "seen": design the suppression state honestly (no invented seams).
- [ ] Draft ACs for implementation once the vehicle (67) is decided.

## Constraints

- Respect exception U-A (no privacy/account gates, no connection-lifecycle phases) — the
  reference's sign-in/account beats may have no honest counterpart; record the gap rather than
  inventing one.
- New or adapted copy only (AGENTS.md no-verbatim rule).

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

The vehicle is decided (draft): **ADR-0020** — the wrapper is our own frame over the shipped
dsh client runtime, staged through a `main` page (tickets 77–78) before surfaces land. Your
dependencies on it: (a) first-run renders *inside our frame* (or the staging page), so beats
that need shell chrome wait for 77/78; (b) the shipped `settings.onboarding` slot is usable
only during the staging stage — once the frame election flips, the settings surface is displaced
and onboarding must be ours; (c) "seen" persistence rides our settings namespace (no second
store, A5). U-A still binds: no sign-in/account beats, no connection phases. Blocked-by line
updated mentally: implementable once 77/78 land and your research ACs are done.
