# 298 — The activation notice becomes the surface head, so dsh cannot load the session log

**Status:** open
**Type:** bug
**Labels:** ready-for-agent
**Severity:** P1 / ship blocker — a fresh `/dsh-bot` chat writes a session log the host refuses to load.
**Ship blocker:** yes — the failure is silent at write time and only appears on the next load: the chat's whole transcript becomes unreachable.
**Blocked by:** nothing.
**Origin:** 2026-11-11 log-repair pass: seven session logs under `<DSH_HOME>/sessions` are unloadable, and every one has the ticket-295 activation notice as surface node 0.
**Related:** [295](resolved/295-activation-confirmation-invisible.md) (the notice this ticket constrains), [296](resolved/296-dispatcher-policy-lost-after-host-compaction.md) (policy re-inject on the same `session/event` listener), ADR-0032 (a summoned dispatcher is a parallel session), ADR-0009 (activation is an explicit command).

## Problem

Ticket 295 put the activation confirmation on the session surface with one model-free write during `bindActivation`:

```ts
agent.session.append("user/message", activationNoticeMessage(...), { surfaceOp: "append" })
```

On a FRESH chat that call happens while the surface is still empty, so the notice becomes **surface node 0**. The host requires node 0 to be a system message:

- The loop commits `system/message` at the start of the first step — `dsh-agent-loop/lib/index.js:854` (`for (const { message, intent } of commits) this.session.append("system/message", …, intent)`). The intent is `{ surfaceOp: "append" }`, chosen because `project()` found NO system node (`dsh-agent-loop/lib/index.js:263-269`: "the first prompt, even empty, reserves surface node 0").
- The format v4 validator then rejects the log: `dsh-session-format-v3-to-v4/lib/index.js:599` — `system/message requires a protected first surface head` when the surface is non-empty and no head is protected. Protection is granted only when the system message is appended to an EMPTY surface (`:601`, `if (event.type === "system/message" && this.surface.length === 0) this.protectedHead = event.seq`).

Writing the log succeeds (the live session keeps working); the next **load** fails, which is why this shipped unnoticed. Session-level surface folds do not enforce the rule — only the format validator does, so the defect cannot be caught at append time.

### Corrupt sessions (read-only scan, `.scratch/testing/2026-11-11-log-repair/scan-full.txt`)

Seven of 1 209 logs; `firstSurface` is the notice, `firstSystem` the seq the loop could only commit after it:

| session id | workspace dir | firstSurface | firstSystem |
|---|---|---|---|
| `8dcb9bad-8914-4168-8c62-799a549ee109` | `--C-Users-TZ-Desktop-Can-Balls-into-Space--` | `{seq:1, user/message, notice:true}` | 12 |
| `session-a6a56962-498d-4cf7-baa9-13cf4f80722f` | `--C-Users-TZ-Desktop-Can-Balls-into-Space--` | `{seq:5, user/message, notice:true}` | 15 |
| `91f4b1c8-25e5-4f5d-b7c2-4f26e7425c3f` | `--C-Users-TZ-Desktop-miliastra-game-template--` | `{seq:1, user/message, notice:true}` | 12 |
| `a47a9b1e-ad9c-48d9-b80e-3546fbe7e5bd` | `--C-Users-TZ-Desktop-miliastra-game-template--` | `{seq:1, user/message, notice:true}` | 12 |
| `dcac7556-8152-4394-8391-cf224b274291` | `--C-Users-TZ-Desktop-miliastra-game-template--` | `{seq:1, user/message, notice:true}` | 12 |
| `eab149a3-4b2c-43cf-bc4d-eaa86090ed4b` | `--C-Users-TZ-Desktop-miliastra-game-template--` | `{seq:1, user/message, notice:true}` | 12 |
| `session-bea438f0-b9de-4d82-af23-9c99079579a7` | `--C-Users-TZ-Desktop-miliastra-game-template--` | `{seq:7, user/message, notice:true}` | 19 |

Repairing those logs is a separate work item (a parallel worker owns it); this ticket stops NEW ones.

## Why the obvious routes are wrong

- **`agent.followup`** — the next-turn inbox plus the wake driver (`dsh-agent-loop/lib/index.js:570-572`, `:618-632`): it spends a model turn to print a sentence. Ticket 295 rejected it for exactly this reason, and 298 does not reopen that.
- **Adding a newline to `DISPATCHER_START_SUCCESS`** — `test/composition-polish.test.ts` pins the command result byte-for-byte, and the collapsed card would still show one clipped line (295: "Why the obvious routes are wrong").
- **A channel that adds no surface node** — `inject` (next-step, model-facing) is not user-visible; `command/run` / `command/done` is the clipped card that caused 295; a client toast belongs to the client lane and is not chat content. None of them satisfies "unambiguous confirmation in chat". Rejected on the requirement, not on convenience.
- **Writing our own `system/message` to reserve node 0 first** — that impersonates the loop's projection: the very next `project()` would replace our node (`dsh-agent-loop/lib/index.js:270-280`), we would have to construct a host-owned payload (`createSystemMessage`, `dsh-llm/lib/index.js:86-95`) that we do not author, and any drift in the loop's "first prompt reserves node 0" rule would corrupt the request prefix. Rejected as fragile.

## Decision: defer the notice until a committed system head exists

1. **Probe the head, not the log.** `surfaceHeadState` (`src/adapter/parent-agent.ts`) reads `agent.session.surface.nodes` and `eventAt(node0)`: `"system"` (legal now), `"empty"` (must wait), `"other"` (a log that is already broken; the notice is not the cause), `"unknown"` (no readable seam — keep the pre-298 best-effort append).
2. **Empty ⇒ pending, not written.** `tryActivationNotice` records the agent in a `WeakSet` and returns; activation itself writes nothing, so **no ordering of our own writes can make the notice the head**.
3. **Flush on the host's own commit.** The existing `session/event` listener (the ticket-296 one, no new `ctx.on` — the listener-count pins in `test/activation-lifecycle.test.ts:290` and `test/composition-polish.test.ts:442` stay at 7) gains one branch placed BEFORE the `compaction/end` branch: on `system/message`, if the head now reads `"system"`, flush once. Worker sessions never reach it — the branch only consults the lifecycle's bound `sessions` map, exactly like 296.
4. **Escape the reentrancy guard.** The flush appends from a microtask: the host refuses an append reentered inside its own publication boundary — `if (entry?.appending) throw new Error("session append cannot reenter while another append is being published")` (`dsh-session/lib/index.js:1580`). Dropping the `WeakSet` entry before scheduling makes it one-shot; a second system commit in the same turn is a no-op.
5. **Cleanup.** `deactivateSession` drops the pending entry, so a later activation of the same session id inherits nothing.

The confirmation therefore still reaches the chat as the same `form: "notice"` row with the full 208-character text and the one-line `summary` — model-free, inbox-free, turn-free.

**User-visible cost (accepted):** on a fresh chat the row now appears when the FIRST TURN starts, i.e. just after the user's own message, not at the instant `/dsh-bot` returns. The command card is still immediate, so the user is never left without feedback; a chat that never runs a turn after activation keeps only the card. That delay is the price of a loadable log.

## Ticket 296 is not regressed

Same listener, different branch; the `compaction/end` path (policy probe, `policyInjectInFlight`, boundary re-inject), the per-turn `agent/status` probe and the worker exclusion are byte-identical. `test/adapter-policy-inject.test.ts` passes unchanged.

## Tests

`test/adapter-cordis-dsh-host.test.ts`, describe `ticket 298: the activation notice can never be the surface head`:

- `the host validator rejects the ticket-295 log shape (the bug is real)` — real installed `Session` writer + real `restoreReleasedV4Artifact`; throws `system/message requires a protected first surface head`.
- `a fresh activation defers the notice, then writes a log the host validator accepts` — activation writes no surface node; the loop's first step commits the head; the notice lands after it; the real validator accepts the 7-event log.
- `the deferred notice still carries the full confirmation` — the row keeps `DISPATCHER_START_SUCCESS` and a summary, with zero followups.
- `a second system commit does not duplicate the notice`.
- `a readable empty surface defers; a committed head flushes it once` — host-free twin, so the property is pinned even where dsh is not installed.

The host-backed cases fail on the pre-298 code (`no surface node at activation` / `an empty surface defers the notice instead of making it node 0`) and pass after.

## Residual risks

- The microtask lands after the loop's synchronous step preamble, so the notice currently arrives after the user's prompt message. A host that committed the prompt elsewhere would only change that ordering; the validator cares about the head alone.
- An unreadable surface still takes the pre-298 append. Every real `Agent` exposes `session.surface`, so this is the structural-stub path only.
- A chat that never runs a turn after activation loses the deferred notice by design; the command card remains.
- The seven existing logs stay unloadable until the repair work item lands.
