# Upstream WakeScheduler: mechanism map and ticket-108 adaptation

**Question:** what does the upstream WakeScheduler (`nescafe2009/dsh-grokbot`, MIT; `src/dispatch.mjs` in the local shallow clone) actually do, and which parts of it were adapted into ticket 108's implementation in `src/core/wake-bus.ts`?

**Status:** decision input only — this note documents mechanisms and their adaptation; it does not decide which document wins when documents conflict, and it is not a ruling.

---

## Scope note

The upstream clone and the 2026-10-02 analysis papers live in a git-ignored scratch folder (`.scratch/testing/2026-10-02-grokbot-upstream-compare/`; prior analysis: `upstream-findings.md` §3 and §10, `comparison.md` §5.1), so the facts this note depends on are restated here against the current source: `upstream-clone/src/dispatch.mjs` exports a per-key wake-coalescing state machine (class `WakeScheduler`, `upstream-clone/src/dispatch.mjs:57-183`) whose stated contract is "merge-and-defer without dropping events": a request outside the rate-limit window fires immediately, a request inside the window is held pending and consumed by exactly one window-end timer (`upstream-clone/src/dispatch.mjs:49-55`). Ticket 108 (`Issue-tracker/open/108-wake-coalesce-window.md:13-18`) asked for an opt-in idle-side variant of this shape, now implemented behind the `coalesceWindowMs` option (`src/core/wake-bus.ts:227`, default 0 at `src/core/wake-bus.ts:295`). Mechanism by mechanism:

## 1. Window coalescing

**Upstream.** `request(key)` fires immediately only when the key is not in transit and the rate-limit window has elapsed since `lastFiredAt`; otherwise it marks the event pending and arms one window-end timer (`upstream-clone/src/dispatch.mjs:107-123`, arm at `:69-85`). The timer waits only the *remaining* interval — `intervalMs - (now - lastFiredAt)` — so the cadence is measured from the last fire, not from the request (`upstream-clone/src/dispatch.mjs:72`). A new fire while a turn is in transit also just parks subsequent requests as pending (`upstream-clone/src/dispatch.mjs:118-119`).

**Ours.** The window applies while the session is idle and before delivery, rather than after a fire: an idle background/peer enqueue either joins an already-armed per-session drain or arms one — at most one timer per session, never duplicated (`src/core/wake-bus.ts:346-364`, join guard `:350`; single-slot state field `:193-197`). The window applies only when the session is idle with nothing ready (`src/core/wake-bus.ts:558-564` and the sibling access/peer paths at `:588-590`, `:604-606`, `:665-669`); mid-turn delivery stays owned by the ticket-06 turn-end flush, and a window timer is cancelled outright when a turn starts (`src/core/wake-bus.ts:730-736`). Because the default window is 0, `coalescingActive()` is false and every enqueue keeps pre-108 immediate semantics (`src/core/wake-bus.ts:337-339`, `:399-405`). The upstream post-fire rate limit (rate-limiting *after* a turn) was deliberately not carried over — our existing hold while busy already covers the mid-turn side, so 108 only adds batching for the idle gap between enqueues.

## 2. Pending preservation

**Upstream.** Pending events are never dropped: whoever reaches the window end first — the timer callback or the consumer's `onFired` completion — consumes the same pending flag through one idempotent path (`upstream-clone/src/dispatch.mjs:79-83`, `:125-131`); even a failed attempt re-asserts pending so unacknowledged work survives (`upstream-clone/src/dispatch.mjs:171`).

**Ours.** Enqueues landing inside an armed window join the pending batch lists, and the drain at window end runs the normal flush (`src/core/wake-bus.ts:359-361`, flush at `:454-488`). Two extra preservation layers upstream does not need: the ready batch is marked *before* the host is notified (`src/core/wake-bus.ts:421-432`), so a throwing `onDeliver` never drops the wake — the host just was not told; and a user wake arriving mid-window flushes the pending batch immediately, then reclaims it behind the user wake (`src/core/wake-bus.ts:672-695`), preserving the non-user work while user precedence wins.

## 3. Generation-checked timers

**Upstream.** Each key carries a `timerGen` counter bumped on every arm and on every cancel; a firing callback compares its captured generation against the live one and no-ops when stale, so a cancelled-or-rearmed timer can never double-consume (`upstream-clone/src/dispatch.mjs:73`, `:77`, `:93`). Cancellation is two-layered: the host handle is cancelled *and* the generation is bumped, covering hosts whose cancel is best-effort (`upstream-clone/src/dispatch.mjs:88-94`).

**Ours.** The same two-layer idea, but one bus-level generation instead of per-key counters: `scheduleCoalescedDrain` captures `generation` at arm time and a timer whose captured value is stale no-ops (`src/core/wake-bus.ts:351`, `:354-355`); `dispose()` bumps the generation *first*, then cancels every armed window, so a stale timer is inert even if the injected scheduler ignores the cancel (`src/core/wake-bus.ts:756-764`). The coarser counter is sufficient here because the callback additionally re-checks that the session still holds its own `coalescing` slot (`src/core/wake-bus.ts:356-358`), and within one generation at most one timer per session exists by construction.

## 4. Fail budget

**Upstream.** `failAttempt` decrements a per-key cross-callback budget; at exhaustion it cancels the window timer and stops scheduling retries — but keeps the pending events, to be pushed later by a *new* incoming request (which also resets the budget, since a new event is a new recovery opportunity) (`upstream-clone/src/dispatch.mjs:166-182`, budget reset at `:111`). The window timer is the only scheduling source; the caller never arms its own backoff (`upstream-clone/src/dispatch.mjs:164`, `:178-179`).

**Ours.** The budget became a switch to immediate delivery, not a retry limiter: consecutive coalesced drains whose `onDeliver` throws increment a counter, and at `coalesceFailBudget` (default 3, `src/core/wake-bus.ts:243`, `:248`) the bus flips `degraded`, after which every drain bypasses the window and behaves exactly like window 0 (`src/core/wake-bus.ts:381-396`, switch check at `:337-339`). One flip fires `onDegraded` once with the failure count and last error, which reports the real error ticket 108 requires (`src/core/wake-bus.ts:244`, `:390-393`). Combined with ready-before-notify and the delivery-redrive fallback (`src/core/wake-bus.ts:697-728`), wakes are never silently dropped — the failure mode degrades latency, not delivery.

## 5. Injected virtual clock

**Upstream.** All time reads go through a constructor-injected `now()` and all timer arming/cancellation through injected `delay`/`cancelDelay`, explicitly so a virtual clock can drive tests (`upstream-clone/src/dispatch.mjs:58`, `:62-63`, contract note at `:55`).

**Ours.** The same shape, following the pattern the repo already uses — the access relay already injects `now` and a `schedule`/cancel-function pair for exactly this reason (`src/core/access-relay.ts:139-148`) — and the wake bus copies it: `now?: () => number` and `schedule?: (fn, ms) => () => void` on the options interface (`src/core/wake-bus.ts:229`, `:235`, defaults at `:296-297`, `:288-291`), keeping ticket 108's tests on the offline test suite, with a fake clock.

## Not carried over

The upstream consumer-ack lifecycle — `ack`/`beginAttempt`/`completeAttempt` handshake where the consumer confirms actual consumption and resets state (`upstream-clone/src/dispatch.mjs:134-158`) — has no counterpart in our bus: success is signaled structurally (the host drains the ready wake; turn lifecycle runs through `noteTurnStarted`/`noteTurnEnded`), and undelivered work has the redrive fallback instead of an ack callback. The per-key `drop()` (`upstream-clone/src/dispatch.mjs:96-99`) is likewise absent: our bus keys sessions that live for the process lifetime and tears them all down at once via `dispose()`.

## Summary map

| Upstream mechanism (`dispatch.mjs`) | Ticket-108 adaptation (`wake-bus.ts`) |
| --- | --- |
| post-fire rate-limit window, timer for the remaining time (`:69-85`, `:107-123`) | opt-in idle-side drain window, one per session, joins an existing timer instead of adding one (`:346-364`, `:399-405`) |
| pending flag never dropped, idempotent consume (`:79-83`, `:125-131`, `:171`) | pending batch lists + ready-before-notify + user-wake flush-and-reclaim (`:421-432`, `:672-695`) |
| per-key `timerGen` stale-timer invalidation (`:73`, `:77`, `:93`) | single bus generation + cancel-then-bump dispose (`:351-358`, `:756-764`) |
| per-key retry budget, exhausted = hold pending (`:166-182`) | bus-level consecutive-failure budget → degraded immediate + `onDegraded` (`:381-396`, `:244`) |
| injected `now`/`delay`/`cancelDelay` (`:58`, `:62-63`) | injected `now`/`schedule` following the access-relay pattern (`:229`, `:235`; `access-relay.ts:139-148`) |
| consumer ack handshake (`:134-158`) | not carried over — drain + redrive fallback instead |
