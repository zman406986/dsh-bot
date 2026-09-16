# Design 14 — Peer inbox + priority lane

**Status**: design-only (implementation is a later ticket)
**Ticket**: `.scratch/multitask-dispatcher/issues/14-peer-inbox-and-priority-lane.md`
**Blocked by**: 12 — Feature flag + profile split
**Sources**: PRD S9 / §7.6 / §6.4 peer wake, ADR-0002, spec.md peer decisions, `docs/research/dsh-adapter-api-notes.md` §11, `src/core/wake-bus.ts` (five wake sources; `peer` reserved), `src/core/types.ts`, `src/core/dsh-host.ts`

---

## 1. Problem and constraints

Other assistants must reach this dispatcher **asynchronously**. The send is fire-and-forget: it returns a delivery acknowledgement only, never a reply. A peer message later arrives as its own **hidden turn**, clearly identified as another assistant — never as the user. Priority may cut ahead of non-user work, but the user is never interrupted by peers.

Hard constraints:

| Constraint | Source |
|---|---|
| No first-party multi-bot peer bus in dsh | adapter research §11 — plugin owns the inbox; wake via `Agent.followup` |
| Sibling `sendMessage` is not a public path | adapter research §2/§11 |
| Experimental team tooling absent from the local install | adapter research §11 — do not depend on it |
| Group posts ignore priority | ticket AC, spec reference-imitation line, S9 / ADR-0002 |
| Sand-like full messaging hub out of MVP | PRD §7.6, spec Out of Scope |
| New copy only; no reference prompt/identifier strings | AGENTS.md, PRD §8/§17 |
| S9 / M5 is the only droppable criterion; the lane exists from M1 | spec milestone mapping + Further Notes |

---

## 2. Envelope schema

Extends the PRD / spec `PeerEnvelope` sketch. The shape is the decision; names are ours.

```ts
/** How a peer message is addressed. */
export type PeerTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "broadcast" };

/** One peer message. Immutable after accept. */
export interface PeerEnvelope {
  /** Sender-assigned unique id. Primary dedupe key. Required. */
  readonly messageId: string;
  readonly fromAgentId: string;
  readonly fromName: string;
  readonly to: PeerTarget;
  /**
   * Conversation / thread slot (forward-compatibility). Present from day one
   * so a later threaded hub is not a breaking schema change. MVP treats it
   * as an opaque string carried through ack, wake, and transcript.
   */
  readonly conversationId: string;
  readonly text: string;
  /** Reserved. MVP is text-first; empty array or omitted. */
  readonly imageRefs?: readonly string[];
  /**
   * 1:1 only. Ignored when `to.kind` is group/broadcast (AC + S9).
   * Never interrupts a user-owned dispatcher turn.
   */
  readonly priority: boolean;
  readonly createdAtMs: number;
}

/** Fire-and-forget accept result. Never carries the dispatcher's reply. */
export type PeerSendAck =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly acceptedAtMs: number;
      /**
       * False when the envelope asked for priority but policy refused it
       * (group/broadcast target). Sender is told priority did not interrupt.
       */
      readonly priorityHonored: boolean;
      readonly reason?: "group-target" | "broadcast-target";
    }
  | {
      readonly ok: false;
      readonly messageId: string;
      readonly reason: "invalid-envelope" | "unknown-target" | "inbox-full";
      readonly detail: string;
    };
```

### Schema decisions

- **`messageId` is mandatory and sender-generated.** Dedupe and idempotent ack key. The inbox never invents ids after accept (re-queue would lose identity).
- **`to` is a discriminated union**, not a free string. A single agent id and a group id must not be confused; broadcast is explicit. Spec already reserved "to may name a group or broadcast target".
- **`conversationId` is required** (spec Gap 7 slot). Opaque in MVP.
- **`priority` is a boolean in the envelope, not a lane name.** The inbox maps it to a lane after target checks; the wire value stays as the sender wrote it for audit/ack honesty.
- **`imageRefs` reserved, not required.** PRD §7.6: images optional later; text first.
- **Ack is structural, not conversational.** `priorityHonored: false` plus a reason is how the sender learns that a group post did not interrupt members — no separate reply channel.

---

## 3. Inbox and priority-lane placement

### 3.1 Ownership

The **multitask core** owns the inbox (spec: core owns peer inbox + priority lane). The adapter only accepts envelopes from the host edge and maps wakes onto `Agent.followup`. Policy (who may interrupt whom) never lives in the adapter.

### 3.2 Lanes

Per dispatcher session, two ordered inbound queues:

| Lane | Contents | Order |
|---|---|---|
| **priority** | 1:1 envelopes with `priority: true` that passed the group check | FIFO |
| **normal** | every other accepted envelope (non-priority 1:1, all group/broadcast) | FIFO |

Effective priority after target check:

```text
effectivePriority(envelope) =
  envelope.priority && envelope.to.kind === "agent"
```

Group/broadcast always land in **normal**, even if the sender set `priority: true`. The ack still returns `ok: true` with `priorityHonored: false`.

### 3.3 Placement relative to existing wake material

The wake bus already ranks `user` above `worker-settled`. Peer inserts **between** them:

```text
1. user wake                         — always wins; peers never preempt this
2. priority peer wake                — front of inbound; may interrupt a non-user turn
3. non-priority peer wake            — behind user, ahead of background
4. worker-settled / background       — existing behavior unchanged
```

"Behind the user's current work" means: if a user wake is ready or the current turn is user-owned, peer material waits. "Ahead of background" means: when both peer and settled notices are waiting, the next non-user flush delivers peer first; settled stays pending for a later flush (or is included after peer in the same wake only if the wake prompt still carries a clear other-assistant cue — see §4; **default is separate turns** so the peer cue is never diluted).

### 3.4 What priority may interrupt

| Current dispatcher state | Priority peer | Non-priority peer |
|---|---|---|
| Idle, nothing ready | Deliver immediately (host opens turn) | Deliver immediately |
| Idle, user wake ready | Wait (user stays first) | Wait |
| Mid-turn, **user-owned** | **Do not interrupt.** Queue in priority lane | Queue in normal lane |
| Mid-turn, **non-user-owned** (background / prior peer) | Interrupt: reclaim undelivered background batch to pending, signal host to end the non-user turn, become the ready peer wake | Queue; flush after this turn |
| Mid-turn ownership unknown | Treat as user-owned (fail closed) | Queue |

**Workers are not interrupted by peer priority.** "Non-user run" means the dispatcher's non-user *turn*, not in-flight workers. Workers keep running; their settles stay on the wake bus. Re-queue applies to dispatcher-side material (the reclaimed background batch and any already-ready non-priority peer wake).

### 3.5 Re-queue without duplicate

Interrupt path:

1. Snapshot the ready non-user `WakeEvent` (settled notices and/or non-priority peer ids).
2. Push settled notices back onto the bus pending list (same rule as `enqueueUserWake` today).
3. Push any ready non-priority peer envelopes back onto the **front** of the normal inbox lane (preserve order; do not re-accept as new).
4. Mark the interrupted peer wake material as **not delivered** (delivered flag on the inbox row, not a second envelope).
5. Become ready as the priority peer wake.

Invariant: **one envelope, one messageId, at most one delivered turn.** Re-queue never calls the accept path again; it only moves undelivered rows. A messageId that has already been delivered is never re-enqueued (see §5).

---

## 4. Hidden turn and "other assistant" cue

A peer message must never look like the user (ticket AC, PRD §6.4, spec user story 39).

### Delivery shape

1. Core marks the peer wake ready (`source: "peer"`).
2. Host opens a turn via the existing `requestDispatcherWakeup` path (`Agent.followup` on the dispatcher Agent — adapter research §5C).
3. The turn body is **host/plugin-authored new copy**, not a `UserMessage` that impersonates the user. Structure:

```text
[peer message — not from the user]
From: {fromName} ({fromAgentId})
Target: {agent|group|broadcast…} · Conversation: {conversationId}
Priority: {yes|no} · Received: {timestamp}

{envelope.text}
```

Wording is new copy under `prompts/`-style assets; the bracket cue is a *concept* (PRD: "`[peer]` cue style *concept*; new copy"), not a copied literal.

### Host seam notes

- Prefer `followup` (opens a turn) over `inject` alone (no wake). May combine: short followup cue + inject payload if the host wants the body out of the user-visible surface — confirm at ticket 09/adapter integration; core only requires "fresh hidden turn + other-assistant cue".
- Do **not** use the user-messaging path. The dispatcher may *later* choose to paraphrase a peer result to the user on its own turn; that is policy, not the inbox.
- Workers still have no peer tools (tool barrier unchanged).

### WakeEvent extension

```ts
export interface PeerNotice {
  readonly messageId: string;
  readonly fromAgentId: string;
  readonly fromName: string;
  readonly to: PeerTarget;
  readonly conversationId: string;
  readonly text: string;
  readonly priority: boolean; // effective priority used for this wake
  readonly createdAtMs: number;
}

export interface WakeEvent {
  readonly sessionId: string;
  readonly source: WakeSource; // "user" | "worker-settled" | "peer" | ...
  readonly settledWorkers: readonly SettledWorkerNotice[];
  /** Present when source === "peer"; FIFO of delivered peer messages. */
  readonly peerMessages?: readonly PeerNotice[];
}
```

Batching: multiple priority peers that were already in the priority lane may flush as one peer wake (same as settled batching). A priority arrival while a non-priority peer wake is ready replaces it as the ready wake and re-queues the non-priority set (step 3 in §3.5). One peer wake never mixes with `source: "worker-settled"`.

---

## 5. Duplicate prevention

| Layer | Mechanism |
|---|---|
| Accept | `messageId` recorded in an inbox index **before** the ack returns. Second accept with the same id returns the **same** `ok: true` ack shape (`priorityHonored` recomputed from the stored envelope policy decision) and does **not** append a second queue row. |
| Queue | At most one row per `messageId` across both lanes. |
| Deliver | `drain` marks rows delivered and removes them from the lane. A later re-queue only moves **undelivered** rows. |
| Re-queue | No new messageId; no second ack; no second index insert. |
| Ack | Idempotent: repeating `sendPeer(envelope)` with a known `messageId` and identical payload is a no-op enqueue + ack; same id with a different payload is `ok: false` / `invalid-envelope` (or a dedicated `message-id-reuse` reason — pick one at implementation and keep it stable). |
| Bounded memory | Index and lanes are capped (config: max pending envelopes per session). Overflow → `inbox-full` ack; never silent drop of an accepted id. TTL/prune of delivered ids is an implementation detail; keep enough history to reject a late duplicate. |

---

## 6. Wake-bus integration

Current bus (`src/core/wake-bus.ts`): `pending: SettledWorkerNotice[]`, `ready: WakeEvent | null`, `busy: boolean`, user preemption of worker-settled only.

### Required changes (design, not implemented here)

1. **Session state gains turn ownership** — `currentTurn: "user" | "peer" | "worker-settled" | null` (or equivalent). `noteTurnStarted` is not enough for §3.4; the bus must know whether the running turn is user-owned. Fail closed to "user" when unknown.
2. **Peer pending structure** — two FIFO deques (`priorityPeers`, `normalPeers`) holding accepted `PeerNotice`s / envelope refs, not stuffed into `pending: SettledWorkerNotice[]`.
3. **`enqueuePeer(envelope | notice, effectivePriority)`** — placement rules §3.2–§3.4; may call `onDeliver` when idle and nothing user-ready.
4. **Flush order on `noteTurnEnded` / idle** — user ready → leave; else priority peers → peer wake; else normal peers → peer wake; else existing settled flush.
5. **User preemption stays strongest** — `enqueueUserWake` still reclaims a ready **worker-settled** batch; it must also requeue a ready **peer** wake (priority or normal) back into the matching lane so the user turn wins.
6. **`requestDispatcherInterrupt` (new host seam, optional in M5-min)** — only needed to *abort* a live non-user dispatcher turn. If the host cannot cancel mid-turn, the weaker but still AC-compliant MVP is: priority waits for turn end but jumps ahead of everything non-user on the next flush, and mid-turn non-user material is reclaimed at turn end. Prefer real interrupt when the host offers `Agent.cancel` with `keepInbox` (adapter research §3). Document which mode the adapter implements.
7. **Vocabulary** — keep `"peer"` as the wake source; no new source enum members. Group/priority are properties of the notice, not new sources.

`timer` / `external-event` remain accepted and unimplemented.

---

## 7. Core / host API sketch

```ts
// Multitask (or a PeerInbox collaborator it owns)
interface PeerInbox {
  send(envelope: PeerEnvelope): PeerSendAck; // sync accept; no await on delivery
  /** Undelivered snapshot for tests / status tools. */
  listPending(sessionId: string): readonly PeerEnvelope[];
}

// WakeBus additions
enqueuePeer(sessionId: string, notice: PeerNotice, effectivePriority: boolean): void;
// drain/peek already return WakeEvent; peer wakes carry peerMessages

// DshHost addition (adapter implements; tests fake)
/**
 * Ask the host to abandon the current non-user dispatcher turn and open
 * the next one. No-op when the current turn is user-owned or none is live.
 */
requestDispatcherInterrupt?(sessionId: string): Promise<void>;
```

`send` is synchronous accept + ack (fire-and-forget). Delivery is entirely wake-bus + host followup.

Transport (adapter, not core): MVP is **in-process** — peers in the same dsh process call a plugin-exported `sendPeer`. Out-of-process peers are a later adapter face over `ctx.storageDomain` KV or a sidecar; the envelope and ack do not change.

---

## 8. Group / broadcast (schema only in MVP)

- Envelope accepts group and broadcast targets from day one (spec user story 40).
- **No hub.** No membership directory service, no fan-out loop required in M5-min.
- Local policy: when this dispatcher receives a group/broadcast envelope, it queues normally and the sender's ack says priority was not honored.
- Optional later: the adapter fans out to member agent ids; each fan-out is an independent 1:1 envelope with a fresh `messageId` derived per member — do not reuse one id across members (would break dedupe).

---

## 9. File layout

```text
src/core/
  peer-types.ts          # PeerEnvelope, PeerTarget, PeerSendAck, PeerNotice
  peer-inbox.ts          # lanes, effective priority, dedupe index, send()
  wake-bus.ts            # extend: peer queues, turn ownership, flush order
  dsh-host.ts            # optional requestDispatcherInterrupt
  multitask.ts           # own a PeerInbox; expose send on the core surface
  types.ts               # re-export peer types if they are part of the public surface
prompts/ (or equivalent assets dir)
  peer-hidden-turn.md    # new copy: other-assistant cue template
tests/core/
  peer-inbox.test.ts
  wake-bus-peer.test.ts
  multitask-peer.test.ts
adapter (ticket 09+)
  dsh-adapter.ts         # sendPeer edge, followup/cancel mapping
```

No second transcript DB. Accepted envelopes that are still undelivered live in memory with the wake bus for MVP; if restart durability is required later, store only the minimum-to-reconstruct (messageId, envelope, lane, delivered flag) through `ctx.storage` / obligation-marker idiom (ADR-0006 pattern) — **defer**, do not invent a peer-specific store now.

---

## 10. Test plan

All tests against the fake host / pure core; no network, no LLM (S8 pattern).

### Accept / ack

- Valid 1:1 envelope → `ok: true`, `priorityHonored: true`, messageId echoed; no dispatcher turn required for the ack to resolve.
- Same messageId twice, identical payload → one queue row, ack still ok, no double delivery later.
- Same messageId, different payload → refused.
- Invalid envelope (missing messageId / text) → `ok: false` `invalid-envelope`.
- Inbox full → `ok: false` `inbox-full`; previously accepted ids still undelivered.

### Hidden turn

- Delivered peer wake has `source: "peer"` and `peerMessages` carrying from/to/conversationId/text.
- Formatter produces an other-assistant cue; formatter unit test checks presence of cue tokens, not full prose wording policy beyond "must not present as user".
- Core never calls a user-messaging host path for peer delivery.

### Ordering

- User wake ready + idle → user drains first; peer remains pending.
- Non-priority peer + worker-settled both pending, idle → next flush is peer; settled still pending.
- Several normal peers → FIFO; one wake may batch them.
- Several priority peers → FIFO in priority lane.

### Priority interrupt

- Mid non-user turn (bus `currentTurn === "worker-settled"`): priority enqueue → interrupt requested (fake host records it), background batch reclaimed to pending, ready becomes priority peer wake, `peerMessages[0]` is that envelope.
- Mid **user** turn: no interrupt call; priority stays in lane; after user turn ends, priority flushes before settled.
- Priority while non-priority peer wake is ready: non-priority re-queued to normal lane front; ready is priority; no duplicate delivery when both eventually drain.
- Ownership unknown → treated as user-owned (no interrupt).

### Group / broadcast

- Group envelope with `priority: true` → lands in normal lane, ack `priorityHonored: false`, `reason: "group-target"`.
- Broadcast same with `broadcast-target`.
- No interrupt for group priority.

### Re-queue

- After priority interrupt of a background wake that contained N settled notices + M normal peers, all N+M drain exactly once later; inbox index does not grow by re-queue.

### Regression

- Existing wake-bus tests still pass: user preemption of settled, mid-turn hold, settle batching.
- Worker barrier unchanged: workers gain no peer send tool.

---

## 11. Risks and open points

| Risk | Mitigation |
|---|---|
| Host cannot cancel a live dispatcher turn | Document weaker "queue-and-jump" mode (§6.6); still meets "never interrupt user" and "ahead of background". Prefer `Agent.cancel` when available. |
| Mid-turn ownership mis-detected | Fail closed to user-owned; never interrupt on uncertainty. |
| Peer cue confused with user | Dedicated formatter + tests; never reuse user-wake copy. |
| messageId collisions across senders | Treat id as sender-scoped key `fromAgentId + messageId` if global uniqueness cannot be guaranteed; decide at implementation and keep stable. |
| Memory growth of undelivered peers | Cap + `inbox-full` ack; document. |
| Out-of-process transport undefined | MVP in-process only; envelope is transport-agnostic. |
| dsh API drift (0.1.5-rc.1 preview) | Pin version; re-verify followup/cancel at adapter integration (adapter research §14). |
| Group fan-out scope creep | Schema + ignore-priority ack only; hub stays out of scope. |

**Open (non-blocking for this design):**

- Whether a single peer wake may batch priority and undelivered normal together after an interrupt (default: no — priority-only ready wake).
- Exact hidden-turn host primitive (`followup` vs `inject`+`followup`) — adapter ticket.
- Restart durability of undelivered peer rows — deferred; in-memory MVP.

---

## 12. MVP optionality

| Piece | In M5-min / ticket 14 AC | Later / droppable |
|---|---|---|
| Envelope + messageId + target union + conversationId | **Required** (AC) | — |
| Fire-and-forget ack | **Required** | — |
| In-process send edge | **Required** | Out-of-process / sidecar transport |
| Hidden turn + other-assistant cue | **Required** | Richer payload types (images) |
| Normal lane behind user / ahead of settled | **Required** | — |
| Priority 1:1 interrupt non-user | **Required** | Host-cancel soft-fallback if needed |
| Group ignore-priority + honest ack | **Required** | Membership directory, fan-out, hub |
| Turn-ownership tracking in wake bus | **Required** for priority correctness | — |
| Peer durability across restart | Optional | ADR-0006-style markers |
| Peer tool on dispatcher agent (`send_peer` / `list_peers`) | Optional | Needed only when peers are model-driven rather than host-edge |
| S9 itself | ADR-0002: in scope for **this** project (M5) | Spec: only criterion droppable without touching S1–S8; lane vocabulary already reserved from M1 so dropping costs no contract change |

**MVP cut line:** ship 1:1 accept/ack, normal + priority lanes wired into the wake bus, hidden-turn cue, group schema with priority stripped and acked. Do not build a messaging hub, image pipeline, or peer directory in the same change.

---

## 13. Traceability

| AC / requirement | Design section |
|---|---|
| async fire-and-forget + ack | §2, §7, §10 |
| hidden turn, other-assistant cue | §4 |
| non-priority behind user / ahead of background | §3.3, §6.4, §10 |
| priority interrupts non-user only | §3.4, §6.6, §10 |
| never interrupt user turn | §3.4, §6.5 |
| re-queue without duplicate | §3.5, §5, §10 |
| envelope: sender, group/broadcast, conversation id | §2, §8 |
| group ignores priority; sender told | §2, §3.2, §8, §10 |
| no first-party peer bus | §1, §7 |
| wake source `peer` already reserved | §6.7 |
| MVP optionality / M5 / S9 | §12 |

---

## 14. Non-goals (this design)

- Rebuilding dsh messaging or inventing a second transcript DB.
- Worker-to-worker messaging (workers stay leaves; no peer tools on workers).
- A full group/broadcast hub, membership service, or UI.
- Copying reference prompt text, tool names, or identifiers.
- Implementing into `src/` in this ticket — design note only.
