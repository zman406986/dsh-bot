# 14 鈥?Peer inbox + priority lane

**What to build:** Other assistants can reach this dispatcher asynchronously, and the user can never be interrupted by them. A peer message arrives later as its own turn, identified as another assistant rather than the user.

**Blocked by:** 12 鈥?Feature flag + profile split.

**Status:** resolved

- [x] A peer agent can send a message to the dispatcher without waiting for a reply; the send returns a delivery acknowledgement only.
- [x] A peer message arrives as a fresh hidden turn with a cue that it comes from another assistant, never as the user.
- [x] A non-priority peer message queues behind the user's current work and ahead of background work.
- [x] A priority peer message goes to the front of the inbound queue and interrupts an active non-user run.
- [x] A priority peer message never interrupts a turn the user is driving; if the active run is the user's, no interrupt happens.
- [x] Non-user work interrupted by a priority message is re-queued rather than lost, with no duplicate delivery.
- [x] The peer envelope carries a sender identity, a target that may be a single agent or a group/broadcast target, and a conversation identifier.
- [x] Group targets ignore priority: a group post queues normally and the sender is told priority did not interrupt the members.

## Comments

### Implementation (ticket 14)

Shipped as pure core modules + wake-bus integration (design-14):

- `src/core/peer-types.ts` 鈥?`PeerEnvelope`, discriminated `PeerTarget` (agent|group|broadcast), structural `PeerSendAck`, `PeerNotice`, `effectivePeerPriority`.
- `src/core/peer-inbox.ts` 鈥?sender-scoped messageId index, idempotent re-accept, `message-id-reuse` / `inbox-full` / `invalid-envelope`, delivered flags, default cap 64.
- `src/core/wake-bus.ts` 鈥?priority/normal peer deques, turn ownership (`user`|`peer`|`worker-settled`, fail closed to user), flush rank user 鈫?priority peer 鈫?normal peer 鈫?background, interrupt of non-user turns only, user preemption also reclaims peer wakes.
- `src/core/multitask.ts` 鈥?`sendPeer` / `listPendingPeers` / `peerInbox`; drain marks peer rows delivered; wires optional `requestDispatcherInterrupt`.
- `src/core/dsh-host.ts` 鈥?optional `requestDispatcherInterrupt` seam. Live adapter soft-fallback is a no-op (no public mid-turn cancel on the local install); FakeDshHost records calls.
- Hidden-turn copy: `assemblePeerWakeTurn` + `PEER_WAKE_SECTION_HEADINGS` + `buildPeerWakeInstructionsBlock` (new copy only). Plugin `composeWakeText` routes `source === "peer"` to that formatter.
- Tests: `test/peer-inbox.test.ts`, `test/wake-bus-peer.test.ts`, `test/multitask-peer.test.ts` (52 new). Suite 249 鈫?301 pass.

**Out of MVP (as designed):** messaging hub, fan-out directory, images, restart durability, out-of-process transport, dispatcher `send_peer` tool.
- Moved to resolved by overnight sweep 2026-09-18: all ACs checked; verified via implementing commits and artifact spot-check on main.

### 2026-09-19 — supersession note (ticket 70 C14 sort)

Ticket 70 (Design 2026-09-19 §3, landed `d8e2658`) supersedes this ticket's last two ACs --
the group/broadcast target shapes and the "group targets ignore priority" behavior (ACs 7
and 8 above). Those ACs were authored against the pre-ADR-0018 feature-inventory posture;
ADR-0018's exception list (C14: no group rooms; the tier is point-to-point only) is the
definition of done, and retiring the shipped group|broadcast targets is in-scope
conformance, not a new exception. As of `d8e2658`: `PeerTarget` is 1:1-only
(`{kind:"agent", agentId}`), the ack reduces to `{ok, messageId, acceptedAtMs}`
(`priorityHonored` and the `group-target`/`broadcast-target` reasons retired with the
shapes they reported on), the priority flag is inherently 1:1, and `conversationId` is
fenced (kept in schema, never surfaced). This ticket stays resolved as shipped -- history
intact, boxes above stand as of their date; the retirement delta and its evidence live on
ticket 70.
