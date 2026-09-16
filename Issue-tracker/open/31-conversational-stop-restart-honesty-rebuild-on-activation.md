# 31 — Conversational stop semantics + restart honesty (rebuild-on-activation, unknown-state notice)

**Blocked by:** None — core/adapter only; independent of the client-face tickets.
**Status:** open

## Problem

Two fidelity gaps vs the reference (inventory §7): (1) nothing *enforces* the no-stop-control stance — no test prevents a future stop button from creeping into the client face, and the policy copy does not explicitly teach conversational stopping; (2) **`Multitask.rebuildFromDurability` (`src/core/multitask.ts:602`) has no production caller** — design-16 §3.6 promised marker-rebuild on the next activation, but `onActivated` only publishes an (empty) roster today, so a restart silently loses the roster and pre-crash live workers are never reported. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.6–4.7 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [ ] **Rebuild on activation:** in `src/plugin.ts`'s `onActivated`, call `multitask.rebuildFromDurability(sessionId)` BEFORE the first `publishRosterSnapshot`, so restored terminal rows reappear and landed-undelivered items flush on the first wake (S4 across restart). Ordering is the only change — core rebuild semantics are frozen (ADR-0006).
- [ ] **One-time unknown-state notice:** map the `RebuildReport.unknownState` half to a single honest conversational notice in the activated chat (copy: design-17 §7 `restart.unknown-state` — ids, transcript refs, "state is unknown, nothing was replayed"); also emit `restart.restored` when terminal rows were restored with undelivered results. Fires once per activation; no notice when the report is empty. Unknown-state rows NEVER land on the roster (core rule, `multitask.ts:671`) — the notice is conversational only.
- [ ] **No-stop guard test:** a structural offline test asserting the client view models (`roster-store.ts`, `toolviews.ts`) expose no stop/cancel affordance field and the panel/toolview render data carries none — the absence is tested, so a future edit cannot silently add a stop button (design-17 §4.6).
- [ ] **Policy copy (new, clean-room):** add to the dispatcher policy asset/assembly (`src/core/policy/prompts.ts` + `prompts/`-style asset): the stop/course-change rule ("If the user asks you to stop or change course in plain language, treat that as a steer or a stop of the matching worker (stop tool), then confirm plainly what you stopped or changed. Never claim a stopped worker produced a result.") and the no-board/no-milestone narration rule from design-17 §7.
- [ ] Confirm aborted-worker presentation already matches the reference's no-revival rule (`abortedReportBody()` — "(Stopped before completion. No report.)"); no change expected — assert in tests.
- [ ] Offline tests (S8): rebuild-before-publish ordering, notice text (ids/refs present, fires once, silent on empty report), restored rows in first snapshot, no-stop guard, policy assembly contains the new rules; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- Core FSM/steer/todo/rebuild semantics frozen — adapter ordering + copy + tests only; any core change goes back to design.
- `stop_worker` remains agent-facing only; no user-facing stop affordance may be added by this or any sibling ticket (PRD §15.3, design-17 conflict 1).
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.
