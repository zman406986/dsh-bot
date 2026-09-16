# Dispatcher-only spawning (flat team topology)

**Status:** accepted

The team topology is **flat: only the dispatcher spawns agents**. Workers are leaves — they never spawn sub-workers. Nested spawning is out (deferred, behind a future ADR if ever needed). Worker-to-worker messaging topology is not decided here.

## Context

- Interview question: team topology — who may spawn whom, and who may message whom? Human's answer: imitate reference (grok bot) behavior — only the dispatcher spawns.
- ADR-0002 brought peer agents in scope and left open whether agents may create/manage other agents and whether workers may spawn sub-workers (nested teams); this ADR resolves spawning.
- Worker-to-worker messaging is not decided here; it is resolved by observing the reference implementation under the human's "imitate the reference" rule (reference behavior notes, `docs/research/reference-behavior-notes.md`).

## Considered options

| Option | Rejected because |
|---|---|
| **A. Flat — only the dispatcher spawns; workers are leaves** | **Chosen.** Matches reference behavior; keeps a single parent accountable for every worker's registry entry, settle wake, and todo reconciliation (S4/S6). |
| B. Nested — workers may spawn sub-workers | Rejected/deferred: grandchild ownership of registry/wake/todo breaks single-parent reconciliation (S4/S6); revisit via a new ADR only if real workloads demand it. |
| C. Mesh messaging between workers | **Resolved by reference observation: no direct worker-to-worker messaging; all traffic routes through the dispatcher.** Imitate that (reference behavior notes, `docs/research/reference-behavior-notes.md`). |

## Consequences

- S4/S6 stay single-parent: exactly one dispatcher owns each worker's settle wake and todo reconciliation.
- Peers (ADR-0002) remain dispatcher-level identities; this ADR grants them no spawn authority.
- Revisiting nested spawning requires a new ADR.
- Worker-to-worker messaging is resolved by reference observation, not by asking the human: no direct worker-to-worker messaging.
- PRD §6.2, CONTEXT.md ("Worker"), and AGENTS.md are amended to match this ADR.
