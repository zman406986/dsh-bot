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

### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

ADR-0018 voided the capsule/plugin-UI vehicle (ADR-0013); this ticket's panel work shipped
into a surface the wrapper supersedes. Disposition (nothing deleted):

- **Survives:** snapshot v2 fail-closed contract, observer-timeliness projections, and the pure
  view-model logic (dot/ring mapping, blocked > landed > finished precedence, activity-line math)
  — vehicle-independent design input for the wrapper's presence surface.
- **Voided:** the shell.overlay panel delivery and its CSS/locale face — re-hosting in the
  wrapper is new scope (wrapper shell ticket).
- **Re-derive before porting:** the `delivered` field and landed-marker math assumed completion =
  delivered-to-user; ADR-0018 supersedes that (completion = first-visible-ack).
- Presence is NOT on ADR-0018's exception list, so the wrapper's presence surface is held to the
  imitation standard (reference glanceable presence), not to this ticket's capsule-era compromises.

Status stays open, re-scoped: re-host presence in the wrapper and verify against the reference bar.

### 2026-09-20 — live pass 5, Session C (W13): snapshot v2 semantics, landed marker, activity lines, dots LIVE-VERIFIED on the wrapper sidebar; running ring NOT-CAPTURED (poll gap); blocked NOT-TRIGGERED; the two re-opened ADR-0010 rationale questions decided as agent rulings (subject to human reversal)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-C\`
(README maps every artifact to every claim below; per-command `.json` →
`.out.json` pairs in `session-C/driver/`, screenshots in `session-C/shots/`,
offline host-state reads in `session-C/probes/`). One trivial task (1 of 3
budget, recorded pre-send). No AC box ticked (sweep's job).

**Live (with one spawn running/settled on a clean session):**
- **Snapshot v2 semantics LIVE:** rebuilt + live rows carry `blocked: null`,
  `delivered` (flips false→true on delivery), `startedAtMs`/`toolCallCount`
  feeding the derived activity lines (`completed · 41m 37s · 0 次工具调用`
  matches the worker's real `startedAtMs` ≈ 41.6 min earlier) —
  `driver/w13-10`, `w13-17`, `w13-33`.
- **Dots LIVE:** needs-you dot (amber) on the dispatcher row, grey
  unavailable/idle dots elsewhere (`data-presence` state tokens) —
  `shots/w13-shot-sections-after-delivery.png`. **Animated running ring on a
  working row NOT-CAPTURED:** the worker ran ~10–15 s between two polls; no
  poll landed mid-run. Offline-pinned only — NOT claimed live.
- **Landed marker LIVE:** `结果已就绪，尚未送达` ("Result ready — not
  delivered yet") on all restored landed rows, incl. after restart.
- **Activity lines LIVE:** derived `{status} · {elapsed} · {n} tool calls`
  lines on Needs-you rows (ticket 29's live text reaches check rows, not the
  panel — unchanged division).
- **Blocked marker NOT-TRIGGERED:** nothing blocked naturally tonight; not
  forced (per brief). Remains live-unverified.
- **Fail-closed degradation LIVE (stale leg):** after the 60 s no-heartbeat
  window the seat panel degrades to `工作者状态暂时不可用`; after a host
  SIGKILL the surviving stale mirror key keeps the row's dispatcher flag but
  presence renders `状态不可用` at view time — never a wrong roster
  (`w13-09`, `w13-24`, `w13-30`).

**AGENT RULING 1 of 2 (rationale re-opened by ADR-0010 context (b);
decided 2026-09-20 by the overnight Session C executor, SUBJECT TO HUMAN
REVERSAL per the Q1 pattern): `delivered`/landed-marker semantics under
ADR-0018's first-visible-ack = keep the shipped flag, re-glossed.**
`delivered:true` in presence means "the result has become user-visible at
least once"; landed = settled + not yet user-visible. Grounds: (1) in the
wrapper the ONLY path by which a result becomes visible is the deliver path
that flips the flag (`src/core/tools.ts` deliver → `deliverToUser` success →
`markDelivered`), so flag-flip and first-visibility coincide on the shipped
surface — no schema change, no new core state (conflict-8 respected); (2) the
landed set IS the delivery-obligation set (ticket 58's redrive population), so
presence and the obligation layer stay one truth; (3) live anchor: rebuilt
rows carry `delivered:false` from durability and the redrive wake narrates
honestly ("already delivered") — the flag projects obligation truth, which
under first-visible-ack IS the correct "not yet visible" signal. Recorded
live caveat: durable markers carry NO delivered bit
(`session-C/probes/w13-markers-after-rebuild.json`), so across a restart the
panel says "not delivered yet" for results delivered pre-restart until the
next wake reconciles — accepted tonight as honest obligation-truth; if the
human ever wants marker-level delivery bits, that is a durable-marker field
addition (design-17 conflict-8 stop-and-raise), not a client fix.

**AGENT RULING 2 of 2 (attention markers, as this ticket's presence surface
bears on ADR-0010 context (a); decided 2026-09-20, SUBJECT TO HUMAN
REVERSAL): the wrapper presence markers (dots, blocked chip, landed chip,
waiting chips) stay pull-only honest state markers — no simulated push.** The
canonical Needs-you ruling is recorded on ticket 28 (its re-scope owns the
question); this ticket's consequence: the presence chips/markers keep
presenting current core truth at glance value. A native UNSEEN-attention
marker (reference-style badges that persist until looked at) is technically
reachable in the wrapper (the mirror feed updates a live-open page) but
requires NEW client state (per-session seen watermarks) — that is new scope
needing its own ticket, not a rationale re-decree; recorded here so the sweep
sees it was considered, not missed.
