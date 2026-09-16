# 18 — Worker deny-list omits the five dispatcher tools

**Blocked by:** None — can start immediately.
**Status:** open

## Problem

`WORKER_DENIED_TOOL_CANDIDATES` (`src/worker/tool-barrier.ts:14-30`) denies user/peer/spawn/job/todo tools but not the five dispatcher tool names. `registerDispatcherTools` registers `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` / `deliver_result` on the process-global registry (`src/adapter/dispatcher-tools.ts:120`), and worker spawns intersect the deny-list against live global names (`src/adapter/cordis-dsh-host.ts:349-364`) — so spawned workers plausibly see all five dispatcher tools in their tool surface. That violates the ticket-10 tool barrier: workers are blank-context executors with no dispatcher authority.

## What to do

- Add the five dispatcher tool names to `WORKER_DENIED_TOOL_CANDIDATES`.
- Add an offline `node:test` proving a spawned worker's resolved tool filter cannot resolve any dispatcher tool name (FakeDshHost).

## Constraints

- Offline tests only: no network, no LLM, no running dsh (S8).
- Clean-room: new copy only; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.

Found during ticket 16 phase 1 (`.scratch/multitask-dispatcher/research-16-hijack.md` §1.5).
