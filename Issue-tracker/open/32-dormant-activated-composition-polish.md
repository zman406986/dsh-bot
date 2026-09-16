# 32 — Dormant/activated composition polish: copy, locale, surfaces README, prompt review

**Blocked by:** 27, 28, 30, 31 (polish passes over their landed surfaces).
**Status:** open

## Problem

The activated experience must feel like the reference's always-on dispatcher while dormant boot stays stock dsh (design-17 §3). After the per-surface tickets land, the composition needs a coherence pass: the activation copy does not yet tell the user where presence lives or what to expect; the enlarged locale faces need validation; the "no board, no milestones, no notifications" absences need to be written down once; and prompt text must be reviewed so no string implies surfaces that do not exist (design-17 §4.8–4.9, conflicts 2/3).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [ ] Activation success copy: append the presence hint ("The Workers panel shows live progress; results arrive in this chat as they finish." — `activation.presence-hint`, design-17 §7) exactly once to `DISPATCHER_START_SUCCESS` in `src/adapter/activation-command.ts`; zh face in the locale dictionary.
- [ ] Dormant copy review: confirm dormant boot registers nothing visible beyond the two commands (`dispatcher-start`, `dispatcher-steer`) — extend the existing flag-matrix tests to assert no new dormant registrations crept in from tickets 27–31.
- [ ] Deactivation honesty: verify (test) the panel path ages to "unavailable" after session end (stale window) and that re-activation rebuilds — the "what does the user come back to" answer (design-17 §3.2) asserted end-to-end with fakes.
- [ ] Surfaces README: a short doc (repo `docs/` or `CONTEXT.md` section, clean-room) recording the designed absences and their reasons: no push notifications (no seam — pull surfaces only), no todo board (private ledger, ADR-0007; `todoId` is linkage metadata), no milestones (no runtime entity), no stop control (conversational stops, PRD §15.3), no worker console, no timeline cards (closed node-type domain), send journal is host-owned.
- [ ] Prompt review (conflicts 2/3): grep the policy/prompt assets for any wording implying a task board, milestone view, or push notification; fix with new copy if found; record the pass in this ticket's comments.
- [ ] Locale validation: run `validateLocaleDictionary` over the final enlarged dictionary in tests (identical en/zh key sets, all strings); sweep for stray untranslated literals added by 27–31.
- [ ] Optional (drop without ceremony if the seam does not verify at integration): a `settings.onboarding` list entry (seams Finding 5 catalog) describing the opt-in dispatcher in one screen — lightweight, no guided overlay, suppressed once seen is NOT attempted (no verified persistence for "seen" without inventing state; conflict with design-17 §3.1(c)).
- [ ] Offline tests (S8): dormant-registration matrix, deactivation→unavailable→reactivate-rebuild flow, copy assertions, locale validator; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- No new seams, no new core state; this is a composition/copy/docs pass over landed tickets.
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.
