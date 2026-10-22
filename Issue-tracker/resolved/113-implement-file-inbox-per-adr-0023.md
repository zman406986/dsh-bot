# 113 — Implement file inbox per ADR-0023

**Status:** resolved
**Labels:** ready-for-agent
**Related:** ADR-0023 (accepted 2026-10-02), ticket 111 (scope amendment), ticket 06 (external-event wake source vocabulary), ticket 112 (bus disposal — shares the teardown concern)

## Problem

ADR-0023 (`docs/adr/0023-file-driven-external-intake.md`) was accepted by the human in session, 2026-10-02 — the opt-in file inbox is now committed scope. PRD §6.4 (wake model) and §7.1 (component map) were amended per ticket 111 to carry the product-level truth; the full design detail lives in the ADR.

## What to do

- [x] **Core:** give the external-event wake source a real enqueue path + flush lane (external jobs join the existing batching/coalescing; peer-priority ordering respected).
- [x] **Adapter:** inbox watcher — `fs.watch` + rescan-interval fallback per ADR-0023; queued→claimed job claiming; atomic reads.
- [x] **Config:** `inbox.enabled` / `inbox.dir` / `inbox.rescanIntervalMs` under the plugin Config + settings-card companion fields (schema↔card parity pin will enforce) + en/zh copy.
- [x] **Dispatcher delivery:** external jobs open a dispatcher wake turn presenting the job prompt as work material (D21 clamps apply); the dispatcher model decides spawning via the normal `spawn_worker` path — the inbox NEVER spawns (ADR-0003).
- [x] **Todos:** inbox-origin tagging so delivery routing is distinguishable; on worker settle + delivery complete, the plugin writes `reply.md` (non-empty = done) + `status.json` into the job dir via atomic tmp+rename.
- [x] **State:** job dedupe/checkpoint in a storageDomain table (A5 — the watched dir is the external system's store, never ours); boot rescan flows through `rebuildFromDurability` + `redriveUndelivered` (ADR-0012).
- [x] **No live dispatcher:** jobs remain queued and are re-presented on next activation (honest dormant posture, ADR-0023 decision 4).
- [x] **failed/cancelled** mapping from worker error/abort.
- [x] **Tests:** offline only — temp-dir real-fs watcher tests are fine (no dsh, no LLM); restart, no-dispatcher, malformed-job, and reply-writer coverage.

## Constraints

- No client UI (ADR-0014 untouched).
- The watched dir must never become a second store (A5).
- Do not commit — the committer lane handles that.

## Resolution — 2026-10-22

Implemented at commit `15d42a5` ("Ticket 113: RESOLVED — file-driven external intake per accepted ADR-0023 ..."), already on `main`.

Code spot-check against ADR-0023:
- `src/adapter/inbox-watcher.ts` implements the on-disk protocol: `queue.jsonl` lines, per-job `status.json` (queued → claimed → replied | failed | cancelled), non-empty `reply.md` as the done signal, claim-before-present with atomic tmp+rename writes (`claimInboxJob` `:197`, `writeInboxReply` `:208`, failure `:226`, cancel `:242`), already-claimed/finished skipping (`:160-196`), per-pass claim limit (default 50), and `fs.watch` plus `rescanIntervalMs` fallback (`:369`, `:462`, `:490`).
- Core external-event lane: `WakeBus.enqueueExternalJob` in `src/core/wake-bus.ts` (`:172`, `:773`) rides the background rank and joins ticket-108 coalescing; `Multitask.enqueueExternalJob` in `src/core/multitask.ts:1158` creates an inbox-tagged todo and never spawns (ADR-0003).
- Config: `src/plugin.ts:102` `inboxEnabled` (default `false` = off), `:112` `inboxDir` (default `""`), `:117` `inboxRescanIntervalMs` (min 1000, default 5000); en/zh copy and schema↔card parity entries in `src/client/overlay.ts:198-206`/`:374-384` and `src/client/settings-card-store.ts:248-265`. The watcher starts only when enabled and a root is set (`src/plugin.ts:1248`).
- Delivery: `INBOX_JOBS_HEADING` + `clampReport` in `composeWakeText` (`src/plugin.ts:267`, `:400-406`); reply/failed/cancelled resolution writes via the `onInboxJobResolved` hook (`:517-580`) fed from `src/core/multitask.ts:1214-1217` (delivered), `:772-778` (worker error), and the abort path (cancelled).
- State: `inbox_jobs` storageDomain table in `src/adapter/durable-marker.ts:32`, `:254`, `:277`; boot rescan `rescanInboxCheckpoints` (`src/plugin.ts:1174`) runs after `rebuildFromDurability` and `redriveUndelivered` (`:947`, `:988`); disk truth is adopted when terminal.
- No live dispatcher: `presentInboxJob` returns without presenting when `dispatcherSessionIds()[0]` is `undefined`, leaving the job claimed-but-unpresented (`src/plugin.ts:1090-1094`).

Verification today: re-ran `test/inbox-core.test.ts` (11 tests), `test/inbox-watcher.test.ts` (16), `test/inbox-end-to-end.test.ts` (9) — 36 pass, 0 fail. Coverage includes restart re-presentation, no-dispatcher dormancy, earliest-dispatcher routing, malformed queue lines, boot-rescan adoption, the off switch, and the reply writer not gated on current config.

Bookkeeping: `**Status:**` → `resolved`; moved `Issue-tracker/open/113-implement-file-inbox-per-adr-0023.md` → `Issue-tracker/resolved/`. No commit (lead commits).
