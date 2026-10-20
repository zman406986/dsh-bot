# Proposal: extending the useful context window

- Date: 2026-10-19
- Status: **proposal for human decision.** This is level-8 research plus a design recommendation, not a ruling. Nothing here is implemented; every claim about cost is modeled and every measurement is dated and cited.
- Owner objective (2026-10-19): *"extend the useful context window — keep throwing junk out, so when our context reaches 500K it is mostly useful information instead of normally being mostly junk."* Rewrite count is explicitly **not** an objective.
- Evidence index: §12. Per-source detail lives in `.scratch/repo-analysis/` (untracked, disposable).

---

## 1. The one-page version

**The problem is real and now measured.** In 9,667 sessions of real work (14 GB, ZCode store, 2026-08-29 → 10-19):

- Compaction removes **90.7%** of the context per event. Median: 296,018 tokens → 24,934. 264 messages become 1. The summary is **2.6%** of the span it replaces.
- **29.4%** of dropped read bytes are re-fetched later, and 69.4% of compaction events had at least one path re-read afterwards. A third of what is thrown away gets pulled back.
- **87.1%** of all tool-result bytes are spent in failed-search episodes; only 6.7% of episodes were later resolved by an edit to a file that was read.
- **50.8%** of tool-result bytes come from 12,771 results larger than 8 kB, 80% of them file reads.

**What we recommend:** a deterministic density layer that runs in the background, keeps the useful span of a large result **verbatim**, and replaces useless reads with a **written negative fact**. The model never writes memory; it may only propose an edit plan, and a deterministic validator copies every retained byte from the raw log.

**What we do not recommend:** a fixed-interval summarization cadence. The measured evidence says fewer and larger compactions win (35k-run study: 10K→20K trigger raised task resolution 50.7% → 62.7%), and summaries of summaries decay badly (53% of safety rules survive one round, 10% after five).

**The honest scope:** three of the ingredients already ship elsewhere; one is genuinely new. We are not building a system. We are building **one rule** — post-hoc answer-relevance — on top of machinery the host already provides.

**The gate that no longer gates:** the earlier design was gated on `q ≥ 0.5` (evictable share). Real data says median `q` is **0.409** and long editing sessions sit at **0.398**. Under a cost-at-equal-tokens comparison the design does not clear its bar. Under the owner's actual objective — density and continuity versus restarting sessions — it is at cost parity and buys continuity. §7 sets out both readings honestly.

---

## 2. What we already have (verified)

dsh 0.2.1-rc.2 ships a full compaction stack. This is the single most important fact in the proposal: **compaction is not missing, it is early-detection that is missing.**

| Package | Role | Fires at |
|---|---|---|
| `dsh-compaction-basic` | LLM summarizer, cache-reusing prefix call | `min(0.8W, W−O−65536)` = 678,464 on a 1M window |
| `dsh-compaction-tool-result-pruner` | **Deterministic**, size-only: >8192 code points → head 4096 + marker + tail 1024 | only when compaction-basic calls it, or on overflow |
| `dsh-compaction-image-offload` | Offloads oldest images | provider image error |
| `dsh-command-compact` | `/compact` | manual |
| `dsh-token-meter` | `measure(session)` → per-node tokens | always |

Two consequences:

1. **Native compaction has never fired in our dsh store** (0 events; max prompt 137,929 against a 1M window). The sessions that did compact are ZCode's, using ZCode's compactor.
2. **The shipped pruner classifies nothing.** Its own README says "Pruning is syntactic." Size is the only rule. That is the gap we would fill.

**The write protocol is a contract, not a suggestion.** A plugin may issue a surface replacement (`dsh-session/types.d.ts:452-457`), but it must:

1. append `compaction/prune` with `{shadowedRange, shadowedSeqs, shadowedTokenCount}`;
2. **immediately** append the replacement node with `surfaceOp {op:'replace', startSeq, endSeq}` and `sourceEventSeqs:[seq]`, changing nothing but content.

Non-adjacent ordering makes the meter's claim expire as a silent zero delta, or throws on range mismatch. Raw events survive; `dsh-session-query` reads shadowed entries and each record carries `surface: 'current' | 'shadowed' | 'log-only'`. Evicted content is genuinely retrievable.

**A real idle hook exists:** `agent/status` idle plus `agent.runMaintenance()` / `whenIdle()`. Idle rewrites are legal; the next turn logs a request header from the content change. "Background" is not a metaphor here.

---

## 3. What the field already does

Every non-LLM pruning rule found in eleven systems is **size-based or age-based**. None classifies content.

| System | Selection | Transformation | Preserves |
|---|---|---|---|
| dsh pruner | text >8192 code points | head 4096 + marker + tail 1024 | node id, log shadow |
| dsh spill-policy | >12,500 est. tokens | half-head + exact omitted counts + spill path | full text in spill store |
| ZCode microcompact | idle >60 min or ≥0.9× threshold; keep newest 5 batches | `[Old tool result content cleared]` | call ids, transcript |
| OpenHands masking | after newest 100 observations | drop / mask, no LLM | tombstones, event log |
| Kilo prune | protect newest 40,000 tokens; require >20,000 freed | `[Old tool result content cleared]` | stored output |
| Cline basic fold | target 0.7, preserve 20k | notices + path lists | sidecar, transcript |
| Gemini CLI | reverse 50k token budget | last 30 lines + temp file | temp file |
| Claude Code | old whitelisted tool results | `[Old tool result content cleared]` | JSONL originals |
| Grok Bot | tool 100k chars, shell 20k head+tail | head/tail + counts | files on disk |

**Nine junk classes have no rule anywhere:** repeated identical reads, superseded same-path reads, repeated errors and retries, passing-test spam, ANSI and progress noise, huge diffs, stale build output, settled-subagent results, duplicate tool calls.

That list is where we would be inventing. It is also where 87% of the measured waste lives.

---

## 4. What the evidence says about cadence

**Fewer, larger compactions beat frequent small ones.**

- A 35,000-run study raised the compaction trigger from 10K to 20K: events fell **4.85 → 1.15** per attempt and task resolution rose **50.7% → 62.7%** (arXiv:2609.32961).
- Summary fidelity decays with repetition: **53%** of safety rules survive one Claude Code compaction, **10%** after five (arXiv:2608.22752); 10 facts vanish at the first summary and stay absent through **106 of 108** forced compactions (arXiv:2607.20972); compactors retain **17%** of side constraints on average (arXiv:2608.11242).
- Masking halves cost at equal quality (53.4% → 54.8% accuracy, $1.29 → $0.61 per task, arXiv:2508.21433).

**Prior art for the shape we want:**

- **Self-GC** (arXiv:2607.00692) is the nearest neighbour: a forked side channel emits an XML `<gc_plan>` with `fold`/`mask`/`prune` ops over object ids, applied by a deterministic harness. Production: 43.95% of prefix tokens pruned, 84.85% of continuations unaffected, 10–15% fewer daytime input tokens.
- **Gemini CLI** ships span-level verbatim retention: `FileLevel = FULL | PARTIAL | SUMMARY | EXCLUDED` with `startLine`/`endLine`, emitting `[Showing lines X–Y of N in file...]`.
- **Evict-by-pointer** exists at record granularity: Context Surgeon (MIT), Letta MemFS/recall, Zep episodes, TierMem.
- **Span-level evidence retention inside a large tool result has no prior art.** That piece is open design.

**Two findings that change the design:**

1. **Recoverable elision yields no accuracy gain, because agents rarely invoke retrieval** (arXiv:2609.20804). "Lossless" on paper is not lossless in practice. The **in-context written negative fact carries the value**; retrieval is a backstop.
2. **Replaying a failed attempt verbatim increases repetition (0.06 → 0.54), while a written description removes 76% of the inversion** (arXiv:2608.23651). This is direct support for a one-line negative record and against keeping the failed result body.

---

## 5. The measured problem (the part that should decide this)

Source: `.scratch/repo-analysis/2026-10-19-empirical-junk-census-overnight.md`. 9,667 sessions, 14.0 GB, 2,080 compaction rows in 695 sessions.

**Long-session subset** (≥20 turns, or ≥4 compactions, or ≥500k prompt): 589 sessions — 6.1% of sessions but **36% of transcript bytes**.

**Compaction behavior**

| Metric | Value |
|---|---|
| Median tokens before → after | 296,018 → 24,934 (**90.7% cut**) |
| Median messages | 264 → 1 |
| Summary size vs replaced span | 22,115 B vs 853,272 B (**2.6%**) |
| Largest event | 2,224,990 → 64,750 over 6.69 MB |
| Auto / manual | 907 / 121 |

**The false-drop cost is measurable and large.** 69.4% of compaction events with reads in the span had a path re-read afterwards; **29.4% of dropped read bytes were re-fetched**. Roughly a third of what compaction throws away is immediately wanted again.

**Where the bytes go**

| Class | Bytes | Share |
|---|---|---|
| Failed-search episodes | 356.5 MB | **87.1% of tool-result bytes** |
| Results >8 kB (12,771 of them) | 240.3 MB | 50.8% of tool-result bytes |
| Repeat reads (5,440 paths) | 87.5 MB | 21.4% of result bytes |

Failed-search episodes: 21,494 total, median 2 calls, p90 = 11, max 290. Only **6.7%** were later resolved by an edit to a read path.

**The `q` number, honestly:** median **0.409**; long editing sessions **0.398**; sessions over 20 h **0.226**; read-only recon lanes **0.596**. The earlier `q ≥ 0.5` gate **does not hold** for the sessions this design targets.

---

## 6. The recommended design

**A density layer with a deterministic core and an optional model escalation.** The model proposes; the validator disposes.

### 6.1 The rule that carries the most bytes: failed-search eviction

When an agent searches across files and does not find what it needs, the failed reads are waste but the *negative knowledge* is not. Keep the hit verbatim; replace the misses with a written fact.

```
[search: <target>] not found in:
- <path> — <title/first heading> · <lines> lines · <size>
- <path> — ...
Found instead: <path> · <lines kept> · <anchor seq>
```

- Deterministic episode detection over `read` / `grep` / `glob`: a run with no intervening write.
- A "hit" is a later write or edit on a path, a ≥40-char quote in later assistant text, or a path citation.
- The hit stays **fully verbatim**. Misses collapse to ≤160 chars each, ≤1,200 chars per batch.
- Nothing is destroyed: raw events stay in the log and are readable by seq.

**Measured basis:** 87.1% of tool-result bytes are in these episodes. **Honest caveat:** only 6.7% of episodes resolve to an edit, so most episode content is genuinely unused — but that also means most episodes have *no hit to keep*, which is why the negative record (not a retained excerpt) is the payload for the common case.

### 6.2 The rule that carries the most bytes per line of code: oversized results

Cap large results at the point of entry, not later. 12,771 results over 8 kB carry half of all tool-result bytes, 80% of them file reads.

- Keep head + tail, emit exact omitted counts and a spill path (this is dsh's own spill policy shape — copy it, do not invent).
- Align with Gemini CLI's `[Showing lines X–Y of N in file...]` marker so the agent knows what it is missing and how to ask.

This needs no episode detection, no model, and no validator. **It is the cheapest thing with measured impact and it should ship first.**

### 6.3 The novel piece: span selection inside a result

For a large file where only one section mattered, keep that section verbatim:

```
<verbatim excerpt of lines X–Y>
[Showing lines X–Y of N in file <path>. Full file available via read_file.]
```

Selection, in order of preference:

1. **Cross-reference** — spans the agent later quoted or derived from. Deterministic line matching.
2. **Access tracking** — spans followed by an edit, a re-read, or a referenced path.
3. **Agent-authored retention** — the agent records the excerpt when it uses it. Highest accuracy, depends on compliance.
4. **LLM span selection** — a model returns **ranges only**, never prose. Optional escalation, not the default.

### 6.4 What we do not build

- **No fixed-interval summarization.** Measured to lose fidelity and to lose on task resolution.
- **No summary-of-summary.** Every record is written once from raw log content and never re-summarized. Corrections are new records citing old ids, never edits.
- **No replacement of native compaction.** It stays the backstop.
- **No local content-search index and no local token ledger** (ADR-0018 U-H). Measurement rides host facilities.

### 6.5 Safety properties

- The plan schema **cannot carry message or tool content** — only hashes, ranges, and ≤400-char labelled notes.
- Every retained span is hash-verified byte-for-byte against the frozen snapshot. Unmentioned nodes default to keep.
- 30 numbered validator checks; any failure rejects the whole plan, never partially applies.
- Apply is atomic: `compaction/prune` then the `surfaceOp replace`, synchronously, with a `logRevision` compare-and-swap.
- Protected regions: system prompt, dispatcher policy, newest tail, in-flight turn, open approvals.

---

## 7. Cost, honestly stated

Two readings of the same numbers, because the earlier analysis used the wrong denominator.

**Reading A — cost at equal raw token count** (the superseded comparison): the janitor is **+8% at q=0.3, −8% at q=0.5, −37% at q=0.7** on Anthropic-style pricing; on this host (DeepSeek, no write premium, 50× miss penalty) it is **+26% / −6% / −30%**. Given measured median `q` = 0.409, this reading says **the design is not a cost win**.

**Reading B — cost per unit of retained useful context** (the owner's actual objective): per 100k retained useful tokens, modelled ±30%:

| Approach | Total units | Per 100k useful |
|---|---|---|
| Native only (junk-heavy 1M) | 16.45M | 2,192,831 |
| Janitor at 50k | 8.15M | 857,642 |
| 5 fresh sessions + re-orientation | 7.11M | 854,327 |

Under this reading the janitor is **at parity with restarting five times**, **61% cheaper per useful token than a junk-heavy 1M**, and it keeps continuity — no re-orientation turns, no lost state.

**Rewrite cost is a line item, not the design:** rewrites are ~8.8% of the bill. The largest lever is the **compression ratio**, not the cadence (c=8 improves cost per useful token by 21% over c=5).

**Cache facts, as constraints only:** all providers are strict prefix caches, so any mid-conversation rewrite invalidates the tail. On this host a miss costs **50×** a hit ($0.15 vs $0.003 per MTok), and DeepSeek caches survive hours to days, which makes idle-time pruning nearly free. These are reported costs; they do not shape the design.

---

## 8. Rollout, in the order the evidence supports

| # | Slice | Why first | Effort |
|---|---|---|---|
| 1 | **Oversized-result cap** at entry, using the host's spill shape + Gemini's line marker | Measured: 50.8% of tool bytes from 12,771 results. No model, no validator, no epochs. | ~1–2 days |
| 2 | **Failed-search negative record** (deterministic) | Measured: 87.1% of tool bytes. Deterministic; no model. | ~3–4 days |
| 3 | **Span retention** via cross-reference + access tracking | The novel piece; needs the episode machinery from #2 | ~4–5 days |
| 4 | **Validator + atomic swap** hardening (30 checks, crash table, 43 unit cases) | Required before any surface rewrite ships | ~3–4 days |
| 5 | **Optional LLM escalation** | Only for spans the deterministic classifier cannot score | ~3 days, deferred |

Slices 1 and 2 need **no LLM at all** and no surface rewriting if applied at result-creation time. Slices 3–5 need the swap protocol and a live boot.

**Blocking live verification before slice 3:** whether our plugin may append `compaction/prune` and have the meter price it (highest risk); orphan-prune behavior across a hard kill; `logRevision` stability across a synchronous block; whether `cacheRead`/`cacheWrite` are populated on the DeepSeek route; listener ordering in `agent/pre-step`.

---

## 9. What would make us abandon this

1. If slices 1–2 do not reduce measured tool-result bytes by at least 30%, the premise that junk dominates is wrong for our workload.
2. If the re-read rate after eviction exceeds **10%** of evicted bytes (today compaction re-fetches 29.4%), the negative record is not carrying enough information.
3. If a single user-visible error per ~50 passes traces to a false drop, deterministic selection is not trustworthy at span granularity.
4. If `q` measured on *our own* dispatcher and worker sessions stays below 0.4 while slices 1–2 already capture most of the waste, the episode machinery is unnecessary.

Criteria 1–3 are measurable without shipping the risky half. Criterion 4 is measurable from slice 1 and 2 telemetry alone.

---

## 10. Open questions the implementation must not guess

1. What exactly counts as one "tool-result group" for selection — validated with `toolPairingBalancedBefore/After`.
2. Whether a profile patch row reaches `compaction-basic` inside a preset's isolated group.
3. Whether `measure().totalTokens` is the same quantity native compares.
4. Whether `appendPluginRecord` accepts a package-declared type at runtime.
5. Whether `turn-stopping` fires on aborted or errored turns.
6. How large the peer roster will be per turn once ADR-0027 lands, since it changes growth rate.
7. What the user-visible posture is when the circuit breaker opens. Proposal: one line in the next wake turn, no alert.
8. Whether `postCompactTokenCount` can be trusted — the census found it unreliable in 129 of 1,028 events.

---

## 11. Decisions this proposal asks of the human

1. **Ship slices 1–2** (oversized cap + failed-search record), which need no model and no surface rewriting?
2. **Do slice 3** (span retention), accepting that it is the novel part with no prior art?
3. **Accept the density-over-cost framing** — that the baseline is restarting sessions, not native compaction at equal tokens?
4. **Defer slice 5** (LLM escalation) until measured evidence justifies it?

---

## 12. Evidence index

**In-repo, tracked:**
- `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` — owner decisions and cross-source summary
- `docs/research/compaction-stack-design-2026-10-19.md` — first ladder design (superseded framing, useful host facts)
- `docs/research/segmented-compaction-design-2026-10-19.md` — segment model, failed-search rule, options A/B/C
- `docs/research/shadow-janitor-design-2026-10-19.md` — architecture, re-based on density
- `docs/research/janitor-swap-protocol-2026-10-19.md` — 30 validator checks, atomic apply, crash table
- `docs/research/cache-safe-pruning-design-2026-10-19.md` — cadence analysis (superseded objective)
- `docs/research/janitor-redteam-2026-10-19.md` — attacks, kill criteria, reconciliation

**Local scratch (untracked, disposable):**
- `2026-10-19-empirical-junk-census-overnight.md` — **the measured basis for §5**
- `2026-10-19-empirical-junk-census.md` — dsh-store census (short sessions)
- `2026-10-19-dsh-pruning-surface.md` — write protocol, recoverability, idle hooks
- `2026-10-19-native-dsh-compaction.md` — native stack and API surface
- `2026-10-19-nonllm-pruning-rules.md` — rule catalogue, nine uncovered classes
- `2026-10-19-failed-search-eviction-prior-art.md` — Self-GC, Gemini span retention, retrieval-rarely-used
- `2026-10-19-shadow-janitor-prior-art.md` — Self-GC, edit-plan formats, span validation
- `2026-10-19-incremental-compaction-research.md` — compounding-loss measurements
- `2026-10-19-provider-cache-mechanics.md` — per-provider cache table
- `2026-10-18-*` — Grok Bot, DeepSeek-Bot, ZCode lane studies

**External sources cited inline:** arXiv 2609.32961, 2608.22752, 2607.20972, 2608.11242, 2609.20804, 2608.23651, 2508.21433, 2607.00692.
