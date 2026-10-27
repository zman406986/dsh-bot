# 152 — Client rows for `message_agent`, `await_agent`, `spawn_dispatcher` fall back to the generic tool row

**Status:** open
**Labels:** ready-for-agent
**Origin:** PRD gap scan 2026-10-28 — verified against the tree; nothing implemented.
**Related:** PRD §6.3 (dispatcher-visible tools), ticket 24 (the per-tool call views), ticket 116 (`message_agent`), ticket 117 (`await_agent`), ticket 118 (`spawn_dispatcher`), `docs/surfaces.md` (the "Six tool call views" row).

## Problem

The client face claims six `tool.call.toolview` keys: the five long-standing dispatcher tools plus the retired historical `send_peer` key (`TOOLVIEW_TOOL_NAMES`, `src/client/toolviews.ts:58-65`). The dispatcher surface has eight tools (`DISPATCHER_TOOL_NAMES`, `src/core/policy/prompts.ts:65-74`).

`message_agent`, `await_agent` and `spawn_dispatcher` therefore hit the `default` branch of `describeToolview` and degrade to the generic row (`src/client/toolviews.ts:393-408`). The lag is recorded deliberately in the module comment (`src/client/toolviews.ts:43-63`), in `docs/surfaces.md:261`, and pinned by `test/client-toolviews.test.ts:288-296`.

Effect for the user: the three most visible peer/mitosis actions — sending to another agent, waiting on a worker, summoning a dispatcher — render as an unlabeled generic call next to rows that name what happened.

## What to do

- Add a `describe*` parser per tool and claim each name in `TOOLVIEW_TOOL_NAMES`, following the existing per-tool shape (`describeSpawn` … `describeSendPeer`, `src/client/toolviews.ts:377-412`).
- Add locale keys for each new row to both faces of the existing dictionary (`en` and `zh` at `src/client/overlay.ts:115`, `:328`); keep en/zh key parity (the dictionary validator already asserts it).
- Update the deliberate-lag comment (`src/client/toolviews.ts:43-63`), the `docs/surfaces.md:261` row, and the pinning test with the new expectation.

## Acceptance

- [ ] Each of the three tools renders a specific, useful row: target/summary visible, no `TOOLVIEW_DEGRADED_KEY` fallback for a well-formed payload.
- [ ] One test per row covering payload parsing (including a missing or wrong-typed field degrading safely, as the existing tests do).
- [ ] `TOOLVIEW_TOOL_NAMES` matches the dispatcher surface exactly; the "deliberate lag" text and `docs/surfaces.md` no longer describe a gap.
- [ ] `send_peer` stays claimed for historical rows.
- [ ] en/zh key parity holds.

## Constraints

- Views stay read-only presentation: render only what the call already carries; no fetches, no actions (`src/client/toolviews.ts:20-22`).
- Never claim a shipped keyed cell (`SHIPPED_CLAIMED_TOOLVIEW_KEYS`, `src/client/toolviews.ts:72-75`).
- Offline tests only; no browser run needed.

## Comments

2026-10-28: Filed from a read-only gap scan. The lag is already documented in code and docs — this ticket closes it; it does not discover a defect.
