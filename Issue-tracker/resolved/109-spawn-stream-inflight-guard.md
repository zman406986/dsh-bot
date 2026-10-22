# 109 — Per-stream in-flight guard closing the spawn check-then-set window

**Status:** resolved
**Labels:** ready-for-agent
**Related:** 05 (stream_key uniqueness), ADR-0019 (uniqueness domain `(parentSessionId, streamKey)`)

## Problem

`src/core/multitask.ts` `spawnWorker` performs stream-key uniqueness as check-then-set (`src/core/multitask.ts:553` check, registration completes later toward `:601`). Two concurrent `spawnWorker` calls with the same `(parentSessionId, streamKey)` can both pass the check before either registers, violating the settled uniqueness ruling.

## What to do

- [x] Reserve the stream key synchronously at first check (in-flight `Map` insert); release in a `finally` path (or on terminal transition).
- [x] Duplicate reservation → refuse with the existing duplicate-stream-key error, unchanged semantics otherwise.

This enforces ticket 05 / ADR-0019. **NO lock ladder** — the broader applicability verdict is recorded in `docs/research/exclusive-lock-ladder-applicability.md` (companion note filed this session).

## Constraints

- No new public API; no change to error names/shape.
- Concurrency test proves exactly-one-of-two concurrent spawns succeeds.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass: the check-then-set window was identified while auditing spawn uniqueness against ticket 05's settled ruling and ADR-0019's keying domain. The fix is a local in-flight reservation, not a general locking mechanism — the lock-ladder question is answered by the companion research note, not by this ticket.

## Resolution — 2026-10-22

Implemented at commit `9af67e0` ("Ticket 109: RESOLVED — spawn in-flight reservation on the stream key ..."), already on `main`.

Code spot-check:
- `src/core/multitask.ts:505` declares `inFlightStreamKeys`; `:873-880` reserves synchronously (before any `await`) and refuses with the existing `duplicate-stream-key` shape; `:1031` releases in the `finally` covering success, hold refusal, and host error.
- Reservation keyed by `(parentSessionId, streamKey)` per ADR-0019 (sibling sessions never collide).

Verification today: re-ran `test/spawn-inflight-guard.test.ts` — 5 tests, 5 pass, 0 fail (grouped run with tickets 108/110: 30 pass, 0 fail).

Bookkeeping: `**Status:**` → `resolved`; moved `Issue-tracker/open/109-spawn-stream-inflight-guard.md` → `Issue-tracker/resolved/`. No commit (lead commits).
