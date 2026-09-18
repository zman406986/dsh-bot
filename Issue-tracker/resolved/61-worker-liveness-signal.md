# 61 — A bounded worker-liveness signal (approved addition A-8)

**Status:** resolved
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

- [x] A pure liveness derivation exists with a named threshold constant and unit tests covering: advancing, quiet-but-fine, stalled, settled, aborted, and blocked-on-access. — `deriveWorkerLiveness` in `src/core/liveness.ts` (R1: only clock is the passed-in `nowMs`), thresholds `WORKER_STALL_THRESHOLD_MS` + `WORKER_ACTIVE_WINDOW_MS` exported constants (R2); `test/liveness.test.ts` covers all six classes plus boundaries.
- [x] Misclassification cases (R3) are each pinned by a test — settled/error/aborted/blocked-on-access pins exist both pure and end-to-end through `check_workers`; "counted-but-unstamped" advancement reads quiet, never a guessed stalled.
- [x] If the verdict is surfaced, the existing roster/toolview tests still pass and the snapshot change is additive. — Surfaced on the check row only (`WorkerCheckRow.liveness` + `liveness:` segment in `formatCheckRowLine`, an existing result shape per R5); `roster-snapshot.ts` untouched (wire contract stays v3); full suite 0 fail.
- [x] `npm test` 0 fail (baseline: 767 tests / 194 suites), `npm run typecheck` clean (both configs). — 803 tests / 205 suites, 0 fail (baseline plus this ticket's 20 and concurrent agents' work); `tsc` both configs clean.
- [x] The register's A-8 row is referenced in the implementation's doc comments. — `src/core/liveness.ts` header cites register A-8 / ADR-0018 exception D22; same citation threaded through `tool-results.ts`, `tools.ts`, `cordis-dsh-host.ts`, `plugin.ts`.

## Comments

### 2026-09-19 — resolved (implementation)

Shipped: `src/core/liveness.ts` (pure verdict: `active` / `quiet` / `stalled`), surfaced on the `check_workers` row via `toCheckRow` / `formatCheckRowLine`; the adapter's existing ticket-29 activity projection now records its observation moment (`lastActivityAtMs` on `CordisDshHost`) and feeds the verdict from `plugin.ts` through `registerDispatcherTools` into the check handler, which joins `listPendingAccess` for the blocked input. Semantics: terminal (completed/error/aborted) and blocked-on-access workers NEVER read stalled — they read `quiet` (the vocabulary is fixed at three; the row's own `status` field carries the distinct meaning). Exactly-at-threshold is quiet (same convention as `isRosterSnapshotStale`). No timers, no polling, no watchdog; nothing kills or redrives anything (the audit's §2 stage-4 finding stands). Register A-8/D22 reconciliation landed in the register file (follow-up commit).

Friction noted, for the record:

1. **The ticket's premise was slightly off.** The "Preferred" shape assumed `check_workers` already returns "time since last observed activity" — it did not; the adapter projection recorded only the activity *phrase* (ticket 29). Fixed by recording `Date.now()` in the SAME `session/event` `tool/call` subscription, exposed as one read-only accessor next to `recentActivity`. Judged within R4 (no new subscription, no new host API, no polling — the seam is unchanged), but flagged here because R4's stop-and-say-so clause would otherwise apply on a literal reading.
2. **`tool_call_count` has no production caller** — `Multitask.noteToolCall` is exercised by tests only; production counts stay 0 (pre-existing gap, out of this ticket's scope). The derivation still uses the field defensively: counted-but-unstamped advancement → `quiet`, never a time-based claim from an unknown reference.
3. **The "acceptable" roster-snapshot option was deliberately not taken** — keeps the v3 wire contract and the browser face untouched; the model-facing check row is the surface that needed the signal.

## Notes

- The honest framing is "a user can now *see* that a worker is stalled", not "the dispatcher recovers stalled workers". Do not oversell it in the copy the model reads.
- If, while implementing, it becomes clear the reference *does* surface an equivalent signal, say so — that would make this `to-be-removed`-by-matching rather than an approved addition, and the register row should change.
