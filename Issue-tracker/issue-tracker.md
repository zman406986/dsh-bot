# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files under `Issue-tracker/` at the project root.

## Layout

```
Issue-tracker/
├── issue-tracker.md      ← this file
├── open/                 ← active, not yet done
├── open-issue-index.md   ← generated from open/ by tools/issue-index.mjs — never hand-edit
├── deferred/             ← parked; revisit later
├── resolved/             ← finished and accepted
└── cancelled/            ← closed without shipping
```

## Conventions

- One file per ticket: `Issue-tracker/<status>/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Status is **which folder the file is in** (`open` / `deferred` / `resolved` / `cancelled`). Keep a `Status:` line near the top of each issue file in sync with its folder (see `agent.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- Feature specs and design notes may still live under `.scratch/<feature-slug>/` during active work; when a ticket ships or dies, move the ticket file into the matching `Issue-tracker/` status folder

## When a skill says "publish to the issue tracker"

Create a new file under `Issue-tracker/open/` (use another status folder only if it is already known to be deferred, resolved, or cancelled).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly. If only a number is given, search `Issue-tracker/*/` for a matching `<NN>-` prefix.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `Issue-tracker/open/NN-<slug>.md` (or under `.scratch/<effort>/issues/` while the effort is still scratch-local), numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan the active ticket set for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, move the file into `Issue-tracker/resolved/` if it is not scratch-local, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
