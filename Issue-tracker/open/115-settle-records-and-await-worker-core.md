# 115 — Per-target settle records + `Multitask.awaitWorker` (no tool yet)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 114
**Related:** ADR-0025 (bounded await is part of the dispatcher peer model), ticket 116 (`message_agent`), ticket 117 (`await_agent` tool), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.2 and §7 (untracked input, not authority)

## Problem

Nothing in the core remembers a worker's terminal result. The settle path receives `status` and the report text and immediately composes a wake; after that the text lives only in the wake and in the transcript. A dispatcher therefore cannot ask "did that worker finish, and what did it say?" without polling `check_workers` and reading state that does not carry the result.

ADR-0025's product shape needs a bounded wait on a named worker. The wait has to read a record, not poll the host and not read a transcript.

## What to do

- [ ] Add a bounded per-parent-session ring of **64** `SettleRecord`s: `{ workerId, status: "completed" | "error" | "aborted", resultText (clamped), settledAtMs }`. Write it in the settle path **before** the wake is enqueued, so a wait that races the wake still sees the record.
- [ ] Add `awaitWorker(parentSessionId, workerId, timeoutMs, signal, hooks)` returning the outcome union in the design note §4.2: `settled` (with `worker_status`, `result`, `settled_at_ms`, `waited_ms`), `still-running`, `gone`, `released`; refusals `unknown-target`, `self-target`, `not-awaitable`, `too-many-waits`, `invalid-timeout`.
- [ ] Add `cancelWaits(sessionId)`. Wire it to session deactivation so no waiter or timer outlives a deactivated dispatcher.
- [ ] Add an optional `isAgentAlive?: (id) => boolean` port on the core options, wired adapter-side to `ctx.agents.get(id) !== undefined`. It is checked **once at timeout**, never on a timer.
- [ ] Race set: settle-record arrival, timeout timer, `signal` abort, and session deactivation. First wins; every loser is cleaned up in a `finally`.
- [ ] Enforce **4 concurrent waiters per dispatcher session**; a fifth returns `too-many-waits`.
- [ ] Unit tests with the existing `FakeDshHost` harness: settled-before-wait (timeout 0), settle-during-wait with clamped result, timeout returns `still-running` and a later settle is not lost, aborted signal returns `released` and leaves no timer, `isAgentAlive` false at timeout with no record returns `gone`, waiter cap, deactivation cancels waiters.
- [ ] Keep this ticket tool-free. No registration, no prompt text, no PRD text — those are 117 and 119.

## Bounds and constants (ticket-level, recorded before implementation)

| Value | Chosen | Reason |
|---|---|---|
| Ring size | 64 | Bounded memory; far more than one dispatcher can settle between two turns. |
| Default `timeout_ms` | 30,000 | Matches the host's `wait_agent` default. |
| Max `timeout_ms` | 120,000 | The dispatcher's turn is the user's chat; a longer wait is not a chat turn. |
| Concurrent waiters | 4 | Small enough to bound timers, large enough for a team. |
| `timeout_ms: 0` | non-blocking status read | Lets a dispatcher check without waiting. |

## Constraints

- In-memory only. Nothing durable: a restart loses results, which is the documented worker behaviour — report the loss plainly, never replay (ADR-0012).
- No polling of the host, no transcript reads, no timers except the one timeout per wait.
- Does not change settle-wake composition or wake ordering.
- Offline tests only (S8 lane); no live dsh, no LLM.
- ADR-0018 U-H: this is a bounded result ring, not per-stream token/usage accounting and not a search index.

## Comments

### 2026-10-18 — filing

Filed from the 2026-10-18 messaging/await/mitosis design (§12 ticket 115), re-checked against accepted ADR-0025 and the resolved open questions in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md`. The settle record is the only thing `await_agent` (117) reads, which is why it ships first and without a tool.

Blocked by 114: the 0.2.1 host port must land before this is built against the booted tree.
