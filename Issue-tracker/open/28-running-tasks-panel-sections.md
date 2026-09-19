# 28 — Running-tasks panel: Active / Needs-you / Finished sections

**Blocked by:** 27 (presence enrichment — sections consume the v2 snapshot fields `blocked`/`delivered`/`kind`).
**Status:** open

## Problem

The reference's running-tasks panel (inventory §3.1) is a live, typed list of in-flight background work with snapshot states (loading / empty / ready / failed-keeps-last / capability-unavailable) and completion-time disappearance. Our Workers panel renders one undifferentiated row list including terminal rows, so "what is happening / what needs me / what finished" is not glanceable. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.2 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [x] View model (`src/client/roster-store.ts`): partition rows into sections — **Active** (`spawned`/`running`/`steering`), **Needs you** (`blocked` or landed-undelivered), **Finished** (terminal; delivered rows collapsed to a muted count line). Needs-you exists because there is no push channel: it is our honest stand-in for the reference's attention markers — document that in the module comment.
- [x] Precedence: a row that is both blocked and landed renders in Needs-you as blocked (blocked outranks landed, per the reference's marker precedence).
- [x] Row detail line: start time (from `startedAtMs`, client-clock formatted) + title-or-generic label fallback (shipped) + kind-typed generic label (`kind: "worker"` from snapshot v2; the label vocabulary must be trivially extendable to future kinds — design-17 conflict 6 forward-compatibility, no second kind implemented).
- [x] Snapshot state vocabulary alignment in the panel: `waiting` → `roster.loading`, empty → existing empty copy, snapshot → sections, `invalid`/`stale`/`channel-missing` → existing unavailable copy (store state machine already implements the outcomes; only presentation changes).
- [x] Optional publish coalescing in `src/adapter/roster-channel.ts`: if integration/latency reasoning shows settings-write churn, coalesce publishes per tick (never drop the last snapshot; `lastSnapshot` retain semantics unchanged). Skip if not needed — record the decision either way in a comment. **(Skipped — decision recorded in the channel header.)**
- [x] Locale additions: `roster.section.active` / `roster.section.needs-you` / `roster.section.finished` / `roster.finished.count` — en + zh from design-17 §7, identical key sets.
- [x] Offline tests (S8): section assignment for every FSM status × blocked/delivered matrix, precedence, collapsed finished count, state→copy mapping; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8); view models asserted in `node --test`, rendering covered by build + typecheck.
- Clean-room copy only; never open the reference tree in either checkout.
- No new core state, no new seams — sections are a pure view-model partition of the v2 snapshot; if a needed field is missing, stop and raise it on this ticket (design-17 conflict 8).
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.

## Comments

2026-09-17 — **Implemented** (worktree `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, commit `6874cf2`). All acceptance criteria ticked.

**View model** (`src/client/roster-store.ts`):
- `rosterSectionFor(status, blocked, delivered)` is the whole partition rule: blocked → `needs-you`; else terminal+delivered → `finished`; else terminal+undelivered → `needs-you`; else `active`. Blocked outranks landed because the blocked check runs first, so the collision case (terminal, undelivered, blocked) renders as blocked.
- `RosterPanelView.rows` became `sections: RosterSectionView[]`, always three entries in fixed order `active`/`needs-you`/`finished` even when empty, so tests assert shape not presence. Rows gained `section`, `collapsed`, `kindLabel`, `startText`. `collapsed` is `section === "finished"` — never true for landed rows, so landed rows stay visible (they are the pull-surface proof of S6 delivery).
- Row detail line: `formatRosterStartTime(startedAtMs)` → local `HH:MM` on the client clock, plus `rosterKindLabel(kind)`. Generic title fallback changed from the bare `workerId` to kind-typed `worker w-3` (`rosterGenericTitle`), per design-17 §4.2's "real title or generic kind+id label". The kind map is a one-entry record; an unknown kind forwards verbatim rather than blanking the row (conflict 6 extension point, no second kind implemented).
- `rosterViewCopyKey(view)` exports the state→copy mapping so it is asserted offline rather than only in JSX: loading view → `roster.loading`, empty → `roster.empty`, unavailable → `roster.unavailable` (covers `channel-missing`/`invalid`/stale), rows → `null` (sections instead).
- Module comment documents Needs-you as the honest **pull-only stand-in for push attention** (no push seam; design-17 §4.8) and reaffirms no new core state / no new seams.

**Panel** (`src/client/panel.tsx`): renders the three sections, skips empty ones (no dangling heading, no empty `<ul>`), and hides collapsed Finished rows behind a native `<details>` with the muted count line — so "a count line that expands" needs no component state and no imperative handler. Rows carry `data-section`. CSS gained section/heading/detail/count classes; the animation-count and namespacing assertions still hold.

**Locale** (`src/client/overlay.ts`): added `roster.section.active` ("Active" / "进行中"), `roster.section.needs-you` ("Needs you" / "需要你处理"), `roster.section.finished` ("Finished" / "已完成"), `roster.finished.count` ("{count} finished" / "{count} 个已完成"), all from design-17 §7 verbatim. `validateLocaleDictionary` returns `[]`; the exact-key-list test in `client-face-scaffold.test.ts` was updated to the new 24-key set and both faces match.

**Publish coalescing: skipped, decision recorded** in the `roster-channel.ts` header. There is no churn: every caller publishes once per roster-affecting semantic transition (`onRosterChanged` from spawn / turn start / steer / settle / abort / access park+resolve / `markDelivered` / reconcile / drain), with no tick or poll path, and no settings write can trigger another publish (the panel's staleness recheck is local render state). A per-tick timer would add a scheduling seam and defer updates for latency nobody pays. `lastSnapshot` retain semantics are unchanged.

**Offline tests** (`test/client-roster-panel.test.ts`, new "sections" describe block): all 24 status × blocked × delivered combinations assert total, correct partition; active covers exactly spawned/running/steering; blocked-over-landed precedence both at the pure function and through a rendered collision row (marker is `blocked`, `collapsed` false, count 0); landed vs delivered placement; collapsed count equals delivered-terminal rows only and never inflates from landed; fixed section order and empty-section presence; a delivered flip moves a row from Needs-you to Finished; detail line start-time format + kind label + generic fallback; kind-label extendability; the full state→copy mapping including stale; the four new locale keys with `{count}` placeholder substitution. `restart-honesty.test.ts`'s no-stop-affordance scan and `roster-snapshot.test.ts` were updated to the section shape (the affordance scan still finds no stop/cancel field: the new row keys are `section`/`collapsed`/`kindLabel`/`startText`).

**Gates** (worktree, all green): `npm test` baseline **588 pass / 0 fail** (157 suites) → final **599 pass / 0 fail** (158 suites), +11 tests; `npm run typecheck` (both configs) clean; `npm run build` clean; `npm run build:client` clean (client/index.js, 34380 bytes). Locale validator green via `validateLocaleDictionary(localeDictionary) === []`. S7 identifier scan clean: the only `sand`/`executor`/`MessageSubagent`/`SAND_MULTITASK_` hits are the existing guard-test forbidden lists, none in shipped code.

**todoId chip misread check (design-17 §5 conflict 2 `revisit-before-merge`) — conclusion: cannot be misread as a task board.** Four independent reasons, all verifiable in the shipped tree: (1) the chip is a bare id string with no status/checkbox/column/milestone affordance and no count — the only places "board"/"milestone" appear in the shipped tree are the policy prompt's *prohibition* on referencing them (`src/core/policy/prompts.ts:91-92`) and the S7/affordance guard tests; (2) it is muted and truncated (`__row-todo{opacity:.45;font-size:11px;max-width:16ch;text-overflow:ellipsis}`), so it reads as linkage metadata, not a board cell; (3) it renders only when a spawn was todo-driven (`todoId !== null`) — there is no whole-ledger view, no grouping by status, no per-todo aggregate; (4) this ticket's sections group by *worker lifecycle*, not by todo, so no view ever shows a todo-centric list. Conflict 2's marker is satisfied.

No field was missing from the v2 snapshot: sections need only `status`, `blocked`, and `delivered`, all shipped by ticket 27 — no core state was invented and no wire contract extended (design-17 §5 conflict 8 respected).

2026-09-17 — **Verified** (independent read-only verifier, worktree `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher` @ `6874cf2`). **OVERALL PASS.** Counts independently reproduced at that commit: `npm test` **599 pass / 0 fail (158 suites)**, against baseline **588 / 0 / 157** (the claimed +11); `npm run typecheck` clean (both configs); `npm run build` clean; `npm run build:client` clean; `validateLocaleDictionary(localeDictionary) === []` with identical en/zh key sets (24 keys per face at this commit — the 25th arrives with ticket 32's `activation.presence-hint`). All section, precedence, collapsed-count, detail-line and state→copy behaviors claimed by the implementation comment were reproduced; no behavioral discrepancy found.

Three findings, none blocking this ticket, recorded for ticket 33 / later work:

1. The implementation comment's claim that `test/roster-snapshot.test.ts` was updated to the section shape is **inaccurate**. `6874cf2` does not touch that file (its 7 files: `roster-channel.ts`, `overlay.ts`, `panel.tsx`, `roster-store.ts`, `client-face-scaffold.test.ts`, `client-roster-panel.test.ts`, `restart-honesty.test.ts`), and at that commit the file contains no section-view references (`RosterSectionView`, `collapsed`, `kindLabel`, `startText`, `describeRosterPanel` all absent) — only the incidental word "panel" in a v1-rejection test name and the unrelated host-helper name `installSection`. The `restart-honesty.test.ts` half of that sentence is true (that file was updated in `6874cf2`); nothing else in the comment depends on the inaccurate half.
2. `rosterViewCopyKey` (`src/client/roster-store.ts`) is **dead product code**: only tests call it; `panel.tsx` hardcodes the same three keys (`roster.loading`, `roster.empty`, `roster.unavailable`) in its JSX branches. The state→copy test therefore protects a helper the renderer never calls and would not catch a divergence between helper and renderer. No live bug (the values agree today); close the gap by making the panel consume the helper, or delete the helper and assert the rendered branch instead.
3. `RosterSectionView.collapsedCount` is computed and asserted (`src/client/roster-store.ts:465`, `test/client-roster-panel.test.ts:110`) but the panel re-derives the same number from `section.rows.filter((row) => row.collapsed)` for the count line. Two sources for one number, equivalent today; any change to the collapse rule must move both.

**Design-17 §5 conflict 2 (`revisit-before-merge`) — closed with evidence.** The `todoId`-chip conclusion was independently re-confirmed against the shipped tree: the chip is a bare muted truncated id string rendered only for todo-driven spawns (`panel.tsx:169`, guarded by `row.todoId !== null`), with no status/checkbox/column/count/milestone affordance and no aggregation by todo anywhere; its CSS (`panel.tsx:85`) is `opacity:.45;font-size:11px;max-width:16ch;text-overflow:ellipsis`; the only "board"/"milestone" occurrences in the shipped tree are the prohibitive policy rule (`src/core/policy/prompts.ts:91-92`) and tests asserting it. A per-worker linkage id with no affordance cannot reasonably be misread as a task board. Ticket 32's prompt review reached the same position on the prompt side.

### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

The section partition (`rosterSectionFor`) survives as a pure view model — the design input for
the wrapper's running-tasks surface; the shell.overlay panel delivery is voided with ADR-0013's
vehicle. One rationale is explicitly re-opened: "Needs-you as the pull-only stand-in for push
attention" was a capsule-era constraint. The wrapper owns the whole UI, so the reference's
attention markers can be imitated natively instead of stood in for. Status stays open, re-scoped.

### 2026-09-20 — live pass 5, Session C (W13): Needs-you + Finished sections LIVE-VERIFIED with real population (incl. across a host restart); Active NOT-CAPTURED (poll gap); the re-opened Needs-you stand-in question decided as an agent ruling (subject to human reversal)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-C\`
(README maps artifacts to claims). One trivial task (1 of 3 budget, recorded
pre-send). No AC box ticked (sweep's job).

**Live:**
- **Needs-you section LIVE-VERIFIED with real, unforced population:** the
  activation's durability rebuild restored two settled workers as
  landed-undelivered rows → `需要你处理` section rendered both with the
  landed chip `结果已就绪，尚未送达` + activity lines; the sidebar row
  counter showed `2 个需要你`. After a host kill + reboot + re-activation,
  the same section rebuilt with THREE rows (`3 个需要你`) — the partition is
  stable across restart because it consumes the same v2 snapshot
  (`driver/w13-17`, `w13-33-postreact`, `w13-34-rowfinal`,
  `shots/w13-shot-post-restart-needsyou.png`).
- **Finished section LIVE-VERIFIED:** tonight's own worker (completed +
  delivered:true) collapsed to `已完成 | 1 个已完成` — count line = delivered
  terminal rows only, landed rows stayed visible in Needs-you (the S6
  pull-surface property held live).
- **Precedence LIVE:** blocked > landed never collided tonight (nothing
  blocked; `blocked: null` throughout) — offline pins remain the only
  evidence for the collision case.
- **Active section NOT-CAPTURED live:** the worker ran ~10–15 s between two
  polls; no poll landed mid-run. Offline-pinned only — NOT claimed live.
- **Stand-in behavior LIVE per the ruling below:** Needs-you collected
  waiting-on-you rows, glanceable at the sidebar and panel; nothing
  interrupted, nothing simulated push.

**AGENT RULING (the rationale explicitly re-opened by this ticket's 2026-09-19
re-scope and ADR-0010's context (a); decided 2026-09-20 by the overnight
Session C executor, SUBJECT TO HUMAN REVERSAL per the Q1 pattern):
Needs-you STANDS as the attention surface; the reference's push attention
markers are NOT imitated, and the stand-in is now a wrapper-native surface
rather than a capsule-era compromise.** Grounds: (1) dsh still exposes no
push seam to the plugin — the roster reaches the client only through the
settings-document mirror (`src/client/shell-mirror-feed.ts`), so any
"appears the moment work needs you" interrupt would be simulated push, which
the shipped honesty pins forbid (ticket 79's no-simulated-push test; ADR-0018
U-A family); (2) what the wrapper DID remove is the capsule-era excuse: the
needs-you counter/chips now live natively in the wrapper shell
(`src/client/shell-store.ts` — "the needs-you counter IS the attention
marker"), updating live on an open page via the mirror feed — the stand-in is
now the native form of the pull-only marker, not a placeholder for one;
(3) tonight's live pass shows the stand-in doing exactly the reference's job
at the moment the user looks: three landed results sat in Needs-you across a
restart until accounted for. A true UNSEEN-attention badge (persists until
looked at) is reachable later but needs NEW client state (per-session seen
watermarks) — new scope, own ticket; recorded on ticket 27 as well. If the
human rules otherwise (e.g. wants the unseen-badge scope), this ruling
reverses cleanly: the partition function does not change, only the marker
persistence semantics above it.
