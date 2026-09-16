# 27 — Presence enrichment: snapshot v2, status dots/ring, blocked-with-reason, landed marker, activity lines

**Blocked by:** None — builds on the shipped ticket-21 roster overlay (may start immediately).
**Status:** open

## Problem

The ticket-21 Workers panel shows only title + verbatim FSM status + todo id (snapshot v1: `workerId/title/status/todoId`). The reference product's glanceable presence (inventory §2 — status dots, animated running ring, a blocked marker carrying a human-readable waiting reason that outranks unread, and a live activity line) is not reproducible with that wire contract, and dsh has no push channel, so the pull-surface panel must carry the full presence picture itself. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.1 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md` (tracker edits stay on MAIN).

- [ ] Bump `ROSTER_SNAPSHOT_SCHEMA_VERSION` 1 → 2 in `src/core/roster-snapshot.ts`; v2 row fields: `kind: "worker"`, `startedAtMs: number`, `toolCallCount: number`, `delivered: boolean`, `blocked: { class, target } | null` (structured, so the panel localizes the phrase — never a pre-rendered string on the wire).
- [ ] Extend `parseRosterSnapshot` fail-closed: v1 payloads, unknown `kind`, malformed `blocked`, or non-finite clocks return `null` → panel degrades to "unavailable" (never a half-roster).
- [ ] Host projection (`src/plugin.ts` `publishRosterSnapshot` / `projectRosterSnapshot`): join `Multitask.listPendingAccess(sessionId)` by `workerId` for `blocked` (class+target from `AccessRequestBody` — names only, never secret values); `delivered` from the reconciler's delivered state (todo link), `startedAtMs`/`toolCallCount` from `WorkerSummary`.
- [ ] Panel view model (`src/client/roster-store.ts`): status-dot mapping over the six FSM statuses (working = `running`/`steering`, starting = `spawned`, done/failed/stopped for terminal); blocked marker outranks landed, landed outranks finished (reference precedence); derived activity line `{status} · {elapsed} · {n} tool calls` with elapsed computed from `startedAtMs` vs the injected render clock.
- [ ] Panel component (`src/client/panel.tsx`): emit `data-status`-keyed dot/ring spans (animated ring only for `running`/`steering`), blocked marker chip, landed marker ("Result ready — not delivered yet"), muted activity line; demote the `todoId` chip to muted linkage metadata — it must NOT read as a task board (design §4.9 / conflict 2).
- [ ] CSS: `multitask-dispatcher-` prefixed classes only, no shipped kit classes; animation respects the panel's render-only constraint (no new test toolchain).
- [ ] Locale additions in `src/client/overlay.ts` (`roster.blocked.*` per access class, `roster.landed`, `roster.activity.toolcalls`, `roster.loading`) — en + zh, identical key sets (run the shipped `validateLocaleDictionary` in tests); copy from design-17 §7 verbatim.
- [ ] Offline tests (S8): projection joins and fail-closed parsing (v1 payload rejected), precedence rules, activity-line math with a fake clock, locale validator green; full suite green, `npm run typecheck` clean both configs.

## Constraints

- Offline tests only: no network, no LLM, no running dsh (S8); rendering is covered by build + typecheck, view models asserted in `node --test`.
- Clean-room copy only — all new strings from design-17 §7 or original equivalents; never open anything under `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` (either checkout).
- Presence is a projection of existing core truth — if a field the core does not already expose seems needed, STOP and raise a PRD amendment (design-17 §5 conflict 8), do not invent core state.
- Implementation one-at-a-time in the worktree; keep this ticket's status/comments updated on MAIN (never commit tracker files in the worktree).
- No new slot names/ids beyond the shipped `multitask-dispatcher-roster` overlay entry.
