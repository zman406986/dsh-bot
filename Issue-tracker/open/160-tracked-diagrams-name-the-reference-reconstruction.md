# 160 — Tracked diagram files name the un-licensable reference reconstruction; publication waits on the owner

**Status:** open
**Labels:** needs-owner-decision
**Blocked by:** an owner decision — not by any implementation work. Nothing in the repo needs to change before that decision is made.
**Origin:** found 2026-10-29 during the release-prep pass, by reading our own tracked diagram files. Filed as a ticket rather than edited in place, because attribution is not an agent's to delete. **The owner has not ruled on this.**
**Related:** ticket 157 / ADR-0032 (the pass that surfaced it), `reference-deviations/README.md` (the clean-room posture for the same reference tree), `read-before-reference-tree-work.md` (the access rules), `.gitignore:2` (the tree itself is ignored and never published).

## Problem

Two tracked files under `docs/diagrams/` embed provenance pointing at the upstream reconstruction that our local reference tree is described as deriving from. If the repository goes public in its current state, that provenance is published with it.

The reference material itself is **not** in the repository and never has been: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` is gitignored, has zero tracked files, and has zero objects anywhere in history (`git rev-list --all --objects` lists 4,765 objects, none matching that path). This ticket is about **attribution text inside our own tracked files**, not about the tree leaking.

## Evidence

Both files are tracked (`git ls-files -- 'docs/diagrams/*'` returns them).

**`docs/diagrams/reference-agent-runtime.html`** — 730,632 bytes, 14,819 lines. All 37 occurrences sit on **one line**, `:4963`, inside a single `<script id="archify-source-evidence-data" type="application/json">` block. That block carries:

```json
{"schemaVersion":1,"verified":true,
 "repository":{"url":"https://github.com/b-nnett/grok-bot-0.18-reconstructed",
               "revision":"a9f633e09d49a85829b8236331b9e21f7e612634",
               "shortRevision":"a9f633e"},
 "referenceCount":11, …}
```

It also carries 11 `…/blob/a9f633e…/<path>` hrefs: one per diagram node that was traced to a source file, so a reader can click through to the upstream file each node was derived from. The repo name appears 12 times in the file (the `repository.url` plus the 11 blob links).

**`docs/diagrams/reference-agent-runtime.architecture.json`** — 7,111 bytes, 233 lines. The attribution is at `:9-11`:

```json
"repository": {
  "url": "https://github.com/b-nnett/grok-bot-0.18-reconstructed.git",
  "revision": "a9f633e09d49a85829b8236331b9e21f7e612634"
}
```

Exactly one mention of the repo name, no blob hrefs.

**The other diagram artifacts are clean.** Checked by raw byte search, not by eye: `reference-agent-runtime.visual-check.html`, `reference-agent-runtime.visual-check.json`, and the four `visual-check.*.png` screenshots contain **zero** occurrences of the repo name or the revision. The `archify-source-evidence-data` block exists only in the main `.html`.

**Not transcription.** The same mechanical pass that cleared `reference-deviations/` was run here: 0 fenced code blocks, 0 blockquote lines, 0 `import`/`export` statements attributable to the reference. The HTML is 730 KB of diagram render machinery. The provenance is a pointer — "this node was read at this upstream path and revision" — not copied source.

## Why this is an owner decision and not a cleanup

Two defensible positions, and they point opposite ways:

- **Keep it.** It is honest attribution. It also documents where the diagram's claims came from, which is the whole reason the `archify` skill records provenance. Removing it would make the diagram's evidence unfalsifiable while leaving its conclusions in place — a worse position than naming the source.
- **Remove it before publishing.** It points a public reader at a reconstruction we have no licence to redistribute or endorse, and it invites the reading that this repo is a derivative of it. `reference-deviations/README.md` records the reference as "a public reconstruction with unknown upstream provenance", and ADR-0018 exception B9 forbids verbatim copying. Naming it is not copying, but it is a public association.

Neither is a call an agent should make quietly. **Nothing was edited.** The files are exactly as they were found.

If the owner decides to remove it, the mechanical change is small and precise: delete the `archify-source-evidence-data` script block at `reference-agent-runtime.html:4963` and the `repository` object at `reference-agent-runtime.architecture.json:9-11`. The diagram itself does not read that block to render; it is evidence metadata. The `referenceCount`/`nodes` data inside the same block would go with it, which is the cost — the per-node click-through links are in that same object.

## Acceptance

- [ ] The owner states a decision: keep the attribution, remove it, or withhold the two files from publication.
- [ ] If "remove": the change is made in exactly those two places, the diagram still renders, `node tools/doc-lint.mjs` stays clean, and the removal is recorded in this ticket's Comments with the date.
- [ ] If "keep": this ticket is closed with the decision recorded, so the next public-release pass does not re-file it.
- [ ] Either way: the four `visual-check.*` artifacts are re-checked, since they are the files most likely to pick up the same metadata if the diagram is regenerated.

## Constraints

- **Do not edit either file until the owner rules.** Attribution is not an agent's to delete.
- Do not touch `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`. It stays gitignored and unpublished.
- This ticket does not reopen the clean-room posture in `reference-deviations/README.md`, which a separate pass verified: 229 records, 0 fenced code blocks, 0 blockquotes, 0 code-shaped spans on any line citing the reference.
- No source, test or client file is involved. This is a documentation-artifact question.

## Comments

2026-10-29: Filed during the release-prep pass. The instruction to file it rather than edit the files came from the coordinating agent, **not** from an owner ruling — the owner has not been asked and has not decided. The counts and line numbers above were measured in this working tree, not carried over from another report. No file was modified in this pass.
