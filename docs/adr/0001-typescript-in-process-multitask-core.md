# TypeScript in-process multitask core (dsh/Cordis plugin)

**Status:** accepted

The Multitask core is written in **TypeScript** and runs **in-process as a dsh (Cordis) plugin**. dsh's only documented in-process extension surface is TypeScript modules (`apply(ctx)`), and PRD §8 plus §15 items 1–2 already resolved TypeScript + in-process; this ADR records the decision and the override of AGENTS.md's "Not TypeScript. Prefer Go, else Python or Rust" constraint row, which predated that resolution.

## Context

- dsh plugins are TypeScript modules loaded into dsh's Node process via Cordis; there is no documented in-process plugin language other than TypeScript/JavaScript (`docs/research/dsh-extension-surface.md`, Findings 2 and 5).
- The only first-party non-TypeScript route is the Python SDK, which starts a dsh process and speaks JSON-RPC to it — plugins are still installed as TS bundles (same note, Finding 5).
- PRD §8 "Implementation language strategy" resolves TypeScript for the Multitask core and the dsh adapter; PRD §15.1–15.2 mark core language and in-process embed as resolved. AGENTS.md still contradicted this.

## Considered options

| Option | Rejected because |
|---|---|
| **A. TypeScript, in-process dsh plugin** | **Chosen.** Same language as the plugin API; typed, effect-scoped in-memory access to `ctx.subagents`, `ctx.jobs`, `ctx.sessions`, `ctx.storage`, `ctx.tools`; unit-testable without the host (PRD §8). |
| B. Hybrid — thin TS in-process adapter + Go/Python/Rust core over JSON-RPC | Added IPC layer and failure modes for no product gain; dsh's out-of-process API-gateway surface is unaudited (research note, Finding 5 and "Confidence & unknowns"). |
| C. Wholly out-of-process non-TS core | Most work and risk of the three; sits on the same unaudited out-of-process surface. |

## Consequences

- AGENTS.md constraint table and open-decisions paragraph amended to match this ADR.
- No-copy discipline is unchanged in substance: TypeScript is the reference tree's language, so the PRD §8 no-copy rules (item 1 now permits reference reading — see AGENTS.md "Reference folder policy") and the S7 identifier grep apply in full. The language change relaxes nothing about copying.
- dsh is a developer preview with explicit breaking-change warnings; pin the dsh/Cordis versions at integration time and re-verify API names (research note, Finding 1 and "Confidence & unknowns").
