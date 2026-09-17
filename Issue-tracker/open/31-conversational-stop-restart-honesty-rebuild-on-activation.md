# 31 — Conversational stop semantics + restart honesty (rebuild-on-activation, unknown-state notice)

**Blocked by:** None — core/adapter only; independent of the client-face tickets.
**Status:** open

## Problem

Two fidelity gaps vs the reference (inventory §7): (1) nothing *enforces* the no-stop-control stance — no test prevents a future stop button from creeping into the client face, and the policy copy does not explicitly teach conversational stopping; (2) **`Multitask.rebuildFromDurability` (`src/core/multitask.ts:602`) has no production caller** — design-16 §3.6 promised marker-rebuild on the next activation, but `onActivated` only publishes an (empty) roster today, so a restart silently loses the roster and pre-crash live workers are never reported. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.6–4.7 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [x] **Rebuild on activation:** in `src/plugin.ts`'s `onActivated`, call `multitask.rebuildFromDurability(sessionId)` BEFORE the first `publishRosterSnapshot`, so restored terminal rows reappear and landed-undelivered items flush on the first wake (S4 across restart). Ordering is the only change — core rebuild semantics are frozen (ADR-0006).
- [x] **One-time unknown-state notice:** map the `RebuildReport.unknownState` half to a single honest conversational notice in the activated chat (copy: design-17 §7 `restart.unknown-state` — ids, transcript refs, "state is unknown, nothing was replayed"); also emit `restart.restored` when terminal rows were restored with undelivered results. Fires once per activation; no notice when the report is empty. Unknown-state rows NEVER land on the roster (core rule, `multitask.ts:671`) — the notice is conversational only.
- [x] **No-stop guard test:** a structural offline test asserting the client view models (`roster-store.ts`, `toolviews.ts`) expose no stop/cancel affordance field and the panel/toolview render data carries none — the absence is tested, so a future edit cannot silently add a stop button (design-17 §4.6).
- [x] **Policy copy (new, clean-room):** add to the dispatcher policy asset/assembly (`src/core/policy/prompts.ts` + `prompts/`-style asset): the stop/course-change rule ("If the user asks you to stop or change course in plain language, treat that as a steer or a stop of the matching worker (stop tool), then confirm plainly what you stopped or changed. Never claim a stopped worker produced a result.") and the no-board/no-milestone narration rule from design-17 §7.
- [x] Confirm aborted-worker presentation already matches the reference's no-revival rule (`abortedReportBody()` — "(Stopped before completion. No report.)"); no change expected — assert in tests.
- [x] Offline tests (S8): rebuild-before-publish ordering, notice text (ids/refs present, fires once, silent on empty report), restored rows in first snapshot, no-stop guard, policy assembly contains the new rules; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- Core FSM/steer/todo/rebuild semantics frozen — adapter ordering + copy + tests only; any core change goes back to design.
- `stop_worker` remains agent-facing only; no user-facing stop affordance may be added by this or any sibling ticket (PRD §15.3, design-17 conflict 1).
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.

## Comments

### 2026-09-17 — agent team (implementation, worktree `clone/always-on-dispatcher` @ `818d03c`)

All checkboxes done. `npm test` 582 pass / 0 fail (was 572 / 0; 157 suites), `npm run typecheck`
clean on both configs, offline only (S8). Worktree commit: `818d03c` ("Wire conversational
stopping and restart honesty (ticket 31)"), 8 files (2 new).

What landed:
- **Rebuild-on-activation** (`src/plugin.ts`): `onActivated` now runs `rebuildAndNotice` —
  `multitask.rebuildFromDurability(sessionId)` completes BEFORE the first `publishRosterSnapshot`
  and `accessPrompts.sync()`, so restored terminal rows are in the very first mirrored snapshot
  (pinned by test) and landed-undelivered items flush on the first wake. Activation itself still
  returns success immediately (the chain is async); if the activation ends mid-rebuild, the chain
  bails out without publishing or injecting. Core untouched — ordering only, per ADR-0006.
- **One-time restart notice** (new `src/adapter/restart-notice.ts`): `assembleRestartNotice`
  maps the `RebuildReport` to a single injected block (`## Restart` heading; design-17 §7 copy —
  unknown-state line with count/ids/transcript refs + "state is unknown, nothing was replayed";
  restored line with the next-wake delivery expectation). Null on an empty report — silence.
  Delivered through a new `injectNotice` seam on `bindDispatcherLifecycle` (same best-effort
  plugin-message path as the session policy; parent-agent.ts). Fires at most once per activation;
  a second activation in-process rebuilds empty and stays silent (tested).
- **Degraded failure path**: if the marker store itself throws, activation still succeeds and a
  single honest degraded notice ("could not be read … nothing was restored and nothing was
  replayed") is injected instead (tested).
- **No-stop guard** (`test/restart-honesty.test.ts`): structural absence tests — a recursive key
  scan of the roster panel view model (`describeRosterPanel`, over a fixture covering
  blocked/landed/terminal rows) and of all five toolview render models asserts zero keys matching
  /stop|cancel|button|action|affordance/i; plus a plugin-level assertion that the only registered
  commands remain `dispatcher-start` + `dispatcher-steer` (no stop/cancel command).
  `stop_worker` stays agent-facing (tool list untouched).
- **Policy copy** (`src/core/policy/prompts.ts`): design-17 §7 rules verbatim in the session
  policy — the stop/course-change rule (incl. "Never claim a stopped worker produced a result.")
  and the no-board/no-milestone narration rule; presence asserted for `assembleSessionPolicy(true)`,
  OFF still empty.
- **Aborted no-revival presentation**: `abortedReportBody()` exact text asserted; a wake turn for
  an aborted worker renders "(Stopped before completion. No report.)" and never the raced report
  text. No production change needed, as the ticket predicted.

Test adaptations (not regressions): two tests that asserted the OLD synchronous on-activation
publish (`test/roster-snapshot.test.ts`, `test/coexistence.test.ts`) now drain the async rebuild
chain before reading the mirrored snapshot — the ticket's rebuild-before-publish ordering is the
intended change.

Deferred gaps / handover:
- **ADR-0012** ("Activation replays durability, never work", design-17 §9) is recorded in the
  design as landing "with ticket 31", but this ticket's checkboxes do not claim an ADR, so none
  was written — flag for ticket 33 (close-out) to either file it or amend the design.
- The notice rides the existing best-effort `Agent.inject` seam (no wake-bus channel was added —
  that would be a frozen-core change). If integration shows an inject landing after the activation
  turn already flushed, revisit delivery there.
- `restart.*` copy lives as adapter constants (en), matching ticket 30's approval-copy precedent —
  not in the client locale dictionary, since the client face never renders conversational notices.
  zh face remains a later-localization item, consistent with all adapter copy.
- Unknown-state workers whose marker carried a live status are reported by id only (title/todo in
  the marker are not surfaced in the notice); extend the copy only if integration feedback asks.
