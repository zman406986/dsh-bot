# 62 — Verify whether the reference's subagent inherits the shared prompt sections (R-1)

**Status:** open
**Type:** research
**Labels:** ready-for-agent
**Blocked by:** the platform rate limit (agents unavailable until **18:59 on 2026-09-18**); it also **requires a session that has not read product code** — see the clean-room rule below.
**Related:** register item **R-1** (`docs/research/dsh-core-loop-deviations.md` Part C and its reframing note); ticket 55 (the `persona` channel that makes R-1 relevant); `docs/research/reference-agent-prompt-inventory.md` Appendix B

## The question

R-1 has been carried as `approved-by-necessity` — "a worker still inherits the dispatcher's composed preset, and we cannot give it a truly minimal system prompt." Reading the notes again, that framing looks wrong: the reference's subagent does not get a blank system prompt either. It is built by the **same assembler**, driven by one subagent boolean, with role text layered on top of shared sections.

Two things are unresolved, and both are cheap to settle by reading the reference tree:

1. **Do the memory and user-identity sections reach a subagent runner?** Appendix B's composition order shows an early return for a *shared-room* runner but none for a subagent runner. If subagents do receive memory and identity, the "shadow of a shared composer" reading is confirmed.
2. **Whose profile does a child carry** — its own, or the parent's snapshot?

If the answer is "shared sections do reach the subagent", then **R-1 is `not-a-deviation`**: our `persona`-on-an-inherited-preset arrangement is structurally the same shape, and the register item closes with no acknowledgment needed.

## Clean-room — a hard constraint, not a formality

This is a **reference-tree observation pass**. The session running it must **not** have read `src/`, `test/`, `lib/`, or `client/` — the project rule is that the reference tree is never open in the same session as product code, and a prior session in this epic already read both sides in sequence. Spawn a fresh agent for this; do not hand it to an agent that has been working on implementation tickets.

- **Read:** `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`.
- **Do not read:** any product code, and not the reference folder's own `.git` (read files only, no git commands inside it).
- **Concept-level abstraction only.** No source text, prompt text, identifier, or protocol artifact reproduced. File names as provenance are acceptable in a research note; string literals are not. The reconstruction's own codenames stay out of the note — cite file names only where needed, and never reproduce a string.
- Run a case-insensitive self-audit grep over your own note for the reconstruction's codenames before finishing, and report the result.

## Deliverable

Append a dated section to `docs/research/reference-agent-prompt-inventory.md` — **do not** create a new note, because this is a close-out of that note's Appendix B, and a separate file would let the two drift.

The section must state, with `file:line` evidence and an explicit evidence grade per claim — **(a) directly evidenced / (b) inferred / (c) unobservable in this reconstruction**:

1. Whether the memory section renders for a subagent runner, and under what flag.
2. Whether the user-identity section renders for a subagent runner.
3. Whose agent profile a child carries.
4. Whether any **other** section is dropped or swapped for subagent runners beyond the agent directory and the no-user-channel flag — a complete list, since a partial list is how wrong claims get made.

Then a one-paragraph **R-1 verdict**: `not-a-deviation`, or `approved-by-necessity` with the specific shared section that confirms it. Do **not** decide the register disposition yourself — recommend it, and the human's acknowledgment field is set by the human or the lead, never by the researcher.

## Constraints

- **Offline.** No network, no LLM, no running dsh.
- If you launch any process, set a **kill timer at launch time, before doing anything else** (AGENTS.md — cleanup-at-end is not sufficient).
- Modify no file except the note named above. Do not commit.

## Operational notes

- Git Bash here **lacks coreutils** (`ls`, `cat`, `head`, `tail`, `sed`, `grep`, `wc`). Use `Read`/`Glob`/`Grep`. PowerShell output is not captured.
- Use absolute paths.

## Acceptance criteria

- [ ] The four questions are each answered with a `file:line` and an evidence grade — `unknown` is acceptable **only** with a statement of what evidence would settle it.
- [ ] The R-1 verdict paragraph exists and names the specific section(s) that decide it.
- [ ] The self-audit codename grep result is recorded in the section.
- [ ] No product code was read by the session that ran this pass.
- [ ] `git status` clean apart from the note.

## Notes

- **A refutation is worth more than a confirmation here.** If the memory section turns out to be skipped for subagents, that *restores* R-1 as a genuine unreachable gap — and that is the more valuable outcome, because it would mean our worker carries context the reference's does not.
