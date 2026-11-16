# Research: how the reference bots differentiate a nested/summoned agent's prompt from a user-created one

- Question (owner, 2026-10-22): "dispatcher spawned dispatchers system prompt should probably be different from user spawned ones" — what do the reference bots actually do? Does an agent created by another agent get a different system prompt, and what does it know about its parent?
- Scope: reference trees only. `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` (the behavior spec; its own nested git, read-only, never committed into) and the third-party DeepSeek-Bot clone that is NOT in this repo (see Sources). Our own code is read only for the contrast section at the end.
- License posture: no verbatim copying. Everything below is a behavior description in our own words; the only quoted fragments are short phrases needed to identify a rule. Product prompts are new text only (ADR-0018 exception B9; `read-before-reference-tree-work.md`).
- Date: 2026-10-22. Offline: no network, no LLM, no dsh, no browser.

---

## Answer in one paragraph

**Neither reference has a nested-dispatcher prompt.** Grok Bot has no dispatcher-spawns-dispatcher path at all: its subagent (Task) tool is registered only for non-subagent runners, so a child cannot spawn anything. The only "agent creates an agent" path it has is `CreateAgent`, which produces an ordinary top-level peer agent that receives the **same** base system prompt and the **same** tools as a user-created agent; the sole per-agent difference is the name/description block, and the only record that another agent made it is the creator-supplied description. DeepSeek-Bot is the same shape: the system prompt varies by a `main` flag and by stored name/role/instructions, not by creator; the creator is visible only in a one-line kickoff message that becomes the new bot's first user turn ("<creator> just created you..."). **Both references differentiate the creator at spawn time, in the first user message or in data, and neither differentiates the persistent system prompt.** That is the opposite of what the owner assumed — and it is also why there is nothing to imitate here.

---

## Sources

Grok Bot (reference tree, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`):

- `source/host/runner/system-prompt.ts` — the subagent role-text builder and the one main-agent base prompt.
- `source/host/runner/system-prompt-assembly.ts` — the one assembler both runner kinds go through; composition order and the subagent-flagged branches.
- `source/host/host-runner-composition.ts` — assembler construction (`basePrompt`, hard-coded `isSubagentRunner: false`), the child-runner factory, the `agentManagement.create` wiring, `CreateAgent` call chain.
- `source/host/runner/tools/turn-toolset.ts` — per-turn tool registration and the `!isSubagentRunner` gates (Task, multitask, SendMessage family, agent management).
- `source/host/runner/turn-agent-composition.ts` — `buildSubagentConfigsForRun`, returns nothing for a subagent runner; the `executor` role substitution.
- `source/host/sand-multitask.ts` — the executor subagent config (`preserveTaskTool: false`) and the multitask section copy.
- `source/host/extensions/transcript/agent-lifecycle.ts` — `createBackgroundAgent` / `mintAgentSession` / `kickstartAgent`; how `origin` and `purpose` flow.
- `source/shared/agents/onboarding.ts` — the one first-run kickoff text.
- `source/host/gateway-protocol.ts`, `source/host/host-gateway-api.ts` — the RPC create path (`origin` supplied by the caller).
- `source/packages/agent/tools/task-client.ts` — the only `coordinator-agent` handling found (a continuation policy, not a prompt).

DeepSeek-Bot — **not in this repo.** No deepseek reference folder exists under the repo root (`ls` of the root shows only the Grok Bot folder, plus `vendor/` which is off-limits). The closest artifacts are a 2026-10-18 analysis note (`.scratch/repo-analysis/2026-10-18-deepseek-bot.md`, untracked) and a read-only clone left at `C:/Users/TZhen/AppData/Local/Temp/gh-analysis/DeepSeek-Bot`. The behavioral claims below were read from that clone (`ds-bot/src/host/prompt.js`, `roster.js`, `tools.js`); treat them as third-party evidence, not as this repo's reference tree.

Our contrast: `src/core/policy/prompts.ts`, `src/core/policy/assembler.ts`, `src/adapter/parent-agent.ts`, `src/adapter/cordis-dsh-host.ts`, `src/plugin.ts`, `src/worker/agent-def.ts`.

---

## Findings — Grok Bot

### 1. There is no nested spawn, so there is no nested prompt

The Task tool is registered only in the branch guarded by "not a subagent runner and not a shared-room runner" (`turn-toolset.ts`, the block beginning `if (!host.isSubagentRunner … turn.subagentConfigs != null)`). Every other dispatcher-side tool gate in the same function repeats the same condition: multitask todo, SendMessage / SendToAgent / Reaction / CreateAgent / UpdateAgent / UpdateState, generate-image, screenshot / box-help, MCP management and agent management. The subagent-config builder returns `undefined` immediately for a subagent runner (`turn-agent-composition.ts`, `buildSubagentConfigsForRun` first line).

Consequence: a Grok Bot child is structurally a leaf. It is not told "you may not spawn" in prose; the spawn tool simply is not in its tool list. A child given `preserveTaskTool: true` is the only exception in the tree, and only the CI-investigator built-in uses it.

This matches what ADR-0025 already recorded: mitosis has no reference precedent.

### 2. The one "agent creates agent" path produces a full peer, identical to a user-created agent

`CreateAgent` is a normal top-level tool (agent management, not the Task tool). It takes a name and a free-text persona/description, then calls the transcript layer's background-agent creation. Two details matter:

- the call hard-codes the creation **origin to "user"** even when an agent is the caller (`host-runner-composition.ts`, `agentManagement.create` → `createBackgroundAgent({…}, "user")`);
- no parent id, depth, creator, or lineage is passed at all.

The new agent is a normal session: not a subagent. So it goes through `createSystemPromptAssembly` with `isSubagentRunner: false` and `basePrompt = DEFAULT_SAND_SYSTEM_PROMPT` — the same one big main prompt a user-created agent gets, unchanged. The only per-agent content is the profile section (title + the description the creator wrote), rendered from that agent's own profile file.

It also keeps the full tool surface and, when multitask is enabled, the multitask section — so an agent-created agent is **itself a dispatcher**. There is no "secondary dispatcher" role anywhere in the tree.

### 3. The creator shows up only as a one-line first-turn message, and only for user creation

`kickstartAgent` runs one hidden first turn with a single fixed onboarding text. The text branches on whether the agent has a stored purpose ("disk-saver" vs ordinary) and on whether a profile description exists — **not** on who created it. A user-created agent with a description and an agent-created agent with a description receive the same kickoff.

The `origin` field is persisted (`agent-db`, values `"dev"`/`"user"`) and surfaced in the roster summary; no prompt builder reads it. So in the recovered path, the only signal of parentage an agent-created agent carries is the prose the creator wrote into its description.

### 4. The dedicated subagent prompt builder is role-name-only, and unused

`buildSandSubagentSystemPrompt` takes exactly two inputs: the subagent type name and a readonly boolean. Its body is: one identity sentence naming the type; one sentence saying finish autonomously and end with a plain-text final answer that is delivered back to the parent; one sentence saying there is no way to talk to the user and no follow-up questions; an optional readonly line; and one shared safety section. That is the whole thing.

No parent id, no depth, no spawn permission, no naming, no budget, no "you are secondary". "The parent agent" appears as a role word only. And this function has zero recovered call sites — the live child path is the shared assembler with the subagent flag set, which keeps the base prompt and shared sections and drops the dispatcher-only ones (`reference-subagent-inherited-sections.md` has the file:line list).

### 5. What actually tells a Grok child it is not a user-facing agent

Three mechanisms, none of them a distinct prompt:

1. **Tool absence** — no SendMessage, no task tool, no agent management, no multitask todo.
2. **A flipped flag in a shared section** — the untrusted-content section is rendered with "you cannot send messages", so a blocked action is reported in the final answer instead of being told to the user.
3. **The delivery contract** — its final assistant text is returned to the caller as the result. Parenting is implicit in the return path.

Plus, for the box-scoped kinds only, a couple of specialist sections say "name the box path in your final report; the parent agent delivers it". That is the only place a child prompt mentions a parent, and it is about file delivery, not authority.

---

## Findings — DeepSeek-Bot (third-party clone, not in-repo)

### 1. One prompt builder, one flag

`prompt.js` has a single function: identity line (name, plus role label if set), the bot's own instructions, then either `MAIN_RULES + TEAM_RULES` for a main bot or `TEAM_RULES` alone. Nothing about creator. There is also a fixed "group relay" variant for the room session.

### 2. Creator is visible in the kickoff only

`create_bot` is main-bot-only and passes the caller's bot id as `createdBy`. The new bot's kickoff text branches on it, and the agent-created variant opens with "<creator name> just created you for the user", states why it exists when a brief was given, and asks one short question. The user-created variant opens with "The user just created you". Both are followed by the same "where your instructions say otherwise, follow them" line, and `createdBy` then does nothing else for prompt purposes.

So: a one-line provenance in the first user message; the system prompt stays creator-agnostic.

### 3. No nesting either

Bots are peers with their own user chats. A bot created by another bot is a full peer with its own conversation, memory, and tools. The only authority asymmetry is a stored "main" flag (create/update other bots, run groups), not a depth or parent relation. No worker/leaf concept exists.

---

## Our current state — are the two paths identical today?

**Yes. A spawned dispatcher receives byte-identical prompt text, the same eight tools, the same per-turn reminder, and the same peer roster as a user-starting dispatcher.** The mechanism is deliberate: `activateSpawnedDispatcher` and `activate` both call the same private `bindActivation` (`src/adapter/parent-agent.ts`), which injects `assembleSessionPolicy(true)` → `buildDispatcherPolicySection()`.

Precise differences today, all outside the prompt text:

| Difference | Where | Effect |
|---|---|---|
| First user turn is the spawn prompt | `spawnDispatcher` → `request.prompt` (`cordis-dsh-host.ts`) | The child's opening task is whatever the parent wrote; nothing frames it as delegated. |
| Session header carries `parentSession` + `delegationDepth` | host session header | Used only for the top-level gate and the depth ceiling. Never read into a prompt. |
| No host chat surface | host-side | The child cannot reach the user through the chat UI; ADR-0025 decision 6 records this as the first-implementation answer. |
| Depth ceiling derivation | `dispatcherSpawnMaxDepth` | Parent depth + 2, not prompt-visible. |

And three consequences of the identical text that are worth naming:

1. **The policy opens by claiming the wrong identity.** The first line says, in effect, "you are the user's main assistant in this chat". For a spawned dispatcher both halves are false: it is not the main assistant and it has no chat with the user. Its only user-facing route is its creator.
2. **The policy promises a delivery channel the child does not have.** It says workers never talk to the user and "only you deliver". A spawned child's `deliver_result` is registered but no `deliverToUser` producer is wired anywhere in `src/`, so the handler marks the todo delivered and returns success without a send. For a user-started dispatcher that is a known accepted gap (ticket 11: the wake turn itself is user-visible, and a real host send can be plugged in later). For a spawned child there is no user-visible turn to fall back on, so the same tool is a genuine dead end — the child is told it owns a channel it cannot use.
3. **The peer roster is symmetric and unlabelled.** `peerRosterFor` lists every other activated dispatcher with a liveness label. A child therefore sees its creator as just another peer, and the creator sees the child the same way. Nothing marks direction or rank — which is consistent with ADR-0025 decision 2 (peer, not subordinate), but means the child cannot tell it was summoned.
   **Superseded 2026-11-16:** peer visibility is ancestry plus workspace, not the set of activated sessions — cross-workspace and other-team dispatchers are hidden; see `docs/research/stock-subagent-duplication-audit.md` "Dispatcher visibility". The 2026-10-22 observation above stands as written.

**The spawn-side tool description is the only place parentage is stated, and it is stated to the parent, not the child.** `spawn_dispatcher`'s description tells the caller the child "cannot talk to the user, so its work reaches the user only through you".

---

## What this suggests for us (evidence only — no ruling)

**Option A — leave the prompt identical, add one section only for spawned dispatchers.**
Detect "spawned" at activation (the activation path already knows: `activateSpawnedDispatcher` vs `activate`, and the header carries `parentSession`). Append a short section: you were summoned by another dispatcher, that session is your only route to the user, deliver by reporting back, your parent is `<id>`. Keep everything else byte-identical.
- Pro: smallest change; keeps the "peer not subordinate" ruling intact (ADR-0025 decision 2); fixes the two false claims (identity + delivery) without inventing rank.
- Con: adds a second policy assembly path, and the appended text is a cache-prefix difference per session kind. Needs the activation path to pass a discriminator into `assembleSessionPolicy`.

**Option B — split the policy into shared doctrine + a per-kind opener.**
Extract the "how you work" and "what you never do" bodies as shared text; give user-started and spawned dispatchers different openers (user-started: "you are the user's main assistant"; spawned: "you are a dispatcher summoned by another dispatcher; your work reaches the user through it").
- Pro: removes the false identity line at its root rather than patching over it; the shared body keeps the two roles from drifting.
- Con: touches the tested policy text (`POLICY_SECTION_HEADINGS` is a stable test marker) and every existing assertion that pins the section; larger diff than A.

**Option C — do not change the prompt; change the tools.**
Follow the reference's actual mechanism: differentiate by surface, not words. Withhold `deliver_result` (and possibly `spawn_dispatcher`) from a spawned dispatcher, and let the absence carry the meaning, while keeping the policy text shared.
- Pro: matches both references (they differentiate by tool list and delivery path); nothing to cache-key; no new prompt text to review.
- Con: contradicts a shipped tool description and the policy sentence that says "only you deliver", so the text still needs an edit; and ADR-0025 decision 2 says the summoned dispatcher carries the **full dispatcher tool surface**, so withholding tools would reverse a recorded decision and needs its own ticket. (Withholding only `deliver_result` is exactly that reversal and would also have to answer how a child's work reaches the user at all — ADR-0025 decision 6 says it goes through the creator, so the child would need a report channel instead.)

**Option D — record parentage in the first user turn only, like DeepSeek-Bot.**
Have `spawnDispatcher` prepend one provenance line to the prompt it receives ("<parent> summoned you…"), leaving the system prompt untouched.
- Pro: cheapest possible; exactly what the closest analogue does; no policy-test churn.
- Con: it sits in conversation content, so a compaction can drop it — the same failure mode our worker contract was moved out of `request.prompt` to avoid (register D-1, ticket 55).

**Cross-cutting observation, offered as evidence rather than a recommendation:** the difference the owner senses is real, but in both references the discriminator is *capability*, not *prose*. Grok Bot's child is different because it has no Task tool and no user channel; DeepSeek-Bot's bot differs by instruction data, not by role prompt. If we choose prose, we are going beyond both references — which ADR-0025 already permits for mitosis, but it should be a stated choice rather than an assumed imitation.

---

## Open / unclear

- Whether Grok Bot's `coordinator-agent` type (the only place a "spawn more workers when needed" continuation text exists) is a live built-in at all — one reference in `task-client.ts`, no config, no prompt, no registration found. Recorded as a dead branch, not a nested-dispatcher design.
- Whether the reference's live child path applies any additional prompt mutation in the unrecovered bundled engine — the same bounded caveat as `reference-subagent-inherited-sections.md`.
- DeepSeek-Bot claims come from a third-party clone outside this repo at a 2026-10-17 HEAD; no in-repo artifact of it exists beyond the analysis note.

---

## Method

`ls` of the repo root to locate reference material; read `read-before-reference-tree-work.md` and obeyed it (read-only, no commits into the nested git, no verbatim copying). Grepped the Grok Bot `source/` tree for the subagent flag, the Task-tool gates, `preserveTaskTool`, agent creation and kickstart paths; read the assembler, the subagent prompt builder, the toolset gate block, the runner composition, and the lifecycle/kickoff files. Read the DeepSeek-Bot clone's `prompt.js`, `roster.js` (`create_bot` path), and `tools.js`. Then read our `prompts.ts`, `assembler.ts`, `parent-agent.ts`, `cordis-dsh-host.ts` spawn paths, `plugin.ts` activation wiring, and `worker/agent-def.ts` for the contrast. No file in either reference tree was modified; nothing was run.
