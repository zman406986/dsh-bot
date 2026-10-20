# 123 — Session-kind indicators: dispatcher glyph in the sidebar, worker marker in the conversation header

**Status:** open
**Labels:** needs-triage
**Blocked by:** 114 (client 0.2.1 port; the glyph rides the port)
**Related:** ADR-0024 rider + rider addendum (the sidebar glyph is ruled and licensed), ADR-0027 (§Settled identity and dispatch — how a kind is identified), ticket 118 (a spawned dispatcher's preset must be verified), `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q4

## Problem

The owner asked for small marks separating dispatcher sessions, worker (subagent) sessions, and normal sessions (ADR-0024 rider, 2026-10-18). Two facts narrow what is buildable:

1. **Workers are not sidebar rows.** Subagent sessions are stamped `origin: 'subagent'` (`dsh-subagent/lib/index.js:354`) and filtered out of the sidebar entirely (`dsh-client-ui-workspace/lib/client.js:964-966`). `sidebar.session.row.leading` therefore never renders for a worker, so the three-way glyph reduces to **dispatcher vs normal** in that slot.
2. **The slot is idle-only.** The leading cell mounts only for idle, non-archived, non-blank rows; a running row shows the stock status dot instead (`dsh-client-ui-workspace/lib/client.js:2303-2306`). Any design expecting a persistent mark on every row is wrong.

So the worker half of the request has no seat in the slot the owner named. The only remaining seat that can carry it is the **conversation header**, which is a different slot and is **not** licensed by the ADR-0024 rider (that rider permits exactly one additive sidebar registration).

## What to do

**A. Sidebar glyph (dispatcher vs normal) — ready to build**

- [ ] Register `sidebar.session.row.leading` as a `list` entry, 16 px leading cell, `replaceRisk: none`. The stock schedule plugin already occupies the slot at order 10 (`dsh-client-ui-schedule/lib/client.js:7528`); pick an order that does not shadow it.
- [ ] Compute the kind **client-side from the session-list snapshot**, with no new projection and no new store:
  - dispatcher: `projectionValues.agentPreset === "multitask-dispatcher"` — **conditional**: ticket 118 must first confirm the preset exists and lands on live dispatcher sessions. Until then, ship no dispatcher glyph rather than mislabel normal sessions.
  - normal: everything else visible.
  - workers: never appear here (see Problem).
- [ ] The payload is only `{ sessionId }` (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:96-99`, render site `dsh-client-ui-workspace/lib/client.js:2306`); look the session up through `useSessions`.
- [ ] Fail closed: if the snapshot is missing the session, render nothing. A throwing entry abdicates per entry and never takes stock dsh down.
- [ ] Narrow `test/client-face-scaffold.test.ts`'s "renders NOTHING into dsh's layout" pin by exactly this one registration, as the rider already says.

**B. Worker marker in the conversation header — needs an owner decision before building**

- [ ] The candidate seats are `conversation.session.header.actions` (`list`, session scope, owner props take no extra values) and `conversation.session.header.corner` (`single`, session scope). Both are declared in `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:225-258`; the stock subagent UI already registers into `conversation.session.header.actions` (`dsh-client-ui-subagent/lib/client.js:983`).
- [ ] **Stop and ask the owner first.** ADR-0024's rider licenses one additive sidebar registration and says no other slot is licensed. Adding a second registration contradicts decision 1 as currently recorded and needs a dated human ruling extending the rider — an agent must not slip it in.
- [ ] Once licensed: a worker marker here is identifiable by `origin === "subagent"` (ADR-0027) and is visible on the worker's own conversation, which is the only place a worker session is shown at all.
- [ ] Do not try to make workers visible in the sidebar. That would overturn stock's visibility rule and contradicts ADR-0024's native posture.

## Open questions

1. **Does the owner want the worker marker at all**, given it can only live in the conversation header rather than the session list? (Recorded in ticket 114's 2026-10-18 comment as a scope limit.)
2. Which header seat, if any: `conversation.session.header.actions` (list, title-adjacent) or `conversation.session.header.corner` (single).
3. Should a spawned dispatcher get a distinct glyph from a top-level dispatcher? The rider leaves the visual distinction TBD and this ticket invents no icon vocabulary.

## Constraints

- Glyph only. No text, no tooltip surface, no new panel, no floating surface, no stock-layout replacement.
- The 16 px cell takes an icon, not a label.
- One additive registration in the sidebar until a human extends the rider.
- The client revert in ticket 114 must land first; this ticket rides the post-revert composition point.

## Comments

### 2026-10-18 — filing

Filed for ADR-0024's rider and its addendum. The scope limit is the important part of this ticket: the sidebar hides subagent rows, so the worker half of the owner's three-way request is unreachable in the named slot and must move to the conversation header — which needs a fresh human ruling before implementation. That is recorded as a gate, not worked around.

Dispatcher identity is written as conditional for the same reason ADR-0027 records it: no dispatcher preset row exists in the working tree today, so `agentPreset` cannot yet discriminate a dispatcher.
