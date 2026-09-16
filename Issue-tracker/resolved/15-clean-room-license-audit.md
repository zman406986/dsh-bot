# 15 — Clean-room / license audit

**What to build:** The one-time proof that nothing from the reconstruction tree shipped. This is a late gate, run once the product is mostly finished — deliberately deferred, never skipped.

**Blocked by:** 01 through 14 — every ticket above.

**Status:** resolved

- [x] The shipped tree is searched for reconstruction identifiers, at minimum: `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`, and the reconstruction's file basenames.
- [x] The search covers source, prompt assets, tool descriptions, comments, fixtures, and user-visible strings — not just imported modules.
- [x] Prompt assets are reviewed against the rule that they are new copy, not paraphrases: any accidental recalled phrase is rewritten, not lightly edited.
- [x] Every shipped identifier traces to this project's own glossary or is independently chosen.
- [x] The audit is recorded as a dated note under `docs/research/` stating the command run, what was searched, and the result.
- [x] Any finding is fixed and the audit re-run; the ticket is not closed on a finding.
- [x] No reconstruction file is imported, vendored, or transliterated anywhere in the deliverable.

## Answer

Audit run 2026-09-16. Full note: `docs/research/clean-room-license-audit.md`.

- Grepped the shipped tree (`src/`, `test/`, `package.json`/lock, `tsconfig.json`, `README.md`, compiled `lib/`) case-insensitively for `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`, reconstruction file basenames (`subagent-runtime`, `sand-subagent-*`, `run-scheduler`, `completion-revivals`, …), plus word-boundary/`sand-` variants.
- **One finding, fixed:** a file-header comment in `src/adapter/wake-copy.ts` read `No Sand/reconstruction wording.` — the codename `Sand` is banned in shipped comments. Rewritten to `No reconstruction-tree wording.` Rebuilt `lib/` (gitignored). Grep re-run clean.
- Non-findings recorded in the note: the three test `FORBIDDEN_VOCAB` arrays (intentional negative-test fixtures), AGENTS.md/PRD/CONTEXT policy text that names the ban, `sandbox` as a generic host term in `access-types.ts`, and `docs/research`/`docs/diagrams` evidence of the reference runtime (out of product scope).
- Prompt/policy/tool-description assets under `src/core/policy/`, `src/worker/prompt.ts`, `src/adapter/wake-copy.ts`, `src/core/tools.ts`, `src/core/tool-results.ts`, `src/adapter/worker-access-tool.ts` were read end-to-end; all new copy, no reference-like phrasing.
- Glossary trace: shipped names map to CONTEXT.md / PRD §16 (Dispatcher, Worker, Peer agent, Steer, Wake, Delivery, Stream key, Multitask core/profile). No reconstruction codenames, no CONTEXT avoid-list synonyms.
- No vendored reconstruction files. Nested reference tree not opened during the audit and never committed into this repo.
- After fix: `npm run build` + `npm run typecheck` green; `npm test` **301 pass / 0 fail**.

Residual risk (static-text limit, not this ticket's gap): greps cannot catch a paraphrased-but-not-literal borrow. Mitigation already in place: new-copy discipline, `assertNewCopy` unit tests, PRD §10. A semantic similarity pass against the reference would be a new legal task.
