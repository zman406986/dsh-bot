# 27 — Presence enrichment: snapshot v2, status dots/ring, blocked-with-reason, landed marker, activity lines

**Blocked by:** None — builds on the shipped ticket-21 roster overlay (may start immediately).
**Status:** open

## Problem

The ticket-21 Workers panel shows only title + verbatim FSM status + todo id (snapshot v1: `workerId/title/status/todoId`). The reference product's glanceable presence (inventory §2 — status dots, animated running ring, a blocked marker carrying a human-readable waiting reason that outranks unread, and a live activity line) is not reproducible with that wire contract, and dsh has no push channel, so the pull-surface panel must carry the full presence picture itself. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.1 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md` (tracker edits stay on MAIN).

- [x] Bump `ROSTER_SNAPSHOT_SCHEMA_VERSION` 1 → 2 in `src/core/roster-snapshot.ts`; v2 row fields: `kind: "worker"`, `startedAtMs: number`, `toolCallCount: number`, `delivered: boolean`, `blocked: { class, target } | null` (structured, so the panel localizes the phrase — never a pre-rendered string on the wire).
- [x] Extend `parseRosterSnapshot` fail-closed: v1 payloads, unknown `kind`, malformed `blocked`, or non-finite clocks return `null` → panel degrades to "unavailable" (never a half-roster).
- [x] Host projection (`src/plugin.ts` `publishRosterSnapshot` / `projectRosterSnapshot`): join `Multitask.listPendingAccess(sessionId)` by `workerId` for `blocked` (class+target from `AccessRequestBody` — names only, never secret values); `delivered` from the reconciler's delivered state (todo link), `startedAtMs`/`toolCallCount` from `WorkerSummary`.
- [x] Panel view model (`src/client/roster-store.ts`): status-dot mapping over the six FSM statuses (working = `running`/`steering`, starting = `spawned`, done/failed/stopped for terminal); blocked marker outranks landed, landed outranks finished (reference precedence); derived activity line `{status} · {elapsed} · {n} tool calls` with elapsed computed from `startedAtMs` vs the injected render clock.
- [x] Panel component (`src/client/panel.tsx`): emit `data-status`-keyed dot/ring spans (animated ring only for `running`/`steering`), blocked marker chip, landed marker ("Result ready — not delivered yet"), muted activity line; demote the `todoId` chip to muted linkage metadata — it must NOT read as a task board (design §4.9 / conflict 2).
- [x] CSS: `multitask-dispatcher-` prefixed classes only, no shipped kit classes; animation respects the panel's render-only constraint (no new test toolchain).
- [x] Locale additions in `src/client/overlay.ts` (`roster.blocked.*` per access class, `roster.landed`, `roster.activity.toolcalls`, `roster.loading`) — en + zh, identical key sets (run the shipped `validateLocaleDictionary` in tests); copy from design-17 §7 verbatim.
- [x] Offline tests (S8): projection joins and fail-closed parsing (v1 payload rejected), precedence rules, activity-line math with a fake clock, locale validator green; full suite green, `npm run typecheck` clean both configs.

## Constraints

- Offline tests only: no network, no LLM, no running dsh (S8); rendering is covered by build + typecheck, view models asserted in `node --test`.
- Clean-room copy only — all new strings from design-17 §7 or original equivalents; never open anything under `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` (either checkout).
- Presence is a projection of existing core truth — if a field the core does not already expose seems needed, STOP and raise a PRD amendment (design-17 §5 conflict 8), do not invent core state.
- Implementation one-at-a-time in the worktree; keep this ticket's status/comments updated on MAIN (never commit tracker files in the worktree).
- No new slot names/ids beyond the shipped `multitask-dispatcher-roster` overlay entry.

## Comments

### 2026-09-17 — agent team (implementation, worktree `clone/always-on-dispatcher` @ `f09f19d`)

All checkboxes done. `npm test` 534 pass / 0 fail (was 514 / 0; 149 suites), `npm run typecheck`
clean on both configs, offline only (S8). Worktree commit: `f09f19d` ("Enrich roster presence
snapshot and rendering (ticket 27)"), 9 files.

What landed:
- **Snapshot v2** (`src/core/roster-snapshot.ts`): `ROSTER_SNAPSHOT_SCHEMA_VERSION` 1→2; rows carry
  `kind: "worker"`, `startedAtMs`, `toolCallCount`, `delivered`, `blocked: {class, target} | null`.
  Parse is fail-closed: v1 payloads, unknown `kind`, malformed/unknown-class `blocked`, non-finite
  or negative clocks, non-integer counts, non-boolean `delivered` → whole snapshot `null` (panel
  degrades to unavailable, never a half-roster). `projectRosterSnapshot` takes optional
  `sources {pendingAccess, todos}` — blocked joins `listPendingAccess` by workerId (class+target
  names only; `reason`/credential values never projected), `delivered` = linked todo's ledger
  flag, todo-less workers project `true` (no delivery obligation, can never sit landed-undelivered).
- **Observer timeliness without new core state** (`src/core/multitask.ts`, design-17 §5 conflict 8):
  the existing roster observer now also fires on pending-access park (only when the pending set
  grows), `resolveAccess`, timeout/policy denies (via the relay's existing `onResolved`), and
  `markDelivered` — so blocked/delivered markers re-project promptly instead of waiting for the
  next FSM transition. No new core state, no presence store.
- **Panel view model** (`src/client/roster-store.ts`): dot/ring visual mapping (working =
  running/steering, starting = spawned, done/failed/stopped terminal), marker precedence blocked >
  landed > plain finished, derived activity line `{status} · {elapsed} · {n} tool calls` with
  elapsed computed against the injected render clock (clamped at 0 on skew), `waiting` now renders
  loading copy per design-17 §4.2. `formatTemplate`/`formatRosterElapsed` are pure + tested.
- **Panel + CSS** (`src/client/panel.tsx`): `data-status`/`data-visual`-keyed dot span, animated
  ring only on working rows, blocked chip (localized per access class, `{target}` interpolated),
  landed chip ("Result ready — not delivered yet"), muted activity line, `todoId` demoted to
  muted truncated linkage metadata. CSS ships as a namespaced string stylesheet rendered with the
  component (mounts/unmounts with it — HMR-safe, no build toolchain change); only animation is the
  running ring, disabled under `prefers-reduced-motion`; a test greps the constant for bare class
  selectors and animation/reduced-motion guarantees.
- **Locale** (`src/client/overlay.ts`): design-17 §7 copy verbatim — `roster.loading`,
  `roster.landed`, `roster.activity.toolcalls`, `roster.blocked.{tool,credential,network,
  filesystem,other}` — en + zh identical key sets; `validateLocaleDictionary` asserted green in
  tests (and the scaffold test's pinned key list extended).

Deferred gaps / handover:
- Activity-line elapsed keeps counting on terminal rows (view mutes them); live *text* activity
  remains ticket 29's verification question — the derived line is the honest shipped fallback.
- Blocked projection is best-effort by contract (design-17 §10): an ask resolved between list and
  publish self-heals on the next observer fire (which now includes resolve paths above).
- Plugin-level tests cover the parked-ask publish; prompt-seam resolution stays covered by ticket
  23's pump tests (the pump routes through the same `resolveAccess` observer path).
- Ticket 28 (Active / Needs-you / Finished sections) can start from v2 rows unchanged — no
  blockers; v2 field provenance: FSM status + `WorkerSummary` (startedAtMs, toolCallCount),
  ledger todo (`delivered`), pending access tickets (`blocked`).
