# 170 — Prompt pass: dead-end reporting, verification honesty, start acknowledgement, no method design

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing. Copy change only; no behaviour, no host seam, no dependency.
**Origin:** owner-directed prompt review, 2026-11-02, after studying the published `dsh-superagent-prototype` for prompt practice. Owner rulings in that session: add failure-mode reporting; make "failure is an acceptable and important outcome"; report a dead end at once instead of exhausting attempts; replace our "verify before claiming" line with the prototype's stronger version; remove the method-design clause from the dispatcher; add a "say what you are doing" rule.
**Superseded in part, 2026-11-03:** the owner then replaced the whole per-session dispatcher section, the standing rules and the wake-turn instructions with their own copy. Everything this ticket did to the dispatcher text is gone; **the worker-contract half stands and is the live part of this ticket.** The two-class split lives in ticket 173.
**Related:** ADR-0018 (copy policy — adapted copy only, no verbatim text), ADR-0028 (mid-task reply is metadata, not completion), ticket 153 (EN/ZH parity seam), ticket 122 (the worker reply channel), ticket 173 (two dispatcher classes).

## Problem

Five gaps in the model-facing copy, four in the worker contract and two in the dispatcher policy.

**Worker contract.**

1. The `## Final answer` section said the worker's text is delivered to the user "essentially verbatim". That invites a full engineering report into user-facing text. The prototype's rule is the opposite: keep evidence in the report, let the parent write the user-facing line.
2. Nothing told a worker how to end a task it could not finish. It could only hide the failure inside a normal-looking answer, and `mapStopReason` records that as `completed` regardless (`src/adapter/cordis-dsh-host.ts`).
3. A worker with no viable method was not told to say so early. The contract's `## Autonomy` points away from asking, so the cheapest behaviour is to keep retrying a known-bad approach until attempts run out — the most expensive outcome for the dispatcher, which could have redirected it.
4. `## Safety` said only "never present work as finished unless you observed it working". That is a rule without a check: no instruction to name the check, its result, or the check it could not run.

**Dispatcher policy.**

5. The `## How you work` section required the dispatcher to put "success criteria and report format" into every spawn prompt. That contradicts `CONTEXT.md`'s Chief of Staff definition — hand off "the problem and the wanted outcome, not the method" — and contradicts the worker contract, which tells the worker to judge scope and choose an approach itself.
6. The acknowledgement rule appeared in three prompt layers, all three as a *test* for when a todo may be marked `completed`. None instructed the dispatcher to actually acknowledge. A dispatcher could obey every rule and leave the user in silence while three workers ran.

**A seventh, found while making the change.** A worker's `reply_to_dispatcher` rides the peer delivery lane, so its wake rendered with the peer instruction block, whose step 3 says "ending the turn in silence is valid". `isWorkerReply` in `src/core/peer-types.ts` already existed and was tested, but **nothing in production called it**. A worker's `blocked` dead-end report — the exact message needing a decision — arrived under copy telling the dispatcher it could stay silent.

## Change

**`src/worker/prompt.ts`**

- New `## Reporting` section between `## Final answer` and `## Safety`, with a ZH counterpart `## 报告方式`; added to `WORKER_CONTRACT_HEADINGS` / `WORKER_CONTRACT_HEADINGS_ZH` in the same position.
- `## Final answer`: drops the "essentially verbatim" promise; keeps evidence in the body; the parent writes the user-facing version.
- `## Reporting` carries the new rules: failure is an acceptable and important outcome; report a dead end at once with status `blocked` rather than holding it while attempts run out; state plainly what was not verified.
- `## Safety`: the verification line now names the check and its result, and the checks that could not run. Added a restart line — inspect the working tree, `git` history and any outside system before repeating an action.
- EN and ZH edited together; both faces stay 52 lines, which `test/policy-zh-assets.test.ts` pins.

**`src/core/policy/prompts.ts`**

- `buildDispatcherPolicySection`, both faces: added a "say what you are doing before you start it" bullet; replaced the method-design clause with "Give it the problem, the constraints and the context it cannot look up itself. Do not design its method".
- `buildStandingRulesBlock`, both faces: added the same acknowledgement rule in one line.
- `buildWakeInstructionsBlock`, both faces: step 1 no longer repeats the acknowledgement criterion (it lives in the section and the reminder now); a settle still completes nothing.
- `SPAWN_WORKER_TOOL` description, both faces: the same no-method line as the policy.
- New `buildWorkerReplyWakeInstructionsBlock` (EN + ZH): wake instructions for a worker's own mid-task reply, where `blocked` means decide now and `progress`/`note` usually need nothing.

**`src/core/policy/assembler.ts`**

- `assemblePeerWakeTurn` uses the new block when every notice `isWorkerReply`. Mixed wakes keep the peer block, whose rules cover both senders. First production use of `isWorkerReply`.

**Tests**

- `test/policy-assembler.test.ts`: bullet count 19 → 20; the sha256 pin re-computed with a dated comment naming this ticket.
- `test/policy-zh-assets.test.ts`: unchanged; passed as-is after the ZH `git` identifier was backticked.

## Acceptance

- [x] Worker contract has `## Reporting` / `## 报告方式` in both faces, same position, and both faces are 52 lines.
- [x] The dead-end rule names `blocked` and says to report before attempts run out.
- [x] The verification rule names the check, its result, and unrun checks.
- [x] The dispatcher no longer asks for success criteria or report format in a spawn prompt, in either face or in the `spawn_worker` description.
- [x] The acknowledgement rule appears as an action in the system section and the standing rules, and the wake block no longer restates it.
- [x] A wake of worker replies renders the worker-reply block; a mixed or peer-only wake still renders the peer block.
- [x] `npx tsc -p tsconfig.json --noEmit` exits 0.
- [x] `test/policy-zh-assets.test.ts`, `test/policy-assembler.test.ts`, `test/worker-agent-type.test.ts`, `test/worker-reply.test.ts` pass (97/97).
- [ ] Full offline suite run — not yet; this ticket's change is copy only, but the suite has not been executed since the edit.
- [ ] Live check that a real worker's `blocked` reply produces the new wake copy — not run; needs the live-test protocol in `read-before-running-live-and-browser-tests.md`.

## Constraints

- Adapted copy only (ADR-0018 exception B9). No text from the prototype repository is reproduced; the rules were restated in our own words.
- No new tool, no new host dependency, no persistence, no UI.
- Both language faces move together; the parity pins in `test/policy-zh-assets.test.ts` are the gate.
- `## Reporting` is a new heading, which is a contract shape change — any future heading must keep EN/ZH order identical and line counts equal.

## Comments

**2026-11-02 — implemented ahead of filing.** The owner asked for the change directly in conversation and the copy was edited and tested before this ticket existed. Filing it now records the change and its rules; the repo's "log before implementing" rule was not followed for this pass, which is recorded here rather than hidden.
