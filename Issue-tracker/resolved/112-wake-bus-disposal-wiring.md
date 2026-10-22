# 112 — Wire wake-bus disposal into plugin teardown (plus dead-field cleanup)

**Status:** resolved
**Labels:** ready-for-agent
**Related:** 108 (coalescing window); verifier report `.scratch/testing/2026-10-02-grokbot-upstream-compare/verification-report.md`

## Problem

Ticket 108 added `dispose()` to the core wake bus (generation bump + timer cancellation, test-proven — `src/core/wake-bus.ts:756-764`), but nothing in the shipped wiring calls it: the Multitask service creates the bus internally (`src/core/multitask.ts:363`) and exposes no dispose path, and plugin teardown (`src/plugin.ts:883-903`) disposes the host + durable markers only. Low severity today: a post-teardown timer fire reaches `requestDispatcherWakeup` → `ctx.agents.get` → `undefined` → logged no-op that never throws (`src/adapter/cordis-dsh-host.ts:837-845`) — but the guard exists precisely so teardown can be airtight, and the current wiring never arms it.

## What to do

- [x] Expose a dispose path on Multitask (or accept the bus handle at construction) that reaches `createWakeBus`'s `dispose`.
- [x] Call it in plugin teardown alongside host/marker disposal under the Cordis generator-effect contract (ticket-44 shape: cleanup RETURNED from `execute`).
- [x] Test: dispose during an armed coalescing window → stale timer no-ops, no wake after teardown.
- [x] While in `src/core/wake-bus.ts`: remove the dead `coalescing.dueAtMs` field (stored, never read — verifier note N3), or wire it into a test assertion if it earns its keep.

## Constraints

- No behavior change when the window is 0.
- Existing 1246-test suite stays green.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 independent verification of tickets 108/109/110 (verifier note N2 = this wiring gap, N3 = the dead field, folded here). Disposal plumbing only — no behavior change at the default, so no human gate required.

## Resolution — 2026-10-22

All four checkboxes done.

- `src/core/multitask.ts`: `Multitask.dispose()` added to the interface and implemented — it calls `wakeBus.dispose()`. Idempotent (the bus's generation bump makes a repeat a no-op); nothing else in the core owns a timer, so it does nothing more.
- `src/plugin.ts`: the returned teardown cleanup calls `multitask.dispose()` after the prompt-pump sweep and BEFORE `host.dispose()`, so an armed window can never open a turn on a host that is going away. The function is still RETURNED from `ctx.effect` (ticket-44 shape, unchanged).
- `src/core/wake-bus.ts`: the dead `coalescing.dueAtMs` field is gone and the `coalescing` record now holds only its cancel handle. `WakeBusOptions.now` and `MultitaskWakeOptions.now` became dead with it (their only reader computed that field), so both were removed and the two test call sites that passed `now` dropped it. No production caller ever passed it.
- Tests: `test/wake-bus-disposal.test.ts` (new, 3 cases — armed window cancelled on dispose, repeated dispose idempotent, and dispose invalidating timers only so a queued settle survives) plus one plugin-level case in `test/plugin-scaffold.test.ts` that arms a real coalescing window through the shipped `apply()`, runs the collected teardown cleanups, advances mock timers, and asserts no `followup` reached the agent. That case has a control arm (same setup, no teardown) that does wake — so it fails if the wiring is removed (verified by temporarily reverting `multitask.dispose()`).

Constraints held: window 0 unchanged (the dispose call arms nothing and cancels nothing when no timer exists); touched files plus the neighbouring bus/core suites are green.
