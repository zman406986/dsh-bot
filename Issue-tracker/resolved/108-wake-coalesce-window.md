# 108 — Opt-in wake coalescing window (idle-window batching)

**Status:** resolved
**Labels:** ready-for-agent
**Related:** 06 (settled pile-up batching), PRD §14, `docs/research/upstream-wake-scheduler-study`; source: `.scratch/testing/2026-10-02-grokbot-upstream-compare/comparison.md` §5.1

## Problem

`src/core/wake-bus.ts` batches only while the dispatcher is mid-turn (busy-hold + user preemption + flush on turn end, ticket 06). Rapid successive settles while the dispatcher is IDLE each fire their own `requestDispatcherWakeup` → back-to-back wake turns (adapter path `src/adapter/cordis-dsh-host.ts:727-745`, `composeWakeText` `src/plugin.ts:158-224`).

## What to do

- [x] Add optional coalescing to the core wake bus behind a `wakeCoalesceWindowMs` option (default 0 = exactly current behavior; the existing suite must stay green untouched).
- [x] When >0: worker-settled/peer/external enqueues schedule a single drain at now+window instead of an immediate wakeup; enqueues landing inside the window join the pending drain (window coalescing).
- [x] User-source wakes flush the pending window immediately (same preemption discipline as ticket 06).
- [x] Timers are generation-checked: a generation counter incremented on dispose/rebuild invalidates stale timers — a stale timer must never fire.
- [x] Fail budget: after N consecutive `requestDispatcherWakeup` failures (default 3) fall back to immediate mode and surface an honest error — wakes are never silently dropped (delivery redrive remains the backstop).
- [x] Injectable clock/scheduler following the existing repo idiom (`src/core/access-relay.ts:139-148` injectable clock; manual-scheduler test pattern in the access-relay tests).

## Constraints

- `drainWake` reconciliation semantics unchanged; D21 report clamps unchanged.
- Opt-in only — no behavior change at the default.
- Offline FakeDshHost tests with fake clock only (S8 lane).

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass (comparison §5.1): the upstream scheduler study motivated an idle-side batching window beyond ticket 06's mid-turn busy-hold. Agent-implementable as specified (opt-in, default-off, offline-only pins); no human gate required.

## Resolution — 2026-10-22

Implemented at commit `409e989` ("Ticket 108: RESOLVED — opt-in wake-bus coalescing window ..."), already on `main`.

Code spot-check:
- `src/core/wake-bus.ts` `WakeBusOptions.coalesceWindowMs` (default `0` at `:351`), `coalesceFailBudget` with `DEFAULT_COALESCE_FAIL_BUDGET = 3` (`:298`), injectable `now`/`schedule` (`:352-353`), `generation` counter bumped on dispose with a stale-timer no-op guard, `scheduleCoalescedDrain`/`cancelCoalescedDrain`/`coalesceOrFlush`, and the `degraded` fallback to immediate mode via `onDegraded`.
- Wired through `src/core/multitask.ts:527-528` and `src/plugin.ts:90`, `:650-651` (`wakeCoalesceWindowMs`, default 0).
- `drainWake` reconciliation untouched; default path byte-identical.

Verification today: re-ran `test/wake-bus-coalesce.test.ts` — 8 tests, 8 pass, 0 fail (grouped run with tickets 109/110: 30 pass, 0 fail).

Bookkeeping: `**Status:**` → `resolved`; moved `Issue-tracker/open/108-wake-coalesce-window.md` → `Issue-tracker/resolved/`. No commit (lead commits).
