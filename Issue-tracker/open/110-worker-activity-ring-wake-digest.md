# 110 — Bounded worker-activity ring + inline wake digest

**Status:** open
**Labels:** ready-for-agent
**Related:** D21 (report clamps), U-F (inline clamping, no storage spill), 75 (firehose observation)

## Problem

The adapter firehose keeps only the LATEST activity phrase per worker (single-entry `workerActivity`, `src/adapter/cordis-dsh-host.ts:451` and `:511-514`), so `composeWakeText` (`src/plugin.ts:158-224`) can show one phrase at most; multi-step worker runs lose their breadcrumb at wake time.

## What to do

- [ ] Adapter: replace the single-entry per-worker activity with a bounded in-memory ring (last 5 phrases per worker, oldest evicted).
- [ ] `src/plugin.ts`: `composeWakeText` appends a short "Recent worker activity" digest section — inline text, per-worker latest-first, passed through `src/core/report-clamp.ts` clamps — only for workers referenced by the wake's settle notices.
- [ ] No storage writes, no prompt-side references to stored outputs (U-F compliant: clamping inline only); all digest info lives in the wake turn itself (D21 premise intact: the wake notice remains self-contained).

## Constraints

- Adapter-only memory; nothing persisted; no host-seam changes.
- Tests cover ring bounds, eviction order, digest presence/absence, clamping.

## Comments

### 2026-10-02 — filing

Filed from the 2026-10-02 upstream-compare paperwork pass: the single-entry activity slot was observed while tracing wake composition for ticket 108's idle-batching study — the same wake turns that batch poorly also under-report what multi-step workers did. Bounded ring + inline digest keeps the D21 self-contained-notice premise while restoring the breadcrumb.
