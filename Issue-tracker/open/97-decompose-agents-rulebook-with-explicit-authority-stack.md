# 97 — Decompose the AGENTS.md rulebook + add an explicit authority stack

**Status:** open
**Labels:** needs-triage
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

- [ ] Inventory every rule currently in `AGENTS.md`, line by line, into a move/stay table (kept in this ticket's comments or a colophon in the new AGENTS.md) so "no rule lost" is checkable.
- [ ] Write the `read-before-*.md` guides; rewrite `AGENTS.md` as the short pointer rulebook (reading order, type-of-work table, authority stack).
- [ ] Record the authority stack, verify the proposed order against the repo's records, and adjust with reasons where this ticket's sketch is wrong.
- [ ] Rewire cross-pointers so nothing dangles (`docs/adr/README.md`, `agent.md`, `Issue-tracker/issue-tracker.md`, `research/research.md`, `README.md`), then run ticket 96's doc lint (once it exists) clean — if 96 has not landed, do the pointer check by hand and say so in the closing comment.
- [ ] Done means: `AGENTS.md` visibly shorter, every old rule located (moved or stayed, none deleted), the stack present with at least one settled past conflict cited.

## Constraints

- This ticket was filed by a visiting scribe agent; **no implementation is performed in the filing pass** — implementation belongs to this repo's own agents via the normal flow.
- Do not re-litigate any ruled decision: the stack records precedence, it does not reopen ADR-0018, the ADR-0016 retraction, the S7 voiding, or any ticket ruling. If the inventory surfaces a conflict no recorded decision covers, stop and ask the human rather than silently picking an order.
- Guides follow the `read-before-<activity>.md` naming convention (sibling convention, adopted here for guides); generated listings keep the `<subject>-index.md` convention from ticket 96; the root `README.md` stays exempt from any naming ban (npm product surface).

## Comments

### 2026-09-20 — scribe (filing pass; no implementation performed)

Filed together with ticket 96 from an outside audit. Evidence gathered this pass: the three numbered conflicts above were each verified against the current files (`AGENTS.md` reference-policy section vs its "Definition of working"; `AGENTS.md` constraints table vs `docs/adr/0001-typescript-in-process-multitask-core.md` and the shipped TypeScript tree; ADR-0018's voiding of the PRD requirements recorded in `docs/adr/README.md`); the ADR-0016 retraction wording is quoted from `docs/adr/README.md`. The proposed stack order is a proposal for verification, not a ruling — this scribe has no authority to set precedence, only to show the conflicts that need one.
