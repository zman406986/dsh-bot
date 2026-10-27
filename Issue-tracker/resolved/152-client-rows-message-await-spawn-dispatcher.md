# 152 — Client rows for `message_agent`, `await_agent`, `spawn_dispatcher` fall back to the generic tool row

**Status:** resolved
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

2026-10-28 (implementation, branch `ticket-152-tool-rows`): done, awaiting review — Status stays open.

- `src/client/toolviews.ts`: added `describeMessageAgent` (target, acceptance lane `delivered_as`, priority, ok/refusal outcome; message body never rendered), `describeAwaitAgent` (worker id, status line — `settled · <worker_status>`, `released · <reason>`, or a plain `still-running`/`gone`; a refusal adds the verbatim reason as outcome), and `describeSpawnDispatcher` (child session id, clamped title from result with args fallback, outcome; handoff prompt never rendered). `TOOLVIEW_TOOL_NAMES` is now `DISPATCHER_TOOL_NAMES` + the retained historical `send_peer` key (nine keys); the "deliberate lag" comment is replaced with the closed state.
- `src/client/overlay.ts`: four new field keys in both faces — `toolview.field.agent`, `toolview.field.status`, `toolview.field.delivered-as`, `toolview.field.dispatcher`; en/zh parity intact (validator passes).
- `docs/surfaces.md`: the tool-view row is now "Nine tool call views" and no longer describes a gap; `src/client/index.ts` module comment updated to the nine-key count.
- Tests: `test/client-toolviews.test.ts` — the claim pin now expects the exact dispatcher surface plus `send_peer`; three new describe blocks (one per tool) cover the key fields, refusal/degrade paths, wrong-typed fields, and body/prompt non-rendering. The locale-key pin in `test/client-face-scaffold.test.ts` gained the four new keys.
- Verification (worktree only): `tsx --test test/client-toolviews.test.ts test/client-face-scaffold.test.ts test/coexistence.test.ts test/client-conversation-surface.test.ts` → 230 pass, 0 fail; `npm run typecheck` clean.

## Resolution — 2026-10-28

Landed via merge `e0cb917` ("Merge branch 'ticket-152-tool-rows'"), carrying branch commit
`58f1a05`. Specific rows for `message_agent`, `await_agent`, and `spawn_dispatcher`; en+zh
dictionary parity intact. The 230 focused tests pass.

Bookkeeping: `**Status:**` → `resolved`; moved
`Issue-tracker/open/152-client-rows-message-await-spawn-dispatcher.md` → `Issue-tracker/resolved/`.
