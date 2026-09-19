# 96 — Doc lint + generated indexes: make the orientation docs provably honest

**Status:** resolved
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
- [x] Done means: `node tools/doc-lint.mjs` (and each generator, then a `--check`-style rerun) exits clean on the fixed tree, and **a second run produces no diff**. **(Verified 2026-09-20, W14 — see the closing comment below.)**

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

### 2026-09-20 — W2 implementation (overnight run, first catches + indexes)

**All 16 known catches fixed, plus one late tooling catch. Branch `wt/doc-lint-96-fixes`; merges
`b6ca9ac` + `c6668a4` (branch commits `7faa45b`, `a28ec40`, `49f5953`, `2f9c540`).**

- `orientation-path-resolution` (6): AGENTS.md's four dead `docs/agents/*` cites repointed at the
  real homes — tracker section → `Issue-tracker/issue-tracker.md`; triage-labels and domain-docs
  sections → `agent.md` (both conventions live there); research section → `research/research.md`.
  README.md: `dev/cordis.dev.patch.yml` → `dev/cordis.web.patch.yml` (and the overlay invocation
  now reads `--profile web`, per that patch file's own header — the transient overlay targets the
  web route; the persistent multitask-profile route is the paragraph above). research/research.md:22:
  `docs/adr/0001-choose-go-for-core.md` → `docs/adr/0001-typescript-in-process-multitask-core.md`,
  with the sentence now stating the real citation (0001 → `docs/research/dsh-extension-surface.md`).
- `orientation-required-citation` (3): satisfied by the same repointing — AGENTS.md now cites
  `Issue-tracker/issue-tracker.md`, `agent.md`, and `research/research.md`.
- `orientation-forbidden-claim` (3): AGENTS.md line 3 "greenfield / no application code" replaced
  with a truthful current-state paragraph (TypeScript Cordis plugin; `src/` core/adapter/worker/
  client plus the `client/` wrapper shell; npm-driven typecheck/offline tests/build); the adjacent
  stale "Root currently has only the PRD and one reference tree" sentence went with it. AGENTS.md's
  tracker-location claim → `Issue-tracker/<status>/`, `.scratch/` described as scratch-only, per the
  tracker guide. README.md Status section rewritten as an honest implemented-and-offline-tested
  paragraph with no rot-prone counts.
- `tracker-status-agreement` (3): tickets 43/52/54 `**Status:** open` → `**Status:** resolved`.
  Each file's closure is recorded in dated in-file comments (43: all five ACs ticked with live-pass
  evidence; 52: "Q3 discharged; ticket resolved"; 54: "resolved by the team lead"). None looked
  genuinely unresolved; no file moved.
- `open-index-freshness` (1): `Issue-tracker/open-issue-index.md` generated (11 rows, GENERATED
  header) and committed; the layout block in `Issue-tracker/issue-tracker.md` now lists it.
  Regenerating produces no diff.
- `adr-index-row-freshness` (0): already clean; `docs/adr/README.md` untouched.

**Late catch, fixed in tooling (rule adjustment):** on merged main, `npm run lint:docs` flagged the
fresh index STALE — git autocrlf had rewritten the committed LF to CRLF at checkout, and the
byte-exact freshness compare treated the checkout artifact as content drift. `issue-index.mjs` now
renders and checks against the existing file's dominant EOL (mirroring adr-index.mjs); 3 new
self-test checks cover the CRLF round-trip (fresh under CRLF; rewrite preserves the style; drifted
content still flags). Docs were correct; the tool was brittle.

**Gates on final main (`c6668a4`):** `npm run typecheck` clean (both tsconfigs); `npm test` =
**1108 pass / 270 suites / 0 fail**; `npm run lint:docs` GREEN and idempotent (second run, no
diff); `doc-lint.mjs --self-test` **38/38** (35 → 38: the three CRLF checks keep per-rule fixture
coverage for the adjusted check).

**Notes for W3:** (1) AGENTS.md is git-ignored — its fixes exist only in the working tree (no
tracked diff, expected; the linter reads the tree, so the guard still holds). (2) The self-test
total is now 38, not 35. (3) Known and deliberately out of scope: AGENTS.md's PRD table still says
"Not TypeScript" for the core language while ADR-0001 rules TypeScript-in-process — left for
ticket 97 / W4's authority-stack pass; no lint rule covers it today. Ticket stays open for W3
independent verification.

### 2026-09-20 — RESOLVED (W14 closure): lint + generators verified green and idempotent by a fresh independent verification pass; moved open/ → resolved/

**Delivered (chain record).** W1 tooling: `tools/doc-lint.mjs` (6 data-driven rules),
`tools/issue-index.mjs`, `tools/adr-index.mjs` (zero deps; the ADR generator owns only the row
set and preserves hand-maintained status prose), `npm run lint:docs` wired, self-test green
(merge `690916f`, branch commits `2a452fa`/`c2eca32`, dated comment `0b1ceca`). W2 first catches +
indexes: all 16 known catches fixed — the 4 dead `docs/agents/*` cites repointed, the false
"no application code" claim deleted, the `.scratch/` tracker claim corrected, README Status
rewritten, tickets 43/52/54 status agreement fixed, `Issue-tracker/open-issue-index.md` generated
and committed — plus one late tooling fix (EOL-aware index freshness; self-test 35→38) (merges
`b6ca9ac` + `c6668a4`, branch commits `7faa45b`/`a28ec40`/`49f5953`/`2f9c540`, dated comment
`18833d5`).

**Verification (2026-09-20, W14 — independent of W1/W2).** Honesty note: the overnight PLAN's W3
verifier dispatch never landed a comment on this ticket, so this closure records the equivalent
pass, run fresh today by an agent that executed neither W1 nor W2: `npm run lint:docs` GREEN
(doc-lint 0 findings across 6 rules; issue-index fresh — 11 rows before this closure's move, 9
after regeneration; adr-index fresh, 20 rows); `doc-lint.mjs --self-test` 38/38; **idempotence —
both generators re-run in place, `git diff` empty** (second run produces no diff — this ticket's
own done-condition, the box above is ticked from this check); ADR status prose preserved (0005 /
0009 supersession notes, the 0013 vehicle note, and the 0016 fabricated-premise retraction all
verified present in `docs/adr/README.md`; prose preservation is also self-test-covered); AGENTS.md
claims verified against disk (thin pointer stub citing the real homes: `Issue-tracker/
issue-tracker.md`, `agent.md`, `research/research.md`) and README.md's Status section verified
rewritten as an honest implemented-and-offline-tested paragraph. Offline gates re-run on main
this date for the record: `npm run typecheck` clean (both tsconfigs); `npm test` **1125 pass /
0 fail / 272 suites**.

Moved `Issue-tracker/open/96-doc-lint-and-generated-indexes.md` → `Issue-tracker/resolved/`,
`**Status:**` → `resolved`. No other file moved.
