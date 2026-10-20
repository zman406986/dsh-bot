# 121 — Peer awareness: tail-pushed roster with liveness

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (independent of the 0.2.1 port)
**Related:** ADR-0027 (§Settled identity and dispatch), ADR-0025 (mitosis creates the peers the roster lists), ADR-0026 (rooms are a separate channel), ADR-0010 (presence-as-projection precedent), ADR-0018 C13 (no identity roster)

## Problem

An agent learns who exists only by already knowing a tool exists. `send_peer` needs a session id the dispatcher cannot get on its own, `fromName` is just the session id, and nothing in the prompt lists peers or their state. ADR-0027 rules discovery in, pushed at the prompt tail.

## What to do

- [ ] Build a peer roster projection from live state: one row per eligible session, with **session id as the key**, `subagent.label` as the label, and a status shape.
- [ ] **Identity rules, as settled in ADR-0027:** session id is the only identity; `subagent.label` is the only durable label; read it through `projectionValues.subagent.label` (per-session snapshot). Display fallback: label → session title → session id. Do not add a user-assigned name field.
- [ ] **Kind rules, as settled:** a worker is `origin === "subagent"`; a dispatcher is `agentPreset === "multitask-dispatcher"` **only after this ticket verifies that such a preset exists and lands on live dispatcher sessions**. Until verified, do not claim the kind; list the row and record the reduced shape honestly.
- [ ] Inject the roster at the **prompt tail**, after the stable prefix, so the cached prefix survives. Pin with a test that the roster text rides only in the tail and that the prefix stays byte-stable across turns.
- [ ] Include liveness and current activity, targeting the `statusOf` shape: **working / waiting / approval / idle**, plus current tool and current target. Ship only the statuses that are actually observable on dsh 0.2.1; a test should pin the observable set and the text must not invent a status it cannot see.
- [ ] Fail closed and cheap: if peer state cannot be read, the tail says less or nothing. The turn and the prefix must never fail because the tail could not be built.
- [ ] Decide and record whether workers appear in the roster (ADR-0027 open question 2). Whatever is chosen must respect that workers are leaves.
- [ ] Refresh point: per-turn prompt assembly. Bound the cost of assembling and diffing the roster; record the bound.

## Open questions this ticket must answer (ADR-0027's list)

1. Where in the tail the roster sits relative to standing rules and reminders.
2. Whether workers are listed, and how a summoned dispatcher appears.
3. The refresh point's cost bound.
4. Which of working / waiting / approval / idle are actually observable on the installed host.
5. Whether a dispatcher preset exists to carry the kind (shared with ticket 118).

## Constraints

- Injected text, not a tool call. No directory tool (C13).
- No saved identities; the roster is derived from live state every turn.
- No local store, no search index (ADR-0018 U-H).
- The status vocabulary becomes shared text; product copy is this ticket's.
- Offline tests only; the prompt-assembly path is unit-testable with the existing harness.

## Comments

### 2026-10-18 — filing

Filed for ADR-0027's human ruling, whose identity, label, and dispatch questions were settled on 2026-10-18 (`.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q2/§Q4). No source was edited in this records pass.

The `agentPreset` kind check is written as a verification because the working tree currently has no dispatcher preset row and workers inherit the parent's preset — the mechanism is sound, the precondition is not yet true.
