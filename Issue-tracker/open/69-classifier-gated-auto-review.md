# 69 — Classifier-gated auto-review (ADR-0018 in-scope area)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 67 (approval cards are a wrapper surface), 72 only if multi-dispatcher routing changes the relay's keying
**Related:** ADR-0018 (in scope: "classifier-gated auto-review"; exception U-D), `docs/research/always-on-dispatcher-behavior.md` area 6, 30 (the shipped session-scoped always-allow + prompt UX), 13/23 (access relay + prompt pump), ADR-0008

## Problem

The reference gates risky actions through an inline approval-card flow decided by a classifier
layer, not the model alone: typed cards (local command, remote-box action, connected-service call,
automation write, cloud-agent action, worker dispatch), clamped detail with omission marker,
location lines, stale/pending projections, and a persistent "always allow this rule" choice.
Ticket 30 shipped a session-scoped slice on the prompt pathway and deliberately did not adopt the
classifier; ADR-0018 brings the area in scope.

## What to do (research/design ticket)

- [ ] Verify the reference's card types, anatomy, and classifier-gating behavior from the research
      notes (cite file:line; never open the reference tree).
- [ ] Map to the shipped relay: what ticket 13/23/30 already cover (structured asks, clamped
      detail, session-scoped always-allow, expired honesty) vs what is new (classifier layer,
      card types, per-surface location labels).
- [ ] **U-D is binding:** "always allow" rules stay session-scoped — no persisted rule store, no
      settings-managed controller. Design within that.
- [ ] Worker-dispatch as a gated card type: how spawns present for approval without breaking the
      always-on model (no activation step).
- [ ] Draft implementation ACs once 67's vehicle is decided.

## Constraints

- Relay semantics that survive (timeout ADR-0008, deny-by-default, dedupe) are not re-litigated
  here; the design extends them.
- New or adapted copy only.
