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

- [ ] Test-file-only timer hygiene in T1/T7/T14 (short/manual timeouts, arming
  asserted without waiting); suite well under ~30 s, same pass count.
- [ ] Diagnose the deny-delivery throw path: minimal core/adapter fix with an
  offline regression test, or document benign with file:line reasoning here.

## Constraints

- Offline tests (S8). No core behavior changes beyond the item-2 bug fix.
- Clean-room: never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
