# 113 — Implement file inbox per ADR-0023

**Status:** open
**Labels:** ready-for-agent
**Related:** ADR-0023 (accepted 2026-10-02), ticket 111 (scope amendment), ticket 06 (external-event wake source vocabulary), ticket 112 (bus disposal — shares the teardown concern)

## Problem

ADR-0023 (`docs/adr/0023-file-driven-external-intake.md`) was accepted by the human in session, 2026-10-02 — the opt-in file inbox is now committed scope. PRD §6.4 (wake model) and §7.1 (component map) were amended per ticket 111 to carry the product-level truth; the full design detail lives in the ADR.

## What to do

- [ ] **Core:** give the external-event wake source a real enqueue path + flush lane (external jobs join the existing batching/coalescing; peer-priority ordering respected).
- [ ] **Adapter:** inbox watcher — `fs.watch` + rescan-interval fallback per ADR-0023; queued→claimed job claiming; atomic reads.
- [ ] **Config:** `inbox.enabled` / `inbox.dir` / `inbox.rescanIntervalMs` under the plugin Config + settings-card companion fields (schema↔card parity pin will enforce) + en/zh copy.
- [ ] **Dispatcher delivery:** external jobs open a dispatcher wake turn presenting the job prompt as work material (D21 clamps apply); the dispatcher model decides spawning via the normal `spawn_worker` path — the inbox NEVER spawns (ADR-0003).
- [ ] **Todos:** inbox-origin tagging so delivery routing is distinguishable; on worker settle + delivery complete, the plugin writes `reply.md` (non-empty = done) + `status.json` into the job dir via atomic tmp+rename.
- [ ] **State:** job dedupe/checkpoint in a storageDomain table (A5 — the watched dir is the external system's store, never ours); boot rescan flows through `rebuildFromDurability` + `redriveUndelivered` (ADR-0012).
- [ ] **No live dispatcher:** jobs remain queued and are re-presented on next activation (honest dormant posture, ADR-0023 decision 4).
- [ ] **failed/cancelled** mapping from worker error/abort.
- [ ] **Tests:** offline only — temp-dir real-fs watcher tests are fine (no dsh, no LLM); restart, no-dispatcher, malformed-job, and reply-writer coverage.

## Constraints

- No client UI (ADR-0014 untouched).
- The watched dir must never become a second store (A5).
- Do not commit — the committer lane handles that.
