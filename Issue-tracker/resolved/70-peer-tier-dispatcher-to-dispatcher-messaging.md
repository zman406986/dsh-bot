# 70 — Peer tier: dispatcher-to-dispatcher messaging (ADR-0018 in-scope area)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none for the design pass — 67 resolved (ADR-0020); 72 resolved and its practical gate (76's session keying) landed. Live two-dispatcher verification rides the 45/33 lane (ADR-0019 sign-off gates live work only — ticket-76 precedent). See the 2026-09-19 triage comment.
**Related:** ADR-0018 (in scope: "the peer tier (dispatcher-to-dispatcher messaging)"; exception C15, C14), PRD §7.6 / S9 / ADR-0002 (peer agents in scope; async fire-and-forget with optional priority interrupt), 14 (shipped peer inbox + priority lane), ticket 50's cancelled outbound half

## Problem

ADR-0018 makes dispatcher-to-dispatcher messaging a first-class area. Ticket 14 shipped a peer
inbox and priority lane against the single-dispatcher model; ticket 50 (cancelled) sketched the
outbound half under a since-retracted premise. The wrapper era needs the peer tier re-based:
dispatcher sessions messaging each other, async, with the optional priority interrupt of non-user
work (S9).

## What to do (research/design ticket)

- [x] Re-verify what the reference's peer/multi-agent messaging actually does from the research
      notes (org-chart edges, recent-conversation markers — cite file:line; never open the
      reference tree). — Done in the Design 2026-09-19 comment §1.
- [x] Re-base ticket 14's inbox/priority-lane design onto per-dispatcher sessions (keying per
      session, not one process-global lane). — Audited; already keyed (76); isolation pins
      specified in the Design comment §4.
- [x] Design the outbound send: async fire-and-forget; optional priority interrupt of non-user
      work; last-wins semantics do not apply across peers (per-peer steer is a dispatcher-internal
      concern). — Design comment §2.
- [x] **C14 is binding:** no org chart, no group rooms, no routines — the tier is point-to-point
      messaging only. **C15 is binding:** peer messages are a wake source into the receiving
      dispatcher's existing single-wake-kind pipeline, not a new wake kind class. — C14 sort
      recorded (retire group|broadcast); Design comment §3.
- [x] Draft implementation ACs once 67 and 72 land. — Chunked ACs; Design comment §5.
- [x] **Chunk 1 (offline, M):** core C14 sort + isolation. — `d8e2658`: `PeerTarget` is
      1:1-only (group|broadcast retired as conformance per §3; `priorityAckFields` gone;
      ok-ack reduced to `{ok, messageId, acceptedAtMs}`; `conversationId` fenced — the
      assembler no longer surfaces it); new `isLiveDispatcherSession` knob finally produces
      `unknown-target`, plus unconditional `self-target` refusal in `sendPeer` (plugin wires
      the knob to `lifecycle.isDispatcherSession`); `test/multi-dispatcher-peer.test.ts` pins
      all six §4 two-dispatcher cases + both knob fences + absent-knob host-agnosticism.
      1:1 traffic behavior unchanged (narrow guard held).
- [x] **Chunk 2 (offline, M):** sixth dispatcher tool `send_peer` + policy copy. —
      `1a4eb6d`: def in `createDispatcherTools` (zero `activateToolSurface` changes — the
      per-session scoped surface registers every def); addressing = dispatcher session id;
      sender identity stamped from the registration closure (no spoofable `from` arg);
      handler mints `messageId` + fenced `conversationId: "direct"`; ack maps to honest
      acceptance-only summary (`formatPeerSendAck` — never user delivery, never a reply);
      refusals (`unknown-target` / `self-target` / `inbox-full` / `message-id-reuse`) carry
      no-retry copy (`formatPeerSendRefusal`); over-max 8000-char inline U-F refusal;
      priority honored only as the 1:1 lane choice (interrupt rule is the shipped
      non-user-only fail-closed wake-bus path — untouched); worker barrier denies
      `send_peer`; toolview row + locale labels; scoped-visibility test (dispatcher sees it,
      worker scope does not).
- [x] **Chunk 3 (offline, S):** client placement per ADR-0020 hand-off. — `fbd4066`:
      dispatcher sidebar rows (79) carry a hover/focus copy-session-id affordance (shows the
      id verbatim; copies through the injected `copyToClipboard` host seam with a contained
      best-effort `navigator.clipboard` fallback — no fake success); conversation surface
      (80) pinned honest: an injected peer wake turn is skipped wholesale by the reduction
      and never renders as user speech; locale labels en/zh; component tests per the 79/80
      patterns.
- [ ] **Chunk 4 (45/33 lane ONLY, S):** live two-dispatcher verification. — **Unticked by
      design; routed to ticket 33's live lane** (ADR-0019 sign-off gates live work,
      ticket-76 precedent). Remaining live ACs: two dispatchers activated; A's model calls
      `send_peer` with B's session id; B opens a peer-cue turn; the priority variant
      interrupts B's non-user turn and never a user-driven turn; a bad-id send yields honest
      refusal copy with no retry. Trivial tasks only, kill timers per AGENTS.md.

## Constraints

- Workers never participate in the peer tier (leaves); only dispatchers.
- New or adapted copy only.

## Comments

### 2026-09-19 — agent (claim: implementation chunks 1–3, offline)

Claimed for chunks 1–3 per the Design 2026-09-19 comment §5: chunk 1 core C14 sort +
two-dispatcher isolation pins; chunk 2 `send_peer` tool + policy copy; chunk 3 client
placement (79 copy-id affordance, 80 peer-cue honesty). Chunk 4 (live two-dispatcher
verification) stays unticked — 45/33 lane only. Escalation 1 (directory-less addressing
annotation) remains open with the ticket; proceeding per the dispatch ruling (the design
already resolved the reading).

### 2026-09-19 — agent (vehicle hand-off from 67)

Vehicle decided (draft): **ADR-0020**. Placement: peers are dispatcher sessions, so the
wrapper's sidebar roster (ticket 79, keyed by session id per ADR-0019/76) is where peer
presence and the send targets live; conversations with peers render as conversation surfaces
of their session (80). Your design constraints (C14 point-to-point, C15 single wake kind) are
unchanged; your remaining block on 72 is discharged at the design level (ADR-0019 drafted) —
the practical gate is now 76's session keying, same as 79's.

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent)

Verdict (a) for the design pass. Every named gate has landed: 67 → ADR-0020; 72 → ADR-0019
drafted AND 76 shipped the session keying this tier needs. Verified against the core: the peer
data path is already per-dispatcher (`src/core/peer-inbox.ts:35-46` — the inbox face is
`send(sessionId, envelope)` / `listPending(sessionId)` / per-session delivered flags;
`src/core/multitask.ts:943-962` — `sendPeer`/`listPendingPeers` take the session id; the wake
bus holds per-session peer deques with turn-ownership + priority-interrupt rules from 14). What
does not exist yet is the outbound half (14 explicitly left the dispatcher send tool out of
MVP; 50's cancellation voided its sketch, not the need) and the wrapper-era placement/sort.

**Agent-ready brief (design ticket — implementation decomposes at dispatch time; this ticket
does not spawn sub-tickets)**

- **Scope-in:** reference peer-messaging verification from the notes (thin — record it);
  inbound re-base audit against 76's keying; outbound send design; the C14 sort of the shipped
  group/broadcast envelope targets; implementation ACs chunked for dispatch.
- **Scope-out:** org chart, group rooms, routines (C14); workers as participants (leaves); a
  new wake-kind class (C15 — peer messages stay a wake source into the existing single-wake
  pipeline); send journal / offline queue / retry or reconnect affordances (A4 + the
  conservative U-A reading of ticket 82's interim rule: a failed peer send gets honest copy,
  never a retry control); push presence (79's pull-only markers stand).
- **Builds on:** `src/core/peer-types.ts` (`PeerEnvelope`, `PeerTarget` agent|group|broadcast,
  priority), `src/core/peer-inbox.ts` + `src/core/wake-bus.ts` (per-session lanes, interrupt
  of non-user turns only), the optional `requestDispatcherInterrupt` host seam (live adapter
  no-op fallback — recorded), 76's per-session scoped tool registration (the outbound tool
  registers in each dispatcher's own surface), 79's sidebar roster rows + 80's conversation
  surfaces (placement per ADR-0020's hand-off), `docs/research/reference-behavior-notes.md:60`
  (peer tool is top-level-agent-only; workers exclude it) + `always-on-dispatcher-behavior.md`
  area 9 (org-chart context — excluded C14, cited only for what peer messaging is NOT).
- **ACs:**
  1. Verification from the research notes, cited file:line, with the thin-depth caveat
     recorded — design only on what is cited; no invented reference detail.
  2. Inbound audit: an offline S8 test pins two dispatcher sessions have fully isolated
     inboxes, wake lanes, and delivered flags (expected pass — the core is already keyed;
     a failure here is a bug to fix, not new design).
  3. Outbound design: per-session dispatcher send tool (name/schema ours), addressing =
     target dispatcher session id (how the sender learns ids: the sessions feed / 79's
     roster), async fire-and-forget ack (direct send — A4), optional priority interrupt of
     non-user work only (existing turn-ownership rules; S9).
  4. C14 sort recorded for the shipped group|broadcast targets: expose / fence / retire,
     with rationale — point-to-point is the tier's contract.
  5. Implementation ACs chunked: (i) core outbound + offline tests; (ii) client placement
     hooks in 79/80 surfaces; (iii) live two-dispatcher verification, marked for the 45/33
     lane only.
- **Risks:** the group/broadcast shapes predate ADR-0018 — the AC-4 sort may retire shipped
  surface (that is in-scope conformance, not a new exception); priority interrupt must never
  interrupt a user-driven turn (14's rules already pin this — reuse, don't re-design).
- **Size:** M (design); implementation L → decompose at dispatch time.

### 2026-09-19 — agent (Design 2026-09-19: outbound per-session send, C14 sort, chunked ACs)

Design pass complete. Headline: the inbound half is already per-dispatcher and keyed (76 landed);
the design adds a **sixth dispatcher tool** for point-to-point outbound send on the existing
per-session scoped surface, **retires the pre-C14 group|broadcast shapes as conformance**, and
chunks implementation into 3 offline slices + a live-only slice for the 45/33 lane. The PRD's
"Phase 2 optional" header wording is stale, not a live conflict — ADR-0002 (accepted) resolved
§15.5 in-scope and ADR-0018 lists the peer tier in-scope, so the smallest honest scope here is
**inbound (shipped) + one outbound tool; no hub, no directory, no transport work**.

#### §1 Verified inventory (cited; honest gaps recorded, not simulated)

Exists today (all per-dispatcher since 76):

- Accept/dedupe authority: `src/core/peer-inbox.ts:35` `send(sessionId, envelope)`, `:37`
  `listPending(sessionId)`, `:44` `markDelivered`, `:46` `has`; per-session state
  `:122-139`; cap 64 `:16`; sender-scoped dedupe index `:57-60`; idempotent re-accept
  `:166-192`; refusal reasons (invalid-envelope / unknown-target / inbox-full /
  message-id-reuse) `:50-58`. NOTE: `unknown-target` exists in the ack vocabulary but is
  **never produced** — `send` lazily creates state for any session id (`:132-139`), so today a
  send to a nonexistent session acks ok and sits unread forever. Recorded gap; §2 fixes it.
- Core API: `src/core/multitask.ts:239` `sendPeer(sessionId, envelope): PeerSendAck`, `:241`
  `listPendingPeers`, `:245` `peerInbox`; wiring `:965-980` (inbox accept →
  `wakeBus.enqueuePeer` with `effectivePeerPriority`); drain marks rows delivered `:318-325`.
- Wake path (C15-clean): `src/core/wake-bus.ts:14-30` — `peer` is a source **inside** the
  single existing wake vocabulary, not a new kind class; per-session priority/normal deques
  `:166-169`; flush rank `:302-336`; user-preemption reclaim `:343-368`; `enqueuePeer`
  `:455-511` — fail-closed user ownership `:459-462`, priority interrupts non-user turns only
  `:470-484`, workers never interrupted `:105-108`.
- Interrupt seam: `src/core/dsh-host.ts:34` optional `requestDispatcherInterrupt?`, soft
  fallback wired `src/core/multitask.ts:311-317`. Honest limitation: the live adapter's
  fallback is a no-op, so on the live host a priority peer currently **wins the next flush**
  rather than aborting a mid-turn (recorded in code, not simulated away).
- Hidden-turn copy: `src/core/policy/assembler.ts:200-227` `assemblePeerWakeTurn` —
  other-assistant cue, renders `fromName (fromAgentId)` per notice. This rendering is the
  model-visible discovery surface a replying dispatcher reads the sender's id from.
- Worker barrier: structural (ADR-0019 scope chains), `src/adapter/dispatcher-tools.ts:4-10`;
  core-side pin `test/multitask-peer.test.ts:340`.
- Scoped registration (76): `src/plugin.ts:429-458` `activateToolSurface` — the closure IS the
  session; `src/adapter/dispatcher-tools.ts:152-178` registers every def from
  `createDispatcherTools`.

Does NOT exist: any outbound dispatcher send tool. Ticket 14's resolved comment lists
"dispatcher `send_peer` tool" out of MVP; `createDispatcherTools` returns exactly five defs
(`src/core/tools.ts:244,340,437,468,523`; names `src/core/policy/prompts.ts:8-12`), and no
model-visible surface exposes peer session ids.

Reference verification (from the notes only; reference tree not opened):

- `docs/research/reference-behavior-notes.md:60` — worker runs exclude the peer-message tool
  (workers are leaves; our conformances match).
- `:86-100` — direct peer messaging exists only between top-level agents; fire-and-forget: the
  send returns a delivery ack; the reply arrives later as its own message waking a fresh turn.
- `:126-145` — explicit priority flag: priority 1:1 goes front-of-queue **and** interrupts the
  recipient's running turn, never a user-driven one; interrupted work is re-queued, re-drivable,
  deduped; **priority is 1:1 only** — group posts ignore it.
- `:133` — the reference's "broadcast" is the **user** messaging all their agents (a distinct
  user cue), not a peer-tier send.
- `:70`, `:88` (`always-on-dispatcher-behavior.md`) — org-chart edges/recent-conversation
  markers visualize the hub we excluded (C14); cited only for what the tier is NOT.
- **Thin-depth caveat (recorded, per AC 1):** the notes are "clear for 1:1 peer priority;
  partial for the broadcast/channel lanes … not traced end-to-end" (`:143`). The design builds
  only on the 1:1 material; the partially-traced area (group/broadcast) is precisely the area
  §3 retires, so no design weight rests on thin evidence.

#### §2 Outbound design: per-session send tool

**Tool.** A sixth dispatcher tool, name ours: `SEND_PEER_TOOL = "send_peer"` (constant in
`src/core/policy/prompts.ts`, appended to `DISPATCHER_TOOL_NAMES`). Schema (authored as
`ToolParameterNode`, serialized per ticket 45):
- `to_session` (string, required) — target **dispatcher session id**.
- `text` (string, required, non-empty; max length refused inline — see gaps below).
- `priority` (boolean, optional, default false) — 1:1 lane choice.

The handler mints `messageId` (unique per send; the dedupe index stays an internal guarantee,
not a model burden) and defaults `conversationId` to a constant (`"direct"` — the opaque
forward-compat slot stays inert). `fromAgentId`/`fromName` = the sender's **own session id**
from the registration closure (`getSessionId()`, `dispatcher-tools.ts:141`) — no `from` arg,
so a dispatcher cannot spoof a sibling.

**Registry (per 76).** The def is added to `createDispatcherTools`; `activateToolSurface`
needs zero changes (it registers every def through the activated agent's scoped
`agent.ctx.tools`, `plugin.ts:452-455`). Per-agent visibility is the fence: a worker or sibling
cannot see the tool at all (host `UNKNOWN_TOOL`) — no execute-time gate, no new registration
path. The "five dispatcher tools" comments (`plugin.ts:384`, `dispatcher-tools.ts:1-2`) get a
count touch-up.

**Addressing.** Target = the peer's dispatcher session id. How the sender learns it (no
directory — C13 territory, see §6): (a) a peer wake turn renders the sender's
`fromAgentId` (`assembler.ts:212-213`), so a recipient can reply to the id it sees; (b) the
user supplies/pastes an id via the composer, with ticket 79's roster rows (keyed by session id)
as the human-side source. There is no discovery tool by design: discovery would be a roster
of peers, which C13 excludes.

**Ack semantics (A4, direct send).** The tool result is the existing structural `PeerSendAck`
(`peer-types.ts:37-58`). `ok:true` means exactly: **accepted into the target's inbox and wake
lane; the target's next turn will see it** — inbox insert, never user delivery, never a reply,
never "the peer read it". Copy must not promise more. Failures render honest refusal copy via
`renderStructured` (`dispatcher-tools.ts:41-75`) with **no retry affordance and no queueing**
(A4 + the conservative U-A reading per ticket 82): a failed send is reported, full stop.

**New small core seam — liveness check.** `MultitaskOptions` gains optional
`isLiveDispatcherSession?: (sessionId: string) => boolean`; `sendPeer` consults it for the
`to_session` before accept and refuses with `unknown-target` (finally produced) when false;
`self_session === to_session` refuses with a new `self-target` ack reason (a self-send would
enqueue a peer wake into the sender's own inbox — a self-loop with no reference warrant; thin
evidence, refused as the honest default). The plugin wires the callback to
`lifecycle.isDispatcherSession(id)`; core tests inject a fake; absent callback keeps current
behavior (core stays host-agnostic, wiring lives adapter-side). Offline-testable both ways.

**Optional priority interrupt (non-user-only).** `priority:true` on 1:1 →
`effectivePeerPriority` → front-of-queue plus interrupt of a live turn whose owner is
`"peer"` or `"worker-settled"` — i.e. background worker-settle turns and prior peer turns.
"Non-user-only" means precisely: a user-driven turn (owner `"user"`) or **unknown** ownership
is never interrupted (fail closed, `wake-bus.ts:459-462`); interrupted non-user work re-queues
re-drivable and deduped (`:343-368`, tests `multitask-peer.test.ts:202-261`); in-flight workers
keep running (`wake-bus.ts:105-108`). Warrant: S9 (`PRD:75`),
`reference-behavior-notes.md:130-131`, ADR-0002 — **imitation, no new exception**. Mechanism
reuses the existing optional `requestDispatcherInterrupt` seam with its recorded no-op
fallback. Last-wins does not apply across peers: B8 steer is dispatcher-internal; peer
messages are fresh turns, never mid-turn injections (the priority interrupt is a run
interrupt + re-queue, not a steer).

#### §3 C14 sort of the shipped group|broadcast targets

Binding citations: ADR-0018 exception item 7 (C14: "no org chart, no routines/automations
subsystem, no per-agent memory, **no group rooms**"; the list is exhaustive — anything not on
it is imitated) and this ticket's own contract ("the tier is point-to-point messaging only").
The reference HAS group rooms and broadcast (`reference-behavior-notes.md:96,132-133,139`), so
excluding them is a deviation — and C14 **is** the recorded exception covering it. Shipping
group targets would contradict the exception list; retiring them is **in-scope conformance**
(triage's wording), not a new exception.

| Shipped surface | Disposition | Rationale |
|---|---|---|
| `PeerTarget` kind `"group"` (`peer-types.ts:7-10`) | **Retire** | Remove from the union, inbox validation (`peer-inbox.ts:96-99`), `priorityAckFields` (`:113-115`), label (`:88-89`), and the priority-target check (`peer-types.ts:79-81` → `priority` alone). No producer or consumer exists (no outbound tool ever shipped; wake copy renders the label only). Tests `multitask-peer.test.ts:99-142`, `peer-inbox.test.ts:120-172` rewrite with the shapes. |
| `PeerTarget` kind `"broadcast"` | **Retire** | The reference broadcast is the user-to-all-agents cue (`:133`) — not a peer-tier send at all; the dispatcher-facing semantic is empty under C14 + point-to-point. Ack reason `"broadcast-target"` retires with it. |
| Ack fields `priorityHonored` + reasons `"group-target"|"broadcast-target"` (`peer-types.ts:42-47`) | **Retire** | They only ever reported the target check; 1:1 priority is always honored. ok-ack reduces to `{ok, messageId, acceptedAtMs}`. |
| `conversationId` (`peer-types.ts:19-24`) | **Fence (keep, inert)** | Opaque forward-compat carrier; threading/replies UI is U-B-excluded client-side. Kept as schema, default-minted, never surfaced. |
| `priority` flag (1:1) | **Expose** | The tier's one optional semantics, S9-backed; after retirement it is inherently 1:1. |

Ticket-14 tension resolved: ticket 14's group/broadcast ACs were authored against the
pre-ADR-0018 feature-inventory posture (ADR-0004); ADR-0018's preamble supersedes wherever
conflicting, and its exception list is the definition of done. Ticket 14 stays resolved as
shipped (history intact); this ticket carries the retirement delta. Alternative considered and
rejected: fence-only (keep types, never expose) — `multitask.sendPeer` is a public core API, so
a fenced-but-accepted group envelope would still enqueue, wake, and deliver: shipped,
unreachable-by-tool, live-by-API surface with dead ack branches, which is exactly the ambiguity
a C14 sort exists to remove.

#### §4 Isolation audit (offline two-dispatcher inbox/wake)

Pinned today: inbox session independence at the module level (`test/peer-inbox.test.ts:202`
"sessions are independent"); scoped tool surfaces + per-session handler routing
(`test/multi-dispatcher.test.ts:309,336`); stream-key domains `:378`; per-session roster
publish `:398`; per-session policy rows `:538`. The peer suites are **single-session**:
`test/wake-bus-peer.test.ts:10` and `test/multitask-peer.test.ts:14` both fix
`SESSION = "session-1"`.

Missing (new offline pin, expected pass — a failure here is a bug to fix, not new design), as
`test/multi-dispatcher-peer.test.ts`, two sessions A/B through one Multitask + FakeDshHost:
1. A `sendPeer`s to B: `requestDispatcherWakeup` fires for **B only**; A gains no wake, no
   inbox rows, no state.
2. `listPendingPeers(A)` stays empty while B holds the row — no cross-session leakage.
3. Draining B's peer wake marks **B's** rows delivered; a same-messageId row in A (sender-
   scoped index) is untouched — delivered flags are per-session.
4. B mid non-user turn + priority peer from A: interrupt and turn-ownership changes touch B
   only; `getTurnOwner(A)`/`isBusy(A)` unchanged.
5. B mid **user** turn + priority from A: queued, no interrupt, per existing rules — pinned
   across two sessions, not just one.
6. Post-retirement: a group/broadcast envelope is refused at accept (pins the §3 sort).

#### §5 Chunked implementation ACs (triage sizes implementation L; chunks split here)

- **Chunk 1 — core sort + isolation (offline, M).** Retire group|broadcast per §3 (schema,
  inbox, wake-bus comments, label; tests rewritten); add `isLiveDispatcherSession` knob +
  `unknown-target`/`self-target` production; land `test/multi-dispatcher-peer.test.ts` §4.
  AC: full suite green offline (S8); no behavioral change for 1:1 traffic.
- **Chunk 2 — tool + policy copy (offline, M).** Sixth def `send_peer` in
  `createDispatcherTools` + `TOOL_DESCRIPTIONS` copy (fire-and-forget wording: "returns an
  acceptance ack; the reply, if any, arrives later as its own turn — never wait"); handler
  mints messageId/conversationId, maps ack to honest summary; text over the inline max refused
  with `invalid-envelope` detail. ACs (offline): handler→`sendPeer` round-trip ack; unknown/
  self target refusal copy; priority honored only as 1:1 lane choice; scoped-surface test
  shows the new tool visible to the dispatcher session and absent from worker scope.
- **Chunk 3 — client placement (offline, S).** Ticket 79's roster rows are the id source: add
  a copy-session-id affordance on dispatcher rows; ticket 80's reduction shows peer-cue turns
  for their session honestly (the wake turn is a hidden dispatcher turn — verify the surface
  does not present it as user speech). AC: component tests per the 79/80 test patterns.
- **Chunk 4 — live two-dispatcher verification (45/33 lane ONLY, S).** Live-only ACs, gated on
  ADR-0019 sign-off (ticket-76 precedent): two dispatchers activated; A's model calls
  `send_peer` with B's session id; B opens a peer-cue turn; the priority variant interrupts
  B's non-user turn and never a user-driven turn; a bad-id send yields honest refusal copy
  with no retry. Trivial tasks only, kill timers per AGENTS.md.

#### §6 Honest gaps + human escalations

- **Gap (recorded):** reference peer evidence is clear for 1:1 priority only (`:143`); no
  design weight rests on the partially-traced lanes. **Gap (recorded):** the reference clamps
  peer text to 8000 chars (`:156`); our inbound path assembles peer text raw today
  (`assembler.ts:215-224`) and no clamp exists — Chunk 2 refuses over-max inline (U-F), and a
  follow-up may apply the same bound on the inbound accept edge.
- **Escalation 1 (ready-for-human, low-stakes confirmation — not a new exception request):**
  directory-less addressing. The reference ships a peer directory
  (`reference-behavior-notes.md:94`; PRD §7.6 "Directory" row); this design addresses peers by
  dispatcher session id with no directory, reading that as covered by C13 ("no agent-identity
  roster … dispatchers exist — via sessions"). If the human reads C13 as scoped to identity
  *surfaces* only, a one-line ADR-0018 annotation ("no peer directory; peer addressing is
  session ids") should be recorded before/with Chunk 1.
- **No escalation needed for:** priority interrupt (S9 + `:130-131`, imitation); direct
  fire-and-forget send (A4 conformant); group|broadcast retirement (conformance under C14).
- **Note (no action this ticket):** PRD §7.6 still headers "Phase 2 — peer agents (optional)"
  and §1 "(optional Phase 2)" post-rebase; ADR-0002 (accepted) resolved §15.5 in-scope and
  ADR-0018 lists the tier in-scope (`PRD:408` carries the resolution). Stale wording, not a
  live conflict — fold into the next PRD-wordsmith batch.

### 2026-09-19 — agent (chunks 1–3 complete offline; resolved with chunk 4 routed to the 45/33 lane)

**Recovery note (honest provenance):** the implementing session died on a usage limit after
landing chunks 1–3 (`d8e2658`, `1a4eb6d`, `fbd4066`) but before any bookkeeping — the only
uncommitted worktree state was the claim comment above, triaged sound and committed as
`a55dc99`. A recovery pass re-audited all three chunk diffs against Design 2026-09-19 §2–§5
(conformant; no hunks reverted), then ran the full gates fresh.

**Gates (2026-09-19, post-chunk-3 tree):** `npm test` **1101/1101 pass, 266 suites, 0 fail**
(offline, S8); `npm run typecheck` green (both tsconfigs); `npm run build:client` green
(164,805 bytes). `grep` of `src/client` for `priorityHonored` / `group-target` /
`broadcast-target` / retired target kinds: zero product references (comments + negative test
assertions only) — the ack shrink left no dangling consumer.

**Escalation 1 disposition (directory-less addressing):** the dispatch ruling accepted the
design's reading (C13 covers it; peer addressing = dispatcher session ids learned from peer
wake turns and 79's roster rows — chunk 3's copy affordance is the human-side source). No
ADR-0018 annotation recorded; the human may add the one-liner later if they read C13
narrower — nothing shipped depends on it.

**Residual (recorded, no action here):** the design §6 inbound-clamp follow-up stands —
`send_peer` refuses over-max text outbound (chunk 2), but the inbound accept edge still
assembles peer text raw; a later ticket may apply the same 8000 bound at accept. Chunk 4's
live ACs are deliberately unticked and live on ticket 33's lane (see the chunk-4 checkbox
above for the enumerated list).
