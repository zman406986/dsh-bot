# dsh-forget: extend the useful context window by forgetting useless parts while memory is fresh

- Date: 2026-10-19
- Status: **design proposal for human decision.** Level-8 research plus a recommendation, not a ruling. Nothing implemented.
- Supersedes `docs/research/proposal-context-density-2026-10-19.md`, whose cadence verdict imported evidence from summary-based systems (see §2).

---

## 0. The claim

> **Compaction is stupid. It asks a bloated agent to one-shot remember everything important. That always fails.**

The failure is structural, not a tuning problem. By the time compaction runs, the agent is at its least able to judge what mattered: the context is enormous, the oldest material is far away, and the budget it must fit into is small. It is asked to perform a recall task at the exact moment recall is hardest.

Then it throws away 90.7% of the context and hopes.

**dsh-forget inverts the operation.** Instead of compressing a bloated context once, it **forgets useless parts continuously while memory is fresh** — at the moment relevance is knowable, not hours later. Nothing is summarized. What survives is verbatim. What is dropped is either provably useless or retrievable by id.

**Success criterion: native compaction never fires.** Today it fires 2,080 times across 695 sessions. The target is zero. Compaction is not our mechanism; it is our failure state.

---

## 1. Why the obvious objection does not apply

The obvious objection is: "frequent context operations are known to hurt — there is a 35,000-run study showing fewer, larger compactions resolve tasks better (50.7% → 62.7% when the trigger moved from 10K to 20K)."

**That study, and every study like it, measures summary-based compaction.** In those systems each operation is lossy: a model reads the context and writes a shorter prose version. Loss per operation multiplies with frequency, so fewer operations genuinely win. The finding is a statement about the cost of *summarizing*, not about the cost of *forgetting*.

dsh-forget's operations are of a different kind:

| | Summary-based compaction | dsh-forget |
|---|---|---|
| What the operation does | model rewrites content smaller | removes content from the visible surface |
| What survives | a prose paraphrase | the original, verbatim, or a written negative fact |
| Per-operation loss | large and unpredictable | zero for forgotten content (still in the log); zero for retained content (byte-identical) |
| Cost of frequency | multiplies loss | multiplies nothing but bookkeeping |
| When it runs | once, at maximum bloat | continuously, at episode close, while fresh |

**Removing the loss term removes the reason frequency was bad.** With lossless operations, frequency stops being a design variable at all: run them as often as the content justifies. The measured decay in summary systems — 53% of safety rules surviving one round, 10% after five, 10 facts absent through 106 of 108 forced compactions — is precisely the failure dsh-forget exists to make irrelevant.

This is the whole thesis. If the operations are not lossless, the thesis is false and the design should be abandoned.

---

## 2. What we learned from the earlier pass (and what was wrong)

The previous proposal imported the "fewer, larger compactions" verdict as a design constraint. That was a reasoning error: the verdict is about summary-based systems, and this design removes summarization from the loop. Any decision in that document justified by "compaction-frequency studies" is withdrawn here.

What survives, because it is independent of compaction technique:

- **The problem is real and measured** (§3).
- **Native dsh already ships a compaction stack** (§4) — we do not need to build one, and we do not want it to fire.
- **All existing pruning rules are size- or age-based**; none classify content (§5).
- **Retrieval is rarely used by agents** (arXiv:2609.20804), so a dropped item with only a pointer is effectively lost. The written negative fact must carry the value.
- **A written description of a failure suppresses repeat attempts**; replaying it verbatim increases them (arXiv:2608.23651).
- **The write protocol is a contract**: `compaction/prune` then an adjacent `surfaceOp replace`, or the meter silently misprices (§4).

---

## 3. The measured problem

Source: `.scratch/repo-analysis/2026-10-19-empirical-junk-census-overnight.md`. 9,667 sessions, 14.0 GB, 2,080 compaction events in 695 sessions.

**Compaction, as practiced:**

| Metric | Value |
|---|---|
| Median tokens before → after | 296,018 → 24,934 (**90.7% removed**) |
| Median messages | 264 → 1 |
| Summary size vs replaced span | 22,115 B vs 853,272 B (**2.6%**) |
| Largest event | 2,224,990 → 64,750 over 6.69 MB |
| **Dropped read bytes re-fetched later** | **29.4%** |
| Events with at least one path re-read after | 69.4% |

That last row is the indictment. The agent threw away 90.7% of its context and then went back for a third of it. Compaction removed information it still needed.

**Where the bytes go:**

| Class | Bytes | Share of tool-result bytes |
|---|---|---|
| Failed-search episodes | 356.5 MB | **87.1%** |
| Results >8 kB (12,771 calls) | 240.3 MB | 50.8% |
| Repeat reads of the same path (5,440 paths) | 87.5 MB | 21.4% |

Failed-search episodes: 21,494 total, median 2 calls, p90 = 11, max 290.

**A correction to the earlier reading of this data:** only 6.7% of episodes were later resolved by an edit to a read path. That does not weaken the rule — it changes what the rule must produce. Most episodes never find a hit, so the payload for the common case is a **negative fact** ("not in these files"), not a retained excerpt.

---

## 4. The host already provides the machinery

dsh 0.2.1-rc.2 ships: `dsh-compaction-basic` (LLM summarizer at 678k on a 1M window), `dsh-compaction-tool-result-pruner` (deterministic, size-only, 8192 code points → head 4096 + marker + tail 1024), `dsh-compaction-image-offload`, `dsh-command-compact`, `dsh-token-meter`.

Two facts that shape everything:

1. **The shipped pruner classifies nothing.** Its README says "Pruning is syntactic." Size is the only rule.
2. **A plugin may write its own prune.** Any producer may issue a `surfaceOp replace` (`dsh-session/types.d.ts:452-457`), provided it appends `compaction/prune` `{shadowedRange, shadowedSeqs, shadowedTokenCount}` and **immediately** appends the replacement with `sourceEventSeqs`, changing only content. Non-adjacent ordering makes the meter's claim silently expire as a zero delta.

Raw events survive every surface rewrite; `dsh-session-query` reads shadowed entries and records carry `surface: 'current' | 'shadowed' | 'log-only'`. **Forgetting is reversible by construction.**

A genuine idle hook exists: `agent/status` idle plus `agent.runMaintenance()` / `whenIdle()`. Background work is real here, not a metaphor.

---

## 5. What everyone else does, and the gap

Every non-LLM pruning rule across eleven studied systems is **size-based or age-based**: dsh's pruner, dsh's 12,500-token spill policy, ZCode's idle microcompact (60 min, keep newest 5 batches), OpenHands observation masking (after newest 100), Kilo (protect newest 40k, free 20k), Cline basic fold, Gemini CLI's reverse 50k budget, Claude Code tool-result clearing, Grok's char caps.

**Nine junk classes have no rule anywhere:** repeated identical reads, superseded same-path reads, repeated errors and retries, passing-test spam, ANSI and progress noise, huge diffs, stale build output, settled-subagent results, duplicate tool calls.

That is the gap dsh-forget occupies. It is also the only place we would be inventing rather than copying.

Prior art that constrains the design:

- **Self-GC** (arXiv:2607.00692) is the nearest neighbour: a forked side channel emits a `fold`/`mask`/`prune` plan, applied by a deterministic harness; production 43.95% of prefix pruned, 84.85% of continuations unaffected.
- **Gemini CLI** ships span-level verbatim retention (`FULL | PARTIAL | SUMMARY | EXCLUDED` with line ranges and a `[Showing lines X–Y of N in file...]` marker).
- **Evict-by-pointer** exists at record granularity: Context Surgeon, Letta MemFS/recall, Zep, TierMem.
- **Span-level selection inside one large result has no prior art.** That single piece is ours.

---

## 6. The method

### 6.1 Principle

**Forget, never compress.** Every operation must satisfy one of:

1. **Remove something provably useless**, and leave a written fact that says what it was and that it was useless — so the agent does not redo the search.
2. **Keep something verbatim**, either whole or as exact line ranges.
3. **Replace a body with a pointer** whose target is readable by id.

No operation may rewrite retained content. No operation may feed prior output back through a model. Corrections are new records citing old ids.

### 6.2 The four forgetting rules

**F1 — Entry-time capping (cheapest, highest measured yield).**
Large results are capped when they arrive, not later: head + exact omitted counts + a line-range marker + a spill path. 12,771 results over 8 kB carry **50.8%** of all tool-result bytes, 80% of them file reads. This needs no episodes, no model, no surface rewrite.

**F2 — Failed-search forgetting (the flagship).**
A search episode closes when the agent stops reading new paths. Then:

- the **hit** (if any) is kept verbatim;
- the **misses** become one written fact:

```
[search: <target>] not found in:
- <path> — <title or first heading> · <lines> · <size>
- …
<if found> Found in: <path> · lines <X–Y> kept verbatim
<if not found> No match in these files. Do not re-read them for this.
```

Measured basis: 87.1% of tool-result bytes live in these episodes. The negative record is the payload because 93.3% of episodes never resolve.

**F3 — Span retention inside a result.**
When a large result was used only in part, keep the used lines verbatim and drop the rest with a marker:

```
<verbatim lines X–Y>
[Showing lines X–Y of N in file <path>. Full file available via read_file.]
```

Selection, in order: cross-reference (spans the agent later quoted or derived from — deterministic line matching), then access tracking (spans followed by an edit, re-read, or path citation), then agent-authored retention (the agent records the excerpt at use time), then optional LLM range selection.

**F4 — Closed-episode eviction by pointer.**
When old segments must leave the window, they are evicted whole to the log with a stable id and their own short title. Never re-summarized, never folded into another record. Retrieval restores the original verbatim.

### 6.3 Why "while fresh" is the operative phrase

Seals happen at **episode close**, not on a token timer. At that moment:

- the span is small and recent, so selection is accurate;
- relevance is directly observable in what the agent just did (it quoted this, edited that, gave up on these);
- nothing has been paraphrased yet, so there is no prior loss to compound.

This is the structural answer to "summaries of summaries": **there are no summaries**, and every record is written once, from raw content, at the moment the information is most legible.

### 6.4 What does not happen

- No fixed-interval summarization.
- No summary of a summary, ever.
- No rewriting of retained content.
- No replacement of native compaction — it stays as a backstop that should never be reached.
- No local content-search index, no local token ledger (ADR-0018 U-H).
- No model writing memory. The model may propose ranges; the validator copies bytes.

### 6.5 Safety

- The edit-plan schema **cannot carry content**: only hashes, seq ranges, and ≤400-char labelled notes.
- Every retained span is hash-verified byte-for-byte against a frozen snapshot. Nodes not mentioned in the plan default to **keep**.
- 30 numbered validator checks; any failure rejects the whole plan. No partial application.
- Atomic apply: `compaction/prune` then the `surfaceOp replace`, synchronously, with a `logRevision` compare-and-swap.
- Protected: system prompt, dispatcher policy, newest tail, in-flight turn, open approvals.
- Failure posture: forget nothing, write one honest line. Never degrade silently.

### 6.6 Why the cache survives: seal latency, not seal frequency

Prompt caches are strict prefix caches — all providers, verified. A rewrite at position N invalidates every cached token **after N**. Nothing before N is touched.

That asymmetry is the whole answer. **Where you cut decides the cost, not how often you cut.**

| Cut location | Invalidated suffix | DeepSeek cost (miss 1.0 / hit 0.02) |
|---|---|---|
| Head — old junk at token 100k of a 1M context | 900k tokens | ~900,000 units |
| Tail — the episode that just closed at token 950k | 50k tokens | ~50,000 units |

Same amount of forgetting, **~180× difference in cache cost.** Cutting old material requires re-reading everything after it; cutting recent material does not.

**This is what "while memory is fresh" buys, and it is a cache property, not only an accuracy property.** Sealing an episode at its close means the span is still near the tail, so the suffix that gets invalidated is small. The governing variable is **seal latency** — how far behind the tail the sealed span sits — not the token cadence.

Three independent arguments now point at the same design choice:

1. **Accuracy** — at episode close, relevance is directly observable (what the agent quoted, edited, or abandoned), so selection is trustworthy.
2. **No compounding loss** — records are written once from raw content, so there is no summary to decay.
3. **Cache cost** — the cut is near the tail, so the invalidation is bounded by latency, not by the 1M-token context.

**Break-even for a tail seal.** A 50k episode at the tail becomes a 5k record. The one-time cost is writing the 5k replacement (~4.9k units at this host's pricing); the per-turn saving is 45k fewer cached reads (~0.9k units per turn). **Payback in about 5 turns.**

For comparison, the same eviction at the head invalidates 900k tokens. At 0.9k units saved per turn, that never pays back in a real session. **Head eviction is the operation to avoid; tail sealing is the one to do constantly.**

**Three consequences for implementation:**

- **F1 is free.** Entry-time capping appends the capped result as new content; nothing already in the prefix changes. Zero invalidation.
- **Seal eagerly, at `turn-stopping` or idle.** Every turn of delay adds suffix to the invalidated region. The budget is latency, so the design should have a latency SLO (seal within a turn of episode close), not a token interval.
- **Old sealed records are not re-evicted during a session.** Once a record has moved toward the head, replacing it costs the whole suffix. When records must eventually leave the window, do it at a **cold-cache boundary** — a resumed session, an idle gap past the TTL, or a model change — where the invalidation is free because the cache had already expired. On this host caches survive hours to days of disuse, so overnight idle is a genuinely free eviction window.

**What this removes from the earlier debate:** the "fewer, larger rewrites" argument assumed every rewrite was a head or whole-suffix rewrite. With tail sealing, rewrite *count* is cheap and only rewrite *position* is expensive. Frequency is no longer a cost axis at all — which is the same conclusion the loss argument reached, by a different route.

---

## 7. Success metrics

dsh-forget is falsifiable. These are the numbers that decide it:

| Metric | Today | Target |
|---|---|---|
| Native compaction events | 2,080 across 695 sessions | **0** |
| Dropped bytes later re-fetched | **29.4%** | <10% |
| Tool-result bytes in failed-search episodes | **87.1%** | <45% |
| Results >8 kB entering context uncapped | 12,771 | 0 |
| Median summary-to-span ratio | **2.6%** | n/a — no summaries |
| Useful depth before forced loss | ~296k tokens | >1M |

Criterion 1 is the headline: if native compaction still fires, dsh-forget is not working, regardless of how good the forgetting looks.

---

## 8. Rollout

| Slice | What | Needs model? | Needs surface rewrite? | Effort |
|---|---|---|---|---|
| 1 | F1 entry-time capping | no | no | 1–2 d |
| 2 | F2 failed-search forgetting | no | no (result creation) / yes (retroactive) | 3–4 d |
| 3 | F4 closed-episode pointer eviction | no | yes | 3–4 d |
| 4 | F3 span retention | optional | yes | 4–5 d |
| 5 | Validator hardening: 30 checks, crash table, 43 unit cases | no | — | 3–4 d |
| 6 | LLM range-selection escalation | yes | — | 3 d, deferred |

Slices 1 and 2 need no model and can be applied at result-creation time, avoiding surface rewrites entirely. Slices 3–4 need the swap protocol and a live boot.

**Blocking live verification before slice 3:** whether our plugin may append `compaction/prune` and have the meter price it; orphan-prune recovery across a hard kill; `logRevision` stability across a synchronous block; `cacheRead`/`cacheWrite` populated on the DeepSeek route; listener ordering in `agent/pre-step`.

---

## 9. What would make us abandon this

1. Slices 1–2 do not cut tool-result bytes by 30% → the premise that junk dominates is wrong for our workload.
2. The re-fetch rate after forgetting stays above 10% → the negative facts are not carrying enough information.
3. Native compaction still fires after slices 1–3 → the forget rate is too low to matter.
4. One user-visible error per ~50 passes traces to a false drop → deterministic selection is not trustworthy at span granularity.
5. A falsification of the core claim: if forgetting provably costs task quality even when lossless, the thesis is wrong and the design dies.

---

## 10. Open questions

1. What counts as one "tool-result group" — validated with `toolPairingBalancedBefore/After`.
2. Whether a profile patch reaches `compaction-basic` inside a preset's isolated group.
3. Whether `measure().totalTokens` is the same quantity native compares.
4. Whether `appendPluginRecord` accepts a package-declared type at runtime.
5. Whether `turn-stopping` fires on aborted or errored turns.
6. How the peer roster (ADR-0027) changes growth rate per turn.
7. The user-visible posture when the circuit breaker opens — proposal: one line in the next wake turn.
8. Whether `postCompactTokenCount` can be trusted — unreliable in 129 of 1,028 events.

---

## 11. Decisions asked of the human

1. Adopt the **dsh-forget** framing and the success criterion "native compaction never fires"?
2. Ship slices 1–2 (no model, no surface rewrite)?
3. Accept that span selection is the novel part with no prior art?
4. Keep the LLM as an optional range-selector only, never as a writer of memory?

---

## 12. Evidence index

**Tracked in-repo:** `dispatcher-peer-memory-indicators-design-2026-10-18.md` (owner decisions), `segmented-compaction-design-2026-10-19.md` (segment model, options), `shadow-janitor-design-2026-10-19.md` (architecture, density-rebased), `janitor-swap-protocol-2026-10-19.md` (30 checks, crash table), `janitor-redteam-2026-10-19.md` (attacks, kill criteria).

**Local scratch (untracked):** `2026-10-19-empirical-junk-census-overnight.md` (**the measured basis for §3**), `2026-10-19-dsh-pruning-surface.md` (write protocol, recoverability, idle hooks), `2026-10-19-nonllm-pruning-rules.md` (rule catalogue, nine uncovered classes), `2026-10-19-failed-search-eviction-prior-art.md`, `2026-10-19-shadow-janitor-prior-art.md`, `2026-10-19-incremental-compaction-research.md`, `2026-10-19-provider-cache-mechanics.md`, `2026-10-19-evidence-transferability.md` (which studies transfer).

**External:** arXiv 2607.00692 (Self-GC), 2609.20804 (retrieval rarely used), 2608.23651 (description beats replay), 2508.21433 (masking halves cost). Studies of summary decay are cited only as the failure dsh-forget removes, never as design guidance.
