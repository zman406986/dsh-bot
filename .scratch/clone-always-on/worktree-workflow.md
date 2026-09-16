# Worktree workflow — ticket 17 behavior-clone effort (Phase 0)

Dated: 2026-09-17. Set up off main @ `b00d355`. This doc governs how agent teams work on
ticket 17 (`Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md`) without
crossing wires with main-repo work (e.g. ticket 16 follow-ups).

## 1. Layout

| Checkout | Path | Branch | Purpose |
|---|---|---|---|
| Main checkout | `C:\Users\TZhen\Desktop\dsh-bot` | `main` | Shared tracker, research notes, all non-ticket-17 work |
| Clone worktree | `C:\Users\TZhen\Desktop\dsh-bot-always-on` | `clone/always-on-dispatcher` | ALL ticket-17 implementation |

- Created with `git worktree add C:/Users/TZhen/Desktop/dsh-bot-always-on -b clone/always-on-dispatcher`.
  Verify anytime with `git worktree list` from either checkout.
- The worktree has its own `.git` file pointing back at the shared repo. **Commits made inside
  the worktree land on `clone/always-on-dispatcher` only** — `main` is untouched until the
  merge procedure below runs.
- Sibling directory by design. NEVER create a worktree inside the repo, inside the reference
  folder, or anywhere under
  `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` (that tree is legally
  contaminated and has its own nested `.git` — never commit into it).
- The worktree was verified self-sufficient offline at setup: `npm ci` clean,
  `npm test` → **514 pass / 0 fail**, `npm run typecheck` clean (2026-09-17).

## 2. What lives where

| Artifact | Location | Notes |
|---|---|---|
| Ticket-17 implementation code (all phases ≥ 3) | **Worktree** | Commit on `clone/always-on-dispatcher` |
| Ticket-17 design doc `.scratch/clone-always-on/design-17-*.md` | **Worktree** | Committed on the clone branch; reaches main at merge time |
| Ticket-17 split-ticket implementation edits (code + tests) | **Worktree** | One ticket at a time (see §5) |
| Split tickets for 17 (filing, status, comments) | **Main** (`Issue-tracker/open/17-*.md` and follow-ups) | Shared tracker stays on main; implementation status flows via ticket comments, not worktree commits |
| Phase-1 behavior inventory `docs/research/always-on-dispatcher-behavior.md` | **Main** | Research note lives on main so every agent (including read-only verifiers) can cite it |
| `docs/research/` (other notes), `docs/adr/`, `CONTEXT.md` | **Main** | If the clone work needs a research note or ADR, write it on main |

Rule of thumb: **evidence and coordination → main; product code and its design doc → worktree.**
The worktree is a quarantine: if any provenance contamination slips in, it stays reviewable as
one branch diff instead of leaking into main commit by commit.

## 3. Merge / LQA procedure (worktree → main)

`clone/always-on-dispatcher` merges back to `main` ONLY after all three gates:

1. **Clean-room QA** — identifier grep over the whole branch diff vs main, using the method in
   `docs/research/clean-room-license-audit.md`: case-insensitive `rg` for the banned
   identifiers and reconstruction basenames across every file the branch touches (source,
   prompts, tool descriptions, comments, test fixtures, user-visible strings, compiled output),
   plus a manual read of every new prompt/copy asset. Banned identifiers:
   `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*` (and reconstruction file
   basenames per the audit note). Intentional `FORBIDDEN_VOCAB` negative-test fixtures are the
   only allowed hits in `test/`.
2. **Offline tests green in the worktree** — `npm test` (0 fail) and `npm run typecheck` pass
   in `C:\Users\TZhen\Desktop\dsh-bot-always-on` with no network, no LLM, no running dsh (S8).
3. **Full-diff provenance review recorded in ticket 17 comments** — a human-free review of the
   complete `main...clone/always-on-dispatcher` diff for any reference-tree borrow
   (structure, phrasing, protocol artifacts), with the reviewer's findings appended as a dated
   comment on `Issue-tracker/open/17-*.md` on main.

Merge style: squash or merge commits — implementer's choice — but every commit/merge message
must reference the split ticket number(s) it closes (e.g. `17.3`).

## 4. Hard rules for anyone working in the worktree

- **Never open the reference tree while writing multitask-core or product modules.**
  Observation happens in dedicated research passes only (per ticket 17's legal section):
  read/observe → write abstract concept notes on main → close the tree → implement from the
  notes. An agent must never have the reference tree open and product code in the same editing
  session.
- **Never commit into the reference folder.** It is not the product repo; it has its own `.git`.
- **Never `git add -A`.** Stage exact paths only, in both checkouts.
- Banned identifiers (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`) are a **merge
  gate**, not a style preference. A branch that fails the grep does not merge.
- Workers stay blank-context with no user messaging; todos' `completed` means delivered to
  user; PRD wins where the reference behavior and PRD conflict (raise a decision, don't
  silently follow either).

## 5. Parallel-agent etiquette

- **Implementation tickets are worked one-at-a-time in the worktree.** It is a single shared
  working tree — two agents editing at once collide on disk and on the index. Serialize
  split-ticket implementation: finish (commit) one ticket's work before starting the next.
- **Verifiers may run read-only in parallel** (run tests, typecheck, grep audits, read the
  diff) — as long as they commit nothing and change no files.
- The Phase-1 research agent works on **main** (read-only on the reference tree, one note in
  `docs/research/`) and does not touch the worktree.
- If main moves forward (ticket 16 work, research notes), the worktree does not auto-rebase.
  Refresh deps in the worktree with `npm ci` after rebasing/merging main into the clone branch
  so `node_modules` matches the lockfile.

## 6. Setup evidence (Phase 0 acceptance)

- Worktree: `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`,
  base `b00d355` (same commit as main at setup).
- `npm ci`: clean (13 packages, prepare-hook build succeeded, 0 vulnerabilities).
- `npm test`: 514 pass / 0 fail (146 suites), offline.
- `npm run typecheck`: clean (both `tsconfig.json` and `tsconfig.client.json`).
- No commits made inside the worktree at setup; branch head == `b00d355`.
