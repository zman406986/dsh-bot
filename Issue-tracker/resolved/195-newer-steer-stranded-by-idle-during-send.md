# 195 — Newer accepted steer is stranded when idle arrives before the older send resolves

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** yes — S3: accepted mid-run correction delivery

## Requirement

A mid-run steer must reach the same worker with its context preserved, without restarting it ([PRD S3:69](../../PRD-dsh-multitask-dispatcher.md#L69), [worker contract:140](../../PRD-dsh-multitask-dispatcher.md#L140)). The core parks a single last-wins correction and delivers it at a boundary ([PRD §7.3:238–242](../../PRD-dsh-multitask-dispatcher.md#L238-L242)). Once an older correction is already being sent, a newer accepted correction must retain a delivery opportunity when that send finishes.

## Problem and source evidence

An already running worker accepts FIRST, then accepts SECOND while the send of FIRST is pending. If the next idle boundary arrives before that older send resolves, the core skips it. The successful older send preserves SECOND in the slot but leaves no drain, retry, or new interrupt to deliver it. SECOND can remain parked until an unrelated later boundary; a later terminal settle clears it without delivery.

The current source establishes the full production path:

1. Worker idle is the delivery signal: [parent-agent.ts:763–765](../../src/adapter/parent-agent.ts#L763-L765) calls `host.emitStepBoundary(workerId)`. The adapter invokes subscribers asynchronously without waiting for their send to finish ([cordis-dsh-host.ts:3602–3618](../../src/adapter/cordis-dsh-host.ts#L3602-L3618)); the core subscriber is [multitask.ts:1197](../../src/core/multitask.ts#L1197). Delivery reaches the real adapter method, which awaits `ctx.subagents.sendMessage` ([cordis-dsh-host.ts:4316–4346](../../src/adapter/cordis-dsh-host.ts#L4316-L4346), specifically [line 4344](../../src/adapter/cordis-dsh-host.ts#L4344)).
2. While FIRST is in flight, another boundary returns immediately at [multitask.ts:1152](../../src/core/multitask.ts#L1152). It records no pending boundary for later consumption.
3. SECOND replaces the parked slot at [multitask.ts:1591–1592](../../src/core/multitask.ts#L1591-L1592). The interrupt branch runs only when the core record is `running` ([lines 1594–1597](../../src/core/multitask.ts#L1594-L1597)). While it is already `steering`, SECOND is only parked and returns `{ ok: true }` ([lines 1620–1621](../../src/core/multitask.ts#L1620-L1621)).
4. When FIRST succeeds, [multitask.ts:1183–1191](../../src/core/multitask.ts#L1183-L1191) removes the in-flight guard, clears retry state, and preserves the replaced slot. It assumes the next boundary will deliver SECOND, although that boundary already arrived and was skipped. It neither drains the newer correction nor schedules a retry or requests another interrupt. The worker remains `steering`.
5. If the worker later settles without another boundary delivering SECOND, [multitask.ts:983–986](../../src/core/multitask.ts#L983-L986) clears the parked correction and retry state. This later loss follows from source; the recorded reproduction below stops before terminal settle.

## Recorded deterministic reproduction

The supplied audit reproduced this with the actual `createMultitask` core, `createCordisDshHost` adapter, and `bindDispatcherLifecycle` lifecycle. Only the promise returned by `ctx.subagents.sendMessage` was gated; the core drain, adapter `sendMessage`, and lifecycle boundary handling were the real implementations. The file-free command family was `node --import tsx --input-type=module`, run from the repository root. No network/LLM timing is needed to establish this interleaving.

1. Construct and bind those components, register a live worker, and emit its `running` status so its core record is running.
2. Call `steerWorker(workerId, "FIRST")`. Record `{ ok: true }` and one interrupt.
3. Emit worker `idle` through the bound lifecycle. This starts the real send of FIRST; hold only its `ctx.subagents.sendMessage` promise unresolved.
4. Emit worker `running` while FIRST's promise is still pending.
5. Call `steerWorker(workerId, "SECOND")`. Record `{ ok: true }`; the core is already steering, so there is no second interrupt.
6. Emit worker `idle` while FIRST's send remains pending. This is SECOND's available boundary, skipped by the in-flight guard.
7. Resolve FIRST's send successfully, then flush microtasks until the adapter and core success continuations finish. Emit no additional idle boundary and do not settle the worker before inspecting the result.
8. Inspect sent correction texts, interrupt count, core worker status, and scheduled steer retry timers. Assert that SECOND has been sent.

Recorded observed result (correction texts shown without their wrapper):

~~~text
first: { ok: true }
second: { ok: true }
sent: [FIRST]
interrupts: 1
status: steering
retryTimers: 0
~~~

The assertion that SECOND was sent failed; the reproduction exited with code 1. Expected: the accepted SECOND correction retains a delivery path after FIRST resolves, reaches the same worker exactly once, and returns the core to running when no correction remains. Delivery must not depend on an unrelated third boundary or another user correction rescuing it.

This ticket records the supplied executed evidence and independently checked current source lines. The reproduction was not rerun during ticket writing; no probe or test file was created.

## Adjacent passing controls and the coverage gap

The supplied audit also ran:

~~~sh
node --import tsx --test --test-name-pattern="a newer steer parked during the send|two boundaries inside one send window" test/multitask-hardening.test.ts
~~~

Result: 2/2 selected tests passed. They cover the neighboring orderings separately:

- [multitask-hardening.test.ts:396–429](../../test/multitask-hardening.test.ts#L396-L429) parks a newer steer during the older send, but resolves the send at lines 412–413 **before** emitting the next boundary at lines 424–425. It supplies the extra boundary missing from this race.
- [multitask-hardening.test.ts:431–455](../../test/multitask-hardening.test.ts#L431-L455) overlaps two boundaries inside one send window, but queues no newer steer. Suppressing the second send there correctly prevents duplicate delivery of the same correction.

Neither covers a newer steer together with its boundary arriving during the older send. These passing controls were not rerun during ticket writing.

## Impact and severity

**P2 / medium. S3 ship blocker: yes.** The dispatcher receives a success acknowledgement for SECOND, yet the worker can continue with only FIRST applied or finish without ever receiving the newer correction. This breaks the promised delivery of an accepted mid-run correction, with no restart involved.

The demonstrated failure is a stranded correction for the affected worker. It does not establish a dispatcher-wide deadlock. The deterministic gate proves the ordering defect; live timing frequency and the duration of the vulnerable send window have not been measured.

## Duplicate check and related-ticket distinctions

Checked ticket filenames, titles, and relevant content across all four folders, `open`, `deferred`, `resolved`, and `cancelled`, on 2026-11-07. ID 195 was unused and no duplicate of this in-flight-send/consumed-boundary race was found. IDs 195–199 were reserved by the parent; 195 is assigned to this finding.

- [03 — Steer queue:9–14](../resolved/03-steer-queue.md#L9-L14) establishes context preservation, interrupt-at-boundary delivery, and single-slot last-wins. This ticket isolates a later asynchronous send/boundary interleaving that strands a newly accepted slot.
- [60 — Deliver a steer at the nearest step:55–62](../resolved/60-steer-delivery-nearest-step.md#L55-L62) resolves the choice of interrupt-then-idle delivery versus a finer host signal. This finding uses the existing idle boundary and needs reliable delivery across an in-flight send; it does not require changing that settled mechanism.
- [142 — Workers wakeable on send:75–80](../resolved/142-workers-wakeable-on-send.md#L75-L80) concerns durable identity and dormant-worker wake/reattachment, and explicitly preserves the live-worker steer path. This reproduction begins with an already live, running worker and uses that live path throughout.
- [190 — Cold resume drops the worker running edge:14–25](../open/190-cold-resume-drops-worker-running-edge.md#L14-L25) loses a running observation before durability rebuild creates the worker record, causing corrections to refuse `not-running`. Here a valid live record accepts both corrections, and the newer one strands during an older send. The existing 190 file is the unrelated cold-resume case; no prior ticket for this finding was written under that ID.

## Acceptance criteria

- [ ] Add a deterministic offline regression for the exact order above through the actual core, adapter, and bound lifecycle, gating only `ctx.subagents.sendMessage`. Both steer calls are accepted, the second idle arrives before FIRST resolves, and SECOND is delivered exactly once without an unrelated extra boundary or user correction.
- [ ] After the accepted corrections are delivered and no newer slot remains, the worker returns to `running`. The worker/session identity and conversation/tool context are preserved; no replacement worker or restart is introduced.
- [ ] Overlapping boundaries with no newer steer still deliver the same correction only once. A newer steer whose boundary arrives after the older send resolves also continues to deliver once. Keep the two cited controls passing.
- [ ] Preserve single-slot last-wins for corrections still pending, and preserve existing failed-send retry behavior. Stop/terminal settlement must continue to prevent sending to or reviving a terminal worker, including when an older send resolves late.

The recorded interleaving, exact source path, observed failure, and bounded acceptance criteria make this ready for an agent; no additional product decision is required.

## Comments

- 2026-11-07 — Ticket only. Recorded the supplied failing deterministic core/adapter/lifecycle reproduction and the supplied 2/2 passing adjacent controls; verified source references and duplicate/ID availability. No implementation, test, configuration, other documentation, or generated-index edits; no agents, probes, or tests launched.

## Resolution - 2026-11-08

A boundary consumed inside an in-flight steer send is now recorded, and the newer correction is drained right after the old send succeeds; commit `030f231`; `test/multitask-hardening.test.ts` 27/27.
