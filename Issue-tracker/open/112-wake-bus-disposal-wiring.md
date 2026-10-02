# 112 — Wire wake-bus disposal into plugin teardown (plus dead-field cleanup)

**Status:** open
**Labels:** ready-for-agent
**Related:** 108 (coalescing window); verifier report `.scratch/testing/2026-10-02-grokbot-upstream-compare/verification-report.md`

## Problem

Ticket 108 added `dispose()` to the core wake bus (generation bump + timer cancellation, test-proven — `src/core/wake-bus.ts:756-764`), but nothing in the shipped wiring calls it: the Multitask service creates the bus internally (`src/core/multitask.ts:363`) and exposes no dispose path, and plugin teardown (`src/plugin.ts:883-903`) disposes the host + durable markers only. Low severity today: a post-teardown timer fire reaches `requestDispatcherWakeup` → `ctx.agents.get` → `undefined` → logged no-op that never throws (`src/adapter/cordis-dsh-host.ts:837-845`) — but the guard exists precisely so teardown can be airtight, and the current wiring never arms it.

## What to do

- [ ] Expose a dispose path on Multitask (or accept the bus handle at construction) that reaches `createWakeBus`'s `dispose`.
- [ ] Call it in plugin teardown alongside host/marker disposal under the Cordis generator-effect contract (ticket-44 shape: cleanup RETURNED from `execute`).
- [ ] Test: dispose during an armed coalescing window → stale timer no-ops, no wake after teardown.
- [ ] While in `src/core/wake-bus.ts`: remove the dead `coalescing.dueAtMs` field (stored, never read — verifier note N3), or wire it into a test assertion if it earns its keep.

## Constraints

- No behavior change when the window is 0.
- Existing 1246-test suite stays green.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 independent verification of tickets 108/109/110 (verifier note N2 = this wiring gap, N3 = the dead field, folded here). Disposal plumbing only — no behavior change at the default, so no human gate required.
