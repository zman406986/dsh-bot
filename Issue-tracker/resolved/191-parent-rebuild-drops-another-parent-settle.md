# 191 — A parent rebuild drops another parent's buffered settle

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P1 / high
**Ship blocker:** yes (silent worker-result loss violates S4)

## Requirement

PRD [§4 S4](../../PRD-dsh-multitask-dispatcher.md#L70) requires a worker finish to wake the dispatcher so it can reconcile the todo and deliver the result. A finished worker must not remain silently represented as live while its result has no delivery wake.

## Problem and evidence

The plugin creates one shared Multitask instance at [src/plugin.ts:1290](../../src/plugin.ts#L1290). Recovery is invoked for a particular session at [src/plugin.ts:1541](../../src/plugin.ts#L1541), and each activation starts that recovery asynchronously at [src/plugin.ts:1637](../../src/plugin.ts#L1637) through [line 1661](../../src/plugin.ts#L1661). ADR-0019 explicitly keeps one shared instance while rebuilding per activated session ([ADR-0019:39-41](../../docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md#L39)).

The core buffers a terminal event when a worker has been adopted but its roster record has not yet been restored: [src/core/multitask.ts:1073](../../src/core/multitask.ts#L1073) through [line 1083](../../src/core/multitask.ts#L1083). pendingSettles is shared state in that core instance, keyed by worker id ([src/core/multitask.ts:616](../../src/core/multitask.ts#L616), [line 626](../../src/core/multitask.ts#L626)). reclaimWorker records an adopted id before its marker is available ([src/core/multitask.ts:1634](../../src/core/multitask.ts#L1634) through [line 1649](../../src/core/multitask.ts#L1649)).

A concrete lost-result interleaving is:

1. Dispatchers A and B independently start recovery; both marker reads are held pending ([src/core/multitask.ts:1939](../../src/core/multitask.ts#L1939) through [line 1941](../../src/core/multitask.ts#L1941)).
2. B's resumed worker is adopted before B's read completes. It settles while it has no core record, so its event is buffered in pendingSettles.
3. A's marker read resolves first. After restoring A's markers, A's rebuild sweeps every buffered settle and deletes any whose worker id is absent from the shared workers map ([src/core/multitask.ts:2075](../../src/core/multitask.ts#L2075) through [line 2076](../../src/core/multitask.ts#L2076)). This cleanup has no parent-session check, so it deletes B's buffered event while B's marker read is still pending and B has no record.
4. B's read resolves. Its adopted-worker branch creates B's record with status spawned ([src/core/multitask.ts:1950](../../src/core/multitask.ts#L1950) through [line 1964](../../src/core/multitask.ts#L1964)), then looks for the buffered settle to replay ([line 1992](../../src/core/multitask.ts#L1992) through [line 1995](../../src/core/multitask.ts#L1995)). The event is already gone, so applySettle is not called.

## Impact

Without applySettle ([src/core/multitask.ts:971](../../src/core/multitask.ts#L971) through [line 1063](../../src/core/multitask.ts#L1063)), B never gets the terminal transition, terminal marker update, settle record, or dispatcher wake. Its rebuilt record remains spawned and its stream key remains claimed; its linked todo remains pending or in progress according to the marker. The worker result has no settle wake to drive delivery, violating S4.

## Confidence and validation limitation

High-confidence source-order reasoning: the independent asynchronous reads permit this ordering, and the shared cleanup deterministically removes B's event before B can replay it. This establishes a reachable source-level failure, not its production frequency. No runtime reproduction or test was run; this is a source audit only.

## Duplicate check

The open, deferred, resolved, and cancelled folders were checked for issue-number availability and related findings. No current duplicate was found.

- [Resolved 142](../resolved/142-workers-wakeable-on-send.md#L118) covers adoption before a rebuild and replaying a buffered settle during that worker's own rebuild; it does not cover another parent's rebuild deleting the shared event.
- [Resolved 90](../resolved/90-restart-honesty-carried-verifier-findings.md#L94) covers activation generations and rebuild/publication ordering, not settle-buffer ownership.
- [Resolved 59](../resolved/59-freed-stream-key-double-worker-risk.md#L11) concerns unknown-state occupancy and potential duplicate workers, not a buffered terminal result being discarded.
- [Resolved 120](../resolved/120-mock-llm-e2e-messaging-await-mitosis.md#L40) concerns the fresh-spawn running edge arriving before host/core registration.
- [Resolved 163](../resolved/163-ticket-157-four-implementation-defects.md#L13) concerns summoned-dispatcher recovery defects, not worker settle replay.
- [Open 158](158-157-verification-sweep.md) is a verification-only sweep.
- [Open 190](190-cold-resume-drops-worker-running-edge.md#L14) is adjacent but distinct: it concerns losing a resumed worker's running edge, not cross-parent deletion of a buffered terminal settle.

## Acceptance criteria

- A focused regression check holds independent A and B marker reads pending, adopts and settles B before B's read completes, resolves A first, then resolves B. B is reconstructed terminal exactly once through the normal settle path.
- The accepted B settle produces exactly one settle record and dispatcher wake, releases B's stream key, and preserves the todo's delivery obligation until the dispatcher provides the first visible acknowledgement.

## Comments

2026-11-07 — Source audit confirmed the shared-buffer cross-parent cleanup race. All four issue states were rechecked; no duplicate found. Source reasoning only: no repro, tests, or test suite run. Ticket-writing only; no implementation or test files changed.

## Resolution - 2026-11-08

Fixed in `475c12f`: the pending-settle sweep now removes an entry only when it is phantom for the rebuilding parent (`adoptedAwaitingMarker`); `test/multitask-hardening.test.ts` passes 26/26.
