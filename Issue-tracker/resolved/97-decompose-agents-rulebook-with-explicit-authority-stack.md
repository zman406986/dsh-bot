# 97 — Decompose the AGENTS.md rulebook + add an explicit authority stack

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (logically pairs with ticket 96 — its doc lint then guards the new structure; neither blocks the other)
**Related:** `docs/adr/README.md` (ADR-0016 retraction — the motivating case), ADR-0001, ADR-0018, ticket 64 (PRD amendments), ticket 69's Q1 ruling (an example of a recorded agent ruling), sibling-repo pattern cited below as device-specific evidence

## Problem

`AGENTS.md` is a single wall of text mixing at least six unrelated rule families: PRD-first process, legal/copy policy for the reference tree, browser self-test kill timers, network/proxy rules, tracker rules, and domain-doc pointers. A fresh agent cannot tell which rule wins when two conflict, because precedence between conflicting rules is **implicit**.

That is not hypothetical. Conflicts provable on disk today:

1. **AGENTS.md contradicts itself on the S7 grep.** Its reference-tree copying policy (2026-09-18 amendment) says "the S7 clean-room identifier grep is **voided** as a ship gate", while its own "Definition of working" section still requires "Legal QA: grep the shipped tree for reconstruction identifiers — S7 / PRD §12". An explicit order (human ruling / ADR-0018 above older AGENTS.md prose) settles it; nothing in the file states one.
2. **AGENTS.md vs ADR-0001.** The implementation-constraints table says the multitask core is "**Not TypeScript.** Prefer Go, else Python or Rust" — but ADR-0001 accepted a TypeScript in-process multitask core and the entire shipped tree is TypeScript. Only someone who already knows the ADR wins can resolve this.
3. **AGENTS.md's PRD-preference claim vs ADR-0018.** AGENTS.md says "Prefer the PRD over folder names or the reference README when they conflict", yet ADR-0018 (accepted, human-ruled 2026-09-18, the master rule) voids the PRD's feature-flag and clean-room-grep requirements, and the PRD was amended to match (ticket 64). The real order — accepted ADRs above the PRD — exists only in practice, not in any recorded stack.

And the case that shows what missing precedence costs: **ADR-0016 was retracted 2026-09-18 as "signed under a fabricated premise"** (`docs/adr/README.md`; tickets 50/51 cancelled). An explicit conflict-order plus a habit of verifying a decision's stated premise before recording it is exactly the guard that episode lacked.

## Proposal

Follow the sibling repo's pattern (device-specific absolute path, sibling repo "Spreadsheets in Space"): `C:\Users\TZhen\Desktop\Spreadsheets in space\AGENTS.md` — sections **"Reading order"**, **"Type-of-work rules live with the work"** (the work→guide table), and **"Authority stack"** (numbered, highest first, with a stop-and-ask rule for uncovered conflicts).

1. **Split per-topic rules into `read-before-<activity>.md` guides co-located with the work.** Candidates, from what the wall actually contains:
   - Kill timers + live-test token frugality + the dsh-key rule → e.g. `read-before-running-live-and-browser-tests.md` (or co-locate near `dev/` / the test scripts — implementer's call on placement).
   - Reference-tree legal/copy policy → a short guide that points at ADR-0018 and the 2026-09-18 human ruling rather than restating them (one home per fact).
   - Tracker rules already live in `Issue-tracker/issue-tracker.md` — AGENTS.md should only point there, not carry a divergent copy (its `.scratch/` claim is already wrong; ticket 96 fixes that line).
   - Network/proxy note → a small environment/ops guide or a compact AGENTS.md section if it stays short.
   - The implementation-constraints table and "Definition of working" are PRD/ADR territory: point at the authoritative docs, keep only rules that are genuinely process.
2. **AGENTS.md becomes a short rulebook that points:** reading order, the type-of-work table (work → guide), the authority stack, non-goals. Every rule in today's file either moves into a guide or stays — **none is deleted**; that is the definition of done.
3. **Add a numbered authority stack.** Proposed from what is actually on disk — **verify and adjust before recording** (the implementing agent may find more records than this pass did):

   1. **Human explicit override** — dated rulings, whether spoken or recorded on an ADR/ticket.
   2. **Accepted ADRs** — ADR-0018 is the human-ruled master rule among them; draft `-nonhuman-approved` ADRs rank below accepted ones until signed.
   3. **The PRD as amended** (ticket 64's amendments ride with it; AGENTS.md's stale "Open decisions" pointers and the Go/Python/Rust table row yield to ADR-0001 here).
   4. **`CONTEXT.md`** — the shared-language glossary.
   5. **`AGENTS.md` + the `read-before-*.md` guides** — process rules.
   6. **Recorded ticket rulings** — including agent rulings explicitly marked subject to human reversal (e.g. ticket 69's Q1, which self-describes exactly that way).
   7. **Research notes** (`docs/research/`) — evidence and decision inputs, never rulings.

   Two deliberate deviations from the brief's sketch (human → PRD → AGENTS.md → ADRs → tickets → research), with reasons: the repo's own records put **ADRs above the PRD** (ADR-0018 voided PRD requirements and the PRD was amended to conform), and ticket rulings sit above research notes because a recorded decision — even a reversible agent one — outranks evidence it consulted. Note the sibling ranks its shared language *above* its ADRs; here the glossary was amended to conform to ADR-0018, so ADRs-above-glossary matches observed practice — keep it that way unless the implementer finds a counterexample.

4. **The stack settles, it does not re-open.** Cite at least one past conflict as settled by the stack — the S7 self-contradiction (resolved: human ruling/ADR-0018 over stale prose) and ADR-0001 over the "Not TypeScript" table row are both ready-made; the ADR-0016 fabricated-premise retraction is the motivating case and should be referenced as why the stack exists.

## What to do

- [x] Inventory every rule currently in `AGENTS.md`, line by line, into a move/stay table (kept in this ticket's comments or a colophon in the new AGENTS.md) so "no rule lost" is checkable. **(Done — the moved-rule register in `docs/agents-rulebook.md` §Moved-rule register, 30 rows; no-rule-lost independently re-checked 2026-09-20, W14 — see the closing comment.)**
- [x] Write the `read-before-*.md` guides; rewrite `AGENTS.md` as the short pointer rulebook (reading order, type-of-work table, authority stack). **(Done — both guides + the ~50-line stub verified on disk 2026-09-20, W14.)**
- [x] Record the authority stack, verify the proposed order against the repo's records, and adjust with reasons where this ticket's sketch is wrong. **(Done — 8-level stack, practice-cited per level, deltas (a)/(b) recorded in the W4 comment; re-verified 2026-09-20, W14.)**
- [x] Rewire cross-pointers so nothing dangles (`docs/adr/README.md`, `agent.md`, `Issue-tracker/issue-tracker.md`, `research/research.md`, `README.md`), then run ticket 96's doc lint (once it exists) clean — if 96 has not landed, do the pointer check by hand and say so in the closing comment. **(Done — 96 landed first; lint 0 findings; re-run green 2026-09-20, W14.)**
- [x] Done means: `AGENTS.md` visibly shorter, every old rule located (moved or stayed, none deleted), the stack present with at least one settled past conflict cited. **(Verified 2026-09-20, W14 — see the closing comment below.)**

## Constraints

- This ticket was filed by a visiting scribe agent; **no implementation is performed in the filing pass** — implementation belongs to this repo's own agents via the normal flow.
- Do not re-litigate any ruled decision: the stack records precedence, it does not reopen ADR-0018, the ADR-0016 retraction, the S7 voiding, or any ticket ruling. If the inventory surfaces a conflict no recorded decision covers, stop and ask the human rather than silently picking an order.
- Guides follow the `read-before-<activity>.md` naming convention (sibling convention, adopted here for guides); generated listings keep the `<subject>-index.md` convention from ticket 96; the root `README.md` stays exempt from any naming ban (npm product surface).

## Comments

### 2026-09-20 — scribe (filing pass; no implementation performed)

Filed together with ticket 96 from an outside audit. Evidence gathered this pass: the three numbered conflicts above were each verified against the current files (`AGENTS.md` reference-policy section vs its "Definition of working"; `AGENTS.md` constraints table vs `docs/adr/0001-typescript-in-process-multitask-core.md` and the shipped TypeScript tree; ADR-0018's voiding of the PRD requirements recorded in `docs/adr/README.md`); the ADR-0016 retraction wording is quoted from `docs/adr/README.md`. The proposed stack order is a proposal for verification, not a ruling — this scribe has no authority to set precedence, only to show the conflicts that need one.

### 2026-09-20 — triage (overnight team-lead run, W0 bookkeeping)

Triaged 2026-09-20 by the overnight team-lead run: `ready-for-agent`. Next in the overnight work
order (W4 implementation + W5 independent verification, after 96's tooling lands).

### 2026-09-20 — agent (W4 implementation: rulebook decomposed, stack recorded; stays open for W5 verifier)

**What moved where.** The line-by-line inventory is the **moved-rule register** in
`docs/agents-rulebook.md` §Moved-rule register — 30 register rows covering every rule line of the
old file's 11 sections, none deleted. Counts: **6 moved unmodified** (read-PRD-before-work;
never-commit-into-the-reference-tree; the browser-test block (authorization + dsh key + trivial
tasks); the kill-timer block; the network/proxy line; the log-an-issue-before-implementing rule)
→ `read-before-running-live-and-browser-tests.md`, `read-before-reference-tree-work.md`,
`docs/agents-rulebook.md` §Environment & network, and `Issue-tracker/issue-tracker.md`
("Before implementing anything", moved this date, unmodified). **6 stayed as pointers** (intro
state; tracker layout; triage labels; domain docs; research notes; non-goals) — their homes
already exist (`Issue-tracker/issue-tracker.md`, `agent.md`, `research/research.md`, PRD §2) and
were reused, no parallel docs created. **15 became pointers to higher authority** (the
reference-tree ruling rows → ADR-0018 B9 / PRD §3/§17; constraints rows → ADR-0018 exceptions
A5/B8/B9, A2-note, PRD §6.2/§6.5/§7/§15; definition-of-working → PRD §4 S1/S5/S8; the
PRD-preference rule kept but scoped below levels 1–2). **3 marked superseded/voided, not
rewritten** (below). `AGENTS.md` is now a thin pointer stub: current state, reading order,
type-of-work table, stack summary, non-goals pointer, and a safety one-liner routing live-test
work to the guide. Honest note: `AGENTS.md` is git-ignored (`.gitignore` line 3), so the stub is
local-only — that is precisely why the durable homes are the tracked files above; recorded as a
feature of the decomposition, not a workaround. Source notes ("moved from AGENTS.md <section>,
2026-09-20, unmodified") are carried in both guides and the register.

**Final authority stack** — flagged in the rulebook as "proposed order, verified against recorded
practice — human reversal possible"; one practice citation per level:

1. **Human explicit override** — ADR-0018 "accepted (human-ruled, 2026-09-18) — the master rule"
   (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md`); the 2026-09-18
   reference-tree accepted-risk ruling (exception B9); ADR-0016's retraction shows an override
   striking even a signed ADR.
2. **Accepted ADRs** — accepted ADR-0001 over the "Not TypeScript" row
   (`docs/adr/0001-typescript-in-process-multitask-core.md`); ADR-0018 supersedes accepted
   0005/0009 by name.
3. **The PRD as amended** — ADR-0018 voided the PRD's flag/S7 requirements (ticket-64 batch, PRD
   §15/§4 strikethroughs); PRD §8 had already resolved TypeScript while AGENTS.md still said
   otherwise (ADR-0001 Context records it).
4. **Draft ADRs** (`-draft-nonhuman-approved`) — ADR-0017: "Nothing is re-litigated until the
   text is signed … no existing code or ticket is retired on the strength of this draft alone"
   (`docs/adr/README.md`); ADR-0020 exists only to pick accepted ADR-0018's vehicle.
5. **`CONTEXT.md`** — its 2026-09-19 amendment notes conform the glossary upward to ADR-0018.
6. **`AGENTS.md` + the `read-before-*.md` guides** — the register rows yield to ADR-0001/0018;
   "Implementation is ticketed separately (ticket 76) per repo rule" (`docs/adr/README.md`,
   draft-0019 note) shows a process rule binding an ADR follow-up.
7. **Recorded ticket rulings** — ticket 69's Q1, "ruled 2026-09-19 (overnight dispatched ruling,
   agent — subject to human reversal)" (`Issue-tracker/open/69-classifier-gated-auto-review.md`);
   the U-I re-scope "Agent-recorded 2026-09-19 as a dispatched overnight ruling, subject to human
   reversal" (recorded in ADR-0018's exception U-I, ticket 71).
8. **Research notes** — ADR-0001 cites `docs/research/dsh-extension-surface.md` as its evidence
   base; the note itself "takes no side".

**Deltas from this ticket's proposed 7-level sketch** (adjusted to match recorded practice):
(a) draft ADRs are pulled out of the "accepted ADRs" level into their own level **below the PRD**,
because the record shows an unsigned draft does not move the PRD (ADR-0017's suspension of
PRD-first resolutions takes effect only on signing); (b) two adjacencies are untested by any
recorded conflict and are flagged as such in the rulebook: `CONTEXT.md` vs draft ADRs, and
`AGENTS.md`/guides vs ticket rulings (the sketch's order kept there). No inventory finding
lacked a recorded decision, so the stop-and-ask human escalation was not triggered.

**Superseded-row marking.** The constraints-table row "**Not TypeScript.** Prefer Go, else
Python or Rust. …" is preserved verbatim in the register, **marked superseded** with a pointer to
`docs/adr/0001-typescript-in-process-multitask-core.md` (the exact row ticket 96 flagged for this
ticket). Also marked, not rewritten: the open-decisions paragraph (stale — PRD §15 is fully
resolved/voided; ADR-0006's Consequences had already recorded that AGENTS.md must not name an
open §15 item, so the local file had drifted) and the S7 legal-QA line (voided by ADR-0018; the
S7 self-contradiction, ADR-0001-vs-row, and the ADR-0016 fabricated-premise retraction are cited
in the rulebook as the settled conflicts the stack exists to settle).

**Cross-pointers and lint.** Rewired: `CONTEXT.md`'s B9 cite now points at
`read-before-reference-tree-work.md`; a dated AGENTS.md-pointer note was added to
`docs/adr/README.md` (accepted ADR texts untouched, per the 2026-09-19 ticket-74 note pattern —
older ADR prose saying "see AGENTS.md" resolves through the stub to the new homes). The doc lint
was extended for the new doc class (rulebook + both guides added as orientation docs; `AGENTS.md`
mustCite-guarded on the three new homes; row-shaped forbid guards for the superseded
"Not TypeScript. Prefer Go…" row and the S7 grep line, so the register's verbatim quotes and the
stub's settled-conflict mention stay legal). Per-rule fixture coverage unchanged (no new rules);
self-test stayed green.

**Gates (on merged main):** `npm run lint:docs` green and idempotent — doc-lint 0 findings across
6 rules, issue-index fresh (11 rows), adr-index fresh (20 rows); doc-lint `--self-test` 38/38;
`npm run typecheck` clean (both tsconfigs); `npm test` **1108 / 270 / 0** (assertions / suites /
fail — matches baseline).

**Commits:** branch `wt/agents-rulebook-97`: `5d83187` (guides), `f78676f` (rulebook),
`5d6bdcf` (CONTEXT.md + ADR-README pointer rewires), `268106f` (doc-lint); `--no-ff` merge
**`b574410`**; on main directly (ticket-33 precedent): `b9b61a7` (tracker rule moves home) and
this comment.

**Stays open** for the W5 independent verifier (no-rule-lost diff of old vs new AGENTS.md against
the register, stack-vs-practice check, pointer resolution, lint re-run) and the W17/W18 sweep.

### 2026-09-20 — RESOLVED (W14 closure): no-rule-lost, stack-vs-practice, pointers, and lint independently verified by a fresh verification pass; moved open/ → resolved/

**Delivered (chain record).** W4: `docs/agents-rulebook.md` — the 8-level authority stack
(practice-cited per level, untested adjacencies flagged, deltas from the sketch recorded with
reasons), the settled-conflict citations (S7 self-contradiction, the "Not TypeScript" row vs
ADR-0001, the PRD-preference claim vs ADR-0018, plus the ADR-0016 fabricated-premise retraction
as the motivating case), and the 30-row moved-rule register (none deleted; superseded/voided rows
marked, not rewritten) — plus `read-before-running-live-and-browser-tests.md`,
`read-before-reference-tree-work.md`, the thin AGENTS.md pointer stub, the CONTEXT.md and
ADR-README pointer rewires, and the doc-lint extension for the new doc class (merge `b574410`,
branch commits `5d83187`/`f78676f`/`5d6bdcf`/`268106f`; main-direct `b9b61a7` tracker-rule move;
dated comment `66f16d8`).

**Verification (2026-09-20, W14 — independent of W4).** Honesty note: the overnight PLAN's W5
verifier dispatch never landed a comment on this ticket, so this closure records the equivalent
pass, run fresh today by an agent that did not implement W4:

- **No rule lost:** the moved-rule register (30 rows) was checked against the
  pre-decomposition AGENTS.md text (session-start snapshot). Every section — Source of truth,
  Reference-tree copying policy, Implementation constraints (all 8 table rows), Open decisions,
  Definition of working, Non-goals, Browser self-testing, Kill timers, Network, and the four
  Agent-skills sections — and every rule line is accounted for (moved unmodified / pointer /
  marked superseded-voided); none found missing.
- **Guides + stub on disk:** both `read-before-*.md` guides exist with source notes and the moved
  rules (live-test authorization + dsh-key rule + trivial-tasks rule + the kill-timer block;
  ADR-0018 B9 pointer with the no-restatement discipline); AGENTS.md is a ~50-line pointer stub
  (visibly shorter) whose cites resolve; `docs/agents-rulebook.md` is tracked (the durability
  feature, since AGENTS.md is git-ignored).
- **Stack matches recorded practice:** accepted ADRs above the PRD (ADR-0018 voided PRD
  requirements; the ticket-64 amendments ride with the PRD), draft ADRs below the PRD
  (ADR-0017's sign-gate), ticket rulings above research notes — i.e. the W4 deltas are exactly
  the recorded ones. No ruled decision re-opened: the rulebook settles S7, ADR-0001, and the
  ADR-0016 retraction without re-arguing them.
- **Pointers + lint:** `npm run lint:docs` GREEN (doc-lint 0 findings across 6 rules — the lint
  guards the stub's mustCite homes and the superseded-row/voided-S7 forbid rules), self-test
  38/38, idempotent (generator re-run, no diff).
- Offline gates re-run on main this date for the record: `npm run typecheck` clean (both
  tsconfigs); `npm test` **1125 pass / 0 fail / 272 suites**.

Moved `Issue-tracker/open/97-decompose-agents-rulebook-with-explicit-authority-stack.md` →
`Issue-tracker/resolved/`, `**Status:**` → `resolved`. No other file moved.
