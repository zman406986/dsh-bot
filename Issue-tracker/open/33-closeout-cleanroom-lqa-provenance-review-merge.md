# 33 — Close-out: clean-room LQA gate + full-diff provenance review + merge to main (ticket 17)

**Blocked by:** 27, 28, 29, 30, 31, 32.
**Status:** open

## Problem

`clone/always-on-dispatcher` merges to `main` only after the three gates in `.scratch/clone-always-on/worktree-workflow.md` §3. Tickets 27–32 added client CSS, locale faces, prompt/policy copy, and adapter copy — exactly the artifact classes where provenance contamination would hide, so the branch-wide pass must run over the WHOLE ticket-17 diff, not per-ticket slices.

## What to do

Work happens per the workflow doc: tests/greps run in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`; the recorded review comment and ticket-17 close-out land on MAIN.

- [ ] **Gate 1 — clean-room identifier grep** over the full `main...clone/always-on-dispatcher` diff per `docs/research/clean-room-license-audit.md`: case-insensitive `rg` for `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*` and reconstruction basenames across every touched file (source, prompts, copy strings, comments, test fixtures, compiled client output). Only intentional `FORBIDDEN_VOCAB` negative-test fixtures may hit, in `test/` only.
- [ ] **Manual copy read:** read every new prompt asset, locale string, and user-visible copy line added by 27–32; confirm original expression (design-17 §7 is the only sanctioned source) and en/zh key parity.
- [ ] **Gate 2 — offline tests green in the worktree:** `npm test` 0 fail and `npm run typecheck` clean (both configs), no network/LLM/running dsh (S8); record the counts.
- [ ] **Gate 3 — full-diff provenance review:** a human-free review of the complete branch diff for structural/phrasing/protocol borrow from the reference tree (per workflow §3), findings appended as a dated comment on `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` on MAIN.
- [ ] Confirm the §5 conflict markers were honored: spot-check each `revisit-before-merge` row of design-17 §5 against the landed code (e.g. no stop control, no todo board, no second wake kind, session "always" rows cleared) and record each check in the review comment.
- [ ] Merge `clone/always-on-dispatcher` → `main` (squash or merge, implementer's choice) with every message referencing the closed ticket numbers (e.g. `17.27`–`17.33`); then `npm ci` on main so `node_modules` matches the lockfile, and re-run the suite once on main.
- [ ] Close tickets 27–33 (and ticket 17 Phase 3) with dated comments carrying commit hashes; never `git add -A` at any step.

## Constraints

- The reference tree stays closed in both checkouts — the grep runs against OUR diff only.
- Merge gates are hard: any grep hit outside allowed fixtures, any red test, or a missing provenance comment blocks the merge.
- One implementation ticket at a time was the rule through 27–32; this ticket runs only after 32 is committed.
- Tracker/status updates on MAIN; product code and the merge happen via the worktree branch.
