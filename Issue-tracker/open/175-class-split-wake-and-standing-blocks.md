# 175 — Class-split the standing rules and wake instructions, and record the dispatcher class per session

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing hard. `src/core/policy/prompts.ts` is being edited by ticket 173 and ticket 174 right now — land those first, or rebase onto them.
**Origin:** owner-directed, 2026-11-02/11-03, recorded in ticket 173 ("a class for dispatcher spawned dispatcher (not human spawned)"). This finishes the split ticket 173 started: one block was split, five were not.
**Related:** ticket 173 (the class split itself and its "Known limitation"), ADR-0034 (records the two-class split), ADR-0032 (a summoned dispatcher is a top-level session; question 1 stands), ticket 166 (the one-text ruling this reverses), ticket 174 / ADR-0033 (the access feature is being deleted — out of scope here), ticket 170 (owns `buildWorkerReplyWakeInstructionsBlock` — out of scope here), ticket 163 (the generation half of the same cold-resume seam).

## Problem

Ticket 173 gave the dispatcher two classes and branched exactly ONE prompt block on them: `buildDispatcherPolicySection`. The other blocks still take `language` and nothing else, so a summoned team leader currently receives copy written for the user's chief of staff.

Three separate faults, all verified in the tree:

1. **Standing rules are chief-of-staff rules.** `buildStandingRulesBlock(language)` (`src/core/policy/prompts.ts:414`) says "All non-trivial work, including planning, goes to a worker or a team", "Tell the user what you are doing before you do it", "A correction is a steer (`message_agent`), not a cloned worker". A team leader leads one large job: it chunks, dispatches, re-chunks, and reports progress to the dispatcher that summoned it. "A team" means nothing to it — it *is* the team leader — and "tell the user" names the wrong audience for progress.
2. **Wake instructions are chief-of-staff instructions.** `buildWakeInstructionsBlock(language)` (`:446`) says "Decide, for each result, whether the user should hear about it" and "Deliver through the user-facing send only". For a team leader a settle is a signal to re-chunk and dispatch the next parts, and the primary audience for that news is the summoner (via `message_agent`), not only its own user.
3. **The class is dropped after activation.** `src/adapter/parent-agent.ts` keeps four per-session maps — `sessions` (`:302`), `generations` (`:310`), `spawnGenerations` (`:321`), `spawnTitles` (`:331`) — and **no** origin map. `origin` is passed to `assembleSessionPolicy` once inside `bindActivation` (`:504`) and then thrown away. Every later composition point (`assembleTurnReminder` at `parent-agent.ts:425`, and `composeWakeText` at `src/plugin.ts:352`, which calls `assemblePeerWakeTurn` `:367`, `assembleTurnReminder` `:422`, `assembleWakeTurn` `:427`) therefore has no way to ask which class this session is.

The third fault is the reason the first two cannot be fixed by touching `prompts.ts` alone: without a recorded class, the callers still cannot ask.

Line anchors above are as read on 2026-11-03; concurrent tickets are editing `prompts.ts`, so re-read before editing.

## What needs to change

### 1. Record the class per session (`src/adapter/parent-agent.ts`)

- Add `const origins = new Map<string, DispatcherOrigin>()` beside the existing maps, with a doc comment saying why it is separate from `generations` (activation counter), `spawnGenerations` (tree depth) and `spawnTitles` (roster label): this one is "which policy class this session runs".
- Set it in `bindActivation` from the `origin` argument it already receives (`:478`).
- Delete it in `deactivateSession` (`:336`), the same way `spawnTitles` is deleted — the entry must not outlive the activation.
- Expose an accessor on `BindDispatcherLifecycleResult`, next to `dispatcherGeneration` (`:582`): `dispatcherOrigin(sessionId: string): DispatcherOrigin | null`, gated on `sessions` membership exactly like `dispatcherGeneration` and `activationGeneration`. Absent session → `null`, never a guessed class.

`origin` remains caller-supplied at activation: `plugin.ts:765` `onDispatcherSpawned` already passes `origin: "spawned"`, and the command path omits `options`, which defaults to `"user"` (`parent-agent.ts:538`). No new option is needed.

### 2. Thread the class into the three assemblers (`src/core/policy/assembler.ts`)

- `assembleTurnReminder(todos, peers?, language?, origin?)` (`:95`) — forwards to `buildStandingRulesBlock`.
- `assembleWakeTurn(notices, access?, language?, origin?)` (`:405`) — forwards to `buildWakeInstructionsBlock`.
- `assemblePeerWakeTurn(notices, language?, origin?)` (`:545`) — forwards to `buildPeerWakeInstructionsBlock`.

Append the parameter **after** `language`, and default it to `"user"`. Two reasons: `language` is the existing last positional argument everywhere, so an appended optional keeps every current call site and every existing test call compiling unchanged; and a default of `"user"` makes a caller that forgets the argument reproduce today's bytes rather than silently seating a team leader as a chief of staff.

### 3. Give the three blocks a class (`src/core/policy/prompts.ts`)

Keep `language` first and append `origin` — `buildStandingRulesBlock(language?, origin?)`, `buildWakeInstructionsBlock(language?, origin?)`, `buildPeerWakeInstructionsBlock(language?, origin?)`. Existing calls like `buildStandingRulesBlock("zh")` must keep working.

- Add a private `buildStandingRulesBlockEn` that dispatches on the class to two private builders (chief of staff, team leader), and a matching `buildStandingRulesBlockZh`. Same shape for the wake block and the peer wake block.
- The chief-of-staff texts stay byte-identical (ticket 173's sha pin discipline applies to the policy section; do not drift the other blocks either — the existing needles in `test/policy-assembler.test.ts` and `test/policy-zh-assets.test.ts` are the guard).
- Both faces move together: every new EN function needs an authored ZH counterpart with the same line count, same order, same backticked tool names. ZH is authored, not translated (ADR-0018 exception B9, ticket 153's rule).

### 4. Wire the callers

- `src/adapter/parent-agent.ts:425` — the per-turn reminder already reads `multitask.listTodos(agentSessionId)` inside the `agent/status` listener; pass `origins.get(agentSessionId) ?? "user"`.
- `src/plugin.ts:352` `composeWakeText` — take the class as one more argument (or a `originOf: (sessionId) => DispatcherOrigin | null` closure) and pass it to all three assembler calls. The wiring at `src/plugin.ts:708` builds the closure; it may read `lifecycle.dispatcherOrigin(sessionId)` there, under the same deferred-closure rule the surrounding comment already states for `host` and `pumpFor` (`lifecycle` is declared at `:1254`, and the closure only runs at wake delivery).
- `src/core/tools.ts:1580` `buildTurnReminderForSession` — leave it alone unless it gains a caller. It has none today. Record that decision rather than silently changing its signature.

### Out of scope, deliberately

- **`buildAccessPolicyBlock`** — the whole access feature is being deleted by ticket 174 under ADR-0033. Do not split it, do not thread a class into it. If ticket 174 has not landed when this ticket is implemented, wait or skip that block; do not create work that will be deleted.
- **`buildWorkerReplyWakeInstructionsBlock`** (ticket 170's block). It already carries the chief-of-staff audience in step 4 ("Tell the user when it changes what they are waiting for"). For a team leader that should point upward as well. It is not in this ticket because ticket 170 still owns the block and is open. Recorded as a follow-up: **the same defect survives there and the owner should know.** See §Comments.
- **Tool descriptions.** Both classes get the same eight tools (ticket 173's constraint), and `TOOL_DESCRIPTIONS` describes tools, not roles. No change.
- **The generation number.** A cold-resumed summoned dispatcher also loses its generation; that is ticket 163's defect 1, on the same seam (`onUserDispatcherResumed`). Do not fix it here — but coordinate before editing that call, because both tickets add an argument to it.

## Proposed team-leader EN text

New copy, drafted for this ticket. Not reference-tree text (ADR-0018 exception B9); adapted from our own existing blocks. The team-leader faces are **shorter** than the chief-of-staff faces (5 rules vs 6, 5 wake steps vs 6, 1 peer step vs 5) after the owner's 2026-11-03 edits, so EN/ZH parity is per class, and the parity pins must compare within a class rather than assume one shared count. ZH must be authored to match its EN face line for line.

### Standing rules — `spawned` class

```text
## Standing rules
- Chunk down tasks as much as you can, run as many lanes in parallel as you can. If any task can be run in parallel chunks, do that instead of giving to a single agent.
- Keep turns short: dispatch or re-chunk, then end or wait bounded (`await_agent`); never loop.
- A correction is a steer (`message_agent`), not a cloned worker. When a part is running and the direction changes, steer it.
- Plain and concise language, no jargon. Lead with what is now unblocked, not "it worked".
- Update the ledger and keep it lean. It is how you see what is running, what is parked, and what still needs splitting.
```

Why each rule moved:

| Chief of staff | Team leader | Reason |
|---|---|---|
| "All non-trivial work … goes to a worker or a team" | "Chunk down tasks as much as you can, run as many lanes in parallel as you can…" | A team leader *is* the team. "Or a team" is an instruction to summon a peer; it already was summoned. The replacement pushes chunking and parallelism instead. |
| "Tell the user what you are doing before you do it" | **deleted by owner ruling 2026-11-03** | The leader does not narrate to the user; the wake steps carry the reporting rule instead. |
| "Lead with the concrete thing, not 'it worked'" | "Lead with what is now unblocked" | The leader's news is *unblocking*, not a finished thing the user reads. |
| "A correction is a steer" | kept, plus "when a part is running and the direction changes" | Same rule; the clause names the case where it fires for this class. |

Bullet count: 5 (chief of staff keeps 6). The per-class parity pin must tolerate different counts per class.

### Wake instructions — `spawned` class

```text
## What to do now

1. Match each settled worker to its ledger entry (`todo_id` on the worker record). A settle closes one part, not the job.
2. Re-chunk what is left. A finished part usually changes the split: decide what can run in parallel now, and dispatch it before you answer anyone.
3. Report back to whoever gave you the task order. `message_agent` to your parent agent; use the user-facing send if the user directly ordered something from you.
4. Report failures early instead of exhausting save attempts. If the approach looks like a dead end, report at the first sign.
5. Silence is a valid outcome only when nothing changed for anyone above you.
```

Why each step moved:

| Chief of staff | Team leader | Reason |
|---|---|---|
| "A settle does not complete anything" | "A settle closes one part, not the job" | Same discipline (ADR-0007: a settle completes nothing), restated for a job made of many parts. |
| (absent) | step 2, "Re-chunk what is left" | This is the leader's actual job after a settle. The chief of staff has nothing to re-chunk; a leader that only reads results and never re-dispatches stalls the job. |
| "whether the user should hear about it" + "Deliver through the user-facing send only" | step 3, merged by owner ruling 2026-11-03 | One rule, one audience test: report to whoever gave the order. `message_agent` upward; user-facing send only when the user ordered the work directly. |
| "report the honest state and decide: retry as a new spawn, steer …, or drop" | step 4, "report at the first sign" | Owner ruling 2026-11-03: report early instead of burning attempts. The old three-way retry menu is gone. |
| "Silence is a valid outcome" | "only when nothing changed for anyone above you" | Silence is still valid, but the test is stronger: a settle that changes nothing the summoner needs is silence; one that changes the plan is not. |

Step count: 5 (chief of staff keeps 6).

### Peer wake instructions — `spawned` class

```text
## What to do now

1. Treat every message above as coming from another assistant — not from the user.
```

Steps 2–5 are deleted for this class by owner ruling 2026-11-03. Only the provenance rule survives: a team leader must never mistake a peer note for user input. Step count: 1 (chief of staff keeps 5).

## Requirements

- **R1** A per-session class record exists in `parent-agent.ts`, is cleared on deactivation, and is readable through `dispatcherOrigin(sessionId)`; a dormant session answers `null`.
- **R2** `assembleTurnReminder`, `assembleWakeTurn` and `assemblePeerWakeTurn` accept the class as a trailing optional argument, defaulting to `"user"`, and forward it to their block.
- **R3** `buildStandingRulesBlock`, `buildWakeInstructionsBlock` and `buildPeerWakeInstructionsBlock` accept `(language?, origin?)` in that order; `buildStandingRulesBlock("zh")` still compiles and returns the ZH chief-of-staff text.
- **R4** Every caller passes the real class: `parent-agent.ts:425`, and all three calls inside `composeWakeText`.
- **R5** EN and ZH faces stay line-for-line equal for both classes of both blocks (`test/policy-zh-assets.test.ts` is the gate); ZH is authored, not a translation.
- **R6** Chief-of-staff output is byte-identical to today for every block this ticket touches — no drift, no reflow. A test asserts equality against a literal or a sha, per the ticket-173 convention.
- **R7** No tool surface changes: both classes still get the same eight tools.
- **R8** The access block is untouched (ADR-0033 / ticket 174 deletes it).
- **R9** Offline tests only. No network, no LLM, no live dsh.

## Cold resume: this ticket fixes it, and here is why

Ticket 173 records that the class is not durable, so a cold-resumed summoned dispatcher reads as chief of staff. **This ticket fixes that instead of inheriting it**, because the durable answer already exists and costs no schema change.

The reasoning, verified in the tree:

- `DurableDispatcherMark` (`src/core/durability.ts:128`) carries `sessionId`, `parentSessionId` and `generation`. It does **not** need a fourth field, because the row's *presence* already means "this plugin spawned this session as a dispatcher": `writeDispatcherMark` is called only from the spawn path (`src/adapter/cordis-dsh-host.ts:2572`), and `parseDispatcherMark` rejects generation 1. A user-started dispatcher never gets a row.
- A summoned dispatcher is a top-level session (ADR-0032), so its cold resume takes the parentless branch (`cordis-dsh-host.ts:1963-1974`) into `resumeUserStartedDispatcher` (`:1883`) — it never reaches `resumeMarkedDispatcher` (`:1720`), which is the parented branch. That is exactly why the class falls back today: `onUserDispatcherResumed` (`src/plugin.ts:794`) calls `lifecycle.activate(agent)` with no options, and `parent-agent.ts:538` defaults to `"user"`.
- By the time that hook runs, the host has **already** established the session is a dispatcher, and it has a synchronous, durable way to say which kind: `dispatcherMarkAnswer(sessionId)` (`:2057`) answers `"dispatcher"` from the mark mirror, falling back to the store's `peekDispatcherMark`. A `"dispatcher"` answer on this path therefore means "spawned by a dispatcher in an earlier process" — the `spawned` class.

So the fix is: the resume hook passes the class, computed as `dispatcherMarkAnswer(sessionId) === "dispatcher" ? "spawned" : "user"`, and `plugin.ts` forwards it as `origin` on the existing `lifecycle.activate(agent, options)` call. No new table, no `DOMAIN_VERSION` bump, no change to what a mark means.

Two honest limits, both to be recorded in the code comment when implemented:

- `dispatcherMarkAnswer` can answer `"unknown"` while the durable store has not opened. On this path the projection has already returned `"dispatcher"`, so the answer is not `"unknown"` in practice; if it ever is, fall back to `"user"` (today's behaviour) and say so in a comment rather than guessing `spawned`.
- If the implementer finds the probe unusable at that moment, the fallback is to **inherit** the gap: ship the split without the resume fix, and update ticket 173's limitation to say the class still falls back after a restart. Do not widen `DurableDispatcherMark` for this — that is a persistence change needing its own ticket, which is exactly what ticket 173 declined to do.

The generation half of the same seam belongs to ticket 163. Coordinate so the two arguments are added once.

## Acceptance criteria

- [ ] `origins` map added, set at activation, deleted at deactivation; `dispatcherOrigin(sessionId)` answers the live class or `null`.
- [ ] `assembleTurnReminder`, `assembleWakeTurn`, `assemblePeerWakeTurn` take the class as a trailing optional defaulting to `"user"`.
- [ ] `buildStandingRulesBlock` / `buildWakeInstructionsBlock` / `buildPeerWakeInstructionsBlock` take `(language?, origin?)` and branch on the class.
- [ ] A summoned dispatcher's per-turn reminder renders the team-leader standing rules; a user chat renders the chief-of-staff ones.
- [ ] A summoned dispatcher's settle wake renders the team-leader wake steps; a user chat renders the chief-of-staff ones.
- [ ] Chief-of-staff bytes for all three blocks are unchanged (pin proves it).
- [ ] EN/ZH line parity holds for both classes of both blocks; the ZH text is authored.
- [ ] A cold-resumed summoned dispatcher gets the team-leader class (new test), or — if the probe route was rejected — ticket 173's limitation is updated to say it does not, and the reason is recorded here.
- [ ] The existing cold-resume test that pins the chief-of-staff fallback (`test/spawn-dispatcher-activation.test.ts:1304-1313`) is updated to the new expectation, not deleted.
- [ ] `npx tsc -p tsconfig.json --noEmit` exits 0; the policy tests, both activation tests, and the ZH parity test pass.
- [ ] `node tools/issue-index.mjs --check` and `node tools/adr-index.mjs --check` are clean.

## Constraints

- Adapted copy only (ADR-0018 exception B9). The text above is new; do not copy it from anywhere.
- Do not edit `src/core/policy/prompts.ts` while ticket 173 or ticket 174 is mid-flight on it. Rebase, then land this.
- Keep `language` first in every signature. Reordering it would churn every call site for no gain.
- Do not add a third class, and do not add a per-turn class switch. The class is fixed for the session's lifetime, the same way `ADR-0005` fixed the policy.
- No new jargon in the model-facing text: no codenames, no private vocabulary. "The dispatcher that handed you this job" is deliberately plain.
- Do not re-open ADR-0032's settled decisions. Question 1 ("a summoned dispatcher addresses its own user directly") stands; this ticket changes the *shape of the work*, not who may speak.

## Comments

**2026-11-03 — filed by an investigation pass, not by the implementer.** Found while recording the two-class split for the ADR/PRD pass. One adjacent defect is **not** covered here and needs the owner's attention: `buildWorkerReplyWakeInstructionsBlock` (ticket 170's block, reached through `assemblePeerWakeTurn`) still tells a team leader to "tell the user when it changes what they are waiting for". For a summoned leader, a blocked worker reply should also go upward to its summoner. It is excluded because ticket 170 still owns that block; if ticket 170 closes first, file the follow-up or fold it in.
