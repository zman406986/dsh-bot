# 287 — Eight adapted-copy follow-ups from the 2026-11-08 bounded review
**Status:** resolved
**Labels:** needs-owner-decision
**Priority:** low-medium — F1 is a false channel claim; the rest are wording consistency.
**Severity:** P3 / low
**Ship blocker:** no
**Origin:** docs/research/no-verbatim-copy-review-2026-11-08.md (ticket 183), 2026-11-08, reviewed window 5dbf04c..3d08313.
**Blocked by:** owner approval for changes to owner-supplied prompt copy and user-facing UI copy. No implementation question is open.
## Problem
The bounded copy review passed with no verbatim violation, but recorded eight concrete wording or channel defects. They are listed here so the review's findings are tracked; none was fixed during the review.
## Findings
1. **F1 (medium) — false channel claim in the team-leader wake.** src/core/policy/prompts.ts:555 and :584 tell the team leader to use "the user-facing send". ADR-0009:12, src/core/tools.ts:1243-1246 and test/dispatcher-tools.test.ts:633 record that the shipped plugin wires no `deliverToUser`. The chief-of-staff step in the same block was already corrected to the reply channel at :534.
2. **F2 (low-medium) — ZH peer step 4 points at missing parentheses.** src/core/policy/prompts.ts:658 refers to parentheses next to the sender's name, but the renderer prints them only for worker senders (assembler.ts:489-496). EN was corrected to "shown above" at :629; ZH was not.
3. **F3 (low) — ZH never quotes the handoff label.** EN names `Summoning dispatcher session id` at :349, :555 and :738; ZH paraphrases it three ways at :373, :584 and :764.
4. **F4 (low) — one parameter, two words.** `todo_id` is called "Ledger entry" in `deliver_result` (src/core/tools.ts:1207) and "todo entry" in `spawn_worker` (:843), undoing the 10-28 ledger-to-todo normalization.
5. **F5 (low-medium) — user-facing tool card written to the dispatcher.** `toolview.deliver.recorded` (src/client/overlay.ts:198 and :528) says "say it in your reply" / "请在你的回复中告知用户".
6. **F6 (low) — two identical steer states.** `toolview.steer.pending` and `.sent` are the same text in both faces (src/client/overlay.ts:187-188 and :519-520), unlike spawn/stop/message.
7. **F7 (low) — ZH priority adjective returns.** `toolview.fact.priority` ZH "优先" (src/client/overlay.ts:495) reintroduces the form the 10-28 pass replaced with 优先级.
8. **F8 (cosmetic) — one action, two ZH words.** ZH steer copy uses 中途指示 (src/client/steer-command.ts:103) and 纠偏 (:105, :108).
## Requested work
Owner rules on the F1 wording (reply channel) and approves or edits each remaining item. Then one copy pass fixes the approved set, updates the affected tests or snapshots, and leaves the review note and its PASS verdict intact.
## Acceptance
- F1 either states the reply channel like the chief-of-staff step, or cites an owner decision that a user-facing send exists.
- Each remaining finding is fixed or explicitly declined by the owner, with the decision recorded here.
- No historical review record is rewritten; this ticket and the note carry the follow-up trail.
## Checks
Filing only: line reads in the reviewed blob and the current tree. No tests, build, network or live session. See the note for the review method and its stated limits.

## Comments

2026-11-08 — **Owner approved the pass; closed.** The owner ruled F1 on the reply channel, approved F2–F7 as proposed, and chose 中途指示 as the one ZH word for steering (F8).

- **F1** — the EN and ZH team-leader wake steps now say a direct user order is answered in the leader's reply ("that reply is the channel they read" / "用户读到的就是这条回复"). The claim that a user-facing send exists is gone; the peer and worker-reply prohibitions are unchanged.
- **F2** — ZH peer step 4 points at the sender id shown above, not at parentheses that are usually absent.
- **F3** — the three ZH handoff references quote the fixed `Summoning dispatcher session id` label.
- **F4** — `deliver_result`'s `todo_id` is described as a "Todo entry".
- **F5** — the delivery card says the result arrives in the reply in both faces.
- **F6** — an accepted steer reads "Steer queued for …" / "已为 … 排队中途指示".
- **F7** — the ZH priority fact is 优先级.
- **F8** — 纠偏 was replaced by 中途指示 across the ZH steering copy: the steer command's success and refusal lines, the roster button, the model-facing policy, and F6's new sentence.

Tests updated: `test/policy-assembler.test.ts` (EN team-leader wake pin and the ZH quoted-label allowance), `test/policy-zh-assets.test.ts` (quoted-label allowance in the untranslated-word sweep), `test/client-toolviews.test.ts` (delivery card and accepted-steer copy), `test/steer-command.test.ts` (ZH success copy). Full gate: `npm test` 1311/1311, `npm run typecheck` clean, `npm run lint:docs` clean.
