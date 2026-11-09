# 297 — Worker contract: an approval ask may now be answered by the dispatcher

**Status:** cancelled
**Type:** task
**Labels:** ready-for-agent
**Severity:** P3 / low
**Ship blocker:** no — behaviour is unchanged for the worker until 295 and 296 land; this is the text that keeps it honest.
**Blocked by:** nothing.
**Origin:** 2026-11-09 lane decision; the current wording in `src/worker/prompt.ts` predates 295/296 and ADR-0033.
**Related:** 295, 296 (the behaviour this text describes), 292, 293 (the asks that stay impossible); ADR-0033.

## Problem

The worker contract's `## Limits` section currently tells a worker that what it can reach is fixed when it starts and cannot be widened, and that a blocked task ends in a report instead of an ask (`src/worker/prompt.ts`, EN and ZH faces). That was true when it was written. After 295 and 296 an approval ask from a worker reaches its dispatcher, and may be answered with one attempt's worth of permission.

Leaving the text as it is would be a lie with consequences: a worker that hits a gate will report blocked and stop, when the dispatcher could have allowed the attempt. Over-correcting is worse — the contract must not promise a question channel. Questions and plan approval stay unreachable (293).

## Acceptance criteria

- [ ] The `## Limits` section says, in plain language, that an action needing approval may be answered by the worker's dispatcher, and that the answer covers that attempt only.
- [ ] The same section says a denial or an expiry is final for that attempt: report what was blocked and why, do not retry the same ask in a loop.
- [ ] Both faces are updated together (EN and ZH) with the same meaning; neither face promises a user question channel, and neither claims the worker can widen its own scope.
- [ ] Section headings and their order are unchanged — they are stable test markers.
- [ ] No literal `{{` or `}}` enters the contract text.
- [ ] `npm run lint:docs` passes and the worker prompt tests stay green.

## Constraints

- New copy only. No prompt sentence, idiom, or structure copied from the reference tree; the file's own clean-room comment stands.
- Change the Limits wording only; do not touch other sections, and do not restate the host's delegation statement, which the host already injects.
- Do not soften the rule that the worker never messages the user or other agents. Only the approval ask changes.
- This ticket is text; if the wording and the implemented behaviour disagree, the behaviour wins and this text is the defect.

## Comments

2026-11-09: Filed from the design lane. The exact sentences are the implementer's, subject to the constraints above.
2026-11-09: Cancelled at the owner's channel — its premise (an ask may be answered) is dead and no contract text should change: the feature this ticket described is not shipping. See `docs/adr/0036-delegated-child-ask-needs-host-change.md` (proposed, pending owner confirmation).
