# 18 — Worker deny-list omits the five dispatcher tools

**Blocked by:** None — can start immediately.
**Status:** resolved

## Problem

`WORKER_DENIED_TOOL_CANDIDATES` (`src/worker/tool-barrier.ts:14-30`) denies user/peer/spawn/job/todo tools but not the five dispatcher tool names. `registerDispatcherTools` registers `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` / `deliver_result` on the process-global registry (`src/adapter/dispatcher-tools.ts:120`), and worker spawns intersect the deny-list against live global names (`src/adapter/cordis-dsh-host.ts:349-364`) — so spawned workers plausibly see all five dispatcher tools in their tool surface. That violates the ticket-10 tool barrier: workers are blank-context executors with no dispatcher authority.

## What to do

- [x] Add the five dispatcher tool names to `WORKER_DENIED_TOOL_CANDIDATES`.
- [x] Add an offline `node:test` proving a spawned worker's resolved tool filter cannot resolve any dispatcher tool name (FakeDshHost).

## Constraints

- Offline tests only: no network, no LLM, no running dsh (S8).
- Clean-room: new copy only; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.

Found during ticket 16 phase 1 (`.scratch/multitask-dispatcher/research-16-hijack.md` §1.5).

## Comments

- 2026-09-17 (agent team): Implemented — dispatcher tool names added to worker deny-list (src/worker/tool-barrier.ts:31-36); offline test test/worker-agent-type.test.ts proves workers cannot resolve them. typecheck clean; 302 tests passing. Commit 6477ed7.
- Moved to resolved by overnight sweep 2026-09-18: all ACs checked; verified via implementing commits and artifact spot-check on main.
