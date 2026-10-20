# 119 — Policy, PRD, CONTEXT, worker barrier, and ADR row for the dispatcher peer model

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 116, 117, 118
**Related:** ADR-0025, ADR-0027, ADR-0028, ADR-0029 (rows/notes already recorded), ticket 114 (0.2.1 port and the native-dsh posture), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §3 and §9 (untracked input, not authority)

## Problem

The ADRs rule the behaviour, but the text the model reads still describes the old contract: the dispatcher policy has no `message_agent` or `await_agent` line, the worker prompt says the only channels back are the final answer and the access ask, the PRD still says peer send is fire-and-forget, and the worker tool barrier has no deny entries for the new names. Shipping code whose prompt contradicts it produces a dispatcher that does not know the tools exist.

## What to do

- [ ] `src/core/policy/prompts.ts`, dispatcher "How you work": add lines for messaging any visible agent (worker → correction, dispatcher → assistant-to-assistant, never the user), for creating one dispatcher peer, and for one bounded wait when the next step is genuinely blocked.
- [ ] `src/core/policy/prompts.ts`, "What you never do": replace the absolute poll ban with the narrowed rule — `check_workers` is a snapshot, no repeated checks, no sleeping, never wait unbounded; one bounded `await_agent` on the worker actually needed is the only wait.
- [ ] `src/core/policy/prompts.ts`, `buildStandingRulesBlock()`: replace "Do not wait on workers." with the bounded-wait wording.
- [ ] **ADR-0028 obligation:** update `src/worker/prompt.ts` so the "only channels back" statement names the mid-task reply channel. As of this filing it says the only channels are the final answer and the access ask, and that gap is owed to ADR-0028 decision 4. Add a test pinning that the contract names all three.
- [ ] `src/worker/tool-barrier.ts`: add `message_agent`, `await_agent`, `spawn_dispatcher` to the deny-list candidates. Keep `send_peer`.
- [ ] PRD amendments, quoting the design note §3 replacements: §4 S9 (bounded await), §6.1 (dispatcher policy), §6.2 (spawning row), §6.3 (tool table), §6.4 (anti-patterns and the wake table's peer row), §7.6 (Phase 2 peers), §10 (prompt assets), §16 (glossary).
- [ ] `CONTEXT.md`: dispatcher may spawn workers and one dispatcher peer at the same conceptual layer; worker stays a leaf; peer agent includes a dispatcher another dispatcher created.
- [ ] `docs/adr/README.md`: the 0025/0027/0028/0029 rows already carry their settled-bounds notes from the 2026-10-18 records pass — **verify, do not duplicate**. ADR-0025/0026/0027/0028/0029 files are already in `docs/adr/`; no move is needed (the design note's "move on sign-off" step is stale).
- [ ] Re-run `node tools/adr-index.mjs` and `node tools/issue-index.mjs`, then `npm run lint:docs`.

## What this ticket must NOT do

- Do not re-open a settled ADR. Bounds and identities are decided in the ADR bodies; this ticket only puts them into prose.
- Do not state a worker glyph exists. The worker marker lives in the conversation header (ticket 123), not the sidebar.
- Do not describe `contextPressure.contextWindow` as the compaction trigger denominator (ADR-0029 says it is not).

## Constraints

- Text must describe **shipped** behaviour; this is why it is blocked by 116, 117, and 118.
- Worker policy stays byte-identical except the ADR-0028 channel sentence. A test should pin that.
- No em-dash-only rewording drift: the PRD replacements come from the design note §3, adjusted only where an ADR overrides them (mitosis bounds, chatroom bounds).

## Comments

### 2026-10-18 — filing

Filed from design note §12 ticket 119, with one correction: the ADR row/move step is already done — all five ADRs are filed under `docs/adr/` and their index rows carry the settled decisions. This ticket verifies the rows and does not move files.

The worker-prompt update is not new scope: ADR-0028 decision 4 already records it as an owed obligation.
