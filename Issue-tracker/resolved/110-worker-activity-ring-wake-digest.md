# 110 — Bounded worker-activity ring + inline wake digest

**Status:** resolved
**Labels:** ready-for-agent
**Related:** D21 (report clamps), U-F (inline clamping, no storage spill), 75 (firehose observation)

## Problem

The adapter firehose keeps only the LATEST activity phrase per worker (single-entry `workerActivity`, `src/adapter/cordis-dsh-host.ts:451` and `:511-514`), so `composeWakeText` (`src/plugin.ts:158-224`) can show one phrase at most; multi-step worker runs lose their breadcrumb at wake time.

## What to do

- [x] Adapter: replace the single-entry per-worker activity with a bounded in-memory ring (last 5 phrases per worker, oldest evicted).
- [x] `src/plugin.ts`: `composeWakeText` appends a short "Recent worker activity" digest section — inline text, per-worker latest-first, passed through `src/core/report-clamp.ts` clamps — only for workers referenced by the wake's settle notices.
- [x] No storage writes, no prompt-side references to stored outputs (U-F compliant: clamping inline only); all digest info lives in the wake turn itself (D21 premise intact: the wake notice remains self-contained).

## Constraints

- Adapter-only memory; nothing persisted; no host-seam changes.
- Tests cover ring bounds, eviction order, digest presence/absence, clamping.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass: the single-entry activity slot was observed while tracing wake composition for ticket 108's idle-batching study — the same wake turns that batch poorly also under-report what multi-step workers did. Bounded ring + inline digest keeps the D21 self-contained-notice premise while restoring the breadcrumb.

## Resolution — 2026-10-22

Implemented at commit `00458fe` ("Ticket 110: RESOLVED — worker rows gain a live activity ring and wakes carry a digest line ..."), already on `main`.

Code spot-check:
- `src/adapter/cordis-dsh-host.ts:594` `WORKER_ACTIVITY_RING_CAPACITY = 5`; `:612` `WorkerActivityRing` (record/evict at `:615-621`, `latest`, `recent`, `clear`/`clearAll`); instance at `:743`, fed from the firehose at `:855`, exposed at `:989`/`:1002`/`:1018`, cleared on dispose at `:1370`. Adapter-only memory, nothing persisted.
- `src/plugin.ts:264` `WAKE_ACTIVITY_DIGEST_HEADING = "## Recent worker activity"`; `:283-301` `assembleActivityDigest` clamps every phrase through `clampActivity` from `src/core/report-clamp.ts` (`:55`), newest-first, `WAKE_DIGEST_ACTIVITY_COUNT = 3` per worker, omitted entirely when empty; appended in `composeWakeText` at `:416`.

Verification today: re-ran `test/worker-activity-ring.test.ts` (11 tests) and `test/wake-activity-digest.test.ts` (6 tests) — 17 pass, 0 fail; grouped run with tickets 108/109: 30 pass, 0 fail.

Bookkeeping: `**Status:**` → `resolved`; moved `Issue-tracker/open/110-worker-activity-ring-wake-digest.md` → `Issue-tracker/resolved/`. No commit (lead commits).
