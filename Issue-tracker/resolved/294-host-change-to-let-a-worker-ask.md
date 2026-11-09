# 294 — Option for the owner — a host change to let a worker ask

**Status:** resolved
**Type:** task
**Labels:** ready-for-human
**Severity:** P3 / low
**Ship blocker:** no — the product ships without a worker ask channel; a blocked worker reports and stops (ADR-0033), which is the recorded limit.
**Blocked by:** nothing, but see the last constraint: this cannot be done while the owner's instance is running.
**Origin:** the 2026-11-09 owner-channel decision that killed the un-pin approach (tickets 295, 296, 297, now cancelled), recorded against `docs/research/child-ask-seams.md` findings 1–6.
**Related:** 292 (the isolated proof that the seam exists but is pinned shut), 293 (the honest limit that stands today); ADR-0033 (asks removed), ADR-0036 (recorded by the cancellation).

## Why this ticket exists

With the un-pin approach dead, there is no in-tree route to a worker ask, and that is the correct state for the product to ship in. What is left is a question the plugin cannot answer: **would a small host change reopen the channel, and is it worth asking for?** This ticket is that question, written so the owner can rule on it. The plugin does not act on it.

The plugin cannot get there by bypassing the subagent path either. That is not a workaround: the permission preset pins a directly-created session the same way on `agent/created` (`dsh-permission-presets/lib/index.js:376-395`), and the path would additionally have to reimplement several internal-only behaviours. A host change is genuinely the only route.

## What the smallest host change would be

Two closed doors stand in the way, and the second is the one that matters:

1. **Questions are refused before their own waterfall.** `assertLiveRoot` throws `UserQuestionError` with code `DELEGATED_CALLER` when the calling agent is owned by another live agent (`dsh-user-questions/lib/index.js:539-543`), and that throw happens **before** the `user-questions/request` waterfall at `:707-712`. No policy, listener, or spawn option can reach past it.
2. **Approvals are closed earlier still, and the grant is unbounded.** The approval path returns `"rejected"` before its waterfall whenever the policy is `never` (`dsh-user-approval/lib/index.js:200`), and when it does dispatch, `approveEscalation` hands back the **requested** escalation mode without consulting the parent (`dsh-sandbox/lib/index.js:151-152`). So any host change must also let a caller **cap the granted mode** to what the parent could have granted itself; opening the channel alone would let a child run wider than its parent.

In one sentence: open a **bounded ask channel for an owned child** — let a delegated child reach the question/approval waterfall with the request routed to its owner, and let the granting side clamp the answer to the parent's own sandbox and approval mode.

## What it would unlock

- A worker can ask its dispatcher, or the user through the dispatcher, a clarification instead of ending the job early with a blocked report.
- A worker can request an escalation **bounded by the parent's mode** — never wider than what the parent itself could have granted.
- Everything the product decided against stays decided against: no worker-to-worker channel, no worker addressing the user directly, no worker widening its own scope.

## What this ticket is not

- Not a plugin change. No listener, no append, no policy rewrite, no contract text (that was 297, cancelled).
- Not a decision. It records the option and the evidence so the owner can rule.

## Acceptance criteria

- [ ] The owner decides one of: **ask the host upstream**, **do it**, or **drop it** — and the ruling is written on this ticket.
- [ ] The plugin does not attempt the change: no `src/` edit, no vendored-tree edit, no host patch, no listener that presupposes the channel exists.
- [ ] If the ruling is "drop it", the reason is recorded here and 293 stays the single place the limit is stated.
- [ ] If the ruling is "do it", it becomes an ordinary ticket with its own scope — this ticket closes with a pointer to it, and the restart is scheduled with the owner.

## Constraints

- Do not touch `dsh-user-questions`, `dsh-user-approval`, `dsh-sandbox`, `dsh-subagent`, or the vendored tree from this ticket.
- Do not weaken the `ask_user_question` denial in the worker tool barrier, and do not add prompt text that hints at a channel the host still refuses.
- A host edit needs **a dsh edit plus a restart**, so it is not ours to do while the owner is running. The owner's live instance on 3080 is never restarted to try this.
- Any host change must let the caller cap the granted mode; a change that opens the channel without the cap is worse than no change and must be refused.

## Comments

2026-11-09: Filed at the owner's channel after 295/296/297 were cancelled. Evidence lines were re-read against the installed host in this pass, not carried over.

## Comments

Owner's ruling 2026-11-10: not wanted. The current behaviour stands — a worker carries on or stops on its own, and only the dispatcher talks to the user. The option is recorded for the future but is not to be implemented.
