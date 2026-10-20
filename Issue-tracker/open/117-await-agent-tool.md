# 117 — `await_agent` tool

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 115
**Related:** ADR-0025, ADR-0028 (the reply lane is the inverse direction), ticket 119 (policy text and PRD anti-pattern narrowing), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.2 and §7 (untracked input, not authority)

## Problem

Ticket 115 gives the core a bounded wait. Nothing exposes it to the model, so the dispatcher still cannot use it. It also cannot be released early when the user sends a message, which is what keeps PRD S1 ("reply within seconds") believable while a wait is in flight.

## What to do

- [ ] Register the `await_agent(target, timeout_ms?)` tool through the dispatcher tool surface with `executeOverride(args, exec)` so `exec.signal` reaches the wait.
- [ ] Bounds: default 30,000 ms; accepted range 0–120,000; `timeout_ms: 0` is a non-blocking status read. Out of range → `invalid-timeout`.
- [ ] **Worker targets only.** A dispatcher target refuses with `not-awaitable`, and the copy says to message it and end the turn. This is the cycle rule: workers have no await tool and dispatchers are not awaitable, so `A awaits B awaits A` is not constructible. A refusal, not a timeout.
- [ ] Waiter cap: 4 concurrent per dispatcher session; a fifth → `too-many-waits`.
- [ ] User-message early release: the adapter watches the **dispatcher's own** session in `session/event` and releases that session's waiters with `released` / `reason: "user-message"`. Key the release on the **structured** user source, never on text.
  - When the event shape is first verified against the booted 0.2.1 tree. If it cannot be verified, **ship without early release** and record that honestly — the 120 s cap is then the only bound. Do not guess a shape.
- [ ] Deactivation cancels waiters (`cancelWaits` from 115); turn abort via `exec.signal` propagates.
- [ ] Unit tests: `timeout_ms: 0` on a settled record returns `settled` with the clamped result; a settle landing during the wait resolves it; timeout returns `still-running` and the record survives; abort resolves `released` and leaves no timer; dispatcher target returns `not-awaitable`; fifth waiter returns `too-many-waits`; a user message releases a live waiter; deactivation cancels.

## Bounds (ticket-level, recorded before implementation)

| Value | Chosen |
|---|---|
| Default timeout | 30,000 ms |
| Max timeout | 120,000 ms |
| Concurrent waiters per session | 4 |
| `timeout_ms: 0` | non-blocking status read |

The 120 s cap is deliberately below the host's own wait ceiling because the dispatcher's turn is the user's chat turn.

## Constraints

- No timer polling. The only timers are the per-wait timeout and the release path.
- Reads ticket 115's record. Does not poll the host, does not read a transcript.
- Worker tool surface unchanged: `await_agent` is a dispatcher-only tool and must never appear in a worker's scope.
- Offline tests (S8 lane). A live check of the user-source event shape is gated by `read-before-running-live-and-browser-tests.md` (kill timer, trivial task, evidence under `.scratch/testing/2026-10-18-<slug>/`).

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 117. The early-release item is the one place where this ticket may have to ship a reduced shape: the user-source event shape on the dispatcher's own session is not yet verified against the booted tree, and the honest fallback is to ship without early release rather than guess. That fallback is recorded here so it cannot be discovered mid-implementation.

Blocked by 115 (the record and the wait this tool exposes).
