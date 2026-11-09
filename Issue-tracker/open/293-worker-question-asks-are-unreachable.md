# 293 — Worker questions and plan approval stay unreachable, and that is the recorded limit

**Status:** open
**Type:** task
**Labels:** ready-for-human
**Severity:** P3 / low
**Ship blocker:** no — nothing breaks; this records what the feature deliberately cannot do.
**Blocked by:** nothing.
**Origin:** 2026-11-09 design lane, re-read against `docs/research/child-ask-seams.md` finding 4 and the host's own source at the lines below.
**Related:** 289, 290 (approvals only), 291 (where the limit is stated to the worker), ADR-0033.

## Problem

Approvals can be answered for a worker. Questions cannot, and no amount of policy or listener work changes that.

`assertLiveRoot` (`dsh-user-questions/lib/index.js:539-543`) throws a `UserQuestionError` with code `DELEGATED_CALLER` when the calling agent is not in `agents.roots()`, and owned children are excluded from roots (`dsh-agent/lib/index.js:752-754`). The throw happens **before** the `user-questions/request` waterfall (`:707-712`), so no policy, no listener, and no spawn option can reach it. The callers that hit it are `ask_user_question` (`dsh-tool-ask-user/lib/index.js:180-198`, `:305-314`) and plan review / `exit_plan_mode` (`dsh-plan-mode/lib/index.js:264-291`). The child sees an immediate tool error, never a wait.

Plainly: a worker cannot ask its dispatcher or the user a question. Our worker tool barrier also denies `ask_user_question` by name (`src/worker/tool-barrier.ts:19`), so the tool is not even offered. This ticket is the honest limit of the feature that 289 and 290 build, and the one place the decision is recorded.

## Acceptance criteria

- [ ] The limit is quoted with its `file:line` evidence in the worker contract's `## Limits` section, and that edit is tracked by 291.
- [ ] This ticket stays the single place this decision is recorded; the contract, the ADRs, and later tickets point here instead of restating it in their own words.
- [ ] The owner's ruling is recorded here: accept the limit as it stands, or authorise asking the host for a change later. Neither is assumed by this ticket.
- [ ] If a future host version exposes a question channel for owned children, this ticket is the one to reopen — nobody widens the worker surface on the strength of a changelog.

## Constraints

- Do not attempt a host change, patch, or vendored edit to make a question reachable.
- Do not weaken or remove the `ask_user_question` denial in the worker barrier; the host would refuse the call anyway.
- Do not let prompts hint at a question channel "just in case" — a promise the host refuses is worse than the limit.
- No code change in this ticket. It is a decision record plus one linked sentence in 291.

## Comments

2026-11-09: Filed from the design lane at the owner's channel. The evidence lines were re-read, not carried over from the research note.
