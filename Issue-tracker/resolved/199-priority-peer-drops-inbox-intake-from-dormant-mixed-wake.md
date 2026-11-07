# 199 — Priority peer drops inbox intake from a dormant dispatcher's mixed wake

**Status:** resolved
**Labels:** ready-for-agent
**Type:** bug
**Severity:** P2 / medium
**Ship blocker:** no

## Problem and impact

With the opt-in file inbox enabled, a priority peer message can discard an intake job's prompt before the dispatcher sees it. The affected wake contains both a settled worker and an unpresented inbox job, has source `worker-settled`, and is waiting for a durably marked dormant dispatcher to resume. Priority reclaim restores the worker notice but drops the intake payload. The subsequent peer and worker turns contain no inbox job; the inbox todo remains pending, and retrying the same job in the same core returns `duplicate-job`.

The lost payload is external intake: [ExternalJobNotice at src/core/wake-bus.ts:41](../../src/core/wake-bus.ts#L41) carries `jobId`, `promptText` and `jobDir`. The worker's report survives this reclaim and was delivered in the supplied reproduction. Its separate delivery-obligation marker is also retained ([src/core/multitask.ts:1037](../../src/core/multitask.ts#L1037)).

P2 / medium, nonblocker: this can strand accepted external work without presenting its prompt, but requires the optional inbox, a mixed wake, a dormant marked target and a priority peer arriving before resume composes the wake. The inbox ships disabled by default ([PRD:400](../../PRD-dsh-multitask-dispatcher.md#L400)). Permanent loss across restart is unproven; recovery limits are described below.

## Requirement

External intake must present the job prompt through the dispatcher wake path and join normal batching ([PRD §6.4:171](../../PRD-dsh-multitask-dispatcher.md#L171), [ADR-0023 decisions 1–2:19](../../docs/adr/0023-file-driven-external-intake.md#L19)). Priority may reorder non-user work, but reclaimed work must remain queued without duplicate delivery ([resolved 14:14](../resolved/14-peer-inbox-and-priority-lane.md#L14)). The cause and expected behavior are specified without a new product decision, justifying `ready-for-agent`.

## Confirmed source path

Source reviewed on 2026-11-07 at revision `3d08313`.

1. An intake job accepted while the dispatcher is busy goes into `pendingExternalJobs` without opening a turn ([src/core/wake-bus.ts:871](../../src/core/wake-bus.ts#L871), [line 892](../../src/core/wake-bus.ts#L892)). Dispatcher disposal calls `cancelTurn` ([src/adapter/parent-agent.ts:630](../../src/adapter/parent-agent.ts#L630), [line 643](../../src/adapter/parent-agent.ts#L643)). That clears busy/ready state but leaves pending lists intact ([src/core/wake-bus.ts:991](../../src/core/wake-bus.ts#L991)).
2. A worker settling afterward joins the pending jobs ([src/core/wake-bus.ts:768](../../src/core/wake-bus.ts#L768)). `flushBackground` puts both arrays into ready ([line 612](../../src/core/wake-bus.ts#L612)); `sourceFor` chooses `worker-settled` whenever there is any worker notice ([line 333](../../src/core/wake-bus.ts#L333)). This is a valid mixed background wake.
3. With no live agent but a durable dispatcher mark, `openWakeTurn` parks the notification and requests resume before composing the wake ([src/adapter/cordis-dsh-host.ts:1901](../../src/adapter/cordis-dsh-host.ts#L1901)). Resume starts through a promise continuation ([line 2024](../../src/adapter/cordis-dsh-host.ts#L2024)). The mixed core wake remains undrained during dormancy.
4. A priority `message_agent` to that dispatcher calls `sendPeer` ([src/core/tools.ts:1486](../../src/core/tools.ts#L1486)). A durably marked absent target is accepted ([src/core/multitask.ts:2135](../../src/core/multitask.ts#L2135)); the peer is then enqueued ([line 2163](../../src/core/multitask.ts#L2163)). The idle-ready priority branch promotes it ([src/core/wake-bus.ts:845](../../src/core/wake-bus.ts#L845)), invoking reclaim ([line 760](../../src/core/wake-bus.ts#L760)).
5. `reclaimReadyNonUser` restores external jobs only for source `external-event` ([src/core/wake-bus.ts:736](../../src/core/wake-bus.ts#L736)). For mixed source `worker-settled`, the fallback restores only `settledWorkers` ([line 742](../../src/core/wake-bus.ts#L742)), then clears ready ([line 748](../../src/core/wake-bus.ts#L748)). The mixed wake's `externalJobs` are discarded.

The dormant condition matters: the ordinary live-host path invokes the composer synchronously ([src/adapter/cordis-dsh-host.ts:1920](../../src/adapter/cordis-dsh-host.ts#L1920)), and the composer immediately drains the core wake ([src/plugin.ts:565](../../src/plugin.ts#L565)). A later priority send cannot reclaim that already-drained live wake. This ticket makes no user-preemption claim.

## Deterministic reproduction and observed output

Supplied confirmation: actual-core and actual-Cordis-host inline, in-memory probes passed assertions of this defect, including a live control. Command family: cache-disabled PowerShell here-string piped to `node --import tsx --input-type=module`, constructing shipped `createMultitask` and `createCordisDshHost` with memory services. No probes or tests were rerun during filing; no real-filesystem restart was exercised. These steps and observations record that supplied confirmation, not a newly executed transcript.

1. Construct the actual core and Cordis host with memory services and production compose/drain wiring. Give dispatcher `d` a durable mark and a worker `w`. While `d` is busy, accept external job `j` with a distinctive prompt and job directory. It waits pending and has no worker of its own.
2. Live control, using a separate fresh fixture: keep `d` live, settle `w` while the dispatcher is still busy, then end the dispatcher turn so both notices flush together. The composed mixed wake contains `j`.
3. Defect fixture: after accepting `j` while busy, dispose/deactivate `d` through the lifecycle path, retaining its durable mark and pending intake. Leave `d` absent from the live-agent lookup and hold cold-resume completion. Settle `w` with report `done`. Inspect ready: source `worker-settled`, worker `w` and external job `j` are all present.
4. Before releasing resume, call `sendPeer` with a valid envelope from another dispatcher to `d` and `priority: true`. It is accepted and replaces the undrained mixed ready wake with a peer wake.
5. Release resume and process the peer turn and following background turn through real composition. The peer arrives first, then the worker report `done`; neither turn presents `j`.
6. Retry `enqueueExternalJob` for the same `j` in the same core and invoke normal delivery redrive. Retry refuses `duplicate-job`, and no intake wake is redriven.

Observed fields, normalized from the supplied passing probe assertions (`jobs` lists intake job IDs carried by the wake/composition):

```text
live control mixed composition: jobs=[j]
dormant mixed ready: source=worker-settled, jobs=[j]
sendPeer(priority:true): accepted
resumed peer wake: jobs=[]
following worker wake: jobs=[], worker report=done
retry same j: {ok:false,reason:duplicate-job}
inboxRedriven:false
```

## Recovery limits

Initial enqueue creates an inbox-tagged pending todo. Same-session dedupe treats its existence as evidence of presentation ([src/core/multitask.ts:1747](../../src/core/multitask.ts#L1747)), rejecting replacement enqueue even though the prompt was never composed. Worker-result redrive requires an `in_progress` todo and a terminal worker ([src/core/todo-reconciler.ts:327](../../src/core/todo-reconciler.ts#L327)); an unspawned pending intake job does not qualify.

Activation performs checkpoint rescan ([src/plugin.ts:1601](../../src/plugin.ts#L1601)), which can resolve the disk prompt and re-present it ([line 2002](../../src/plugin.ts#L2002)). Re-presentation is subject to owner/todo dedupe: a still-live owner's existing inbox todo suppresses it ([line 1803](../../src/plugin.ts#L1803)). A fresh core or later eligible activation may therefore recover a checkpointed job. Real filesystem/restart recovery was not verified, and permanent background-job completion loss is not established.

## Duplicate check and related differences

Before creation, checked filenames and related evidence across all four status folders (`open`, `deferred`, `resolved`, `cancelled`), including intake/external-job, mixed-wake, priority and reclaim terms. Numeric ID 199 was unused in all four; no existing ticket covers this mixed-payload reclaim defect.

- [Resolved 113:13](../resolved/113-implement-file-inbox-per-adr-0023.md#L13) added the opt-in intake lane, batching, dedupe and restart re-presentation. This finding concerns loss of already-accepted intake when priority reclaims a mixed wake; it does not reopen inbox feature design.
- [Resolved 58:53](../resolved/58-delivery-obligation-bound-lost-telemetry.md#L53) redrives settled worker-result delivery obligations. Here the worker result is preserved; the missing prompt belongs to an unspawned intake todo outside that redrive condition.
- [Resolved 14:14](../resolved/14-peer-inbox-and-priority-lane.md#L14) established priority reclaim without loss or duplicate delivery before the inbox payload category was added. This is the mixed worker/intake case left uncovered by source-based restoration.

## Acceptance criteria

- [ ] Priority reclaim preserves all payload categories in a mixed background wake, including each external job's original `jobId`, `promptText` and `jobDir`, regardless of the wake source discriminator.
- [ ] In the dormant marked-dispatcher sequence above, resume presents the priority peer first and each reclaimed intake job exactly once through the existing background lane. Intake stays out of the peer wake; no duplicate inbox todo or intake presentation is created.
- [ ] The original worker notice and report remain available after priority reclaim without duplication caused by reclaim; existing worker-result delivery obligations and redrive behavior remain intact.
- [ ] The live-host control and pure external-event reclaim continue to present intake once, and already-accepted job retries retain existing dedupe behavior. The mixed case succeeds without depending on restart/rescan to reconstruct the discarded prompt.

## Comments

- 2026-11-07 — Audit ticket only, using supplied actual-core/Cordis-host memory-probe observations and current source review. No implementation, tests, configuration, documentation or generated index edits; no probes or tests executed during filing.

## Resolution - 2026-11-08

A reclaimed mixed wake now restores `externalJobs` for every non-user source, not just `external-event`; commit `b144ec1`; `test/wake-bus.test.ts` 18/18.
