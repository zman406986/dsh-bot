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
The line between behavior and scope in reference imitation: the reference is authoritative for *how* an adopted feature behaves, while the product goal and S1–S9 decide *which* features exist.
_Avoid_: parity, feature match

**Multitask profile**:
The dedicated dsh profile in which the dispatcher ships enabled. Distinct from stock/default profiles, where the feature is off; the profile IS the flag's home, not a runtime toggle (ADR-0005).
_Avoid_: mode, setting

**dsh profile**:
A named stack of plugin bundles plus patch layers under `$DSH_HOME/profiles`, composed at boot as bundles → `cordis.patch.yml` → `--patch` overlays. A plugin reaches a profile through an `insert` row in that profile's patch layer.
_Avoid_: config, setup

**Host tree vs reference tree**:
Two trees sit side by side, with opposite rules. The **host tree** is dsh itself (MIT, installed under npm's global `node_modules`) — safe to read and imitate; it is the platform. The **reference tree** (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) is behavior-only — never code, prompts, identifiers, or literals.
_Avoid_: upstream, dependency tree
