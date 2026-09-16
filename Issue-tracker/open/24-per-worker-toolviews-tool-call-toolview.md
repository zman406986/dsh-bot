# 24 — Per-worker detail: tool.call.toolview entries for the dispatcher tools

**Blocked by:** 20 (client-face scaffold).
**Status:** open

## Problem

The five dispatcher tools render as dsh's generic tool rows. Design 16 (§4.2, §2) specs keyed `tool.call.toolview` entries so `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` calls render as readable per-worker detail. Unclaimed wire-tool keys fall back to the generic row, so claiming ours is additive-safe (research Finding 5, contract note "an unclaimed key falls back to the generic tool row"; worked example: `dsh-client-ui-cordis`).

## What to do

- [x] Client: register keyed `tool.call.toolview` entries for the wire tool names `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker` (and `deliver_result` if it benefits) via `ctx.slots.inject(<owner>, () => ctx.slots.register({name: "tool.call.toolview", key: <wire name>}, Comp))` — keys are exactly the core tool names from `src/core/policy/prompts.ts`, nothing invented.
- [x] Each view parses that tool's args/result shapes from `src/core/tools.ts` (worker id, title, status rows, steer text, stop reason) and renders compact detail: worker id + title + outcome; status rows reuse the core FSM vocabulary labels. No new data fetches — render only what the tool call already carries.
- [x] Never claim a key the shipped composition already covers (shadowing election) — the five names are plugin-owned since ticket 11; verify at integration that shipped UI has not added views for them (re-verify against the 0.1.5-rc.1 catalog, version drift risk, research Finding 5).
- [x] Pure-logic tests under `node --test`: arg/result-shape parsing (including malformed/partial results — render a degraded row, never throw), label mapping, locale dictionary shape. Component rendering: build success + typecheck only (S8).

## Constraints

- Offline tests only (S8); no network, no LLM, no running dsh.
- Views are read-only presentation; they expose no actions and never bypass the parent-agent authority path (design §3.4).
- Clean-room: all view copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.

## Comments

- **2026-09-17 (agent team) — implemented.** Commit `200dbfc` "Add per-tool views for dispatcher tools (ticket 24)"; ticket-file commit follows.
  - **All five toolviews shipped** (`deliver_result` included — its row shows the delivered/todo outcome at a glance on wake turns): `src/client/toolviews.ts` (shipped-slot name `tool.call.toolview`, keyed registrations built from the core wire-name constants, pure defensive payload→view-model parsers), `src/client/toolview-panel.tsx` (zero-hook props-driven component factory; degraded copy / field rows / check status rows), wired in `src/client/index.ts` via one `slots.inject("tool.call.toolview", …)` registering five entries (HMR-safe: single inject controller, fiber teardown disposes all). `src/client/context.ts` widened to accept keyed-entry options; locale dictionary in `src/client/overlay.ts` gains 9 toolview keys (en+zh, clean-room original).
  - **Additive-safe claim verified against the pinned research catalog** (Finding 5, 0.1.5-rc.1): shipped toolview keys are `cordis_define`/`cordis_run` only; our five keys are disjoint (test fixture `SHIPPED_CLAIMED_TOOLVIEW_KEYS`). Keys derive from `DISPATCHER_TOOL_NAMES` — nothing invented.
  - **Verbatim vocabulary:** check-row status labels use the core FSM words as-is (identity contract, same as the roster panel); outcomes render `ok` or the payload's failure reason verbatim; booleans render `true`/`false`; long steer text collapses to one line clamped at 160 chars.
  - **Tests:** suite 415 → **501 passing, 0 fail** (+86: new `test/client-toolviews.test.ts` — per-tool payload parsing from realistic `src/core/tools.ts` shapes, malformed/partial payloads degrade without throwing across all five tools, foreign-tool/key-conflict semantics, HMR reversal; `test/client-face-scaffold.test.ts` + `test/client-roster-panel.test.ts` updated for the second inject). `npm run typecheck` clean on both configs; client esbuild contract test still green.
  - **Deferred gaps:** (1) the renderer's exact toolview prop face is unverified against a live dsh host — parsers accept `{args, result}` and degrade on any deviation; re-verify at integration per design-16 §8 version-drift risk. (2) Views render compact detail only (no elapsed/activity/attachment paths) per the ticket's compactness rule. (3) Component rendering remains build+typecheck-only (S8, no DOM harness).
