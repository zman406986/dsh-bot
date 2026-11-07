# 190 — Cold resume drops the worker running edge

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no

## Requirement

A worker whose resumed turn has been observed running must have a running roster state and accept mid-run corrections. The contract requires steering to preserve the worker's context ([PRD §6.2:140](../../PRD-dsh-multitask-dispatcher.md#L140)); the lifecycle requires `spawned → running` when the first turn starts ([ticket 02:9](../resolved/02-worker-lifecycle-fsm.md#L9)). The cold-resume contract also requires re-attachment to produce a usable live roster record ([ticket 142:78](../resolved/142-workers-wakeable-on-send.md#L78)).

## Problem and evidence

When a durably marked worker cold-resumes before the fresh core's marker read finishes, the host can adopt it and observe its resumed turn running before the core has a worker record. The core drops that running edge, then rebuilds the worker as `spawned`. The record stays incorrectly `spawned` for the remainder of the affected turn unless another running edge or a terminal settle arrives.

The current source establishes this order:

1. [src/plugin.ts:1637](../../src/plugin.ts#L1637) enters the activation callback; [line 1641](../../src/plugin.ts#L1641) installs the tool surface before [line 1659](../../src/plugin.ts#L1659) launches recovery without awaiting it. Recovery calls the core rebuild at [line 1541](../../src/plugin.ts#L1541), whose marker read awaits at [src/core/multitask.ts:1939](../../src/core/multitask.ts#L1939). A dispatcher can therefore send while that read is pending.
2. The host adopts the resumed worker into its own map at [src/adapter/cordis-dsh-host.ts:2834](../../src/adapter/cordis-dsh-host.ts#L2834), then calls the re-attachment hook at [line 2865](../../src/adapter/cordis-dsh-host.ts#L2865). The hook at [src/plugin.ts:1260](../../src/plugin.ts#L1260) calls `reclaimWorker` at [line 1261](../../src/plugin.ts#L1261).
3. With neither a loaded unknown-state hold nor a worker record, `reclaimWorker` only records `adoptedAwaitingMarker` at [src/core/multitask.ts:1646](../../src/core/multitask.ts#L1646), [line 1647](../../src/core/multitask.ts#L1647) and [line 1648](../../src/core/multitask.ts#L1648). It does not create the worker record in this branch.
4. The running-status handler finds the adopted host worker and calls `noteTurnStarted` at [src/adapter/parent-agent.ts:757](../../src/adapter/parent-agent.ts#L757) through [line 761](../../src/adapter/parent-agent.ts#L761). That method immediately calls `transition` ([src/core/multitask.ts:1624](../../src/core/multitask.ts#L1624)); the missing-record check at [line 836](../../src/core/multitask.ts#L836) and [line 837](../../src/core/multitask.ts#L837) returns without preserving the event.
5. When the marker read completes, the adopted-worker branch creates the record at [src/core/multitask.ts:1950](../../src/core/multitask.ts#L1950) with `status: "spawned"` at [line 1957](../../src/core/multitask.ts#L1957). There is no corresponding running-event buffer or replay: the pending state holds adoption identity and terminal settles ([line 616](../../src/core/multitask.ts#L616), [line 626](../../src/core/multitask.ts#L626)), and rebuild replays only `pendingSettles` at [line 1992](../../src/core/multitask.ts#L1992).
6. A subsequent correction hits the existing roster record, whose status fails the running/steering gate at [src/core/multitask.ts:1583](../../src/core/multitask.ts#L1583) and returns `not-running` at [line 1586](../../src/core/multitask.ts#L1586).

**Confidence:** high-confidence source-order reasoning. The marker-read await permits the interleaving, and the two core methods deterministically discard the observed running edge and later create a spawned record. **NO runtime repro executed.** This audit did not measure the frequency or duration of the interleaving.

## Impact

During the affected resumed turn, `check_workers` reports the wrong lifecycle state because it projects the core roster ([src/core/tools.ts:1030](../../src/core/tools.ts#L1030)). Further `steer_worker` and worker-targeted `message_agent` corrections refuse `not-running` even though the host has already reported the worker running: both tools call the same core steer path ([line 1080](../../src/core/tools.ts#L1080), [line 1454](../../src/core/tools.ts#L1454)). A later running edge can correct the live state; a terminal settle can end it. Until either happens, the dispatcher cannot correct that running turn through these tools.

P2 / medium: a timing-dependent cold-resume path loses accurate status and mid-run steering for an active turn. Ship blocker: no.

## Suggested minimal reproduction

Not executed; this is a deterministic core-level reproduction suggestion:

1. Seed durability with a worker marker whose status is `running`, owned by `parent`, and construct a fresh core with no loaded hold or worker record.
2. Call `reclaimWorker(id, parent)`, then `noteTurnStarted(id)` to represent host adoption followed by the observed running edge.
3. Await `rebuildFromDurability(parent)`. Inspect the worker: the current code creates it with status `spawned`, despite the earlier observed edge.
4. Call `steerWorker(id, correction)`; the current code refuses `not-running`. The matching integration ordering starts rebuild with its marker read held pending, runs steps 2 during that read, then releases it.

## Duplicate check

Checked ticket-number availability, titles and related root causes across `open`, `deferred`, `resolved` and `cancelled` on 2026-11-07. No `190-*` file or duplicate of this cold-resume worker-record gap was found before creation.

- [Resolved 120:50](../resolved/120-mock-llm-e2e-messaging-await-mitosis.md#L50) fixed the fresh-spawn running-edge loss by registering the host and core records before activation. This finding enters through cold-resume re-attachment while durability is still loading; it does not use that fresh-spawn registration path.
- [Resolved 90:94](../resolved/90-restart-honesty-carried-verifier-findings.md#L94) and [its publication fix:113](../resolved/90-restart-honesty-carried-verifier-findings.md#L113) address dispatcher activation generations and rebuild-before-publish ordering. They do not preserve a worker running event received before its core record exists.
- [Resolved 163:13](../resolved/163-ticket-157-four-implementation-defects.md#L13) addresses summoned-dispatcher generation, required working directory, reactivation deduplication and guarded session-controller access. Those are dispatcher recovery defects with different roots.
- [Resolved 142:78](../resolved/142-workers-wakeable-on-send.md#L78) establishes the resumed-worker roster requirement and introduced this re-attachment path. The remaining gap is the observed running edge during adopt-before-rebuild; terminal settles already have a replay path.

## Acceptance criteria

- [ ] If a marked worker is reclaimed before its marker is loaded and a running edge is observed before rebuild creates the record, completing rebuild preserves that observation: the worker is `running`, and `check_workers` reports it accurately.
- [ ] During that still-running resumed turn, `steer_worker` and worker-targeted `message_agent` accept a correction through the existing steer semantics, preserving context.
- [ ] Re-attachment alone, with no observed running edge, leaves the rebuilt worker `spawned`; the never-started refusal remains accurate.
- [ ] A terminal settle received in the adoption/rebuild window wins over any running observation. Rebuild leaves the worker terminal, and a late or duplicate running edge cannot revive it or make it steerable.

## Comments

- 2026-11-07 — Source audit confirmed the cold-resume ordering gap with high-confidence source-order reasoning. NO runtime repro executed; no implementation or tests changed, and no test suite run. Ticket-writing stage only; no fix or design proposal is included.

## Resolution - 2026-11-08

Fixed in `43e7c08` (the buffered turn-started edge is replayed before any buffered settle) and `5d3c4c7` (three host cases); `test/adapter-cordis-dsh-host.test.ts` passes 153/153 across both host suites.
