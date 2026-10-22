# 119 — Policy, PRD, CONTEXT, worker barrier, and ADR row for the dispatcher peer model

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 116, 117, 118
**Related:** ADR-0025, ADR-0027, ADR-0028, ADR-0029 (rows/notes already recorded), ticket 114 (0.2.1 port and the native-dsh posture), design `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` §3 and §9 (untracked input, not authority)

## Problem

The ADRs rule the behaviour, but the text the model reads still describes the old contract: the dispatcher policy has no `message_agent` or `await_agent` line, the worker prompt says the only channels back are the final answer and the access ask, the PRD still says peer send is fire-and-forget, and the worker tool barrier has no deny entries for the new names. Shipping code whose prompt contradicts it produces a dispatcher that does not know the tools exist.

## What to do

- [x] `src/core/policy/prompts.ts`, dispatcher "How you work": add lines for messaging any visible agent (worker → correction, dispatcher → assistant-to-assistant, never the user), for creating one dispatcher peer, and for one bounded wait when the next step is genuinely blocked.
- [x] `src/core/policy/prompts.ts`, "What you never do": replace the absolute poll ban with the narrowed rule — `check_workers` is a snapshot, no repeated checks, no sleeping, never wait unbounded; one bounded `await_agent` on the worker actually needed is the only wait.
- [x] `src/core/policy/prompts.ts`, `buildStandingRulesBlock()`: replace "Do not wait on workers." with the bounded-wait wording.
- [x] **ADR-0028 obligation:** update `src/worker/prompt.ts` so the "only channels back" statement names the mid-task reply channel. As of this filing it says the only channels are the final answer and the access ask, and that gap is owed to ADR-0028 decision 4. Add a test pinning that the contract names all three.
- [x] `src/worker/tool-barrier.ts`: add `message_agent`, `await_agent`, `spawn_dispatcher` to the deny-list candidates. Keep `send_peer`.
- [x] PRD amendments, quoting the design note §3 replacements: §4 S9 (bounded await), §6.1 (dispatcher policy), §6.2 (spawning row), §6.3 (tool table), §6.4 (anti-patterns and the wake table's peer row), §7.6 (Phase 2 peers), §10 (prompt assets), §16 (glossary).
- [x] `CONTEXT.md`: dispatcher may spawn workers and one dispatcher peer at the same conceptual layer; worker stays a leaf; peer agent includes a dispatcher another dispatcher created.
- [x] `docs/adr/README.md`: the 0025/0027/0028/0029 rows already carry their settled-bounds notes from the 2026-10-18 records pass — **verify, do not duplicate**. ADR-0025/0026/0027/0028/0029 files are already in `docs/adr/`; no move is needed (the design note's "move on sign-off" step is stale).
- [x] Re-run `node tools/adr-index.mjs` and `node tools/issue-index.mjs`, then `npm run lint:docs`.

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

### 2026-10-22 — progress pass (Status stays claimed)

Blockers 116/117/118 are resolved; the dispatcher surface is eight tools. Text only — no edit under `src/core/tools.ts`, `src/adapter/`, `src/plugin.ts`, or `src/client/`.

**`src/core/policy/prompts.ts`**

Added to `## How you work` (after "Workers cannot talk to the user. Only you deliver."):

- "You may message any agent you can see (`message_agent`). To a worker it is a correction to work in flight; to another dispatcher it is one assistant writing to another. It is never delivered as the user, and it never counts as the user speaking."
- "If your next step is blocked on one worker's result, wait on that worker once (`await_agent`), bounded. Waiting is not polling."
- "You may summon another dispatcher (`spawn_dispatcher`). It is a peer: same tools, same policy, its own ledger and inbox. It cannot talk to the user, so its work reaches the user only through you. It is not awaitable — message it, and its answer arrives later on its own."

Replaced in `## What you never do`:

- old: "Poll a worker in a loop during a turn. Spawn, steer, stop, or check once — then move on or end the turn."
- new: "Poll in a loop. `check_workers` is a snapshot: do not call it repeatedly, do not sleep between checks, and never wait with no bound. One bounded `await_agent` on the worker you actually need is the only wait."

Replaced in `buildStandingRulesBlock()`:

- old: "- Short turn: reply or act, then end. Do not wait on workers."
- new: "- Short turn: reply or act, then end. One bounded wait on one worker is allowed; never loop."

Two remaining `send_peer` prose mentions replaced with `message_agent` semantics: `PEER_ROSTER_INTRO` ("…you can message with message_agent…") and `buildPeerWakeInstructionsBlock()` step 4 ("use message_agent addressed to the sender's session id"). Both are model-facing; the retired NAME stays exported for the client toolview registry and stays in the worker deny candidates.

**`src/worker/tool-barrier.ts` — verification only, no edit needed.** All eight dispatcher names plus the retired `send_peer` are already candidates (116/117/118 added the last three). Added a structural test rather than another comment: it iterates `DISPATCHER_TOOL_NAMES` and asserts every name is a deny candidate and that `buildWorkerToolFilter` denies it, so a ninth dispatcher tool cannot ship without a deny entry.

**`src/worker/prompt.ts` — already satisfied.** ADR-0028 decision 4's obligation landed in ticket 122: the Limits section reads "Your only channels back are your final answer, the mid-task reply described below, and, when a gated action needs one-time access, the access ask described below." Pinned by `test/worker-agent-type.test.ts` ("Limits names all three channels back"). No further edit; worker policy stays byte-identical otherwise.

**PRD (`PRD-dsh-multitask-dispatcher.md`)** — §4 S9, §6.1 (two appended bullets), §6.2 (Spawning row), §6.3 (Steer row corrected to `steer_worker`, plus Message/Await/Spawn-dispatcher rows), §6.4 (anti-pattern narrowed, peer wake row now a structured `agent-message` source), §7.6 (Transport/Wake/Priority replaced, Join and Bounds appended), §10 (await added to the tool-description row), §16 (Spawned dispatcher and Await rows). Wording follows the design note §3, adjusted where ADR-0025 overrides it: the note says "generation 1 only" and "4 live spawned dispatchers", but ADR-0025 decision 5 and §Starting bounds rule **no cap of ours**, so the PRD says the host's own depth ceiling and live-child pool are the bounds. Chatroom bounds (ADR-0026) are not referenced — no room ships.

**`CONTEXT.md`** — the four entries from the audit exist and were checked against shipped code:

- Mitosis: correct as written, unchanged.
- Chatroom: prose is right but nothing ships (ticket 125 is open), so it now says "Not yet implemented (ticket 125)."
- Mid-task reply: said "also called RespondToCoordinator" — that is the ZCode reference name, not ours. Now names the shipped tool: "shipped as the worker-only `reply_to_dispatcher` tool (ADR-0028)."
- Compaction boundary: correct — `CompactionBoundary` in `src/core/durability.ts:64` is one row keyed by session id, newest `passSeq` wins, and `boundarySeq` is the resume cut. Unchanged.
- Also added: a **Dispatcher** entry, because ADR-0025's "may spawn workers and one dispatcher peer at the same conceptual layer" had no glossary home. Peer agent gained "Includes a dispatcher another dispatcher created (ADR-0025)." Worker is already correct ("a leaf — it never spawns other agents") and did not change.

**ADR index** — verified, no edit. Rows 0025–0029 carry their settled-bounds notes; `node tools/adr-index.mjs --check` reports fresh (30 rows). No file move was needed, per the filing comment.

**Not done, deliberately.** No `node tools/adr-index.mjs` write, no `node tools/issue-index.mjs` write, no `npm run lint:docs` — the constraint on this pass was typecheck plus one grouped test run, and both index `--check` commands already report fresh. The ticket's last checkbox is the closer's, not this pass's.

**Gates.** `npx tsc -p tsconfig.json --noEmit` clean. One grouped tsx run over `test/policy-assembler.test.ts`, `test/policy-peer-roster.test.ts`, `test/worker-agent-type.test.ts`, `test/restart-honesty.test.ts`, `test/adapter-policy-inject.test.ts`, `test/dispatcher-tools.test.ts`: **121 tests, 121 pass, 0 fail**. New pins: six policy-doctrine pins in `policy-assembler.test.ts` (one per new line, plus the poll-ban narrowing, the standing-rule replacement, the reply path, and an assertion that no dispatcher-facing copy still names `send_peer`), one structural barrier pin in `worker-agent-type.test.ts`, and the updated `PEER_ROSTER_INTRO` pin in `policy-peer-roster.test.ts`.

**Contradiction found, not fixed (out of scope: text/doctrine ticket).**

1. `buildAccessPolicyBlock()` at `src/core/policy/prompts.ts:210` tells the dispatcher to "Answer with resolve_access (allow or deny)" — **no `resolve_access` tool is registered anywhere**. Searched `src/`: the only hits are that prompt line itself and the reference-notes file that flags the same gap (`docs/research/reference-architecture-patterns.md:83`). The shipped answer paths are `Multitask.resolveAccess` reached through the adapter's resolve command and approval cards (`src/adapter/resolve-command.ts`, `src/adapter/access-prompt.ts`), neither of which is a model-facing tool. So the model is told to call a verb it cannot call. Needs its own ticket (either register the tool or rewrite the line to name the real path).
2. `buildDispatcherPolicySection()` also says "Progress is conveyed by your own narration and the workers panel". Since ADR-0024/ticket 114 the roster panel is retained-but-unmounted (`docs/surfaces.md:150`, `:250`), so in the default posture there is no workers panel to point at. Not in this ticket's named scope; flagging rather than rewriting doctrine that ticket 114/123 may still be settling.
3. The design note §3.3 replacement said a spawned dispatcher "may spawn workers but never another dispatcher." Shipped code has **no generation gate** — `src/core/tool-results.ts:109` states "no `recursion-limit`, no `dispatcher-cap`, no generation counter", and ADR-0025 §Starting bounds explicitly leaves a child's own mitosis open ("A child dispatcher may itself summon another dispatcher; the host's depth and pool values are what stop it"). I wrote the PRD row to the ADR/code ("bounded by the host's depth ceiling and live-child pool, with no cap of ours") rather than the note's generation-1 line. Recorded here because the ADR's own Consequences table still lists a "Further dispatchers | Refused (`recursion-limit`)" row that the shipped code contradicts — that is ADR-level and needs its own records pass, not a silent edit. **Independently found and filed as ticket 131** (2026-10-22, needs-triage): the host depth ceiling does not refuse a mitosis hop either, because every hop raises its own ceiling in lockstep. My PRD wording names both the depth ceiling and the live-child pool as the bounds; ticket 131 shows only the pool actually binds, so the PRD sentence may need a further trim once that ticket is ruled. I did not pre-empt the ruling.

4. `docs/adr/0025` §Consequences and ticket 118's test list still expect a generation-1 refusal that the code does not implement — same finding as above, already tracked as ticket 131. Nothing in this pass touched either file.

## Answer

Resolved 2026-10-22. The prose the model reads now describes the shipped eight-tool dispatcher, and the PRD/CONTEXT carry the peer model. Every citation below was spot-checked at the named line before resolution (`src/core/policy/prompts.ts` :81, :126, :154-156, :161, :166, :178, :216, :236; `PRD-dsh-multitask-dispatcher.md` :75, :122-123, :136, :147-150, :163, :168, :287, :355, :434-435; `CONTEXT.md` :11-40; `src/worker/tool-barrier.ts` :31-51; `src/worker/prompt.ts` :61). Gates re-run at resolution: `npx tsc -p tsconfig.json --noEmit` exit 0; one grouped run of the six files named in the progress comment **121 tests / 31 suites / 121 pass / 0 fail**; `node tools/doc-lint.mjs && node tools/issue-index.mjs --check && node tools/adr-index.mjs --check` all green (index 14 rows after this move, ADR index 30 rows).

**Dispatcher policy — three added lines** (`buildDispatcherPolicySection()`, `src/core/policy/prompts.ts:154-156`), after "Workers cannot talk to the user. Only you deliver." (:150):
1. `message_agent` — "You may message any agent you can see … To a worker it is a correction to work in flight; to another dispatcher it is one assistant writing to another. It is never delivered as the user, and it never counts as the user speaking."
2. `await_agent` — "If your next step is blocked on one worker's result, wait on that worker once (`await_agent`), bounded. Waiting is not polling."
3. `spawn_dispatcher` — "It is a peer: same tools, same policy, its own ledger and inbox. It cannot talk to the user … It is not awaitable — message it, and its answer arrives later on its own."

**"What you never do" narrowed** (:166). The old absolute "Poll a worker in a loop during a turn" became: "Poll in a loop. `check_workers` is a snapshot: do not call it repeatedly, do not sleep between checks, and never wait with no bound. One bounded `await_agent` on the worker you actually need is the only wait."

**Standing rule rewritten** (`buildStandingRulesBlock()`, `:178`). Old "- Short turn: reply or act, then end. Do not wait on workers." → new "… One bounded wait on one worker is allowed; never loop."

**Both stale `send_peer` prose mentions replaced.** `PEER_ROSTER_INTRO` (:126) now says "…you can message with message_agent…"; `buildPeerWakeInstructionsBlock()` step 4 (:236) now says "use message_agent addressed to the sender's session id". No model-facing string names `send_peer` any more — pinned by `test/policy-assembler.test.ts:448` ("no dispatcher-facing copy still names the retired send_peer"), which iterates the dispatcher section, standing rules, peer wake tail, roster intro, and every tool description. The name still exists only as a client toolview key and a deny candidate (deliberate; ticket 116).

**Barrier — verified, no edit needed.** `src/worker/tool-barrier.ts:31-51` already denies all eight dispatcher names plus the retired `send_peer`. Rather than another comment, `test/worker-agent-type.test.ts:135` now iterates `DISPATCHER_TOOL_NAMES` and asserts each is a deny candidate AND denied through `buildWorkerToolFilter`, so a ninth dispatcher tool cannot ship without a deny entry.

**Worker prompt (ADR-0028 decision 4) — already satisfied before this ticket.** `src/worker/prompt.ts:61` reads "Your only channels back are your final answer, the mid-task reply described below, and, when a gated action needs one-time access, the access ask described below." Pinned by `test/worker-agent-type.test.ts:274`. No edit; worker policy is byte-identical otherwise.

**PRD amended** (`PRD-dsh-multitask-dispatcher.md`): §4 S9 (:75, bounded await), §6.1 (:122-123, two bullets), §6.2 Spawning row (:136), §6.3 (:147-150 — the Steer row corrected to `steer_worker`, plus Message/Await/Spawn-dispatcher rows), §6.4 (:163 peer wake source is the structured `agent-message`; :168 anti-pattern narrowed), §7.6 (:287 Join row; Transport/Wake/Priority replaced), §10 (:355), §16 (:434-435).

**Design-note bounds deliberately NOT copied — recorded decision.** The design note §3 says a spawned dispatcher is "generation 1 only" and allows "4 live spawned dispatchers". **Neither went into the PRD.** ADR-0025 decision 5 and §Starting bounds rule that the host's `maxDepth` ceiling and the live-child pool are the only bounds and that we add no cap of ours; a cap would need its own ticket stating the tradeoff. The PRD therefore says the peer is "bounded by the host's depth ceiling and live-child pool, with no cap of ours". Chatroom (ADR-0026) bounds are likewise not referenced — no room ships.

**CONTEXT.md verified against shipped code.** Mitosis correct, unchanged; Compaction boundary correct, unchanged (one row keyed by session id, newest `passSeq` wins — `src/core/durability.ts:64`); Chatroom now says "Not yet implemented (ticket 125)"; Mid-task reply now names the shipped `reply_to_dispatcher` instead of the reference name `RespondToCoordinator`; Peer agent gained the mitosis clause; new **Dispatcher** entry added; Worker already correct ("a leaf").

**ADR index verified, no edit.** Rows 0025-0029 already carry their settled-bounds notes; `node tools/adr-index.mjs --check` is fresh at 30 rows. No file move was needed.

**Three contradictions found and NOT fixed** (out of scope: they need their own rulings, not prose edits):

1. **`resolve_access` is a phantom tool.** `src/core/policy/prompts.ts:216` (`buildAccessPolicyBlock()`) tells the dispatcher to "Answer with resolve_access (allow or deny)", but no such tool is registered anywhere in `src/`. The real answer paths are `Multitask.resolveAccess` via the adapter's resolve command and approval cards (`src/adapter/resolve-command.ts`, `src/adapter/access-prompt.ts`), neither model-facing. Already flagged in `docs/research/reference-architecture-patterns.md:83`. **No ticket existed under `Issue-tracker/open/` at resolve time (checked: no 132+ file); it is being filed separately by the bookkeeping lane.**
2. **"The workers panel" is unmounted.** `src/core/policy/prompts.ts:161` says "Progress is conveyed by your own narration and the workers panel", but since ADR-0024/ticket 114 the roster panel is retained-but-unmounted (`docs/surfaces.md:150`, `:250`). **Also not yet filed under `Issue-tracker/open/` at resolve time; being filed separately.**
3. **No generation gate vs ADR-0025's consequences table.** The design note said a spawned dispatcher "never spawns another dispatcher"; shipped code has no such gate (`src/core/tool-results.ts:109`: "no `recursion-limit`, no `dispatcher-cap`, no generation counter"), and ADR-0025 leaves the child's own mitosis open. **Ticket 131 (`open/131-second-level-dispatcher-spawn-admitted.md`, needs-triage)** holds the ruling, and adds the harder fact that the depth ceiling never binds either because every hop raises it in lockstep — only the 8-slot pool does. The PRD sentence names both bounds; **it may need a trim to the pool alone once 131 is ruled.** No pre-emption of that ruling here. ADR-0025's Consequences table and ticket 118's test list still carry the contradicted generation-1 row; both are untouched by this ticket.

**Bookkeeping.** This file moved to `Issue-tracker/resolved/119-policy-prd-context-barrier-amendments.md`; index regenerated with `node tools/issue-index.mjs`; doc gates green. No commit.

