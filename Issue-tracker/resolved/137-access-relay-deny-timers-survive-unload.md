# 137 — Access-relay deny timers survive plugin unload and wake a disposed core

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing
**Related:** 112 (wake-bus disposal wiring — the precedent this ticket extends), 108 (coalescing window), 23 (prompt pump / parked asks), ADR-0008 (deny-by-default on timeout), ADR-0019 (per-session asks)

## Problem

`createAccessRelay` arms one `setTimeout` per parked ask — the deny-on-timeout timer (`src/core/access-relay.ts:324-332`, armed inside `noteRequest`). The only cancellation paths were `finish()` (resolve and the timer's own callback, `:264-288`) and `clear(workerId)` (`:349-355`). There was no path that cancels every parked ticket at once.

Plugin teardown (`src/plugin.ts:1356-1374`) resets the prompt pumps (`:1365-1367`) and disposes the wake bus (`multitask.dispose()`, `:1371`), but never cleared parked relay tickets. `Multitask.dispose()` (`src/core/multitask.ts:1453-1458`) reached only `wakeBus.dispose()` — its own comment claimed "nothing else here owns a timer", which was accurate for the core but not for the relay it constructs at `src/core/multitask.ts:585`.

So after unload/HMR:

1. Each parked ask's timer stayed armed and later fired.
2. Its callback called `finish(...)`, which found the ticket still in `byWorker` and ran the deny path: `deliverDecision` (a `host.sendMessage` on a disposed host) plus `options.onResolved(...)`.
3. `onResolved` (`src/core/multitask.ts:608-616`) called `notifyRosterChanged` and `wakeBus.enqueueAccessNotice(...)`. The relay calls it from OUTSIDE the bus, so the ticket-108/112 generation bump did not cover the arrival: the enqueue re-armed a coalescing window on a bus that had just been disposed (and, if the core object is reused across an HMR re-apply, delivered a stale notice into a live-ish bus).

Delivery errors are swallowed by `deliverDecision` (`:248-262`), so the failure was silent: no crash, just a timer firing after teardown, a send attempt into a disposed host, and a wake enqueued on a disposed core.

## What to do

- [x] Add a dispose/clear-all path on the access relay that cancels every parked deny timer AND marks the relay closed, so later `resolve`/`clear`/`noteRequest` calls are no-ops (never arm a new timer, never call `onResolved`/`deliver`).
- [x] Call it from plugin teardown, with the order recorded below.
- [x] Offline tests prove (a) a parked ask's timer never fires after disposal and `onResolved`/`deliver` are never called, (b) a control arm with no disposal shows the timer DOES fire, (c) the plugin-level case: teardown with a parked ask enqueues no wake and delivers no message.

## Order note (for the implementer)

`pump.reset()` aborts outstanding prompt requests; the pump's `askOne` catch path can call `options.requeueConversational(...)`, which enqueues an access request on the wake bus. The relay's timer can also resolve through the pump's `notifyExpired`. Since relay disposal only cancels relay timers (it resolves nothing), the chosen order is:

1. `lifecycle.unbind()` (deactivates each session, resets its pump — this is where an in-flight pump answer could land),
2. `multitask.clearSessionAccessPolicy()`,
3. pump reset sweep (unchanged),
4. **relay dispose**, as the first half of `multitask.dispose()` (clears all parked timers, closes the relay),
5. wake-bus dispose, as the second half of the same call,
6. `host.dispose()`, `markers.dispose()`.

The key constraint: relay disposal precedes bus disposal, so no `onResolved` can reach the bus after it is disarmed; and it comes after the unbind/pump sweep, so a pump answer already in flight during the unbind has landed (or been dropped) before tickets disappear. Closing the relay also makes an in-flight `resolveAccess` from a pump that lands after step 4 a no-op instead of a delivery into a dying host.

## Constraints

- No behavior change while the plugin is live: the relay behaves exactly as before until dispose is called.
- Idempotent dispose (repeated teardown safe), same shape as `Multitask.dispose()` / `wakeBus.dispose()`.
- The `src/core/multitask.ts` edit is confined to the `dispose()` body and its doc comment; the `AccessRelay` interface and implementation carry the rest.
- Offline only: manual scheduler, no real timers, no network.

## Comments

### 2026-10-22 — filing

Filed while implementing ticket 112. 112's teardown wiring proved the wake bus is disarmed, but the relay's own timers were never in its scope: `Multitask.dispose()`'s comment ("nothing else here owns a timer") was accurate for the core, not for the relay it constructs at `src/core/multitask.ts:585`. Severity is low (delivery failures are swallowed) but the leak is real and the fix is small.

## Resolution — 2026-10-22

All three checkboxes done.

- `src/core/access-relay.ts`: `AccessRelay.dispose()` added. It sets a `closed` flag, cancels every parked ticket's deny timer, and clears the map. The flag is also read by `finish()` and `noteRequest()`, so a scheduler that ignores its cancel (the stale-callback case the wake bus already guards against) still cannot deliver or enqueue a notice, and a late host event cannot park a new ask. Idempotent — a second call finds an empty map and re-sets the flag.
- `src/core/multitask.ts`: `Multitask.dispose()` now calls `accessRelay.dispose()` before `wakeBus.dispose()`. Relay first because its `onResolved` enqueues onto the bus from outside the bus's generation guard; bus second. The interface's dispose doc was updated to say so (the old "nothing else here owns a timer" claim is now false and removed).
- `src/plugin.ts`: teardown order is `lifecycle.unbind()` → policy clear → pump reset sweep → `multitask.dispose()` (relay then bus) → `host.dispose()` → `markers.dispose()`. The pump sweep deliberately runs before relay disposal: an answer already in flight from a prompt resolves (or is dropped as expired) while the relay is still open, and anything landing after that point is a no-op instead of a delivery into a dying host. The stale ticket-23 comment ("the relay timeouts still deny their asks") was corrected.
- Tests — 7 new cases, all green:
  - `test/access-relay.test.ts`, suite "access relay — dispose (ticket 137)" (4): control (no dispose → timer denies and notifies); dispose cancels every parked timer and no callback delivers or notifies even when the scheduler fires the stale callbacks; after dispose `resolve`/`clear`/`noteRequest` are no-ops and arm nothing; dispose is idempotent and safe with nothing parked.
  - `test/access-relay.test.ts`, suite "access relay — core teardown cancels parked asks (ticket 137)" (3): control (no dispose → one sendMessage and one wake); `multitask.dispose()` → timer cancelled, no sendMessage, no wake, nothing enqueued; dispose idempotent with a later `resolveAccess` returning false and delivering nothing.
  - `test/plugin-scaffold.test.ts` (1): "plugin teardown cancels a parked access deny timer (ticket 137)" — real `apply()`, a spawned worker, a real `request_access` park under a 50 ms configured timeout, mock timers. Control arm (no teardown) delivers one deny and wakes once; teardown arm delivers nothing and wakes nothing. Verified as a real detector by temporarily removing `accessRelay.dispose()` from `Multitask.dispose()` — the case fails.
- Test runs: `test/access-relay.test.ts` 40/40, `test/plugin-scaffold.test.ts` 17/17, `test/wake-bus-disposal.test.ts` (canary) 3/3 — 60/60 in one run. Neighbouring access suites `test/access-prompt.test.ts` + `test/worker-ask-park.test.ts` 63/63.
- No behavior change for a live plugin: nothing calls the new dispose until teardown, and the `closed` flag starts false.
