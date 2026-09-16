# 28 — Running-tasks panel: Active / Needs-you / Finished sections

**Blocked by:** 27 (presence enrichment — sections consume the v2 snapshot fields `blocked`/`delivered`/`kind`).
**Status:** open

## Problem

The reference's running-tasks panel (inventory §3.1) is a live, typed list of in-flight background work with snapshot states (loading / empty / ready / failed-keeps-last / capability-unavailable) and completion-time disappearance. Our Workers panel renders one undifferentiated row list including terminal rows, so "what is happening / what needs me / what finished" is not glanceable. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.2 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [ ] View model (`src/client/roster-store.ts`): partition rows into sections — **Active** (`spawned`/`running`/`steering`), **Needs you** (`blocked` or landed-undelivered), **Finished** (terminal; delivered rows collapsed to a muted count line). Needs-you exists because there is no push channel: it is our honest stand-in for the reference's attention markers — document that in the module comment.
- [ ] Precedence: a row that is both blocked and landed renders in Needs-you as blocked (blocked outranks landed, per the reference's marker precedence).
- [ ] Row detail line: start time (from `startedAtMs`, client-clock formatted) + title-or-generic label fallback (shipped) + kind-typed generic label (`kind: "worker"` from snapshot v2; the label vocabulary must be trivially extendable to future kinds — design-17 conflict 6 forward-compatibility, no second kind implemented).
- [ ] Snapshot state vocabulary alignment in the panel: `waiting` → `roster.loading`, empty → existing empty copy, snapshot → sections, `invalid`/`stale`/`channel-missing` → existing unavailable copy (store state machine already implements the outcomes; only presentation changes).
- [ ] Optional publish coalescing in `src/adapter/roster-channel.ts`: if integration/latency reasoning shows settings-write churn, coalesce publishes per tick (never drop the last snapshot; `lastSnapshot` retain semantics unchanged). Skip if not needed — record the decision either way in a comment.
- [ ] Locale additions: `roster.section.active` / `roster.section.needs-you` / `roster.section.finished` / `roster.finished.count` — en + zh from design-17 §7, identical key sets.
- [ ] Offline tests (S8): section assignment for every FSM status × blocked/delivered matrix, precedence, collapsed finished count, state→copy mapping; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8); view models asserted in `node --test`, rendering covered by build + typecheck.
- Clean-room copy only; never open the reference tree in either checkout.
- No new core state, no new seams — sections are a pure view-model partition of the v2 snapshot; if a needed field is missing, stop and raise it on this ticket (design-17 conflict 8).
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.
