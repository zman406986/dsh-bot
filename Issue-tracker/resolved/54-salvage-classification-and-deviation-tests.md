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

- [x] Every `src/` and `test/` file classified, no `TBD` rows. — 53 + 41 files; one file (`report-clamp.ts`, 123 lines) and its test (116 lines) carry `unresolved — needs U-3` and are **counted separately**, not rounded into a verdict.
- [x] The test-encoding-a-deviation list exists, or the silence is documented explicitly with the searches that established it. — Four of six deviations pinned; two silent; the search vocabulary and hit counts are recorded in the note §3.6.
- [x] Counts and the survives/adapts/scrapped split stated with method. — Note §4; 39/13/1 by file, computed by script, totals reconcile.
- [x] §5's hypothesis explicitly confirmed or refuted. — Note §6: confirmed in headline, refuted on two sub-claims (`types.ts` is not untouched; `report-clamp.ts` is unresolved rather than surviving).
- [x] `git status` clean apart from the new note.

## Comments

### 2026-09-18 — head start from team-lead: the deviation-encoding tests

The research team hit the platform rate limit (resets **18:59:25**), so the assigned worker could not start. Rather than idle, the team lead ran a **targeted search** for exactly the output this ticket calls its most important — the tests that encode a deviation. **This is not the exhaustive survey** and it is not the per-module classification. Verify and extend it; do not treat it as complete, and do not re-derive it from scratch.

**Four of the six deviations are pinned by the existing suite.** That is the finding: the suite is not silent, it is *complicit* — it asserts the deviating behaviour, so any fidelity fix will fail tests that currently pass. Budget for updating them.

| Deviation | The test that encodes it | What it pins |
|---|---|---|
| **D-1** contract channel | `test/adapter-cordis-dsh-host.test.ts:190-192` (and `:223`) | Asserts the worker contract arrives as `spec.request.prompt[0].text`. **This is the conversation channel.** Ticket 55 must update it, not work around it |
| **D-3** safety section | *none* | Search for `safety` across `test/` returns **zero hits** — the section is absent *and* unguarded. Ticket 56 adds the first coverage |
| **D-4** restart notice queued | `test/restart-honesty.test.ts:305-308` | Collects the notice from **`agent.injected`** and asserts exactly one. This pins the *queueing* primitive — the exact defect. **Ticket 57 will break this test**, and that is correct: the assertion must move to the waking path. The surrounding assertions (content, exactly-one, rebuild-before-publish, unknown rows off-roster) are all sound and should be kept |
| **D-5** unbounded undelivered persistence | `test/todo-reconciler.test.ts:486` (`landedUndelivered.length === 1`) and **`:526`** (`assert.deepEqual(first.landedUndelivered, second.landedUndelivered)`) | `:526` is the sharp one — it asserts the landed-undelivered item is **unchanged across successive reconciles**, i.e. that nothing ever escalates it. That is D-5 stated as a requirement. Also `test/durable-roster.test.ts:272-273`, `:481-482`. Ticket 58 must update these |
| **D-6** delivery telemetry | *none* | `disposition`, `superseded`, `lost`, `redrive` return **zero hits** across `test/` — no coverage, consistent with the subsystem not existing |
| **B-1** freed stream key | not yet searched | **Not covered by this head start.** Search the restart suites specifically: `test/durable-roster.test.ts` "restart rebuild" block (`:233-486`) is the likely home |

**Second finding — the seam we are about to adopt is completely unguarded.** `persona` appears **nowhere** in `test/`. Neither does `agentOptions`. So ticket 55 wires a verified host seam that no test currently watches: write the assertion *before* the change, or a regression in the channel swap is invisible.

**Method, so it is reproducible:** `Grep` over `test/` for each deviation's vocabulary — `request\.prompt|persona|agentOptions`, `safety`, `restart|injectNotice`, `landedUndelivered|markDelivered`, `lost|redrive|disposition|superseded`. Absence of hits is reported as a finding, per the ticket.

**Still yours to do:** the per-module classification of all 54 `src/` files and 41 `test/` files with verdict + loop stage + reason; the counts; the orthogonality check on tickets 43–49; and the explicit confirm-or-refute of the audit's §6 hypothesis. Also confirm this head start by re-running each search.

### 2026-09-18 — resolved by the team lead (`docs/research/dsh-core-loop-salvage-map.md`)

The assigned worker died on the 429 twice, so the lead ran the pass. Deliverable written; ticket closed.

**Answer to the rebuild question: adapt, don't demolish — now supported by numbers instead of a reading of the deviation surface.** 53 `src/` files / 12,754 lines and 41 `test/` files / 19,100 lines classified: **39 Keep / 13 Keep+adapt / 1 unresolved / 0 Rewrite / 0 Delete**. 72% of `src` survives untouched; 25% survives with a named change; nothing product-side is thrown away.

**Three findings that change what the follow-on tickets say:**

1. **§6's hypothesis is confirmed but wrong on two rows.** `core/types.ts` was listed as surviving untouched — it cannot, because the obligation vocabulary (D-5/D-6) lands there. And `core/report-clamp.ts` is not "untouched" but **unresolved**: it is the U-3 addition under review, so it belongs to neither bucket. The "wiring change" bucket is also larger than §6 said — 13 modules, not 4.
2. **The head start's D-5 pin was misidentified.** `todo-reconciler.test.ts:526` is a *determinism* assertion (same inputs → same outputs) and a bounded implementation would still pass it — it should be **kept**. The real pin is `:454-487`, titled "does not prune in-progress or undelivered items", which asserts an ancient undelivered item produces no mutation. Ticket 58 updates `:454-487` and keeps `:490+`. The head-start version would have had an implementer "fix" a purity test for no reason.
3. **B-1 is not merely unguarded — it is asserted as intended.** `durable-roster.test.ts:313-321` asserts, under the comment "Stream key is free for a legitimate re-dispatch", that a live-at-crash worker's freed stream key can be re-spawned (`assert.ok(redispatch.ok)`). So **ticket 59's fix must not be "refuse the re-dispatch"** — that breaks a green test asserting a legitimate recovery path. The fix has to make the freed key *safe* (explicit claim state, or cold-resume reattach). No test models the orphan, so the risk itself stays unguarded.

**One task for the implementers, from §3.5:** `persona` and `agentOptions` have **zero** hits in `test/`. Ticket 55 wires a verified host seam that nothing currently watches — write the assertion before the channel swap, or a regression there is invisible.

**One precondition recorded rather than assumed:** this pass read the tests, it did not run them. `npm test` is the precondition for the 8-file / 4,435-line test-cost figure having teeth.

**Path:** `docs/research/dsh-core-loop-salvage-map.md`.
