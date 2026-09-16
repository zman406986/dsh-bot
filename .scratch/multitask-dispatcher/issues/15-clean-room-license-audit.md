# 15 — Clean-room / license audit

**What to build:** The one-time proof that nothing from the reconstruction tree shipped. This is a late gate, run once the product is mostly finished — deliberately deferred, never skipped.

**Blocked by:** 01 through 14 — every ticket above.

**Status:** ready-for-agent

- [ ] The shipped tree is searched for reconstruction identifiers, at minimum: `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`, and the reconstruction's file basenames.
- [ ] The search covers source, prompt assets, tool descriptions, comments, fixtures, and user-visible strings — not just imported modules.
- [ ] Prompt assets are reviewed against the rule that they are new copy, not paraphrases: any accidental recalled phrase is rewritten, not lightly edited.
- [ ] Every shipped identifier traces to this project's own glossary or is independently chosen.
- [ ] The audit is recorded as a dated note under `docs/research/` stating the command run, what was searched, and the result.
- [ ] Any finding is fixed and the audit re-run; the ticket is not closed on a finding.
- [ ] No reconstruction file is imported, vendored, or transliterated anywhere in the deliverable.