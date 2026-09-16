# 26 — Test hygiene: parked 120 s default timers + unbound-parent deny delivery

**Blocked by:** None — can start immediately.
**Status:** open

## Problem

Pre-existing hygiene flagged in ticket 23's closing comment, out of scope there:

- `test/access-relay.test.ts` T1 (:104), T7 (:247), T14 (:439) park tickets via
  `createMultitask(host)` with the real `DEFAULT_ACCESS_TIMEOUT_MS` (120 s,
  `src/core/access-relay.ts:19`) and never resolve — armed timers keep the
  suite process alive; whole-run `duration_ms ≈ 120190`.
- Timeout deny after the parent unbinds: `finish()` fires
  `void deliverDecision(...)` (`src/core/access-relay.ts:220`, also :245);
  `deliver` is `host.sendMessage` (`src/core/multitask.ts:244`), which throws
  when no parent is bound (`src/adapter/cordis-dsh-host.ts:448`) — the rejected
  promise is discarded by `void` → potential unhandled rejection in the real host.

## What to do

- [x] Test-file-only timer hygiene in T1/T7/T14 (short/manual timeouts, arming
  asserted without waiting); suite well under ~30 s, same pass count.
- [x] Diagnose the deny-delivery throw path: minimal core/adapter fix with an
  offline regression test, or document benign with file:line reasoning here.

## Constraints

- Offline tests (S8). No core behavior changes beyond the item-2 bug fix.
- Clean-room: never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.

## Comments

### 2026-09-17 — agent team

Both items closed. Commits `49505c8` (file), `9a8d6b4` (fix: `src/core/access-relay.ts` + `test/access-relay.test.ts` only).

**Item 1 (timers):** T1/T7/T14 now use the manual scheduler with
`timeoutMs: 50` — no real timer survives a test. Added one arming test:
`createMultitask` without `timeoutMs` schedules `DEFAULT_ACCESS_TIMEOUT_MS`
(asserted, never waited). `src/core/access-relay.ts` untouched by this item.

**Item 2 (deny delivery): real crash path, fixed minimally.** Chain: timeout
deny fires → `finish()` does `void deliverDecision(...)`; `deliver` is
`host.sendMessage` (`multitask.ts:244`), which throws when the parent is
unbound (`cordis-dsh-host.ts:448`) — the rejected promise was discarded by
`void` → `unhandledRejection` (Node default crashes the host). Same pattern
in the `noteRequest` policy auto-answer path. Reproduced offline first
(test-before-fix): regression test with a throwing `sendMessage` +
`process.on("unhandledRejection")` listener failed red with exactly that
error. Fix: `deliverDecision` now swallows delivery errors — delivery is
best-effort, the decision is already recorded, and deny notices still reach
the user via `onResolved` → wake bus; covers both call sites, all other
behavior unchanged.

**Gates:** typecheck clean (both configs); `npm test` 512 → **514 passing,
0 failing**; duration **≈ 120.2 s → ≈ 1.2 s** whole suite (access-relay file
alone: 120237 ms → 248 ms). Tests remain fully offline (S8).

