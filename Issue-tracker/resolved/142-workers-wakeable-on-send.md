# 142 — A worker cannot be woken by a send: a steer to a dead worker holds or refuses

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** nothing — the dated owner ruling landed 2026-10-22 and covers this half explicitly.
**Related:** ticket 138 (deferred — the DISPATCHERS half of the same ruling; its comment records the mechanism this ticket reuses), ticket 130 (resolved 2026-10-22 — the `dispatcher_sessions` mark this table follows), ticket 70 (resolved — §2's phantom-target fence, intact for unmarked ids), ticket 58/59 (resolved — the unknown-state hold this ticket resolves on new evidence), ticket 57 (resolved — R4's non-use of cold-resume, narrowed here for one case), ticket 04 (resolved — stop means no revival, preserved), ADR-0025, ADR-0006 / A5 (dsh's own store, no second database), ADR-0019 (per-session authority)

## Owner ruling — 2026-10-22 (level-1 authority)

Quoted: *"yes bots should be wake-able, both dispatchers and children."*

Ticket 138 implemented the dispatchers half. **This ticket is the children half.** The ruling settles both questions the dispatcher half asked, and they apply verbatim here:

1. **Which targets count.** A worker counts when it carries our own durable worker mark. An unmarked id is still refused exactly as ticket 70 §2 designed.
2. **What an accepted send does in flight.** It is accepted, the wake is parked, the target is cold-resumed through the host's own `ctx.subagents.sendMessage`, and the text is delivered when the resumed session exists. The ack promises nothing the mechanism does not do.

## Problem

Workers are spawned blank per task and carry **no durable mark of their own today**. The only durable worker artefact is the `worker_markers` row (ADR-0006), and that row is an *obligation* record, not an identity record: it is deleted on abort, deleted when an unknown-state hold is released, and its presence means "delivery may be owed", not "this id is a worker we spawned".

So a steer aimed at a worker that is not on this core's roster has nowhere to go:

- `steer_worker` → `Multitask.steerWorker`: `getWorker(id) === undefined` returns `unknown-worker` (`src/core/multitask.ts:1099-1106`).
- `message_agent` → the target is not on the roster, so it falls to the peer lane → `sendPeer` refuses `unknown-target` (no live dispatcher, no `dispatcher_sessions` mark).
- After a restart the worker is not even an id the core knows: `rebuildFromDurability` turned its live marker into an unknown-state HOLD (ticket 59 — no roster record), and ticket 58/59 deliberately left that a hold.

The owner ruling makes the hold the wrong answer for a **send**: the user asked for that worker to continue, and the host can cold-resume the session through the same seam the dispatcher half already uses.

## Design

Same shape as the dispatchers half, with one table of its own. No gate, cap, or refusal class is added.

### 1. `worker_sessions` — the durable worker wake mark

A new table in the **same** marker domain (`multitask_dispatcher`), following the `dispatcher_sessions` pattern exactly: no version bump (ticket 124/130 precedent — a bump would refuse to open every existing store on upgrade), one row per worker session spawned by this plugin, keyed by the worker id (the worker id **is** the child session id).

Row: `{ sessionId, parentSessionId }`. `sessionId` is the brand-erased worker id; `parentSessionId` is the spawning dispatcher — the sender a cold resume needs.

Written at worker spawn, **after** `startActivation` resolves (mirroring `writeDispatcherMark`: there is no id to key on before that; the crash window is the accepted one). Unlike dispatcher marks, rows are **deleted** when the worker reaches a terminal state, on abort, and when the unknown-state hold is released — the mark means "this worker session is wake-able", and a finished or abandoned worker must not be resurrected (ticket 04: stop is for good).

### 2. The fence

`Multitask` gains `isDurablyMarkedWorker` (synchronous, backed by an adapter mirror warmed once per dispatcher activation exactly like `refreshDispatcherMarks`) and `durableWorkerParent` (the same mark's parent, so `message_agent` can keep refusing **another** session's worker as `unknown-target` without leaking that it exists).

- `steerWorker`: when the id has no roster record **and** carries the mark, the send is accepted; the wrapped correction is handed to the host's wake seam. Without the mark the refusal is byte-identical to today (`unknown-worker`).
- `message_agent` routes a target to the steer lane when it is on the roster **or** durably marked as a worker of the CALLING session. Everything else keeps its current route and refusal (`unknown-target` for an unmarked or foreign id).
- `sendPeer` is untouched: it stays the dispatcher/peer fence.

### 3. The wake and the delivery

New optional `DshHost` seams: `wakeDormantWorker(workerId, message)` and `forgetWorkerWake(workerId)`.

The adapter parks the message (last-wins, one slot — the same rule the core's steer queue uses), and when no live Agent exists asks the host to cold-resume with the **same** `RESUME_WAKE_CUE` the dispatcher half uses. On `agent/created` for the marked worker id the adapter:

1. re-adopts the worker into its own registry (`workers`), so `interruptWorker`/`sendMessage`/settle resolve again;
2. re-applies the worker composition on the child's own scope — contract section, tool barrier, local reply tool. **This is load-bearing for safety**: a cold-resumed child has none of it, so without this step it would run with its parent's full dispatcher composition;
3. fires `onWorkerReattached`, which lets the core resolve its unknown-state hold into a live roster record (`reclaimWorker`) — the hold says "we cannot tell whether it is alive"; a session the host just re-created is evidence that it is, so keeping the hold would be actively false (and would let `stop_worker` report a release while the worker keeps running);
4. delivers the parked correction, once, through the host's own `sendMessage` (which steers a live target). The parked slot is cleared before the call, so a repeat announcement delivers nothing.

Failure is honest and quiet, like the dispatcher half: the send was already accepted, so a resume that cannot be issued (no mark parent, no bound spawner, a host refusal) logs, leaves the message parked for the next activation, and never throws into the core or invents a refusal.

### Honest limits, stated

- **A worker whose mark predates this ticket is not wake-able.** No migration is attempted; the id refuses exactly as before.
- **A worker whose spawner is not bound in this process is not resumed.** The message stays parked; the send stays accepted.
- **The correction opens its own turn after the cue turn.** Parity with the dispatcher half: `RESUME_WAKE_CUE` opens the resumed session's turn, and the parked correction arrives as the next message. A worker that finishes the cue turn instantly could settle before the correction lands; the core records that settle normally.
- **A reclaimed worker restarts its `startedAtMs` clock.** The hold never carried one; elapsed time is measured from the new activation, not invented.
- **One slot of parked text per worker.** Two sends before the worker returns: the second replaces the first (last-wins), exactly like the core's steer queue.

## Acceptance

- [x] `worker_sessions` is declared in the marker domain **without a version bump**; a row is written at worker spawn with `parentSessionId` = the spawning dispatcher; a malformed row fails at open. — `src/adapter/durable-marker.ts:65-77`, `:346-349`, `test/adapter-durable-marker.test.ts` (3 new: table declared at version 2, write/read/list/delete in the one domain, schema rejects a row with no or non-string spawner).
- [x] The mark is deleted when the worker settles terminally, is aborted, or its unknown-state hold is released — a finished worker cannot be woken back. — `forgetWorkerWake` in `src/core/multitask.ts` (settle path, abortWorker), `releaseUnknownStateHold`; pinned in `test/worker-wake-on-send.test.ts` ("is dropped on a terminal settle…", "is dropped on abort and on an unknown-state hold release") and `test/spawn-dispatcher-activation.test.ts` ("a settled worker's row is dropped…").
- [x] A steer to a durably marked, not-live worker is **accepted** and issues exactly one cold resume through `ctx.subagents.sendMessage` from the SPAWNER, with `RESUME_WAKE_CUE` (never the correction text). — `src/adapter/cordis-dsh-host.ts` (`requestDormantWorkerWake`), pinned in `test/spawn-dispatcher-activation.test.ts` (end-to-end through the real plugin, host and restart) and `test/worker-wake-on-send.test.ts` (core fence).
- [x] The parked correction is delivered **exactly once** when the resumed worker is announced; a second `agent/created` delivers nothing new; two sends before activation leave one (the latest) delivered. — `deliverParkedWorkerWake`; pinned by "two sends before the worker returns coalesce…" and "a second announcement of the resumed worker delivers nothing new".
- [x] The resumed worker comes back composed: contract section, tool barrier, local reply tool — and not with the dispatcher surface. — `reattachMarkedWorker` → `applyWorkerComposition`; pinned by asserting the resumed child's scoped tools are `["reply_to_dispatcher"]`, its section is `WORKER_PERSONA_SECTION`, and it received no policy inject.
- [x] The core's unknown-state hold becomes a live roster record on re-attachment; `check_workers` lists the worker again and `stop_worker` can interrupt it. — `Multitask.reclaimWorker` + the `onWorkerReattached` hook; pinned in `test/worker-wake-on-send.test.ts` (3 reclaim tests: hold→roster + stream key re-taken, no-op for unknown/foreign, reclaimed worker steerable and settleable) and in the end-to-end test (`check_workers` lists it after the resume).
- [x] An **unmarked** dead worker still refuses exactly as before: `unknown-target` through `message_agent`, `unknown-worker` through `steer_worker`, no wake, no resume call, no roster change. — `test/message-agent.test.ts` ("an UNMARKED dead worker still refuses unknown-target"), `test/worker-wake-on-send.test.ts` ("an id with NO durable row refuses exactly as before — both entry points"), `test/spawn-dispatcher-activation.test.ts` ("an UNMARKED dead worker keeps the fence…").
- [x] A **live** worker takes the unchanged steer path (park + interrupt at the step boundary) — no wake, no resume. — `test/message-agent.test.ts`, `test/worker-wake-on-send.test.ts`, `test/spawn-dispatcher-activation.test.ts` ("a LIVE worker takes the unchanged steer path").
- [x] A marked worker owned by **another** session still refuses `unknown-target` from `message_agent`. — `src/core/tools.ts` (the durable-parent fence beside the roster fence); pinned twice.
- [x] Offline tests green, in the grouped run of every touched suite plus the canaries. — 358 pass / 0 fail over 95 suites (see Resolution).

## Constraints

- Additive only: `dispatcher_sessions` semantics and `resolveSessionKind`'s `origin`-first order are untouched; the glyph is ticket 140's.
- No gate, cap, or refusal class is added.
- No invented marker: the identity stays ours (`worker_sessions`), `agentPreset` is not fabricated.
- Offline tests only (S8); no network, no dsh.

## Comments

### 2026-10-22 — filed, then implemented (owner ruling 2026-10-22, children half)

**Design as built.** A `worker_sessions` table in the existing `multitask_dispatcher` domain (no version bump), keyed by worker id, `present = { sessionId, parentSessionId }`, written at worker spawn after the host accepts the child. The adapter mirrors it synchronously (`workerSessionMark` / `refreshWorkerSessionMarks`, warmed on each dispatcher activation beside the ticket-138 dispatcher mirror). The core's `steerWorker` consults `findDurableWorker` when the id has no roster record: a hit is accepted and handed to `host.wakeDormantWorker`, which parks the WRAPPED correction (last-wins) and calls `ctx.subagents.sendMessage(spawner, workerId, RESUME_WAKE_CUE)`. On `agent/created` the adapter's `reattachMarkedWorker` re-registers the worker, re-applies the worker composition (contract + barrier + reply tool), fires `onWorkerReattached` (core: `reclaimWorker`, which resolves the ticket-59 hold), and then delivers the parked correction once. `message_agent` routes a marked dormant worker of the calling session to the same steer branch; a foreign or unmarked id keeps `unknown-target`.

**Why the row is separate from `worker_markers`.** The marker is an obligation record (`toDurableMarker`), deleted on abort and on hold release, and absent for a worker that already settled — none of which answer "is this id a worker we can wake?". The wake row has the opposite lifecycle for the terminal case (it is deleted precisely so a finished worker cannot come back, ticket 04), and is present for a worker whose marker was never written. Reusing one table for both would have made each lifecycle contort to the other.

**Where it deliberately stops short.**

- **No migration.** A worker spawned before this ticket has no row, so it is not wake-able; its send refuses exactly as before.
- **No seeded historical row.** Writing rows for existing marker rows was considered and rejected: the marker set includes unknown-state holds (workers we cannot prove dead), and marking those as wake-able would let a send resurrect a session ticket 59 is deliberately holding.
- **The cue opens its own turn.** Parity with the dispatcher half: `RESUME_WAKE_CUE` is the resume payload; the correction arrives as the resumed session's next message. A worker that finishes the cue turn before the correction lands settles normally, and the correction is then sent to a dead session (logged, not retried) — the same shape the dispatcher half has.
- **One parked slot per worker.** Last-wins, matching the core steer queue; a second send before the worker returns replaces the first.

**Tests (offline, 358 pass / 0 fail over 95 suites in the final grouped run).**

- `test/worker-wake-on-send.test.ts` — **new, 12 tests.** Mark written at spawn with the right parent (+ host mirror in step); dropped on terminal settle (obligation marker untouched); dropped on abort and on hold release; `steerWorker` accepts a marked dormant id and hands the wrapped correction to `wakeDormantWorker`; `message_agent` routes it to the steer lane and never the peer inbox; an id with no row refuses `unknown-worker` / `unknown-target` with nothing sent; a foreign session's marked worker refuses `unknown-target`; a live worker keeps park+interrupt with no dormant wake; a host without the wake seam keeps the refusal; `reclaimWorker` resolves the hold and re-takes the stream key, is a no-op for unknown/foreign ids, and leaves a reclaimed worker steerable and settleable.
- `test/spawn-dispatcher-activation.test.ts` — **5 new** end-to-end through the real plugin, real `CordisDshHost`, storage surviving a simulated restart: the row is written at spawn with the spawner; a settled worker's row is dropped; a send to a marked, dormant worker cold-resumes it through `ctx.subagents.sendMessage` from the SPAWNER with the cue (never the correction), the resumed child is composed as a WORKER (`reply_to_dispatcher` only, contract section, no dispatcher policy), the correction lands exactly once wrapped, and `check_workers` lists the worker again; two sends before return coalesce to one resume and the latest correction; a second announcement delivers nothing new; an unmarked dead id keeps both refusals; a live worker takes the normal path with no re-composition.
- `test/message-agent.test.ts` — **4 new** (the tool-level fence and routing): dormant marked worker accepts as `steer` with honest "dormant / being resumed" copy and no step-boundary promise; unmarked refuses; foreign marked refuses; live path unchanged; identity fence still precedes the rate fence.
- `test/adapter-durable-marker.test.ts` — **3 new** (table declared at the same version, write/read/list/delete in the one shared domain, schema rejects a malformed row).
- `test/policy-assembler.test.ts` — **1 extended** (both dormant-arm copy strings pass the narration lint).
- Canaries in the same grouped run: `test/steer-command.test.ts`, `test/restart-honesty.test.ts`, `test/spawn-dispatcher-host.test.ts`, `test/adapter-cordis-dsh-host.test.ts`, `test/durable-roster.test.ts`, `test/steer-queue.test.ts`, `test/stop-semantics.test.ts`, `test/worker-lifecycle-fsm.test.ts`, `test/worker-reply.test.ts`, `test/multitask-peer.test.ts`, `test/multi-dispatcher-peer.test.ts`, `test/delivery-obligation.test.ts`, `test/wake-bus.test.ts`, `test/tool-results.test.ts`, `test/dispatcher-tools.test.ts`, `test/spawn-inflight-guard.test.ts` — all pass. `npx tsc --noEmit` on both configs is clean.

**Residual limits, recorded not hidden.**

1. **The re-adoption path is the async case.** When the mirror already knows the worker (always true for a send that parked a wake), adoption is synchronous inside `agent/created`. When only the STORE knows it (a host resuming a worker on its own before this process warmed anything), the read lands a microtask later — the same residual the ticket-130 dispatcher path documents.
2. **`reclaimWorker` before the rebuild.** A send can land before `rebuildFromDurability` finishes; the host's live evidence is then remembered (`adoptedAwaitingMarker`) and the pending rebuild restores a live record instead of creating a hold that would block the stream key.
3. **No live run.** Offline only (S8): `ctx.subagents.sendMessage`'s cold-resume behaviour is modelled after `docs/research/dsh-adapter-api-notes.md:83`, exactly as the dispatcher half does. A live confirmation belongs to a separate pass.

