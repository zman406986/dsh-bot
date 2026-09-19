# 96 — Doc lint + generated indexes: make the orientation docs provably honest

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** ticket 97 (its `read-before-<activity>.md` guides add naming surface this lint can later check), sibling-repo tooling cited below as device-specific evidence

## Problem

The orientation layer is rotting in ways nothing catches:

- `AGENTS.md` cites `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`, and `docs/agents/research.md` — **`docs/agents/` does not exist** (verified 2026-09-20). The real homes are `Issue-tracker/issue-tracker.md`, `agent.md`, and `research/research.md`.
- `AGENTS.md` line 3 claims "There is no application code, package manifest, or build/test toolchain at the repo root yet" — false since the early tickets: `package.json` (npm scripts, `files`, dsh client manifest), `src/`, `test/`, `client/`, `lib/`, `scripts/`, `tsconfig.json` all exist.
- `AGENTS.md`'s issue-tracker section says issues live under `.scratch/<feature-slug>/`; the actual tracker is `Issue-tracker/<status>/` per `Issue-tracker/issue-tracker.md` (`.scratch/` holds scratch specs only during active work, per the same guide).
- `docs/adr/README.md` (the ADR index) and the open-ticket set are hand-maintained; no tracker index exists at all. Nothing fails when a pointer or index row drifts — every catch above was found by a human-eye pass.

## Proposal

Port and adapt the sibling repo's zero-dependency doc tooling as plain-node scripts under a new `tools/` directory. Reference (device-specific absolute paths, sibling repo "Spreadsheets in Space"):

- `C:\Users\TZhen\Desktop\Spreadsheets in space\tools\doc-lint.mjs` — orientation-doc guardrails: backticked paths in orientation docs resolve on disk; generated indexes are fresh; naming rules for entry files; tracker in-file status agrees with folder.
- `C:\Users\TZhen\Desktop\Spreadsheets in space\tools\issue-index.mjs` — generates the open-queue index from the folder itself, so a card that moves cannot leave a stale row behind.
- `C:\Users\TZhen\Desktop\Spreadsheets in space\tools\adr-index.mjs` (+ its `adr-new.mjs` concept) — generates ADR index rows from the ADR files.

All three are `node:fs`/`node:path` only, no dependencies — fits this repo (Node >= 22, no new dev deps). Export the check/generation functions so a `--self-test` style pass is possible, as the sibling does.

Checks to port:

1. **Path resolution:** every backticked repo path in the orientation docs (`AGENTS.md`, `README.md`, `CONTEXT.md`, `agent.md`, `Issue-tracker/issue-tracker.md`, `research/research.md`, `docs/adr/README.md`) resolves on disk.
2. **Tracker-index freshness:** the open-queue index is generated from `Issue-tracker/open/*.md` and matches the folder.
3. **ADR-index freshness:** `docs/adr/README.md`'s row set matches the files in `docs/adr/` (see merge rule below).
4. **Status-line agreement:** every ticket file's `Status:` line matches the folder it sits in (the tracker guide already requires this; nothing checks it).

## Mandatory adaptations (this repo is not the sibling)

- **Tracker layout:** `Issue-tracker/{open,deferred,resolved,cancelled}` with files named `NN-<slug>.md` and an in-file `Status:` line — not the sibling's `docs/issue-tracker/open/ISSUE-*.md` card schema. The index row should take the ticket's H1 (`# NN — Title`) and number from the filename.
- **ADR index lives at `docs/adr/README.md`** (sibling: `docs/adr/INDEX.md`), and its `Status` column is hand-maintained, load-bearing prose ("accepted; **superseded by 0018** — no flag, always-on", the ADR-0016 retraction note, the pending-sign-off notes). The generator must own only the row set (number + title + link, derived from the files) and **preserve the existing status prose per ADR number** when regenerating — or the freshness check must be limited to "a row exists per file, no row without a file". Never let a generator flatten the retraction/supersession prose.
- **NO `README.md` ban.** The sibling retires the bare name repo-wide; here the root `README.md` is published npm product surface (it is listed in `package.json` `files`). Do not port that rule. The `<subject>-index.md` convention applies only to generated listings; the `read-before-<activity>.md` guide convention becomes lintable only once ticket 97 introduces such guides.
- **npm, not pnpm.** Optionally wire `npm run lint:docs`; plain `node tools/…` invocations must work regardless.

## What to do

- [ ] Create `tools/` with the adapted scripts (`doc-lint.mjs`, `issue-index.mjs`, `adr-index.mjs`, or index generation folded into doc-lint if simpler). Zero dependencies; runs from any cwd.
- [ ] Fix the first catches as part of this ticket (they are the lint's shakedown, and they are already known-stale): repoint all four dead `docs/agents/*` citations in `AGENTS.md` to the real homes; delete or correct the false line-3 "no application code / package manifest / build-test toolchain" claim; correct the tracker section (tickets live in `Issue-tracker/`, `.scratch/` is scratch specs during active work); rewrite `README.md`'s **Status** section, which still describes "Ticket 01 scaffold … Host adapter and tools land in later tickets" — replace with an honest current-state paragraph (always-on dispatcher plugin, wrapper shell, ~95 tickets of history; keep it npm-surface appropriate).
- [ ] Generate the open-queue index (suggest `Issue-tracker/open-issue-index.md`, per the `<subject>-index.md` naming for generated listings) and add it to the layout block in `Issue-tracker/issue-tracker.md` in the same change.
- [ ] Decide and record the ADR-index merge rule (generator owns rows; human prose preserved per ADR number), then bring `docs/adr/README.md` to that state and prove a regenerate produces no unwanted prose loss.
- [ ] Done means: `node tools/doc-lint.mjs` (and each generator, then a `--check`-style rerun) exits clean on the fixed tree, and **a second run produces no diff**.

## Constraints

- This ticket was filed by a visiting scribe agent; **no implementation is performed in the filing pass** — implementation belongs to this repo's own agents via the normal flow.
- `README.md` changes stay product-appropriate (it ships in the npm tarball); internal bookkeeping goes in the docs, not the product page.
- No new dependencies; scripts stay plain node.

## Comments

### 2026-09-20 — scribe (filing pass; no implementation performed)

Filed together with ticket 97 from an outside audit of the orientation layer. Evidence gathered this pass: `docs/agents/` absent (`ls docs/agents` fails); `AGENTS.md` lines 3, 70, 76, 80, 84 carry the stale claims/citations; `README.md` Status section untouched since ticket 01; `package.json` `files` includes `README.md`; max existing ticket number 95 (`Issue-tracker/resolved/95-packaging-license-prepack-repo-metadata.md`), so this is 96. The sibling tool paths above are device-specific and cited read-only; nothing is copied verbatim — adapt to this repo's schema, per the standing adapted-copy policy (AGENTS.md 2026-09-18 ruling / ADR-0018 exception B9).

Ticket 97 depends on nothing here being merged first, but its guides will add `read-before-*.md` files; if 97 lands first, extend the naming check rather than skipping it.

### 2026-09-20 — triage (overnight team-lead run, W0 bookkeeping)

Triaged 2026-09-20 by the overnight team-lead run: `ready-for-agent`. Next in the overnight work
order (W1–W5: tooling, first catches + indexes, independent verification).
