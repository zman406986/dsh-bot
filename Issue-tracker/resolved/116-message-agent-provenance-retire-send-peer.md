# 116 — `message_agent` tool + routing + structured provenance; retire `send_peer`

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 114
**Related:** ADR-0025 (peer messaging and structured provenance), ADR-0027 (identity and labels), ADR-0028 (the worker reply lane reuses this provenance), ticket 118 (a spawned dispatcher is only useful once it can be messaged), ticket 119 (policy text), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §4.1 and §6 (untracked input, not authority)

## Problem

`send_peer` reaches dispatcher sessions only. A dispatcher that wants to correct a running worker has to know to call `steer_worker` instead, and the two verbs address different populations with different failure shapes. Provenance also rides mostly on the text cue ("Peer message — not from the user") rather than on a structured field.

ADR-0025 settles one dispatcher messaging verb with routing inside it, and provenance as a field rather than a marker.

## What to do

- [x] Add the core tool `message_agent(target, text, priority?)`.
  - Worker target → the existing steer path, unchanged: single-slot last-wins park, interrupt, wrapped send at the next step boundary. Reuse `multitask.steerWorker`; do not build a second queue.
  - Dispatcher target → the existing peer inbox and peer wake lane (`multitask.sendPeer`). `priority` may reclaim a non-user turn and never interrupts a user turn.
  - Refusals, honest and without retry affordance: `unknown-target`, `self-target`, `not-running` (worker terminal or not started), `inbox-full`, `rate-limited`, `invalid-envelope`.
  - Result: `{ ok: true, target, delivered_as: "steer" | "peer", message_id, note }`.
- [x] Retire `send_peer`: remove it from the dispatcher registration list and `DISPATCHER_TOOL_NAMES`. **Keep its core machinery** (inbox, envelope, dedupe, caps) — `message_agent` and ADR-0028's reply channel both ride it.
- [x] Make dispatcher-bound provenance structured. Give the wake message an optional source override and stamp peer wakes with `{ kind: "agent-message", form: "relay", senderSessionId }` instead of the plugin source. The text heading stays as presentation only and is never used to decide origin. Sender identity comes from the registration closure's session id; there is **no `from` argument**.
- [x] Enforce the message rate cap: **8 accepted agent messages per sender session per rolling 60 s** (counted on accept; refusals do not count). Reuse the existing 8,000-character text cap.
- [x] Agent traffic never calls `enqueueUserWake`, never sets `pendingOwner: "user"`, never satisfies an approval ask, and never counts as user presence.
- [x] Unit tests: worker routing parks/interrupts/sends and last-wins holds; settled worker refuses `not-running`; another session's worker refuses `unknown-target`; self-target refuses; dispatcher target accepts into the inbox and enqueues a wake; `priority` lands on the priority lane and does not interrupt a user turn; deactivated dispatcher refuses `unknown-target`; 9th message in the window refuses `rate-limited` with nothing queued; oversize text refuses `invalid-envelope`; a peer wake's source kind is `agent-message` and the bus owner is `peer`.
- [x] Update the tool description. Do not touch policy prose or PRD text — ticket 119 owns those.

## Constraints

- No directory tool. Ids come from a spawn ack, an inbound peer message (`fromAgentId`), the stock `list_agents` for children, or the user (C13).
- `steer_worker` stays. It is the worker-specific correction verb; `message_agent` routes workers through the same core call.
- The stock host `send_message` stays visible in the preset and cannot be hidden without editing a stock preset; the policy text names `message_agent` as the tool to use.
- Offline `FakeDshHost` tests only (S8 lane).

## Comments

### 2026-10-18 — filing

Filed from the design note §12 ticket 116, trimmed to what ADR-0025 actually decides. The retirement is a registration change, not a deletion: the inbox and envelope machinery is what ADR-0028's reply lane reuses, so deleting it would break a later ticket.

Blocked by 114 (0.2.1 host port).

### 2026-10-22 — second half: `send_peer` retired, structured provenance landed

**`send_peer` is retired from the surface; its machinery stays.** Removed: the `sendPeer` tool def from `createDispatcherTools` and its entry in the returned array (`src/core/tools.ts`), `SEND_PEER_TOOL` from `DISPATCHER_TOOL_NAMES` (now the final six: `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `message_agent` — `src/core/policy/prompts.ts:35-42`), its `TOOL_DESCRIPTIONS` entry, and its dead result contract `SendPeerToolResult` / `formatPeerSendRefusal` (`src/core/tool-results.ts`). Kept: `PeerInbox`, `PeerEnvelope`/`PeerNotice`, dedupe, the 64-message cap, `Multitask.sendPeer`, and `formatPeerSendAck` (renamed in comment only — `message_agent`'s dispatcher branch uses it). `SEND_PEER_TOOL` stays exported because `src/client/toolviews.ts` still keys historical `send_peer` rows by that name; nothing registers the tool. `SEND_PEER_TEXT_MAX_CHARS` stays as the shared 8,000-char cap.

**Provenance is a field on the wake path, not the text.** The chain, end to end:

1. `src/core/wake-bus.ts:519-541` `makePeerWake` builds every peer wake with `messageOrigin: { kind: "agent-message", form: "relay", senderSessionId: peerMessages[0].fromAgentId }`. The sender is the opening notice's `fromAgentId`, which `message_agent` fills from `requireSessionId()` — the registration closure (`src/core/tools.ts:1054` reads the session; `:1135-1144` puts it on the envelope as `fromAgentId`). There is no `from` argument anywhere.
2. `WakeEvent.messageOrigin` is the new optional field (`src/core/wake-bus.ts:86`), typed by `AgentMessageWakeOrigin` (`src/core/peer-types.ts:60`).
3. `WakeBusOptions.onDeliver` gained the optional second argument (`src/core/wake-bus.ts:259`); all four peer-flush call sites pass `wake.messageOrigin` / `state.ready?.messageOrigin` (`:555`, `:564`, `:734`, `:754`). Background/user flushes pass nothing.
4. `src/core/multitask.ts:527-532` forwards it: `host.requestDispatcherWakeup(sessionId, origin)`.
5. `DshHost.requestDispatcherWakeup` gained the optional `origin` (`src/core/dsh-host.ts:38-45`). This is an optional parameter on the existing single wake verb, not a second verb — the ticket's "optional source override".
6. `src/adapter/cordis-dsh-host.ts:589-610` `openWakeTurn(sessionId, origin)` is the one wake-turn body; `:946-951` passes the origin through.
7. `src/adapter/wake-copy.ts:75-93` `wakeUserMessage(text, source?)` stamps `source: {kind, form, senderSessionId}` when an origin is given (`:85-90`) and falls back to `{kind: WAKE_SOURCE_KIND}` otherwise (`:91`).

Where the stamp actually lands: on the durable `user/message` event the loop appends for the follow-up (`dsh-llm` `createUserMessage`; shape admitted by `dsh-session-format-v3-to-v4/lib/index.js:70` which lists `agent-message` as a released producer kind, and `dsh-session/lib/index.js:1204-1205` requires only a non-empty `source.kind`). The text heading "Peer message — not from the user" (`PEER_WAKE_SECTION_HEADINGS[0]`) is untouched and remains presentation only; nothing reads it to decide origin.

**Honest reductions, recorded rather than papered over.**
- A lane flush that batched notices from several senders produces one durable follow-up, which can carry one sender id. The source is therefore attributed at the TURN level to the opening notice's sender; each notice keeps its own `fromAgentId` and the rendered body (`assemblePeerWakeTurn`, `src/core/policy/assembler.ts:480`) names every sender. The field answers "which agent opened this turn", not "every agent in it".
- `FakeDshHost.requestDispatcherWakeup` keeps its pre-existing `wakeCalls: string[]` surface and adds `wakeOrigins` (`WakeOriginCall`, `src/core/fake-host.ts:18-22` and `:41`), so older assertions still compile while the new suite can assert the origin.
- `send_peer`'s `formatPeerSendRefusal` copy was deleted with the tool. The refusal vocabulary `message_agent` actually emits is unchanged (`src/core/tool-results.ts` `formatMessageAgentRefusal` / `formatMessageAgentRateLimited`).
- Two model-facing policy strings still name `send_peer` (`src/core/policy/prompts.ts:101-102` `PEER_ROSTER_INTRO`, `:206` `buildPeerWakeInstructionsBlock` item 4). They are policy prose, which ticket 119 owns — left untouched on purpose, recorded here.

**The four "agent traffic never…" checks (all hold structurally).**
1. Never calls `enqueueUserWake`: the only definition is `src/core/wake-bus.ts:802` and **no source file calls `.enqueueUserWake(` at all** — it exists for the host/user channel and is not on any agent path. The peer path calls `enqueuePeer` only (`src/core/multitask.ts:1387`).
2. Never sets `pendingOwner: "user"`: `state.pendingOwner = "user"` occurs at exactly one line, `src/core/wake-bus.ts:824`, inside `enqueueUserWake`. Peer wakes set `"peer"` (`:554`, `:563`, `:636`); background wakes set `ownerForSource(source)` (`:497`, and `ownerForSource` maps `"peer" → "peer"`, `:338-342`).
3. Never satisfies an approval ask: resolution is `accessRelay.resolve` reached only via `Multitask.resolveAccess` (`src/core/multitask.ts:1398-1399`), whose only callers are the two user-answer surfaces — the prompt pump `src/plugin.ts:690` and the `/dispatcher-resolve` command `src/plugin.ts:1264`. `src/core/tools.ts` contains zero references to `resolveAccess` / `accessRelay` / `accessPolicy`, so neither `message_agent` nor `reply_to_dispatcher` can touch an ask.
4. Never counts as user presence: the core keeps no presence state at all (`src/core/multitask.ts:207` — "no presence state; presence is a projection of existing truth"). The peer roster's fields are `isBusy` / pending access / queued wake (`src/adapter/parent-agent.ts:248-250`), none of which an accepted peer message sets to a user value: `isBusy` comes from the host's own `agent/status`, and the turn owner a peer wake produces is `"peer"` (item 2).

**Typecheck:** `npx tsc -p tsconfig.json --noEmit` → exit 0, no output. No tests were run: the ticket's test suite is the next pass, and the existing `test/dispatcher-tools.test.ts` / `test/policy-assembler.test.ts` / `test/worker-agent-type.test.ts` still import `SEND_PEER_TOOL` + `SendPeerToolResult` and will need updating there (source typechecks; test files are excluded from this tsconfig).

**Not touched, by instruction:** `src/plugin.ts`, `src/client/`, any test file, policy prose, PRD, `CONTEXT.md`. Status stays `claimed`; no resolve, no move, no index regen, no commit.

### 2026-10-22 — test pass: `message_agent` suite + `send_peer` repairs

**New file: `test/message-agent.test.ts` — 17 tests / 6 suites, all green.** It runs against `FakeDshHost` only (S8), with the `now` injection point wired to a mutable test clock. Coverage, mapped to the ticket's unit-test line:

- **Worker routing (2):** parks + interrupts + delivers `[Parent correction]`-wrapped text at the next step boundary through `host.fireStepBoundary`, `delivered_as: "steer"`, no peer row and no wake; a second message before delivery replaces the first (single-slot last-wins) and does not interrupt twice.
- **Worker refusals (4):** settled worker → `not-running`; spawned-but-never-started → `not-running`; another session's worker → `unknown-target` with nothing interrupted/queued/woken; self-target → `self-target`.
- **Envelope cap (1):** 8,001 chars → `invalid-envelope`, nothing queued, no wake; exactly 8,000 passes into the inbox.
- **Dispatcher target (3):** accept lands in the peer inbox (`pendingCount` 1, sender/`to`/`conversationId` fields pinned) and enqueues exactly one wake; `priority: true` mid-user-turn interrupts nothing, `getTurnOwner` stays `"user"`, `peek` stays empty, and the priority lane flushes at turn end; deactivated dispatcher target → `unknown-target` via the `isLiveDispatcherSession` knob (same wiring as the existing peer tests), then accepts once the target is live.
- **Rate budget (2):** 8 accepts, a `self-target` refusal in between, the 8th accept still lands (a refusal consumed nothing), the 9th and 10th refuse `rate-limited` with `pendingCount` and `wakeCalls` unchanged, and `clock += 60_000` restores capacity. One budget spans both branches: interleaved worker/peer accepts exhaust the window and both branches then refuse.
- **Provenance (2):** the wake carries `messageOrigin: {kind:"agent-message", form:"relay", senderSessionId}` both on `host.wakeOrigins` (the `FakeDshHost` recorder) and on the drained `WakeEvent`; the following `noteTurnStarted` reads owner `"peer"`; the contrast case asserts a settle wake records `origin: undefined`. The batched-flush test pins the recorded reduction: two senders batched during one user turn flush as one peer wake whose `messageOrigin.senderSessionId` is the opener, while each notice keeps its own `fromAgentId`.
- **The four invariants (3):** `enqueueUserWake` is spied and never called by either branch; a turn opened after a peer flush reads `"peer"`; a pending access ask survives both an accepted peer message and an accepted worker message with zero `sendMessage` calls, and only `resolveAccess` clears it; the target stays `isBusy === false`, gains one queued wake, and opens as a peer-owned turn.

**Repairs (12 files).** `test/dispatcher-tools.test.ts` — dropped the five `send_peer` cases and the `SEND_PEER_TOOL` / `SendPeerToolResult` / `SEND_PEER_TEXT_MAX_CHARS` imports; the seven-name array now ends at `message_agent`; one new case pins the exact `DISPATCHER_TOOL_NAMES` order and the absence of `send_peer`. `test/policy-assembler.test.ts`, `test/activation-lifecycle.test.ts` (dormant negative list, activation surface, scoped surface), `test/adapter-cordis-dsh-host.test.ts` (fake agent plane + worker deny intersection), `test/coexistence.test.ts`, `test/composition-polish.test.ts`, `test/multi-dispatcher.test.ts`, `test/plugin-scaffold.test.ts` — `send_peer` → `message_agent` in every sorted/unsorted name pin; sort order re-checked (`message_agent` sorts before `request_access`/`spawn_worker`). `test/worker-agent-type.test.ts` — the six-tool deny array now IS `DISPATCHER_TOOL_NAMES`; `send_peer` stays a deny candidate (ticket 119 keeps it) and is asserted still denied. `test/worker-composition.test.ts` — fake agent plane and expected deny array. `test/client-toolviews.test.ts` — see below. `test/client-conversation-surface.test.ts` — comment only.

**Assertions not made, and why.**
1. *Client `message_agent` row.* The pin `TOOLVIEW_TOOL_NAMES == DISPATCHER_TOOL_NAMES` can no longer hold: `src/client/toolviews.ts` has no `message_agent` renderer and still claims the historical `send_peer` key (the second-half comment says so explicitly). Asserting a `message_agent` toolview would fail and asserting equality would be false. The pin was rebased to state the substitution (`TOOLVIEW_TOOL_NAMES` == the dispatcher names with `message_agent` swapped back to `send_peer`) and a comment records the lag. Closing that gap is client-face work outside this ticket's source scope.
2. *Presence.* Core keeps no presence state, so "never counts as user presence" is asserted on the observable projections only (`isBusy`, queued wake, turn owner), not a presence field.
3. *Batch provenance.* The test asserts the documented reduction (turn-level opener sender) and the per-notice `fromAgentId` retention — not "every sender appears in `messageOrigin`", which the field cannot express.
4. *`inbox-full`.* Not exercised: the 64-undelivered cap is not on this ticket's unit-test list and is already covered by `test/peer-inbox.test.ts`.

**Gates.** `npx tsc -p tsconfig.json --noEmit` → exit 0, no output; `npx tsc -p tsconfig.client.json --noEmit` → exit 0. ONE grouped run, 19 files (the new file plus every repaired file plus untouched neighbors `adapter-dispatcher-tools`, `tool-schema-shape`, `approval-feed-composition`, `wake-bus-peer`, `policy-peer-roster`, `multitask-peer`): **429 tests / 99 suites / 429 pass / 0 fail / 0 skipped**, 1,041 ms. No `npm test`, no full suite, no build, no commit.

**Not touched:** source, policy prose, PRD, `CONTEXT.md`, index files. Status stays `claimed`; the leader decides the resolve.

## Answer

Resolved 2026-10-22 — the single `message_agent` verb, its two existing-lane routes, the structured wake provenance, and the `send_peer` retirement are on the shipped tree. The citations below were spot-checked at the cited lines before resolution (the wake-origin chain, the six-tool surface, the rate budget, the four invariants, and the deleted exports), and `test/message-agent.test.ts` was re-run at resolution: 17 tests / 6 suites / 17 pass / 0 fail.

**`message_agent(target, text, priority?)` (`src/core/tools.ts:1026-1173`).** Routing is by core truth, never an argument. A worker id owned by this session rides the EXISTING steer path (`multitask.steerWorker`, :1109) — single-slot last-wins park, interrupt, wrapped `[Parent correction]` send at the next step boundary; no second queue. Anything else rides the existing peer inbox/wake lane (`multitask.sendPeer`, :1135). `priority` is dispatcher-only and may reclaim a non-user turn, never a user turn. Result is `{ ok: true, target, delivered_as: "steer" | "peer", message_id, note }` (`src/core/tool-results.ts:105-125`). The refusal vocabulary is closed and carries no retry affordance: `unknown-target`, `self-target`, `not-running`, `inbox-full`, `rate-limited`, `invalid-envelope` (canned copy in `formatMessageAgentRefusal` / `formatMessageAgentRateLimited`, :133-159; a worker id owned by another session refuses `unknown-target` without leaking that it exists). Sender identity comes from the registration closure (`requireSessionId()`, :1054, stamped as `fromAgentId` at :1137); there is no `from` argument. The tool description was rewritten (`src/core/policy/prompts.ts:56-57`).

**`send_peer` retired from the surface; machinery kept.** Removed from `createDispatcherTools` and from `DISPATCHER_TOOL_NAMES` — the final six, in registration order: `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `message_agent` (`src/core/policy/prompts.ts:35-42`). `SendPeerToolResult` and `formatPeerSendRefusal` are deleted. Kept: `PeerInbox`, `PeerEnvelope`/`PeerNotice`, dedupe, the 64-message cap, `Multitask.sendPeer` (`src/core/multitask.ts:1354`), `SEND_PEER_TEXT_MAX_CHARS` as the shared 8,000-char cap, and `formatPeerSendAck` (now `message_agent`'s peer-branch ack). `SEND_PEER_TOOL` stays exported only because `src/client/toolviews.ts` still keys historical `send_peer` rows by that name; nothing registers the tool.

**Structured provenance, end to end.** `makePeerWake` stamps every peer wake with `messageOrigin: { kind: "agent-message", form: "relay", senderSessionId: opener.fromAgentId }` (`src/core/wake-bus.ts:519-541`) via the new optional `WakeEvent.messageOrigin` field (:86), typed by `AgentMessageWakeOrigin` (`src/core/peer-types.ts:60`). `WakeBusOptions.onDeliver` gained the optional second argument (:259) and all four peer-flush call sites pass it (:555, :564, :734, :754); background/user flushes pass nothing. `src/core/multitask.ts:527-532` forwards it to `host.requestDispatcherWakeup(sessionId, origin)`, the new optional parameter on the existing single wake verb (`src/core/dsh-host.ts:38-45`) — not a second verb. `openWakeTurn(sessionId, origin)` (`src/adapter/cordis-dsh-host.ts:589-610`, threaded at :946-951) hands it to `wakeUserMessage(text, source?)` (`src/adapter/wake-copy.ts:75-93`), which stamps `source: {kind, form, senderSessionId}` on the durable `user/message` the loop appends for the follow-up. The text heading "Peer message — not from the user" is untouched presentation only; nothing reads it to decide origin.

**Rate cap.** 8 accepted messages per sender session per rolling 60 s (`MESSAGE_AGENT_RATE_LIMIT` / `MESSAGE_AGENT_RATE_WINDOW_MS`, `src/core/tools.ts:304-305`), counted on accept only — the capacity check precedes both sends and refusals record nothing. One budget spans both routing branches; the worker reply lane shares it (`WORKER_REPLY_RATE_LIMIT` aliases `MESSAGE_AGENT_RATE_LIMIT`, :312; `WORKER_REPLY_TEXT_MAX_CHARS` aliases the 8,000-char cap, :287). The clock is injectable for tests (:181).

**The four invariants verified structurally.** `enqueueUserWake` has no `src/` callers (only its interface and definition, `src/core/wake-bus.ts:174`, :802); `pendingOwner = "user"` occurs at exactly one line (:824) inside it, while peer wakes set `"peer"` (:554, :563); approval resolution is reachable only through `Multitask.resolveAccess` from the two user-answer surfaces (`src/plugin.ts:690`, :1264), and `src/core/tools.ts` has zero references to `resolveAccess` / `accessRelay` / `accessPolicy`; the core keeps no presence state (`src/core/multitask.ts:207`), and an accepted peer message leaves the target's observable projections (`isBusy`, queued wake, turn owner `"peer"`) non-user.

**Tests.** New `test/message-agent.test.ts` — 17 tests / 6 suites on `FakeDshHost` only (S8), with the `now` injection wired to a mutable clock: worker routing + last-wins (2), worker refusals (4), the 8,000-char envelope cap (1), dispatcher accept / priority-mid-user-turn / deactivated-target (3), the shared rate budget including the 9th refusing with nothing queued and the window rolling (2), provenance incl. the recorded batched-flush reduction (2), and the four invariants (3). 12 existing files were repaired for the retirement (`dispatcher-tools`, `policy-assembler`, `activation-lifecycle`, `adapter-cordis-dsh-host`, `coexistence`, `composition-polish`, `multi-dispatcher`, `plugin-scaffold`, `worker-agent-type`, `worker-composition`, `client-toolviews`, `client-conversation-surface`). Grouped run: 19 files, 429 tests / 99 suites / 429 pass / 0 fail. `tsc` clean on both projects.

**Open residuals, recorded honestly.**
1. *No client toolview renderer for `message_agent`.* `src/client/toolviews.ts` still claims the historical `send_peer` key and has no `message_agent` row; the `TOOLVIEW_TOOL_NAMES == DISPATCHER_TOOL_NAMES` pin was rebased to state the substitution (dispatcher names with `message_agent` swapped back to `send_peer`) plus a comment recording the lag (`test/client-toolviews.test.ts:275-291`). Client-face work, outside this ticket.
2. *Batched-flush provenance reduction.* A merged turn carries one sender, so `messageOrigin` is attributed to the opening notice's sender; each notice keeps its own `fromAgentId` and the rendered body names every sender. The field answers "which agent opened this turn", not "every agent in it".
3. *`inbox-full` not exercised here.* The 64-undelivered cap is off this ticket's test list and is already covered by `test/peer-inbox.test.ts`.
4. *Two policy-prose strings still say `send_peer`* (`src/core/policy/prompts.ts:102` `PEER_ROSTER_INTRO`, :206 `buildPeerWakeInstructionsBlock` item 4). Policy text is ticket 119's.

**Not here (by design).** Policy prose, PRD, `CONTEXT.md`, and the client face belong to tickets 119 and the client lane; this ticket touched core, the provenance chain, and tests only. No commit.
