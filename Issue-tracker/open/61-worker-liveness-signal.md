# 61 — A bounded worker-liveness signal (approved addition A-8)

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none.
**Related:** register item **A-8** (`docs/research/dsh-core-loop-deviations.md` Part B — approved addition, ruled 2026-09-18); `docs/research/dsh-core-loop-fidelity-audit.md` §2 stage 4; `docs/research/reference-agent-lifecycle.md` §4; tickets 27–29 (the presence/activity surfaces this feeds)

## Why this exists, and why it is an addition rather than a fix

Today a wedged worker is **invisible**. `check_workers` reports elapsed time, tool-call count, recent activity and a transcript pointer, and a human reads all four and decides — but nothing ever *derives* "this worker has not advanced in a long time". The reference has no worker-health probe either, so this is **not** a fidelity gap; ADR-0017 fidelity is the wrong target here.

**The ruling (2026-09-18):** approve a liveness addition. It is recorded as `A-8`, an approved deviation from a reference that has nothing to match.

## The design constraint that keeps this cheap and honest

The repo's liveness posture is **pull-only and timer-free**: `check_workers` is projected from the host's `session/event` firehose, the policy forbids the dispatcher from polling, and the audit established that "stay responsive" is *structural* (spawn resolves on inbox acceptance) rather than timer-enforced. `reference-agent-lifecycle.md` records the reference's own liveness as pull-only too.

So the recommended shape is a **pure derivation over data we already have**, not a new subsystem:

- **Preferred:** a pure function over the fields `check_workers` already returns — elapsed, tool-call count, and time since last observed activity — yielding a liveness verdict (`active` / `quiet` / `stalled`) with the threshold as a named constant. No timers, no new host seam, no polling, no background task, fully offline-testable, and it cannot break S1.
- **Acceptable:** the same verdict surfaced in the roster snapshot so the panel can show it, provided `src/core/roster-snapshot.ts`'s contract stays additive (it is consumed by both faces — the schema version is part of its wire contract; see the file header).
- **Rejected:** a watchdog that kills or redrives a stalled worker on its own. That is a *remedy*, not a signal, and it collides with the reference's own conservative treatment (its watchdog abandons rather than repairs, and is armed only when a user task waits). If a remedy is ever wanted, it needs its own ruling and its own ticket.

**Do not let this become the reference's watchdog.** The audit's §2 stage 4 finding stands: we need no watchdog because nothing a worker does can block the dispatcher. This ticket adds visibility, not enforcement.

## Requirements

- **R1** The verdict is a **pure** function — no clock read at the type level beyond a passed-in `nowMs`, no timers, no `setInterval`, no polling. Test it by passing `nowMs`, exactly as `todo-reconciler` and `report-clamp` are tested.
- **R2** The threshold is a named exported constant, not a literal at a call site (the lesson of ticket 63).
- **R3** A worker that has settled, aborted, or is `blocked` on a pending access ask is **not** reported as stalled — those are distinct states with their own meanings, and mislabelling them would make the signal untrustworthy. The blocked-outranks-landed marker precedence in the roster projection is the precedent for how these compose.
- **R4** The signal must be **derivable from fields we already collect**. If satisfying this requires a new host seam, stop and say so — that is a materially larger change and needs the human's call, not a quiet expansion.
- **R5** No new dispatcher tool name and no change to the five-tool surface. If the verdict reaches the model, it rides an existing result shape (`src/core/tool-results.ts`).
- **R6** Roster-snapshot changes, if any, keep `ROSTER_SNAPSHOT_SCHEMA_VERSION` handling honest and stay additive for the browser face.
- **R7** Offline only (S8). No network, no LLM, no running dsh.
- **R8** Clean-room identifier grep over the shipped tree: zero product-tree hits.

## Acceptance criteria

- [ ] A pure liveness derivation exists with a named threshold constant and unit tests covering: advancing, quiet-but-fine, stalled, settled, aborted, and blocked-on-access.
- [ ] Misclassification cases (R3) are each pinned by a test — this signal is only useful if it does not cry wolf.
- [ ] If the verdict is surfaced, the existing roster/toolview tests still pass and the snapshot change is additive.
- [ ] `npm test` 0 fail (baseline: 767 tests / 194 suites), `npm run typecheck` clean (both configs).
- [ ] The register's A-8 row is referenced in the implementation's doc comments.

## Notes

- The honest framing is "a user can now *see* that a worker is stalled", not "the dispatcher recovers stalled workers". Do not oversell it in the copy the model reads.
- If, while implementing, it becomes clear the reference *does* surface an equivalent signal, say so — that would make this `to-be-removed`-by-matching rather than an approved addition, and the register row should change.
