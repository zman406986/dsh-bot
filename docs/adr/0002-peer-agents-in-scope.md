# Peer agents in scope for this project

**Status:** accepted

Phase-2 peer agents (M5/S9) are **in scope for this project** — no separate PRD. The dispatcher is always-on and must function with a full team of sub-agents or with just a single sub-agent it dispatches for work; dsh's experimental agent-team tooling shows the surface is feasible (`docs/research/dsh-extension-surface.md`, Finding 3).

## Context

- Interview question: does this project include Phase-2 peers and agent-to-agent depth? Answer: yes — peer agents are in scope; the always-on dispatcher we're building should function with a team of sub-agents, or effectively just one dispatched sub-agent.
- PRD §7.6 currently specs peers as optional ("only if product needs multi-bot"); this ADR resolves PRD §15.5 as in scope for this project.
- dsh ships experimental agent-team tooling (spawn_teammate, shared team task board, team-scoped send/interrupt/list) — feasibility is not the blocker (research note, Finding 3).

## Considered options

| Option | Rejected because |
|---|---|
| **A. In scope for this project (M5/S9)** | **Chosen.** Human decision; one always-on product should carry its own peer behavior, keeping inbox, priority lane, and worker lanes co-designed. |
| B. Separate Phase-2 PRD | Splits one always-on product across two specs; the peer inbox + priority lane would be designed apart from the core they share lanes with. |
| C. Drop peer agents | Contradicts the requirement that the dispatcher work with a team of sub-agents, not just one. |

## Consequences

- Peer inbox + priority lane (PRD §7.1) are core deliverables, not optional extras.
- S9 is a target success criterion for this project; M5 stays in this project's roadmap.
- Still **open** (follow-ups, not decided here): whether agents may create/manage other agents; whether workers may spawn sub-workers (nested teams); peer envelope schema (`conversation_id`, group targets); S9 priority-lane details.
- AGENTS.md open-decisions paragraph and non-goals amended; PRD §15.5 marked resolved; CONTEXT.md gains the "Peer agent" term.
