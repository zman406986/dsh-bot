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

### 2026-09-20 — W1 implementation (overnight run, tooling pass)

**Built and merged (branch `wt/doc-lint-96`, commits `2a452fa` + `c2eca32`, merge `690916f`):**

- `tools/doc-lint.mjs` — zero-dep orientation-doc linter, data-driven: 6 rules
  (`orientation-path-resolution`, `orientation-required-citation`,
  `orientation-forbidden-claim`, `tracker-status-agreement`, `open-index-freshness`,
  `adr-index-row-freshness`). Extension points are data tables — `DOC_EXPECTATIONS`
  (mustCite/forbid with written reasons), `PATH_ALLOWLIST` (12 entries, each with a reason),
  `CONFIG`, and the `RULES` registry. Machine-readable `--json`; human default; exit codes
  0 clean / 1 findings / 2 usage.
- `tools/doc-lint.mjs --self-test` — the tool's own test, 35/35 green, runs only against
  `tools/fixtures/doc-lint/repo/` (a fixture repo with one rot instance per rule). It enforces
  per-rule fixture coverage, allowlist negatives, and generator round-trips (stale→fresh,
  byte-identical regeneration, ADR prose preservation) in a temp copy — the real docs are
  never touched.
- `tools/issue-index.mjs` — deterministic generator for `Issue-tracker/open-issue-index.md`
  (id/slug/title/labels from the H1 + `**Labels:**` line, status from the folder; 11 rows).
  Default writes; `--check` exits 1 when missing/stale; `--json`.
- `tools/adr-index.mjs` — merge-rule regenerator for `docs/adr/README.md`, per the ticket:
  the generator owns only the ROW SET (file exists ⟺ row exists, sorted); every existing row
  LINE is reused verbatim so the hand-maintained status prose (0016 retraction, 0005/0009/0013
  supersession notes, pending-sign-off notes) can never be flattened; new files get a row
  synthesized from the file's H1 + `**Status:**` line; all non-table prose byte-preserved;
  CRLF preserved. **Proven on the real README: regeneration is byte-identical (20 rows,
  `git diff` empty), so the merge state already holds.**
- `npm run lint:docs` wired (`node tools/doc-lint.mjs && node tools/issue-index.mjs --check &&
  node tools/adr-index.mjs --check`). No other script touched. Zero new dependencies
  (node:fs/path/url/os only); all tools run from any cwd.

**How to run:** `node tools/doc-lint.mjs [--json|--self-test]`, `node tools/issue-index.mjs
[--check]`, `node tools/adr-index.mjs [--check]`, or `npm run lint:docs`.

**Known-catches count on the pre-W2 tree: 16 findings across 6 rules** (all expected; W2 fixes
the docs). Breakdown:
- `orientation-path-resolution` (6): the 4 dead `docs/agents/*` cites in AGENTS.md (lines
  70/76/80/84), plus 2 beyond the filing list — README.md:51 cites `dev/cordis.dev.patch.yml`
  which does not exist (only `dev/cordis.web.patch.yml` is committed), and
  research/research.md:22 cites `docs/adr/0001-choose-go-for-core.md` (the repo's real 0001 is
  typescript-in-process).
- `orientation-required-citation` (3): AGENTS.md cites none of `Issue-tracker/issue-tracker.md`,
  `agent.md`, `research/research.md`.
- `orientation-forbidden-claim` (3): AGENTS.md line 3 "no application code, package manifest…";
  AGENTS.md line 70 tracker-lives-under-`.scratch/`; README.md line 7 "Ticket 01 scaffold …
  Host adapter and tools land in later tickets".
- `tracker-status-agreement` (3): tickets **43, 52, 54 sit in `resolved/` with
  `**Status:** open`** — found by the new check, not by the filing audit. W2 should re-point or
  relabel these (mechanical fix, same class).
- `open-index-freshness` (1): the generated open-index does not exist yet — W2 generates and
  commits it, then a second run must produce no diff.
- `adr-index-row-freshness` (0): already clean.

**Gates (recorded on merged main `690916f`):** `npm run typecheck` clean (both tsconfigs);
`npm test` = **1108 pass / 270 suites / 0 fail** (matches the 14ee7a9 baseline); self-test 35/35.
Offline-verified only; no live lane involved.

**Notes for W2:** (1) AGENTS.md is git-ignored (local-only, .gitignore line 3) — lint reads the
working tree, so the guard still works, but W2's AGENTS.md fixes will not produce a tracked
diff. (2) The allowlist exists because not every missing path is rot (convention names like
`CONTEXT-MAP.md`, profile-layer filenames like `cordis.patch.yml`, status-folder shorthand
`open/`); extend it only with a written reason. (3) Ticket 97's `read-before-*.md` naming check
should be added as a new rule + fixture when 97 lands (the RULES registry + self-test coverage
enforcement make that mechanical). Ticket stays open — W2 (first catches + indexes) and W3
(independent verification) remain.
