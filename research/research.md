# Research Notes

Where cited research findings live, so `/research` doesn't invent a new location on every run.

## Location

`docs/research/<slug>.md` — one file per **question or topic**, not per run or per feature.

The directory is created **lazily** by the first `/research` run. Don't pre-create it.

## Naming

Short, descriptive kebab-case concept name, matching the `.out-of-scope/` convention: `dsh-interrupt-continue.md`, `dsh-todo-store.md`, `sidecar-vs-embed.md`. Recognizable from the filename alone, without opening it.

## Why durable, not scratch

These notes are **decision inputs**, not working state. They sit under `docs/` alongside `docs/adr/` for two reasons:

- The dsh host facts are **project-wide** — the PRD's §11 integration checklist and §15 item 2 feed M1 through M4, not one feature. In `.scratch/` they'd be disposed of and re-researched per milestone.
- ADRs cite them. `docs/adr/0001-choose-go-for-core.md` should be able to point at `docs/research/<slug>.md` as its evidence base.

`.scratch/` is for the disposable chain (spec → tickets → implementation) and is swept per feature. Research is not swept.

## Content requirements

Every claim traced back to the **primary source that owns it** — official docs, dsh source, specs, first-party APIs. Not a secondary write-up. Cite inline so a reader can verify without re-running the search.

## How the skills use this

- **`/research`** writes here (background agent; the file is the deliverable).
- **`/grill-with-docs`** reads these before a round when a question is fact-gated rather than preference-gated — facts are the agent's job, decisions are the user's.
- **`/to-spec`** and ADRs cite them rather than restating them.

## First users

PRD §11 (integration checklist) and §15 item 2 (sidecar vs in-process embed) — the dsh host-capability facts that gate M0.
