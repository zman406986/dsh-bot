# 24 — Per-worker detail: tool.call.toolview entries for the dispatcher tools

**Blocked by:** 20 (client-face scaffold).
**Status:** open

## Problem

The five dispatcher tools render as dsh's generic tool rows. Design 16 (§4.2, §2) specs keyed `tool.call.toolview` entries so `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` calls render as readable per-worker detail. Unclaimed wire-tool keys fall back to the generic row, so claiming ours is additive-safe (research Finding 5, contract note "an unclaimed key falls back to the generic tool row"; worked example: `dsh-client-ui-cordis`).

## What to do

- [ ] Client: register keyed `tool.call.toolview` entries for the wire tool names `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker` (and `deliver_result` if it benefits) via `ctx.slots.inject(<owner>, () => ctx.slots.register({name: "tool.call.toolview", key: <wire name>}, Comp))` — keys are exactly the core tool names from `src/core/policy/prompts.ts`, nothing invented.
- [ ] Each view parses that tool's args/result shapes from `src/core/tools.ts` (worker id, title, status rows, steer text, stop reason) and renders compact detail: worker id + title + outcome; status rows reuse the core FSM vocabulary labels. No new data fetches — render only what the tool call already carries.
- [ ] Never claim a key the shipped composition already covers (shadowing election) — the five names are plugin-owned since ticket 11; verify at integration that shipped UI has not added views for them (re-verify against the 0.1.5-rc.1 catalog, version drift risk, research Finding 5).
- [ ] Pure-logic tests under `node --test`: arg/result-shape parsing (including malformed/partial results — render a degraded row, never throw), label mapping, locale dictionary shape. Component rendering: build success + typecheck only (S8).

## Constraints

- Offline tests only (S8); no network, no LLM, no running dsh.
- Views are read-only presentation; they expose no actions and never bypass the parent-agent authority path (design §3.4).
- Clean-room: all view copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
