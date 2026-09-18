# 54 — Salvage classification of the tree, and the list of tests that encode a deviation

**Status:** open
**Type:** research
**Labels:** ready-for-agent
**Blocked by:** none — but the API rate limit that killed the first attempt resets **18:59 on 2026-09-18**; do not launch before then, or you will die the same way.
**Related:** 52 (the parent audit — this is its deferred Q3), `docs/research/dsh-core-loop-fidelity-audit.md` §6–§7 (the provisional hypothesis this ticket must confirm or destroy), `docs/research/dsh-core-loop-deviations.md` (the deviations each verdict must be argued against)

## Why this exists

Ticket 52's Q3 asked for a per-file salvage classification. That pass was killed by an HTTP 429 after 27 minutes and wrote nothing. The audit therefore ships a **provisional** effort shape (§6) that is the lead's reading of the deviation *surface* — untested against the tree. This ticket replaces the guess with the survey.

The human is weighing "stash main and rebuild". The audit's provisional answer is **adapt, don't demolish**. That is a strong claim and it is currently unsupported. Confirm it or destroy it.

## Deliverable

`docs/research/dsh-core-loop-salvage-map.md`, with:

### 1. Per-module classification

Every module in `src/` (54 files) and every test in `test/` (41 files). For each:

| Field | Requirement |
|---|---|
| Verdict | `Keep` / `Keep+adapt` / `Rewrite` / `Delete` |
| Loop stage | 1–10 per ADR-0017, or `not core-loop` |
| Reason | **One line, specific.** A verdict with no reason is not acceptable |

Where a module is sound but its **wiring** changes, say exactly what changes.

### 2. The tests that encode a deviation — the most important output

List every test that asserts our current behaviour **where the reference differs**. Each is a test that must change with any fidelity work, and each one is evidence about what the tree is actually committed to. Search the suite for assertions on: the contract's delivery channel, the absence of a safety section, restart-notice behaviour, the unbounded persistence of undelivered items, and delivery telemetry. If the suite is silent on all of these, **say that** — silence is itself a finding, because it means the deviations were never pinned.

### 3. Counts

Modules and tests per verdict; lines-of-code per verdict if cheap. State the split as **survives / adapts / gets scrapped**, with the method, reproducibly.

### 4. Orthogonality check

Tickets 43–49 are live-pass and infrastructure fixes (web dev overlay, plugin settings card, tool JSON Schema validity, `--dsw-*` theme tokens, command registration via the generator-effect idiom). Confirm each is orthogonal to fidelity and would survive intact; flag any that is not, with a reason.

### 5. Confirm or destroy the audit's §6 hypothesis

The audit claims: *survives untouched* = the loop spine (`worker-fsm`, `wake-bus`, `steer-queue`, `report-clamp`, `types`, `dsh-host`/`fake-host`, `tool-barrier`, roster/presence, all of `client/`, tickets 43–49); *survives with wiring change* = `cordis-dsh-host.ts`, `worker/prompt.ts`, `plugin.ts` + `restart-notice.ts`; *new work* = the obligation layer; *scrapped* = nothing. State plainly whether the survey supports this. A refutation is worth more than a confirmation.

## Anti-motivated-reasoning requirement

This repo has ~700 passing tests and the human is weighing a rebuild. "Everything survives" and "nothing survives" are both suspect. Argue every `Rewrite`/`Delete` from a specific deviation or a specific wrong behaviour, and every `Keep` from a specific matching behaviour. Where you genuinely cannot tell, write `unresolved — needs <what>` and count it separately rather than rounding it into a verdict. **No `TBD` rows.**

## Clean-room

Product-code side only. Do **not** open `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` — not even to look. Use the abstracted notes in `docs/research/`, which are the citable authority for the reference side: `reference-core-loop-spec.md`, `reference-agent-lifecycle.md`, `reference-agent-prompt-inventory.md`, and the audit.

## Constraints

- **Read-only.** Modify no file except your own note. Do not commit. Do not stash, reset, rebase, or delete anything.
- **Offline.** No network, no LLM calls, no running dsh.
- If you launch any process, set a **kill timer at launch, before anything else** (AGENTS.md).
- Git Bash here lacks coreutils (`ls`, `cat`, `head`, `sed`, `grep`, `wc`). Use `Read`/`Glob`/`Grep`. PowerShell output is not captured.

## Acceptance criteria

- [ ] Every `src/` and `test/` file classified, no `TBD` rows.
- [ ] The test-encoding-a-deviation list exists, or the silence is documented explicitly with the searches that established it.
- [ ] Counts and the survives/adapts/scrapped split stated with method.
- [ ] §5's hypothesis explicitly confirmed or refuted.
- [ ] `git status` clean apart from the new note.
