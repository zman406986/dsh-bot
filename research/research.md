# Research Notes

Where cited research findings live, so `/research` doesn't invent a new location on every run.

This convention file itself lives at `research/research.md`. The findings stay under `docs/research/` (widely cited by ADRs, PRD, and design notes).

## Location

`docs/research/<slug>.md` — one file per **question or topic**, not per run or per feature.

The findings directory already exists. New notes go there; this `research/` folder holds the convention doc only.

## Naming

Short, descriptive kebab-case concept name, matching the `.out-of-scope/` convention: `dsh-interrupt-continue.md`, `dsh-todo-store.md`, `sidecar-vs-embed.md`. Recognizable from the filename alone, without opening it.

## Why durable, not scratch

These notes are **decision inputs**, not working state. They sit under `docs/` alongside `docs/adr/` for two reasons:

- The dsh host facts are **project-wide** — the PRD's §11 integration checklist and §15 item 2 feed M1 through M4, not one feature. In `.scratch/` they'd be disposed of and re-researched per milestone.
- ADRs cite them. `docs/adr/0001-typescript-in-process-multitask-core.md` points at `docs/research/dsh-extension-surface.md` as its evidence base.

`.scratch/` is for the throwaway chain (spec → tickets → implementation) and is cleared out per feature. Research is not cleared out.

## Content requirements

Every claim traced back to the **primary source that owns it** — official docs, dsh source, specs, first-party APIs. Not a secondary write-up. Cite inline so a reader can verify without re-running the search.

## How the skills use this

- **`/research`** writes here (background agent; the file is the deliverable).
- **`/grill-with-docs`** reads these before a round when a question turns on facts rather than on preference — facts are the agent's job, decisions are the user's.
- **`/to-spec`** and ADRs cite them rather than restating them.

## First users

PRD §11 (integration checklist) and §15 item 2 (sidecar vs in-process embed) — the dsh host-capability facts that M0 depends on.

## Notes filed

Dated entries, newest last. This list starts 2026-10-18; notes filed earlier are not backfilled here — they are cited from the ADRs and tickets that consumed them.

- 2026-10-18 — [Third-party dsh plugin comparison: Fei2411/DeepSeek-Bot and its fork QingJ01/DS-Bot-App](docs/research/third-party-dsh-plugin-comparison-2026-10-18.md): no-fork verdict, eight adopted-candidate mechanisms with upstream paths, and the license/scope reasons against vendoring. Evidence only.
- 2026-10-18 — [Dispatcher peer model, chatroom, indicators, and compaction: study findings and owner rulings](docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md): awareness/discovery models in Grok Bot, DeepSeek-Bot and ZCode; chatroom bounds; compaction layers and the boundary-as-success-marker pattern; the confirmed session-row leading slot; plus six dated owner decisions (Chief-of-Staff prompt, optional chatroom, pushed peer roster at prompt tail, `RespondToCoordinator`, session-row glyphs, microcompact). Findings are evidence; the decisions are the human ruling.
- 2026-10-19 — [Compaction stack design](docs/research/compaction-stack-design-2026-10-19.md): the layer ladder for this host, built on the verified fact that dsh already ships a tool-result pruner, an LLM summarizer, image offload and a token meter; exact trigger math derived from the native threshold; the boundary-marker shape; and four whole-stack options for the human to choose between. Design proposal, not a ruling.
- 2026-10-19 — [Proposal: extending the useful context window](docs/research/proposal-context-density-2026-10-19.md): the consolidated proposal. Measured on 9,667 real sessions — compaction cuts 90.7% of context, 29.4% of dropped read bytes are re-fetched, 87.1% of tool-result bytes sit in failed-search episodes, and the evictable-share gate does not clear 0.5. Recommends a deterministic density layer (oversized-result cap, failed-search negative record, then span retention) with native compaction untouched and no fixed-interval summarization. Asks four decisions of the human. **Superseded by the dsh-forget proposal below** — its cadence verdict imported evidence from summary-based systems.
- 2026-10-19 — [dsh-forget proposal](docs/research/dsh-forget-proposal-2026-10-19.md): **the current proposal.** Argues that compaction is structurally wrong — it asks a bloated agent to recall what mattered at the moment recall is hardest — and that the correct operation is to forget useless parts continuously while memory is fresh, never to summarize. Rejects the "fewer, larger compactions" verdict as evidence about summary-based systems only, since dsh-forget removes the per-operation loss that made frequency bad. Four forgetting rules (entry-time cap, failed-search negative fact, span retention, closed-episode pointer eviction), measured against 9,667 sessions, with success defined as native compaction never firing.
