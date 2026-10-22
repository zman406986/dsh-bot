# dsh Multitask Dispatcher

Design context for the always-on dispatcher built on dsh (DeepSeek Harness): a main chat agent that delegates work to blank background workers and stays responsive.

## Language

**Multitask core**:
The TypeScript component that owns the dispatcher's policy state — the finite state machine (FSM), worker registry, queue of pending steer messages, todo reconciler, wake bus, peer inbox plus priority queue, and policy assembly — and runs in-process as a dsh/Cordis plugin.
_Avoid_: orchestrator, engine

**Peer agent**:
An agent identity the dispatcher exchanges messages with asynchronously — distinct from a Worker, which the dispatcher spawns and steers. Includes a dispatcher another dispatcher created (ADR-0025).
_Avoid_: bot, teammate

**Worker**:
An agent the dispatcher spawns and steers; a leaf — it never spawns other agents.
_Avoid_: subagent, background agent

**Chief of Staff**:
The dispatcher's role: decide whether the work needs a team or one worker, then hand off the problem and the wanted outcome, not the method.
_Avoid_: orchestrator, manager

**Dispatcher**:
The main chat agent the user talks to. It may spawn workers and, since 2026-10-18 (ADR-0025), one dispatcher peer at the same conceptual layer; it is the only agent that delivers to the user.
_Avoid_: orchestrator, coordinator, front desk

**Mitosis**:
A dispatcher summoning another dispatcher; the summoned one has the full dispatcher tools and policy and is a peer of its creator, not a rank below it (ADR-0025).
_Avoid_: child agent, sub-dispatcher

**Chatroom**:
An optional named group a dispatcher can address instead of one agent; 1:1 messaging stays the default (ADR-0026). Not yet implemented (ticket 125).
_Avoid_: group chat, broadcast channel

**Mid-task reply**:
A worker's message to its own dispatcher sent before the worker finishes, separate from its final answer; shipped as the worker-only `reply_to_dispatcher` tool (ADR-0028).
_Avoid_: partial result, progress ping

**Compaction boundary**:
The one stored marker that records where compacted history ends; resume reads it and nothing else to decide where to continue (ADR-0029).
_Avoid_: checkpoint, summary marker

**Microcompact**:
Dropping old tool results once context use crosses a set share of the usable window, keeping the newest few; no model call (ADR-0029).
_Avoid_: summarization, pruning

**Imitation boundary**:
_Amended 2026-09-19 (ADR-0018, master rule):_ the reference is imitated **in its entirety** — behavior, product experience, and face — except ADR-0018's enumerated exception list, which is exhaustive and is the standard for how close the copy must be. The S1–S9 scope filter (the nine numbered success criteria from the PRD) below applies only to Phase-2/non-core choices not overridden by the ADR. _(Formerly, per ADR-0004: the reference authoritative for *how*, product goal and S1–S9 for *whether*.)_
_Avoid_: parity, feature match

**Multitask profile**:
_Amended 2026-09-19 (ADR-0018):_ the flag this term described is **voided** — no dispatcher mode, feature flag, or kill switch; the dispatcher is always-on, and the wrapper window / expanded surface *was* the dispatcher at that time (the wrapper window was withdrawn by ADR-0024, 2026-10-18 — stock dsh is now the only UI). The term survives only where a dsh profile remains the deployment unit for the plugin. _(Formerly: the dedicated dsh profile where the dispatcher shipped enabled and stock/default off; the profile as the flag's home, ADR-0005.)_
_Avoid_: mode, setting, flag

**dsh profile**:
A named stack of plugin bundles plus patch layers under `$DSH_HOME/profiles`, composed at boot as bundles → `cordis.patch.yml` → `--patch` overlays. A plugin reaches a profile through an `insert` row in that profile's patch layer.
_Avoid_: config, setup

**Host tree vs reference tree**:
Two trees sit side by side, with opposite rules. The **host tree** is dsh itself (MIT, installed under npm's global `node_modules`) — safe to read and imitate; it is the platform. The **reference tree** (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) is the behavior spec. _Copy policy amended 2026-09-18 (ADR-0018 exception B9):_ **no verbatim copying** of source, prompts, identifiers, or protocol artifacts; **adapted copying — restructured, independently named, not textually identical — is permitted** (see `read-before-reference-tree-work.md`; a human accepted-risk decision, not a legal clearance).
_Avoid_: upstream, dependency tree
