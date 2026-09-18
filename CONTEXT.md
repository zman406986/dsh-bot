# dsh Multitask Dispatcher

Design context for the always-on dispatcher built on dsh (DeepSeek Harness): a main chat agent that delegates work to blank background workers and stays responsive.

## Language

**Multitask core**:
The TypeScript component that owns the dispatcher's policy state — FSM, worker registry, steer queue, todo reconciler, wake bus, peer inbox + priority lane, and policy assembly — and runs in-process as a dsh/Cordis plugin.
_Avoid_: orchestrator, engine

**Peer agent**:
An agent identity the dispatcher exchanges messages with asynchronously — distinct from a Worker, which the dispatcher spawns and steers.
_Avoid_: bot, teammate

**Worker**:
An agent the dispatcher spawns and steers; a leaf — it never spawns other agents.
_Avoid_: subagent, background agent

**Imitation boundary**:
_Amended 2026-09-19 (ADR-0018, master rule):_ the reference is imitated **in its entirety** — behavior, product experience, and face — except ADR-0018's enumerated exception list, which is exhaustive and the fidelity bar. The S1–S9 scope filter below survives only for Phase-2/non-core choices not overridden by the ADR. _(Formerly, per ADR-0004: the reference authoritative for *how*, product goal and S1–S9 for *whether*.)_
_Avoid_: parity, feature match

**Multitask profile**:
_Amended 2026-09-19 (ADR-0018):_ the flag this term described is **voided** — no dispatcher mode, feature flag, or kill switch; the dispatcher is always-on, and the wrapper window / expanded surface *is* the dispatcher. The term survives only where a dsh profile remains the deployment unit for the plugin. _(Formerly: the dedicated dsh profile where the dispatcher shipped enabled and stock/default off; the profile as the flag's home, ADR-0005.)_
_Avoid_: mode, setting, flag

**dsh profile**:
A named stack of plugin bundles plus patch layers under `$DSH_HOME/profiles`, composed at boot as bundles → `cordis.patch.yml` → `--patch` overlays. A plugin reaches a profile through an `insert` row in that profile's patch layer.
_Avoid_: config, setup

**Host tree vs reference tree**:
Two trees sit side by side, with opposite rules. The **host tree** is dsh itself (MIT, installed under npm's global `node_modules`) — safe to read and imitate; it is the platform. The **reference tree** (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) is the behavior spec. _Copy policy amended 2026-09-18 (ADR-0018 exception B9):_ **no verbatim copying** of source, prompts, identifiers, or protocol artifacts; **adapted copying — restructured, independently named, not textually identical — is permitted** (AGENTS.md; a human accepted-risk decision, not a legal clearance).
_Avoid_: upstream, dependency tree
