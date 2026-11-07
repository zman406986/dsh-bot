# 196 — Pending worker activation survives plugin unload/HMR

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no — confirmed audit triage for the unload/HMR startup race.

## Problem and evidence

Unloading or hot-reloading the plugin while a worker's `startActivation` is pending can leave the worker running outside its disposed adapter. Teardown cannot see the pending controller or activation receipt, and the late continuation registers them after teardown has already finished.

- [src/adapter/cordis-dsh-host.ts:3655](../../src/adapter/cordis-dsh-host.ts#L3655) creates the abort controller. The reserved worker ownership is registered at [lines 3712–3716](../../src/adapter/cordis-dsh-host.ts#L3712-L3716), but [line 3729](../../src/adapter/cordis-dsh-host.ts#L3729) awaits `ctx.subagents.startActivation` before [lines 3783–3784](../../src/adapter/cordis-dsh-host.ts#L3783-L3784) put the controller and activation into the maps teardown visits.
- [Host disposal:4383–4420](../../src/adapter/cordis-dsh-host.ts#L4383-L4420) removes subscriptions and clears ownership/callbacks. It aborts only existing `spawnControllers` entries and disposes only existing `workerActivations` entries at [lines 4400–4408](../../src/adapter/cordis-dsh-host.ts#L4400-L4408). The pending spawn is in neither map. The continuation after the await has a settled-worker check, but no disposed-host guard; disposal also clears the settled-worker set.
- [src/plugin.ts:2168–2173](../../src/plugin.ts#L2168-L2173) performs ordinary unload/HMR teardown and calls `host.dispose()` once, at line 2170.
- The compiled adapter has the same ordering: [activation await:2610](../../lib/adapter/cordis-dsh-host.js#L2610), [late map registration:2667–2668](../../lib/adapter/cordis-dsh-host.js#L2667-L2668), and [disposal:3214–3241](../../lib/adapter/cordis-dsh-host.js#L3214-L3241).
- The installed native [dsh-subagent startup:1421–1459](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L1421-L1459>) awaits directory resolution, preparation, persistence and materialization, passing/checking the supplied signal. The pending window is real; it is not an artifact of an entirely synchronous startup stub.

## Impact and triage

A worker can continue model/tool work after the plugin has unloaded. The disposed adapter no longer tracks that worker or listens for its completion, so its normal completion/wake path is lost. This touches the delivery obligation in [PRD S4](../../PRD-dsh-multitask-dispatcher.md#L70) for the orphaned stream.

P2/medium reflects the specific trigger: plugin unload/HMR must overlap asynchronous worker startup. The confirmed audit disposition is **non-blocking** for this lifecycle race; that is an explicit ship decision, not an inference that P2 can never block a PRD success criterion. A process crash/cold restart is not required.

## Deterministic reproduction

Use `createCordisDshHost` with a fake context whose `subagents.startActivation` captures `spec.signal`, waits on a manually controlled promise, then returns an activation with the reserved child ID and a counted `dispose()`. Count the context's remaining event listeners.

1. Bind a parent and start `host.spawnWorker(...)` without awaiting it; hold `startActivation` at the promise gate.
2. Call `host.dispose()` once while startup is pending.
3. Observe that listeners have been removed but the captured signal is not aborted and no activation has been disposed.
4. Release the gate and await the spawn promise.
5. Observe that spawn succeeds, the signal is still not aborted, activation disposal count is still zero, and `host.owns(workerId)` is false with no listeners left.
6. As a diagnostic control only, call `host.dispose()` a second time: it now finds the late receipt and disposes it once. Ordinary plugin unload does not make this second call.

The prior file-free audit probe exited 0 and recorded:

```text
before gate release: signalAborted:false, activationDisposals:0, listeners:0
after late activation: spawnSucceeded:true, signalAborted:false,
                       activationDisposals:0, trackedWorker:false, listeners:0
second explicit dispose: activationDisposals:1
```

The first disposal clears the reservation before the late continuation runs. When the receipt has the reserved ID, the continuation does not restore ownership, but does insert the controller/receipt into maps belonging to the already disposed host. With subscriptions removed, no normal adapter settle cleanup can release it.

## Acceptance criteria

- [ ] A single host disposal while worker activation is pending aborts the startup signal.
- [ ] If startup nevertheless returns a late activation receipt, release that receipt exactly once; do not leave a usable worker or retained activation in the disposed adapter.
- [ ] No child survives plugin unload/HMR because its activation was pending. A second explicit disposal must not be needed.
- [ ] An offline regression with gated activation proves both pending-signal cancellation and late-receipt cleanup; keep completed-spawn disposal and normal spawn behavior covered.

## Checks performed

- Read the required repository guidance, [tracker conventions](../issue-tracker.md), [triage vocabulary](../../agent.md#L62) and a small existing ticket. The finding is specified for `ready-for-agent`.
- Re-read the source, compiled adapter and installed native startup locations cited above. No implementation changes were made.
- Duplicate-checked all four tracker directories. [Open 158](../open/158-157-verification-sweep.md#L52) concerns cold-restart marker timing/UI verification; [resolved 112](../resolved/112-wake-bus-disposal-wiring.md#L7) and [resolved 137](../resolved/137-access-relay-deny-timers-survive-unload.md#L8) concern wake/access timers; [resolved 163](../resolved/163-ticket-157-four-implementation-defects.md#L9) concerns other dispatcher cleanup/resume paths. [Resolved 59's historical teardown claim](../resolved/59-freed-stream-key-double-worker-risk.md#L63) does not cover the current pending-activation registration gap. None tracks this race; deferred/cancelled had no matching finding.
- Prior audit validation, supplied with this finding: the file-free probe above reproduced the leak; five plugin scaffold controls passed using the command below. These results predate ticket writing and were not rerun here.

```text
node --import tsx --test --test-name-pattern "dispose-all [(]HMR[)]|a re-apply after dispose-all|rolls back a partial tool registration|removes all eight tools|isolates teardown disposers" test/plugin-scaffold.test.ts
```

- The existing [completed-spawn disposal test:515–528](../../test/adapter-cordis-dsh-host.test.ts#L515-L528) awaits spawn before disposal; it does not cover this pending window.
- No tests, probes or builds were run during ticket writing. Only this ticket file was added; the generated index was not changed.

## Comments

- 2026-11-07 — Filed from the confirmed runtime audit as P2/medium, non-blocking. Scope is pending worker activation during plugin unload/HMR.

## Resolution - 2026-11-08

The spawn controller is published before `startActivation`; dispose aborts it and the late receipt is dropped and disposed once; commit `818c032`; `test/adapter-cordis-dsh-host.test.ts` 75/75.
