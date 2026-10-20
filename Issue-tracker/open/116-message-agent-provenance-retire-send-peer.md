# 116 — `message_agent` tool + routing + structured provenance; retire `send_peer`

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 114
**Related:** ADR-0025 (peer messaging and structured provenance), ADR-0027 (identity and labels), ADR-0028 (the worker reply lane reuses this provenance), ticket 118 (a spawned dispatcher is only useful once it can be messaged), ticket 119 (policy text), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.1 and §6 (untracked input, not authority)

## Problem

`send_peer` reaches dispatcher sessions only. A dispatcher that wants to correct a running worker has to know to call `steer_worker` instead, and the two verbs address different populations with different failure shapes. Provenance also rides mostly on the text cue ("Peer message — not from the user") rather than on a structured field.

ADR-0025 settles one dispatcher messaging verb with routing inside it, and provenance as a field rather than a marker.

## What to do

- [ ] Add the core tool `message_agent(target, text, priority?)`.
  - Worker target → the existing steer path, unchanged: single-slot last-wins park, interrupt, wrapped send at the next step boundary. Reuse `multitask.steerWorker`; do not build a second queue.
  - Dispatcher target → the existing peer inbox and peer wake lane (`multitask.sendPeer`). `priority` may reclaim a non-user turn and never interrupts a user turn.
  - Refusals, honest and without retry affordance: `unknown-target`, `self-target`, `not-running` (worker terminal or not started), `inbox-full`, `rate-limited`, `invalid-envelope`.
  - Result: `{ ok: true, target, delivered_as: "steer" | "peer", message_id, note }`.
- [ ] Retire `send_peer`: remove it from the dispatcher registration list and `DISPATCHER_TOOL_NAMES`. **Keep its core machinery** (inbox, envelope, dedupe, caps) — `message_agent` and ADR-0028's reply channel both ride it.
- [ ] Make dispatcher-bound provenance structured. Give the wake message an optional source override and stamp peer wakes with `{ kind: "agent-message", form: "relay", senderSessionId }` instead of the plugin source. The text heading stays as presentation only and is never used to decide origin. Sender identity comes from the registration closure's session id; there is **no `from` argument**.
- [ ] Enforce the message rate cap: **8 accepted agent messages per sender session per rolling 60 s** (counted on accept; refusals do not count). Reuse the existing 8,000-character text cap.
- [ ] Agent traffic never calls `enqueueUserWake`, never sets `pendingOwner: "user"`, never satisfies an approval ask, and never counts as user presence.
- [ ] Unit tests: worker routing parks/interrupts/sends and last-wins holds; settled worker refuses `not-running`; another session's worker refuses `unknown-target`; self-target refuses; dispatcher target accepts into the inbox and enqueues a wake; `priority` lands on the priority lane and does not interrupt a user turn; deactivated dispatcher refuses `unknown-target`; 9th message in the window refuses `rate-limited` with nothing queued; oversize text refuses `invalid-envelope`; a peer wake's source kind is `agent-message` and the bus owner is `peer`.
- [ ] Update the tool description. Do not touch policy prose or PRD text — ticket 119 owns those.

## Constraints

- No directory tool. Ids come from a spawn ack, an inbound peer message (`fromAgentId`), the stock `list_agents` for children, or the user (C13).
- `steer_worker` stays. It is the worker-specific correction verb; `message_agent` routes workers through the same core call.
- The stock host `send_message` stays visible in the preset and cannot be hidden without editing a stock preset; the policy text names `message_agent` as the tool to use.
- Offline `FakeDshHost` tests only (S8 lane).

## Comments

### 2026-10-18 — filing

Filed from the design note §12 ticket 116, trimmed to what ADR-0025 actually decides. The retirement is a registration change, not a deletion: the inbox and envelope machinery is what ADR-0028's reply lane reuses, so deleting it would break a later ticket.

Blocked by 114 (0.2.1 host port).
