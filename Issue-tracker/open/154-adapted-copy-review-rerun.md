# 154 — Re-run the adapted-copy review: the recorded pass predates tickets 116-149

**Status:** open
**Labels:** ready-for-agent
**Origin:** PRD gap scan 2026-10-28 — verified against the tree; nothing implemented.
**Related:** PRD §12 Legal QA row (`:382`, amended 2026-09-18 by ADR-0018 — adapted-copy review replaces the identifier grep), §13 M4 (exit condition), `docs/research/no-verbatim-copy-review-2026-09-19.md` (the recorded pass), ADR-0018 B9, ticket 33 (the review it closed).

## Problem

The only recorded adapted-copy pass is `docs/research/no-verbatim-copy-review-2026-09-19.md` (ticket 33 close-out, dated 2026-09-19). M4's exit condition is "Adapted-copy review recorded" (PRD:394), and the PRD still points at that file as the evidence.

Copy and code have moved a long way since. Model-facing and user-facing files that changed after the review date:

| File | Last change | What landed since 2026-09-19 |
|---|---|---|
| `src/core/policy/prompts.ts` | 2026-10-24 | peer messaging (`message_agent`, ticket 116), bounded await (117), mitosis (118), peer roster heading/intro (121), spawned-dispatcher policy variant (141) |
| `src/core/policy/assembler.ts` | 2026-10-24 | roster rendering, liveness vocabulary, activity phrasing (121), wake digest wording (110) |
| `src/core/tools.ts` | 2026-10-23 | tool descriptions for the three new verbs, `reply_to_dispatcher` (122) |
| `src/worker/prompt.ts` | 2026-10-20 | worker contract additions |
| `src/adapter/wake-copy.ts` | 2026-10-23 | peer wake cue, resume cue |

None of that copy has a recorded reviewed verdict. The 2026-09-19 pass names its own basis as `docs/research/*.md` plus the tree as it stood then, so it cannot cover text written a month later.

## What to do

- Re-run the same method as the 2026-09-19 pass (it is repeatable and its results table is the template): search battery over `src/ test/ client/ lib/ scripts/ package.json README.md`, naming-independence trace for every new tool/module name, prompt-phrase probes for the phrases the new copy introduces.
- Extend the comparison basis first: read the research notes added after 2026-09-19 (`docs/research/2026-10-18` peer design, `2026-10-22-reference-nested-dispatcher-prompts.md`, the mitosis notes) and record any reference phrasing they quote or describe, because the new copy (peer wake, roster, await, mitosis) is exactly where borrowing would occur.
- Cover the ZH copy if ticket 153 lands first; otherwise state the ZH face as out of scope in the verdict and re-check it when 153 resolves.
- Record a new dated file under `docs/research/` (do not edit the 2026-09-19 file; it is a historical record), and update the PRD's M4 status line to cite the new pass.

## Acceptance

- [ ] A new dated review file exists under `docs/research/`, same structure as the 2026-09-19 pass (method, findings table, verdict).
- [ ] Every finding is either fixed in the same branch or filed as its own ticket; none is left as prose-only.
- [ ] The PRD §13 M4 row cites the new file; the old file stays untouched.
- [ ] The verdict explicitly states which copy was in scope and which was not (ZH, vendored racoons, test fixtures).

## Constraints

- Our shipped tree only; the reference-material folder is read-only and is not opened beyond what `docs/research/` already records.
- No code behavior change beyond fixing copy a finding names.
- Do not treat the review as a compliance gate — ADR-0018 already voided the identifier grep as a gate; this is a quality check whose residual risk the human accepted.
- Offline only.

## Comments

2026-10-28: Filed from a read-only gap scan. File dates above come from `git log -1 --format=%ad --date=short` per file, not from ticket prose. Ticket numbers 116-149 are the ones the filing instruction named; the table lists the files those tickets actually touched.
