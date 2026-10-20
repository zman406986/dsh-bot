# Red-team: the shadow context janitor

- **Date:** 2026-10-19
- **Status: ADVERSARIAL ANALYSIS. NOT A RULING. NOT A DESIGN.** Nothing here is adopted. This document exists to find how the proposed janitor fails before we spend four days building it.
- **Target:** the LLM janitor variant — every ~50k tokens a background agent reads a frozen snapshot, returns a structured edit plan (keep / drop / one-line note), a deterministic validator checks it, and the plan is applied to the live session as a surface replacement at a safe point between turns. Native dsh compaction stays as the 678k backstop.
- **Owner's hard constraint (relayed 2026-10-19):** *"We don't want our memory system cache-destructive — every cleanup causes the LLM to not be able to use existing cache and wasting money."*
- **Method:** read the host facts and the repo's own designs; modelled the cache and model costs from published price multipliers; attacked each rule with concrete transcript shapes. No live janitor pass was run; no 500k-token session exists in this repo to measure. Every number marked *(modelled)* is arithmetic over stated assumptions, not a measurement.
- **What I read:** `docs/research/compaction-stack-design-2026-10-19.md`, `docs/research/segmented-compaction-design-2026-10-19.md`, `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md`, `.scratch/repo-analysis/2026-10-18-memory-compaction.md`, `.scratch/repo-analysis/2026-10-18-zcode-lane-memory.md`, `.scratch/repo-analysis/2026-10-19-online-claude-code-codex.md`, `docs/adr/0027`, `docs/adr/0029`, `src/adapter/parent-agent.ts`.

---

## 0. Bottom line up front

**The design as stated does not survive red-teaming. The 50k cadence is the worst point in the design space, and it dies on cache economics before it ever reaches a selection-quality argument.**

Three findings decide it:

1. **Every janitor pass after roughly 320k tokens costs more in cache invalidation than the native summary it is trying to avoid.** At 1M context, one pass costs ~970k token-equivalents of invalidation + model; one native summary costs ~334k. The janitor needs 20 passes; the last ten each cost 1.7–2.9 native summaries. It cannot win the arithmetic.
2. **The design's own minimum saving (8k tokens) is below the break-even saving at every point past ~265k in a 1M session.** With the repo's proposed 32k protected tail, the maximum possible saving per pass is 18k; the break-even saving at 500k is 20.4k. Every pass after ~467k is a cash loss, and the early passes do not cover it: the 1M session ends ~59% more expensive than native-only. Worse, freeing only 18k of every 50k added does not hold the line at 50k — the surface still climbs toward 640k, so the janitor delays the summary without avoiding it.
3. **The validator proves well-formedness, not sufficiency.** It can prove spans exist, bytes match, tool pairs are intact, protected regions are untouched, and the plan shrinks. It cannot prove the plan kept what the next 100k tokens will need. A plan that keeps 9.9k of plausible junk and drops 100 tokens of gold passes every check.

What survives is not the LLM janitor. What survives is a **deterministic, tool-result-only cleanup applied at native's own rewrite boundary** (so the invalidation is the one native already pays), plus **append-only retention at write time** and **retrieval-first** for the rest. The repo's own segmented design already defers the LLM selector (`segmented-compaction-design-2026-10-19.md` §6.1(e), §17). This red-team says: keep it deferred.

---

## 1. Attacks ranked by expected damage

| Rank | Attack | Damage | Likelihood | Passes the validator? | Mitigation | Does the mitigation solve it? |
|---|---|---|---|---|---|---|
| **1** | **Cache destruction / negative cash economics** | Pays more than native-only; violates the owner's hard constraint; adds latency | High at 50k cadence | Yes — the validator never sees cost | Only prune at native's rewrite or when the cache is provably cold; deep rare prunes, not shallow frequent ones | **No** for the 50k cadence; **yes** only by deleting the cadence |
| **2** | **False drops of load-bearing context** | Wrong answers, rework, silent task failure | Medium-high | Yes — the plan is well-formed | Deterministic signals, size floor, whole-result drops only, retrieval pointers, conservative bias | **Reduces only**; the future is unknowable |
| **3** | **Stale plan / burst / race with native** | Drops content that became relevant after the snapshot; wastes the model call; can corrupt the surface if validation is against the log, not the surface | High in bursts; medium otherwise | Sometimes — a stale plan can still validate | Revalidate against the live surface at apply; discard plans older than one turn; skip when lag > one pass | **Reduces only**; bursts remain the failure case |
| **4** | **Validator false confidence** | Silent bad selection that every check approves | Certain (the validator cannot judge selection) | N/A — this is the validator's limit | Min compression ratio, max kept-junk ratio, audit sample, re-read/regret metrics, human review | **No**; only measurement and review catch it |
| **5** | **Behavioral distortion** (defensive re-reads, note hoarding, distrust) | Eats the token savings; fills context with model-authored summaries; creates the summarization problem the design tried to avoid | Medium-high over long sessions | Yes | A capped `retain` tool instead of free-text notes; cheap exact retrieval; do not announce eviction in the policy | **Reduces only** |
| **6** | **Density claim is unmeasured / scope mismatch** | Builds the wrong layer for the wrong session; the flagship rule lives in workers, the density problem lives in the dispatcher | High | Yes | Measure the useful fraction and the deterministic win on 20 real sessions first | **Yes, if measured before building** |
| **7** | **Interaction correctness** (fork/resume/HMR/mitosis/two dispatchers/roster/policy) | Policy loss, roster loss, double-cleaning, partial application | Medium, high impact | Sometimes | Per-session state; protect by source kind; one atomic replacement; discard pending plans on fork; move policy to a system section | **Reduces only**; needs a state machine |
| **8** | **Cadence mismatch** (20k / 50k / 200k / burst) | The janitor cannot keep up with a 400k-token turn; the backlog makes plans stale | High in the burst case | Sometimes | Derive from `T_native`; skip when lag > one pass; 200k if an LLM is used at all | **Reduces only**; the burst case is inherently unwinnable for a per-turn safe-point janitor |

The rest of this document expands each attack, in the order the brief asked, with the cache attack first because it is the one the owner named and the one that kills the cadence.

---

## 2. Attack 1: cache destruction (the owner's hard constraint)

### 2.1 The mechanism: deletion in the middle is intrinsically cache-destructive

Provider prompt caches are strict prefix caches. A request is billed as a cache read only for the longest byte-identical prefix it shares with a previous request. The moment the janitor replaces a span at surface position `p`, every token after `p` is a new prefix: the provider must re-write the suffix at the cache-write price, and the next request pays for it.

Two consequences the design does not state:

- **The cost of a one-line note is not the note's length.** Replacing a 40k-token read with a 20-token note at position 100k in a 500k context costs `20 + 1.15 × 400k` token-equivalents, not 20. The note is cheap in context and expensive in cache. The design's "one-line note" accounting is wrong by four to five orders of magnitude in a long session.
- **The cut-position dilemma has no good answer.** Cache cost is proportional to the suffix after the cut; selection value is highest for recent content; the junk is old. Therefore:
  - A cut that removes junk (oldest-first) maximizes the invalidated suffix and the cache cost.
  - A cut that minimizes cache cost (just before the protected tail) removes the content most likely to be needed.
  - There is no cut that is both cheap and wise. The design's "clear oldest-first" is explicitly the cache-worst choice (`compaction-stack-design-2026-10-19.md` §7 rule 5 acknowledges the cost but not the dilemma).

The only escapes are to rewrite when the cache is already invalid (native's own rewrite, or a cold cache), or never rewrite at all (append-only, retrieval-first). The design does neither: it schedules rewrites every 50k during a warm, always-on session.

### 2.2 The model and the numbers

Definitions, all *(modelled)*:

- `P` = full input price per token (cache miss).
- Cache read = `0.1P`; cache write = `1.25P` (the published multipliers the coordinator named; Anthropic-shaped). DeepSeek's automatic cache has no explicit write premium (`1.0P`), which lowers the magnitude but not the direction.
- Output = `3P`.
- Session adds `G = 1,000,000` tokens; `A = 2,000` tokens per request; `R = 500` requests.
- Janitor cadence `K = 50,000`; 20 passes at `C = 50k, 100k, …, 1M`.
- The janitor frees `F` tokens per pass; the cut is at 20% of the context, so the invalidated suffix is `S = 0.8C` (generous to the janitor; oldest-first would make `S` larger).
- The janitor's own model call: best case it reuses the main prefix at `0.1P` (`J = 0.1ΣC = 1.05M`); worst case it sends a separate frozen snapshot at full price (`J = ΣC = 10.5M`). The table uses the best case, which favors the janitor.

**Table 1 — 1M-token session, token-equivalents (lower is better) *(modelled)***

| Strategy | Read cost | Write / invalidation | Janitor model | Total | vs native-only |
|---|---:|---:|---:|---:|---:|
| Native only (one summary at 678k) | 16.00M | 1.39M | 0.20M (summary) | **17.59M** | — |
| Janitor, `F = 18k`/pass (32k protected tail) | 16.00M | 10.91M | 1.05M | **27.96M** | **+59%** |
| Janitor, `F = 40k`/pass (10k protected tail) | 10.00M | 10.91M | 1.05M | **21.96M** | **+25%** |
| Janitor, `F = 50k`/pass (no protected tail) | 5.00M | 10.91M | 1.05M | **16.96M** | −4% |
| Janitor, `F = 18k`, full snapshot at full price | 16.00M | 10.91M | 10.50M | **37.41M** | **+113%** |

Read column: 500 requests × the average surface the strategy carries. Native averages ~320k (sawtooth to 678k, reset to 119k). `F = 18k` frees 18k per 50k added, so the surface still grows 32k per pass to ~640k and averages ~320k — **no meaningful read saving**. `F = 40k` grows 10k per pass to ~300k, averaging ~200k; `F = 50k` is flat ~100k. The `F = 50k` row means every added token is dropped, which is incompatible with any protected tail or current turn; it is the upper bound of the strategy, not an option. The `F = 18k` row is the design as written (50k growth, 32k protected tail) and it is the row that matters. Write column: baseline 1.25M writes of new tokens plus native's 137k tail rewrite (native row) or the invalidation premium `1.15 × 0.8 × ΣC = 9.66M` (janitor rows). Janitor model column assumes each call reads the whole conversation at cache-read price (`0.1 × ΣC = 1.05M`), which is the generous assumption for judging global redundancy; a 50k-delta read would be `0.1M`.

**Illustrative dollars** at `P = $0.28/M` (a stated assumption, not a repo fact): native ≈ **$4.94**; `F = 18k` ≈ **$7.83**; `F = 40k` ≈ **$6.15**; `F = 50k` ≈ **$4.75**. The direction is the point, not the cents. Note that only the "drop everything" row reaches parity, and it is not a design; every viable protected tail makes the janitor more expensive than native-only.

**Table 2 — the per-pass comparison that decides the argument *(modelled)***

| Context at pass | Janitor pass cost (invalidation + 50k model) | One native summary event | Ratio |
|---:|---:|---:|---:|
| 500k | 510k | 334k | 1.53× |
| 800k | 786k | 334k | 2.35× |
| 1M | 970k | 334k | 2.90× |

Native's 334k is the incremental cost of one summary: 65,536 output tokens at 3P (~197k) plus re-writing the 119,040 retained tail at 1.15 (~137k). I gave native the worst case — a full 65,536-token output — and it still wins. The design fires 20 janitor passes; the last ten each cost more than the entire summary they are meant to avoid.

### 2.3 The break-even inequality and the 8k minimum

A pass at context `C` that frees `F` tokens, invalidates `S` tokens, and leaves `R_rem` requests in the session is cash-positive iff:

```
0.1 × F × R_rem  >  1.15 × S + J
R_rem             >  (1.15 S + J) / (0.1 F)
```

Worked example: `F = 18k`, `C = 500k`, `S = 0.8C = 400k`, `J = 50k`:

```
R_rem > (1.15 × 400k + 50k) / (0.1 × 18k) = 510k / 1.8k ≈ 283 requests
```

At 2k tokens per request, that is ~566k tokens of future growth. A pass at 500k in a 1M session has only 250 requests left. It is a loss.

**Table 3 — break-even freed tokens per pass, by context *(modelled, J = 50k, S = 0.8C)***

| Context `C` | Requests used | `R_rem` | Break-even `F` | Max possible `F` with 32k tail |
|---:|---:|---:|---:|---:|
| 100k | 50 | 450 | 3.2k | 18k |
| 300k | 150 | 350 | 9.3k | 18k |
| 400k | 200 | 300 | 13.9k | 18k |
| **500k** | **250** | **250** | **20.4k** | **18k** |
| 700k | 350 | 150 | 46.3k | 18k |
| 900k | 450 | 50 | 175.6k | 18k |
| 1M | 500 | 0 | impossible | 18k |

The crossover is ~467k: after that, the maximum saving the design can achieve (18k, because 50k growth minus a 32k protected tail) is below the break-even saving. The design's **minimum** saving of 8k is below the break-even at every context past ~265k. The early passes win; the late passes lose; the total is the +59% in Table 1. This is the single most concrete reason the 50k cadence dies.

Note the second-order effect: freeing 18k of every 50k added does not hold the line at 50k. The surface still grows 32k per pass to ~640k, so the janitor merely delays the native summary — and pays 20 invalidations to do it.

The intuition: keeping a token in context costs `0.1` per remaining request; dropping it saves `0.1 × R_rem`. Rewriting the suffix costs `1.15` once. Break-even needs roughly 11.5 remaining requests per unit of `S/F`. If you free 5% of the suffix, you need 230 remaining requests; if you free half, 23. The janitor is designed to free a small fraction of a large suffix, which is the losing side of the inequality.

### 2.4 Continuous vs bursty use: the design is worst where it is aimed

- **Continuous use (the always-on dispatcher).** Every pass happens while the cache is warm. The full `1.15 × S` premium applies. This is the owner's stated use case and the design's worst case.
- **Bursty use with gaps longer than the provider TTL.** The cache is cold, the premium is zero, and the pass is nearly free in cache terms. But then the session is not a continuous 500k-token context; the density problem is smaller, and the native summary may never fire.
- **Mixed use.** Some passes warm, some cold. The design has no way to know which; it schedules on token count, not on cache state.

The design is therefore most expensive exactly when the dispatcher is doing its job: staying on, making requests, keeping the cache warm.

### 2.5 The native competition: piggybacking is better, but not automatically sufficient

Native compaction already pays one invalidation at 678k: it replaces the head with a checkpoint and re-writes the 119k retained tail. A self-scheduled janitor that rewrites earlier pays **both** invalidations: its own, plus native's if it fails to prevent the threshold.

Piggybacking means running the cleanup immediately before native's summary, in the same pre-step, so the only invalidation is the one native was going to pay anyway. Is it strictly better? It removes the invalidation cost but not the janitor's model cost. An LLM janitor at the boundary still costs `0.1C` (cache-reused call) + output per summary event, ~1.05M over a 1M session, versus native's 0.34M. So **the LLM janitor at the boundary can still be worse than native-only**; the deterministic cleanup is the version that is strictly better, because it adds zero model cost and makes the summary read a smaller, denser surface.

The per-pass comparison is the cleanest way to say it: a self-scheduled pass at 1M costs 2.8 native summaries. Piggybacking collapses the count to one rewrite per native event, but it does not make the LLM call free. If the owner's constraint is "no cache destruction," piggybacking is the only placement that satisfies it; the 50k schedule cannot.

### 2.6 Idle detection: the cache-cold mitigation is a coin flip the design cannot call

The proposed mitigation is "prune when idle because the cache is cold" (`compaction-stack-design-2026-10-19.md` §4, `idleMicrocompactMinutes: 60`). Attack it:

- **The TTL is not known.** The 60-minute figure is an assumption from other harnesses, not a provider guarantee. The repo records no TTL for the live route. If the TTL is 5 minutes, 60 minutes is safe; if it is 24 hours, 60 minutes is warm and the pass pays the full premium.
- **Clock skew and provider variance.** The janitor knows the local last-request time, not the provider's cache state. A provider-side eviction under load can make a warm-looking session cold; a provider-side cache extension can make a cold-looking session warm. Neither is observable before the next request.
- **The catch-22.** The first post-idle request tells you whether the cache was cold — but by then you have already paid to warm it. Pruning after that request invalidates the warmth you just bought. The only free moment is *before* the first post-idle request, which is exactly when you do not know. A provider response with zero cache-read tokens is the only reliable cold signal, and it arrives one request too late.
- **The confidence needed is high.** If `p` is the probability the cache is cold, the expected value of an idle pass is `p × 1.25F − (1−p) × 1.15S`. Break-even:

```
p > 1.15S / (1.25F + 1.15S)

F = 18k, S = 500k  →  p > 96.2%
F = 40k, S = 500k  →  p > 92.0%
F = 200k, S = 500k →  p > 69.7%
```

You need to be 92–96% sure the cache is cold to make a shallow idle pass worthwhile. No wall-clock guess gives that confidence without a provider guarantee. The 60-minute timer is a 60-minute bet at 92–96% confidence, placed every time the session idles.

The only honest versions are: a manual "prune now" the user triggers when they know the session has been idle, or a resume-time pass after a downtime long enough that the cache is almost certainly gone (and even then, the plan must be recomputed, not replayed). Both are outside the proposed automatic design.

### 2.7 The measurement attack: cache counters cannot attribute the cost

The design wants to adapt cadence from `cacheReadTokens` / `cacheWriteTokens` usage events. Those counters cannot answer the question they are being asked.

- **They do not distinguish causes.** A drop in cache-read tokens can come from the janitor's rewrite, a TTL expiry, a provider-side eviction under load, a model switch, a system-prompt or tool-schema change, a `maxTokens` change in the request header, a different account/region, or a retry that took a different route. The controller sees one number and blames the janitor.
- **The janitor's own calls pollute the signal.** If the janitor sends a 50k snapshot, that call's usage is mixed into the same session's accounting. If it runs on a separate session, its cost is invisible to the dispatcher's counters. Either way, attribution is broken.
- **The adapter may not report the fields at all.** `dsh-llm-deepseek/lib/index.js:1826-1827` maps `cache_read_input_tokens` → `cacheReadTokens` and `cache_creation_input_tokens` → `cacheWriteTokens`. No handling of DeepSeek's OpenAI-compatible `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` was found in the installed adapter. The repo's own evidence says cache accounting was captured "from Anthropic/Codex providers" (`.scratch/repo-analysis/2026-10-18-memory-compaction.md:86`). **If the live DeepSeek route does not return the Anthropic-shaped fields, the counters are zero or absent, and the adaptive controller is blind.** Verify one live response before building any controller.
- **A feedback loop can oscillate.** Prune → cache miss → controller concludes pruning is expensive → prune less → cache grows → native fires → controller concludes pruning is needed → prune more. The signal is confounded, so the loop has no stable set point.
- **The janitor can evict the main session's cache entries.** If the provider's cache is account-wide and size-bounded, 50k snapshots compete with the dispatcher's prefix for cache slots. The main session's cache-read rate drops even without a rewrite, and the controller misattributes it to the janitor's last pass.

**Verdict on measurement:** adaptive cadence from cache counters is not buildable on this evidence. It is a guess with a confounded feedback loop. If the design needs a cache-aware trigger, it needs a provider-guaranteed TTL or an explicit cache-management API; neither exists here.

### 2.8 Verdict on the 50k cadence

**It dies. Plainly.** It is the worst point in the design space: frequent, shallow, oldest-position rewrites, each with a growing suffix, each with a model call, and the last pass is always a loss. The numbers:

- One pass at 1M costs 2.8 native summaries; you need 20 passes to avoid one summary.
- With a 32k protected tail, the design's maximum saving (18k) falls below break-even at ~467k; the 1M session ends 59% more expensive than native-only.
- The design's own 8k minimum is below break-even from ~265k onward.
- The idle mitigation needs 92–96% confidence that the cache is cold, which it cannot have.

The cache-safe placements are: (a) at native's rewrite boundary, where the invalidation is already paid; (b) after a resume/downtime long enough that the cache is certainly cold, with a recomputed plan; (c) never rewrite — append-only retention or retrieval-first. A 50k timer is none of these.

---

## 3. Attack 2: the model's incentives, blind spots, and the failed-search rule

### 3.1 Why an LLM janitor keeps the wrong things

The janitor sees a snapshot and must guess what the next 100k tokens will need. It has no access to the future task, the user's next message, or the agent's intent. Its judgment is driven by surface plausibility: recent, named, error-shaped, decision-shaped, and path-shaped content looks important. That is a biased estimator, not a relevance oracle.

**What it systematically over-keeps:**

- Error messages and stack traces, because they look like evidence.
- TODOs, ledgers, and anything that looks like a rule.
- Recent content, because recency is the cheapest relevance proxy.
- Anything with a file path or an identifier, because it looks specific.
- User and assistant prose that states a decision, even when the decision was later reversed.
- Duplicate content that appears in a different format, because the model does not diff bytes reliably.

**What it systematically under-keeps:**

- **Negative knowledge.** "I read file A and it does not contain X" is the most valuable fact in a search episode and the least visible in the bytes. The file's content looks like ordinary code; the absence of X is nowhere in it. If the note says only "read A, 412 lines," the negative fact is gone.
- **Tacit preconditions.** A read of `types.ts` that made `impl.ts` intelligible is not "used" by any deterministic signal, but it was the precondition for the edit. The janitor sees no edit on `types.ts` and drops it.
- **Config values and version numbers.** They are short, boring, and look like boilerplate. They are also exactly what a final report or a compatibility fix needs.
- **Passing test output shapes.** A test that passed is "resolved" and looks droppable; its exact output shape (field names, ordering, schema) may be the contract the next change must preserve.
- **The reason a tool was called.** The assistant message "I'll check whether the retry path is the only caller" is the intent; the file read is the evidence. Drop the intent and keep the evidence, and the next turn cannot tell why the file is there.

**Concrete scenarios with numbers:**

1. **The config value at 30k, needed at 400k.** The agent reads `docker-compose.yml` (40 lines, ~600 tokens) at 30k and sees `ports: "8080:80"`. At 400k the user asks which host port the service exposes. The janitor dropped the compose read at 100k as a "context read with no edit." The note says "read docker-compose.yml, 40 lines, no edit." The agent either re-reads (cheap, one turn) or answers from the container port (80 instead of 8080). False drop; the note preserved the path but not the value.
2. **The error that becomes relevant 100k later.** At 50k a test fails with `ECONNREFUSED 127.0.0.1:5432`; the agent starts Postgres and the test passes. At 300k a different test fails with the same error. The janitor dropped the first error as "resolved." The note says "test failed, fixed." The cause (Postgres not running) is gone; the agent re-debugs from scratch. One re-read of the log would fix it, but the agent does not know the log is the answer.
3. **The passing test's output shape.** At 80k a test prints a JSON schema; the agent writes a parser from it. At 250k the parser breaks and the agent needs the exact field names. The janitor dropped the passing output as "resolved/success." The note says "tests passed." The agent re-runs the test (cheap) or guesses the field names (wrong). If the test is slow or flaky, the re-run costs more than the original read.
4. **The precondition read.** At 60k the agent reads `types.ts`, then `impl.ts`, then edits `impl.ts`. The janitor treats the edit on `impl.ts` as the hit and drops `types.ts` as an unused read. At 200k the agent adds a method and writes an incompatible signature because it no longer remembers the generic constraints. The type checker catches it; the fix costs a turn. If the constraint was a runtime shape, it ships.
5. **The negative search that prevents a repeat.** The agent greps `toggleSandbox` across 9 directories; 8 return no hits, 1 returns the definition. The no-hit results are small, so the janitor does not drop them — but if they include a file list ("searched 4,000 files, no matches"), dropping the list loses the knowledge that those files were checked. The next turn repeats the search. The note format in the segmented design does list the paths, which is the right shape; the attack is that the note itself can be dropped at the next pass (see §3.3).
6. **The read that is a precondition for a different file.** The agent reads `schema.prisma` to understand the data model, then spends 50k tokens on an auth bug. The janitor sees no edit/quote/cite on `schema.prisma` and drops it. The bug turns out to be a missing relation; the exact model definitions are gone. The agent re-reads (cheap) or guesses the relation name (wrong).

**The asymmetry that should drive the design:** a false keep costs `tokens × requests` at the cache-read price (linear, bounded, measurable). A false drop costs a re-read plus latency **plus a possible wrong answer** (non-linear, unbounded, silent). The design should therefore bias toward keeping, especially for small items. It does the opposite: the "must shrink" constraint pushes it to find savings, and the cheapest savings are often small, dense, self-contained facts. That is the alignment failure in §3.4.

### 3.2 The failed-search rule, attacked case by case

The rule: reads in a search episode that are not the hit are dropped, with a note listing path, line count, title, and size. The hit is the first result satisfying H1 (later edit/act), H2 (later quote ≥40 chars), H3 (path cited in later tool args), or H4 (same path read again).

| Case | Misclassification | Cost of false drop | Cost of false keep | Verdict |
|---|---|---|---|---|
| A read "for context" later becomes load-bearing | No edit/quote/cite at snapshot time → dropped | Re-read + possible wrong answer | 2–8k tokens × remaining requests | Keep small reads; drop only large, provably unused ones |
| A read of A was a precondition for understanding B | A has no hit; B has the edit → A dropped | Loses the interface/constraint that made B correct | Small | The rule cannot see cognitive use; size floor and a "read-before-edit" keep rule help |
| Negative knowledge (A does not contain X) | A's bytes look ordinary; the absence is invisible | Repeat search; wrong assumption | Small (A may be large) | The note must state the searched term and the result, not just the path |
| Read twice deliberately (pre/post edit baseline) | Older read "superseded" → dropped | Loses the pre-edit baseline, especially after `write` | 2–8k | Keep the last read before a `write`; drop earlier duplicates only |
| Cross-turn relevance not yet visible | Snapshot sees no future use → dropped | Re-read at the moment of need | 2–8k | The fundamental limit; conservative bias is the only mitigation |
| Read used without quoting (learned API, wrote a different file) | No literal signal → dropped | Wrong API usage; subtle bug | 2–8k | Only agent-authored retention catches this |
| `write`/`edit` as the hit anchor, but the edit is unrelated (formatting, import sort) | H1 fires → episode closes as "found" | Drops the reads that were actually still needed | Small | Require the edit to touch a region related to the search term, or treat H1 as a weak hit |
| H2 quote false positive on boilerplate | License header/import block matches → "hit" | Keeps junk, drops the real search members | Small (false keep) | Reject shingles appearing in >3 results (the segmented design already proposes this) |
| H3 cite false positive: path in a *todo* or *question* | "The agent mentioned the path" → treated as a hit | Drops the reads; the path was a future task, not an answer | Large | H3/H4 must be weak hits: they keep the episode open, they do not confirm a hit |
| H4 re-read false positive: re-read for a different section | Same path → "hit" | Drops the earlier read that covered the needed section | Medium | Compare line ranges; a re-read of a different range is not a hit |

The most dangerous row is **H3 as a confirmed hit**. A path cited in a later tool argument can be a question ("check `sandbox/launch.ts` next"), not evidence that the file contains the answer. Treating it as a hit closes the episode and drops the reads. The design should require H1 (act) or H2 (quote) for a confirmed hit; H3/H4 should keep the episode open and keep the members.

**The size floor is missing.** The design's minimum saving is 8k per pass, which can be met by dropping eight 1k-token reads. Those are exactly the small, dense, negative-knowledge results that are most likely to matter. A size floor (never drop a result under, say, 1k tokens; never drop a zero-hit grep at all) would bias the savings toward the actual junk: one 20k-token dump, not twenty 1k-token facts. The current rule has the selection backwards.

**The scope mismatch.** The flagship rule lives where file reads happen: worker sessions. The density problem the owner describes lives in the dispatcher's 500k context, which is mostly worker reports, wake text, peer messages, and tool calls — not file reads. A dispatcher-only janitor never sees the five failed reads; a worker-only janitor cleans sessions that are often discarded when the task ends. The segmented design acknowledges this (`segmented-compaction-design-2026-10-19.md` §4.4) and extends the janitor to workers. But then the biggest expected win is in the sessions that matter least for the dispatcher's density, and the dispatcher's own 500k is untouched. This is a product-scope problem, not a tuning problem.

### 3.3 Notes are not protected: the recursive-eviction attack

The note that replaces a dropped span is written at the old position. At the next pass, that note is old and short, so it is a natural candidate for "replace with a one-line note" again. If notes are not protected forever, the pointer chain erodes: the first pass drops the file read and writes "read A, no hit"; the second pass drops the note and writes "searched some files"; the third pass drops that. The agent's ability to retrieve the original depends on knowing the path, which the note carried.

The design must either (a) protect every note forever (cost: ~100 tokens × number of drops; 20 passes × 10 drops = 20k tokens, acceptable but must be explicit), or (b) put the pointer index in the current tail/ledger, not at the old position. Option (b) is better: the tail is re-emitted and protected, and the agent sees the pointers every turn. But it grows the tail, which is exactly the part the cache reads every turn. The design must account for that cost.

### 3.4 The objective function is wrong

The validator requires the plan to shrink. The janitor is therefore rewarded for compression, not for correctness. It will find the cheapest-to-drop content that still satisfies the shrink check: small, self-contained, dense facts. That is the opposite of what a density layer should do. The design says "not a summarizer," but a one-line note is a summary; if the note is wrong, the original is gone from the surface (retrievable from the log only if the agent knows to look). The model is optimizing a proxy (shrink) that is anti-correlated with the goal (future utility) in the region where the constraint binds.

The fix is to change the objective: **maximize expected future utility per token, subject to a hard floor on what may be dropped**, not "shrink by any amount." The validator can enforce the floor (size, type, protected regions) but cannot measure utility; only the re-read/regret metrics and human review can. The design should state that the LLM's plan is advisory and that the deterministic floor has veto power.

---

## 4. Attack 3: stale plans, bursts, and races

### 4.1 A plan is a prediction made at 50k and applied later

The snapshot is taken at `T0`; the plan is applied at `T1`, at the next safe point between turns. Content that became relevant in `[T0, T1]` is dropped based on `T0`'s view. Concrete: at 40k the agent reads a file "for context"; at 60k the task changes to need it; the plan computed at 50k drops it. The validator sees the span exists and bytes match, so it applies. The agent loses the file it just started needing.

Mitigation: revalidate the plan's relevance at apply time using the cheap deterministic signals (did a later event cite/edit/quote the span since the snapshot?). If any span gained a signal, remove it from the drop set. This is cheap and effective for the signals the design already trusts. It does not catch semantic relevance that never produces a literal signal. Partial mitigation.

A stronger rule: reject any plan older than one turn. If the janitor cannot apply within one turn, recompute. This bounds staleness but increases model cost (recompute) and may starve the janitor in fast sessions.

### 4.2 The burst: 400k in one turn

The brief's case: the agent reads 400k tokens in one turn. At a 50k cadence, that is eight plans. Each plan is a model call over a 50k snapshot; at an optimistic 5 seconds per call, that is 40 seconds of janitor work. The agent's next turn starts in under a second. The janitor is 40× too slow to keep up.

What happens next depends on the design's queue:

- **Serial background queue:** the plans are applied in order, each against a surface that has moved. The early plans are stale; the validator may reject them or, worse, apply them. The session pays for eight model calls and gets little or no benefit.
- **Parallel plans:** they race on the same surface; application order is nondeterministic; the boundary marker is the only serialization point. This is a correctness hazard.
- **Drop stale plans:** the janitor silently stops working exactly when context grows fastest. That is an honest admission that the layer is best-effort, but it contradicts the density claim.

If the burst crosses 678k, native fires. The janitor's plans are now computed against a surface that native has replaced; validation should reject them. The session pays for the janitor calls **and** the native summary. That is the worst of both.

The only safe behavior is: if lag > one pass, skip and let native handle it. The design should state this, and it should count the skip as a failure of the density claim, not a success of the safety rule.

### 4.3 The native race: validate against the surface, not the log

Native compaction replaces a span with a checkpoint and appends `compaction/start` … `compaction/end`. If the janitor's plan was computed before native fired, its span seqs may still exist in the **log** but be shadowed in the **surface**. A validator that reads `session.eventAt(seq)` or the log will find the bytes and accept the plan; applying a replacement to a shadowed span is a no-op at best, surface corruption at worst.

The fix is explicit: validate every span against `session.surface.nodes` at apply time, not against the snapshot and not against the log. Check that each span is a current surface node, that its bytes match, and that no span is inside a native checkpoint. If any check fails, reject the whole plan; do not apply the valid subset. Partial application is how you get a surface whose notes do not match its content.

The design's "deterministic validator" section does not name the surface-vs-log distinction. This is an implementation trap that will be discovered the hard way.

### 4.4 Fork, resume, HMR, two dispatchers, mitosis

- **Fork.** A fork copies the log up to a point. Pending plans must be discarded; applied records are part of the child's surface and are fine. Segment/record ids that hash the span and bytes are stable; seq-based plans are not. If the fork renumbers inherited events, a pending plan's seqs point at the wrong nodes. Rule: never inherit a pending plan across a fork; recompute in the child.
- **Resume.** The process restarts over a persisted log. A plan computed before the crash may be applied after a native compaction that happened before the crash. The boundary marker must record `planned`/`applied` per pass and the plan's snapshot revision; on resume, a `planned` without `applied` is aborted, not replayed (the compaction-stack design already says this for microcompact, §6.3; the janitor design must say the same).
- **HMR.** A module reload can interrupt a plan between span replacements. If the plan is applied as N separate surface ops, a reload after 3 of 10 leaves a partial plan. Either apply the whole plan as **one** `surfaceOp` over a contiguous range, or record `applied` per span and reconcile on resume. The design does not state which. A partial application is worse than no application: the notes may describe content that was not dropped, or vice versa.
- **Two dispatchers.** ADR-0019 allows multiple activated dispatcher sessions. The janitor's `passInFlight` must be per-session, not global; a global flag lets one dispatcher's pass block the other. The ownership gate must be per-dispatcher: `host.workerIdOf(session.id) !== undefined` identifies *a* worker, not *our* worker. Dispatcher A's janitor must not clean dispatcher B's worker. The segmented design's `owns(session)` gate (`segmented-compaction-design-2026-10-19.md` §4.4) has exactly this bug: it checks `workerIdOf` without checking the parent dispatcher.
- **Mitosis (ADR-0025).** A child dispatcher is created by mitosis. If it forks the parent's session, the parent's records and stubs are inherited; a new pass must not re-seal a span the parent already sealed (the seal cursor is not inherited). If it starts fresh, it inherits none of the parent's notes and re-reads everything. The design does not say which. This is a product decision that must be made before the janitor's state model is written; "child dispatchers share nothing" is not stated anywhere I could find.

### 4.5 The roster and the policy

- **Roster at the prompt tail (ADR-0027).** The roster is a `user/message` re-emitted every turn. Dropping an old roster is harmless (it is stale anyway); dropping the **current** roster loses peer awareness for that turn. The protected tail must include it. The subtler attack: the janitor's note must never summarize the roster ("3 peers: A, B, C"), because the roster is a volatile projection; a stale note is worse than no note. Forbid notes about protected/volatile regions.
- **Dispatcher policy at the head.** The policy is injected once as a `user/message` at activation (`src/adapter/parent-agent.ts:34-57`, `:322`; `compaction-stack-design-2026-10-19.md` §2.1). If the janitor is allowed to drop "old user messages," it kills the dispatcher. The protected set must be by **source kind** (`WAKE_SOURCE_KIND` / the policy's producer-owned kind), not by role: all user messages includes the policy, but also the user's task statements, which are often long and which the janitor would then never touch. If the policy is moved to a per-agent system-prompt section (the compaction-stack design's preferred fix, §2.1), it is protected by construction. **That fix is a prerequisite for any janitor that touches user messages.** If the janitor touches only `tool/result`, the policy is safe, but then the density win is smaller.
- **Protected-list staleness.** A protected list of seqs computed at activation goes stale after a fork, resume, or native compaction. Protect by source kind and by "is in the current tail," not by a fixed seq list.

---

## 5. Attack 4: the validator's limits

### 5.1 What the validator proves, and what it cannot

The validator is a proof of **well-formedness**: every span exists in the current surface, every byte matches, every tool pair is intact, every protected region is untouched, and the plan shrinks. It is not a proof of **sufficiency**: that the edited conversation still contains the facts, constraints, negative knowledge, and intent the next task needs. Sufficiency can only be checked by running the future, which is unavailable. No validator can close this gap. The design should say so plainly instead of implying that validation makes the plan safe.

### 5.2 Failure modes that survive validation intact

1. **The kept-junk / dropped-gold plan.** The janitor keeps 9,900 tokens of plausible-looking junk (a long README, a verbose status report) and drops 100 tokens of gold (a version constraint, a port number). The plan shrinks by 1%; every span exists; every byte matches; the validator passes. The density is unchanged; the one useful fact is gone.
2. **The one crucial sentence inside a kept file.** If the janitor may keep a line range and drop the rest, it can keep lines 1–100 of a file and drop line 101, which says "this API is deprecated." The kept span is real, the bytes match, the pair is intact; the dropped line was load-bearing. Mitigation: drop whole results only, never line ranges within a result, unless the range is selected by a deterministic, audited rule.
3. **The cheapest-to-drop selection.** To satisfy "must shrink," the janitor drops the items that are cheapest to justify dropping: small, self-contained, dense facts (config values, negative search results, version numbers). It keeps the big file dumps because they look important and are expensive to summarize. This is the inverse of the desired selection.
4. **The wrong note.** The note says "the test setup details" while the dropped span said "the test passes only with `--no-cache`." The note is a string; the validator does not check that it is true or complete. The agent trusts the note and runs the test without the flag. This is a summarizer failure by another name.
5. **The stale-snapshot plan.** The validator checks bytes against the snapshot, not the live surface. Native replaced a span after the snapshot; the seq still exists in the log; the bytes match the snapshot; the plan applies to a shadowed span. The surface is now inconsistent. (See §4.3.)
6. **The wrong protected list.** The protected set was computed from roles or a fixed seq list and does not include the policy or the current roster. The validator says "protected regions untouched" because it is checking the wrong list. The policy is dropped; the dispatcher stops delegating. Silent and catastrophic.
7. **The reversed correction.** The plan keeps the stale version and drops the corrected one, or keeps both in the wrong order. Spans exist, bytes match, the plan shrinks; the agent reads the stale value first and acts on it.

### 5.3 Mitigations and their honest limits

- **Minimum compression ratio per span (e.g., 4:1)** and **maximum kept-junk ratio** (e.g., no more than 30% of the kept bytes may be unmodified file dumps). This forces the janitor to target the actual junk, not the small facts. Partial: the ratios are guesses until measured.
- **Whole-result drops only, no line-level drops.** This prevents the one-crucial-sentence failure. It may leave large files intact when only a section is junk; the fallback is a separate, deterministic section extractor with an audited rule, not an LLM line picker.
- **Size floor: never drop a result under 1k tokens; never drop a zero-hit grep.** This protects negative knowledge and small facts. It reduces savings; that is the point.
- **Revalidate against the live surface at apply.** Reject the whole plan on any mismatch. This prevents the stale-span corruption.
- **Protect by source kind and by tail membership.** This prevents policy/roster loss without protecting all user text.
- **Audit sample and replay.** For every N passes, replay the plan against the snapshot and have a human or a stronger model check whether the dropped spans were cited/edited/quoted later. This is the only way to estimate selection quality; it does not prevent the failure, it measures it.
- **Re-read/regret metrics.** Count later reads of dropped paths; if >10%, the selection is too aggressive (the segmented design's own gate, §15.4). This catches the worst cases but not silent wrong answers.

**Residual:** selection quality remains unprovable in advance. The validator can be made sound for well-formedness and still be useless for sufficiency. The design must budget for measurement and review, not just validation.

---

## 6. Attack 5: cognitive and behavioral risks

An agent that knows content may be evicted behaves differently. The design does not say whether the agent is told. Both choices have costs:

- **Told.** The agent re-reads defensively before it needs to, hoards facts in notes, and front-loads files into the current turn. Tool calls go up; the density win shrinks. Concrete: the agent sees a note "5 reads dropped" and re-reads two of them to be safe; 6k tokens come back, and the net saving of a 15k drop is 9k, at the cost of two turns.
- **Not told.** The agent experiences unexplained amnesia: it references a file it "read," the content is gone, and it may hallucinate the missing detail. The note says "read A, 412 lines" — the agent knows A was read but not what it said, which is the worst combination: confidence without evidence.

**The note-hoarding moral hazard.** The cheapest way for the agent to retain a fact is to restate it in a message: "IMPORTANT: the port is 8080; keep this." If assistant messages are protected, the note persists and the transcript fills with model-authored summaries; if they are not, the note is dropped and the agent writes more. Either way, the design creates an incentive to write the verbose summaries it was trying to avoid — just authored by the agent instead of the janitor. The agent's notes are less reliable than the original bytes, and they are exactly the "summary of a summary" the owner objected to.

**Mitigation:** a capped `retain(seq, lines, why)` tool, not free-text notes; a hard byte cap per session; the agent is told retrieval is cheap and exact (`segment_read` / `read_span`), not that content disappears. The cap bounds hoarding; it does not remove the incentive. Partial.

**Observable signals:** re-read rate of dropped paths, note bytes per turn, tool calls per completed task, time-to-completion, and the rate of user corrections ("no, I said 8080"). If any rises after the janitor ships, the density win is illusory. These are the metrics to watch; the design currently has none for behavior.

---

## 7. Attack 6: the density claim

**The claim is unmeasured.** The repo's own evidence: no stored session ever crossed the native threshold; the maximum observed usage was ~68k tokens (`.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md:33`). There is no 500k dispatcher transcript to inspect. "At 500k, most context should be useful" is a hypothesis, not a finding.

**A rough decomposition (hypothesis, not measurement):**

| Component | Plausible share at 500k | Can the janitor drop it? |
|---|---|---|
| System prompt + tool schemas | 2–6% | No (protected) |
| Policy + ledger + roster tail | 2–5% | No (protected; roster re-emitted) |
| Recent working set | 5–10% | No (protected tail) |
| Worker reports (clamped 4k) | 50–70% | Partly — but dropping reports loses provenance |
| Decisions, user instructions | 5–15% | Must keep |
| Failed searches, stale reads, resolved errors | 10–25% | Yes — the target |
| Duplicates / boilerplate | 5–15% | Yes |

If the target class is 20–30% of the transcript, the janitor can at best make the session 20–30% denser, not "mostly useful." The fixed overhead and the current working set are a floor of unavoidable noise. "Mostly useful" is achievable only if the task itself is mostly useful; a long debugging session with many failed attempts is inherently mostly negative results, and the negative results are valuable (they prevent repeats) while looking exactly like junk.

**The negative-knowledge paradox.** The most valuable content in a long debugging session is often the record of what did **not** work. It is also the content most likely to be classified as junk: failed test output, empty greps, abandoned file reads. Dropping it causes repeats; keeping it preserves the density problem. The design's flagship rule is a special case of this paradox, and it resolves it by keeping a note ("searched five, none had it") — which is a summary, with the summary's reliability problem.

**Scope mismatch, restated.** The dispatcher's 500k is mostly reports; the failed-search rule lives in workers. If the owner's density goal is about the dispatcher, the flagship rule is aimed at the wrong session. If it is about workers, the sessions are shorter and often discarded, so the density win has less time to pay back.

**What to measure before building:** on 20 real sessions (dispatcher and worker), tag each span as decision / evidence / status / junk, compute the useful fraction, and compute how many bytes the deterministic failed-search rule would drop. If the deterministic rule captures ≥80% of the bytes the LLM janitor would drop, the LLM layer's marginal density is small and its cost is not justified. This is the first experiment, not the last.

---

## 8. Attack 7: the economics of the janitor call itself

Even before the cache invalidation, the janitor's own model calls are a new cost center:

- **20 passes × 50k snapshot = 1M input tokens per 1M-token session** if the janitor reads only the delta at full price. If it reads the full conversation each pass (which it must to judge whether old content is still needed), the sum is `50k + 100k + … + 1M = 10.5M` tokens. At `P = $0.28/M`, that is **$0.28 to $2.94 per session**, versus a native summary at roughly **$0.10**. The janitor call alone is 3–30× the thing it is trying to avoid.
- **Retries.** A 20% failure rate with one retry adds 20%; a malformed plan is a full call with zero benefit. The design has no circuit breaker for the janitor (the compaction-stack design has one for microcompact; the janitor needs the same).
- **Rate-limit competition.** The janitor's calls share the provider quota with the main session. In a burst, the janitor's eight calls slow the main turn. The design treats the janitor as free background work; it is not, on a rate-limited provider.
- **Model switch.** If the janitor runs on a stronger model to improve selection, the cost multiplies by 3–10×. If it runs on a weaker model, selection quality drops. There is no free lunch.
- **The "bigger context window" comparison.** The provider already offers 1M; the native threshold is 678k. There is no bigger window to buy on this route. The correct comparison is native compaction, and the janitor costs more per avoided summary than the summary itself. If the provider later offers a 2M window, the janitor's premise disappears; check the roadmap before building.

**The point where the janitor becomes the dominant cost:** at `F = 18k` and a full-snapshot read, the janitor's total is 37.4M token-equivalents versus 17.6M for native-only — **2.1× the entire session cost**. The janitor is the dominant cost, not a cleanup layer. At `F = 18k` with a cache-reused call it is still +59% (27.96M vs 17.59M). `F = 40k` with a 10k tail is +25%; only the impossible `F = 50k` (dropping every added token) reaches −4%. There is no viable configuration in the design's own parameter range where the janitor is cheaper than native.

---

## 9. Attack 8: threshold and cadence

| Cadence | Passes per 1M | Invalidation volume *(modelled)* | Janitor model cost | Selection quality | Blast radius per bad plan |
|---|---:|---:|---:|---|---|
| 20k | 50 | ~1.15 × 0.8 × ΣC = ~24M | 1M (delta) | Fresher snapshot, less context to judge; more fixed overhead | Small per plan, but 50 chances to be wrong |
| 50k | 20 | ~9.7M | 1M | The design's choice; the model sees 50k, enough to lose the thread | Medium |
| 200k | 5 | ~1.15 × 0.8 × ΣC = ~2.8M | 1M (delta) or 3M (full) | The model sees 200k; "lost in the middle" degrades selection; fewer global errors | Large: one bad plan drops 200k at once |
| Native boundary only | 1 per threshold | The invalidation native already pays | 0 (deterministic) or 0.1C (LLM) | The summary sees the whole surface; the cleanup is deterministic | The summary's own loss |

- **20k:** the invalidation volume is worse (more passes, each with a suffix), and the model cost is the same order. The only advantage is fresher plans; the disadvantage is 2.5× the invalidations of 50k. Never choose 20k for cache reasons.
- **50k:** the design's choice; the numbers in §2.2 kill it with a 32k tail. Even a 10k tail (`F = 40k`) is +25% versus native. Only dropping every added token reaches parity, which is not a memory system.
- **200k:** better cache economics (fewer passes) but worse selection (the model must judge 200k at once) and a larger blast radius. If an LLM janitor is used at all, 200k is the least-bad cadence; it is still dominated by native-boundary-only on cost.
- **Burst:** a 400k-token turn outruns any cadence. The janitor's only safe behavior is to skip and let native handle it. That is a fair-weather layer, and the design should say so.
- **Janitor slower than growth:** the backlog grows, plans go stale, the validator rejects or misapplies them, and the model cost is wasted. The design needs a lag guard; without one, the failure is silent.

**Recommendation:** no 50k cadence. If an LLM janitor is ever built, 200k plus a hard lag guard plus native-boundary application. The deterministic layer can run at any cadence because it has no model cost; it should still run at the native boundary for cache reasons.

---

## 10. Simpler alternatives that beat the LLM janitor

| Alternative | Model calls | Cache impact | Effort *(segmented design's estimate)* | What it gets | What it misses |
|---|---|---:|---|---|---|
| **A. Deterministic failed-search rule, at native's boundary** | 0 | Shares native's one invalidation | ~3–5 days for the flagship rule; ~9–12 days for the full rule set | The five-failed-reads win, zero model cost, offline-testable, deterministic | Derived use without quoting; silent decisions |
| **B. Agent-authored retention at write time (`retain`)** | 0 (the agent is already running) | Cache-neutral (append-only) | ~2 days | The agent's future knowledge, captured at the moment of use; no stale plan | Adoption risk; over-retention; needs a cap |
| **C. Retrieval-first (ranged reads, no full-file injection)** | 0 | No rewrite at all | ~1–3 days of prompt/tool changes | Avoids the bytes entering the window; the only truly cache-safe density strategy | More tool calls; not all tool outputs are files |
| **D. Native tool-result pruner fired earlier (config)** | 0 | One extra invalidation per threshold, not 20 | ~0.5 day | The huge-single-result win; proven code | No failed-search rule; only oversized results |
| **E. Native only + policy-survival fix** | 0 | Native's one invalidation | ~1 day | The cheapest safe baseline; no new state | The summary's loss; no density improvement |

**Why A beats the LLM janitor:** A costs zero model tokens, is deterministic and offline-testable, has no stale-plan problem (it runs at the same step boundary as the evidence), and shares native's invalidation if applied at the boundary. Its false drops are auditable: the rules are visible, and the re-read/regret metric can be computed from the log. The LLM janitor adds model cost, selection risk, plan staleness, and a validator that cannot judge selection. The segmented design's own option A is the recommended first build (§17); the LLM selector (option C/e) is deferred. This red-team agrees with that order.

**Why B is the right second layer:** the agent knows the future better than a snapshot reader because it is the one acting. A `retain` call at the moment of use captures derived use that no deterministic signal can see. It is append-only, so it does not rewrite the prefix; the cache cost is the same as any other new message. The cap prevents hoarding. The weakness is adoption; the prompt must make retention cheap and the tool must be tiny.

**Why C is the structural fix:** if the bytes never enter the window, there is nothing to clean. Ranged reads (`read` with `offset`/`limit`) and grep-first workflows keep the working set small. This is a prompt/tool-discipline change, not a memory system; it is the only option that is cache-neutral by construction. It does not cover tool outputs that are inherently large (test logs, generated files), which is what D handles.

**Why D is the cheapest partial:** setting the native pruner to fire at a lower pressure (e.g., 0.5 × `T_native`) gives one extra pass per threshold, not 20, and it only touches oversized results. It does not implement the flagship rule, but it captures the "one huge result" case with zero new code. If the goal is "stop the 500k session from being mostly junk," D is the first thing to try, before any janitor.

**The LLM janitor is only justified if A + B + C + D are measured and still leave a density gap** — and then it should run off the critical path, on a fork or a separate session, with its plan applied only at native's rewrite and with a deterministic floor that can veto. Even then, the cache math says it will rarely beat native-only.

---

## 11. What would make me kill this project

Three observations, each measurable before building:

1. **The deterministic rule captures most of the win.** On 20 real sessions, instrument the failed-search rule (read-family adjacency, edit/quote/cite/re-read) offline. If it would drop ≥80% of the bytes the LLM janitor would drop, kill the LLM layer. The marginal density is not worth the model cost, selection risk, and stale-plan machinery. **Decision rule: ≥80% → kill the LLM janitor; keep the deterministic rule.**
2. **The cache cost exceeds the savings in the median session.** Measure `cacheReadTokens` / `cacheWriteTokens` before and after each pass on 20 real sessions, and compute the break-even inequality (`R_rem > (1.15S + J)/(0.1F)`). If the janitor's incremental token cost (invalidation + model) exceeds the read savings, kill it. My model predicts this at `F ≤ 20k` with a 32k protected tail, which is the design's own configuration. **Decision rule: median session net cost > 0 → kill the 50k cadence; keep only the native-boundary deterministic layer.**
3. **False drops cause user-visible errors.** Track the re-read rate of dropped paths and every wrong answer traced to a dropped span. If >10% of dropped spans are re-read, or one user-visible error per ~50 passes is traced to a false drop, kill or restrict to tool results with a size floor and whole-result drops. The segmented design's own gate is <10% re-read (§15.4); hold the janitor to it. **Decision rule: >10% re-read or any wrong answer per 50 passes → kill the LLM selection; keep the deterministic floor.**

**Corollary (the fourth observation):** if native compaction fires anyway in most long sessions because bursts outrun the janitor, the janitor is a tax on top of the backstop, not a replacement. The design's failure mode is paying for both. Kill it if the measured native-fire rate is not reduced by the janitor.

---

## 12. What survives

The design that passes red-teaming:

1. **No 50k schedule.** Cleanup runs only at native's rewrite boundary, where the invalidation is already paid, or at a resume/downtime cold-cache window with a recomputed plan. The trigger is a fraction of `T_native` and a real surface event, not a token count.
2. **Deterministic selection first.** The failed-search rule and the other deterministic rules run with zero model calls, tool-result-only, whole-result drops, a size floor, and a minimum compression ratio. The rules are auditable and offline-testable.
3. **Append-only retention second.** A capped `retain` tool captures derived use at write time; no history rewrite; native remains the only rewrite.
4. **Retrieval-first third.** Ranged reads and grep-first workflows keep the bytes out of the window. The retrieval tools (`segment_read`, `read_span`) are cheap and exact.
5. **Policy survival by construction.** Move the dispatcher policy to a per-agent system-prompt section before any janitor touches user messages. The roster stays at the tail and is never summarized.
6. **One atomic replacement per pass.** All spans in one `surfaceOp`, or per-span `applied` records with resume reconciliation. Validate against the live surface, not the snapshot or the log.
7. **Per-session state, scoped ownership.** `passInFlight` per session; worker ownership checked against the parent dispatcher, not `workerIdOf` globally; pending plans discarded on fork.
8. **Measure before tuning.** Re-read rate, note bytes, tools per task, cache read/write deltas, native-fire rate. The success gate is the segmented design's §15.4 plus the three kill criteria above.

The honest summary: **the LLM janitor is a solution to a problem the deterministic layer has not been measured against.** The repo already has the deterministic design (segmented option A) and the host already has the rewrite that makes cache-safe cleanup possible (native compaction). Build A first; measure; then decide whether an LLM selector adds enough density to justify its cost. The 50k LLM janitor, as stated, does not.

---

## 13. Assumptions, sensitivity, and evidence

| Assumption | Value used | What changes if wrong |
|---|---|---|
| Input price `P` | $0.28/M (illustrative) | Dollar figures scale linearly; token-equivalent conclusions do not change |
| Cache read / write multipliers | 0.1 / 1.25 (published; Anthropic-shaped) | DeepSeek-style automatic cache has no write premium (1.0); the invalidation premium falls ~13%, the direction is unchanged |
| Output price | 3P | Native summary cost rises or falls; the janitor's relative position is unchanged |
| Tokens per request `A` | 2,000 | More tokens per request = fewer requests = worse for the janitor (fewer remaining reads to amortize the invalidation) |
| Freed per pass `F` | 18k / 40k / 50k | The 8k minimum is below break-even past ~265k; larger `F` is the only economic escape, and it requires dropping recent content |
| Invalidated suffix `S` | 0.8C | Oldest-first makes it larger (worse); a tail-near cut makes it smaller but drops the content most likely needed |
| Janitor model cost `J` | 50k/pass best case; `C`/pass worst case | The best case still loses at `F = 18k`; the worst case is 2× worse |
| Protected tail | 32k (repo's proposal) | A 10k tail allows `F = 40k`, which is still +25% vs native; no tail is required to reach parity, which means dropping every added token — not a memory system |
| Cache TTL | Unknown; the design assumes 60 min | The idle pass's break-even confidence is 92–96%; a wrong TTL guess costs a full rewrite |
| Live session length | 1M tokens, 500 requests | The repo has no 500k session; the model is an extrapolation from the native evidence's ~68k maximum |

**Evidence cited:** native threshold and summary mechanics (`.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §3); no compaction in stored sessions and ~68k max usage (same, §1, §9); cache accounting fields and their Anthropic/Codex provenance (`.scratch/repo-analysis/2026-10-18-memory-compaction.md:86`); cache-hostile microcompact (`docs/research/compaction-stack-design-2026-10-19.md:30`); idle pass at 60 minutes (`docs/research/compaction-stack-design-2026-10-19.md:167`, `.scratch/repo-analysis/2026-10-18-zcode-lane-memory.md` §4.4); policy injected once as a user message (`src/adapter/parent-agent.ts:34-57`, `:322`; `docs/research/compaction-stack-design-2026-10-19.md` §2.1); roster at the tail (ADR-0027); boundary marker (ADR-0029); multiple dispatchers (ADR-0019); mitosis (ADR-0025); deterministic option A and the LLM selector deferral (`docs/research/segmented-compaction-design-2026-10-19.md` §6.1, §15.4, §17).

**Not verified:** any live janitor pass; the live provider's cache TTL; whether the DeepSeek route returns `cacheReadTokens`/`cacheWriteTokens` at all; the actual useful fraction of a 500k dispatcher transcript; the actual record size and freed bytes; the actual native-fire rate on long sessions; the actual provider price sheet.

**No source and no ADR was edited. Nothing was committed.**

---

## 14. Reconciliation with the segmented design

**Verdict: the two models reconcile, and the segmented design's cache model is closer for its own mechanism. My +59% was an artifact of two wrong assumptions, not a disagreement about the mechanism.** The assumptions:

1. **One flush per seal.** I charged 20 invalidations (`ΣC`); the segmented design seals every 50k but lands every 3 seals, so 6 flushes per 1M. This alone cuts the invalidation volume ~3.3×.
2. **Whole-suffix invalidation at the current context.** I charged `0.8C` per pass (the cut near the head invalidates everything after it). The segmented design lands a *rolling* window: each flush replaces only the batch sealed since the last flush, so the invalidated suffix is the pending window plus the raw tail (~150k + 50k), not 0.8C. At 1M that is ~200k per flush instead of ~800k. This is the dominant correction, and it is right: the prefix before the last landed position is unchanged and still cached.

With both corrections the segmented numbers reproduce. My stepped model, same parameters (`G = 1M`, 500 requests, 2k/request, 3-seal batches, `ε = 0.05`, native allowed as backstop):

| `q` | Native only | Janitor A (no LLM) | Delta | Janitor C (LLM) | Delta |
|---|---:|---:|---:|---:|---:|
| 0.3 | 17.60M | 19.01M | **+8%** | 19.89M | +13% |
| 0.5 | 17.60M | 16.11M | **−8%** | 16.99M | −3% |
| 0.7 | 17.60M | 11.15M | **−37%** | 12.03M | −32% |

(Anthropic-shaped 0.1/1.25/3 multipliers; millions of full-price input-token units.) These match the segmented design's 12.2 table (−8% at 0.5, −37% at 0.7; +14% at 0.3, where my stepping differs by 6 points because it lets native fire once in the `q=0.3` arm). **The segmented model wins the reconciliation.**

### 14.1 With this host's actual prices

The host runs `deepseek-flash` (`.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §1: `provider: deepseek-official, model: deepseek-flash`). The DeepSeek pricing page fetched 2026-10-19 gives, per 1M tokens, peak: cache hit **$0.006**, cache miss **$0.30**, output **$1.20**. Therefore, for this host:

- `r = cache hit / miss = 0.02` (not 0.1)
- `w = 1.0` — **no separate cache-write fee**; a write is billed at the miss price
- `o = output / input = 4.0`
- Invalidation premium `w − r = 0.98`, **not 1.15**

Running the same stepped model with those values:

| `q` | Native only | Janitor A | Delta |
|---|---:|---:|---:|
| 0.3 | 4.58M | 5.76M | **+26%** |
| 0.5 | 4.58M | 4.33M | **−6%** |
| 0.7 | 4.58M | 3.21M | **−30%** |

Cheap cache reads make the janitor's win *thinner*, not fatter: the read savings shrink 5× while the invalidation shrinks only ~15%. The crossover `q` moves from ~0.44 (Anthropic) to ~0.455 (DeepSeek) in my stepping, but the margin at `q = 0.5` falls from −8% to −6%. **The design's `q ≥ 0.5` gate is therefore the minimum bar on this host, and it is a wash bar, not a win bar. A ship gate with margin should be `q ≥ 0.6`.**

**Answer to question 4, plainly:** my 1.15× was Anthropic-style and wrong for this host. The correct premium is 0.98×, and the correct read ratio is 0.02, not 0.1. This correction *helps* the janitor on the invalidation side but hurts it on the savings side, net roughly neutral. It does not rescue my original +59%; the suffix and batch corrections do that.

### 14.2 Kill criterion #2, revised

Original: `R_rem > (1.15S + J) / (0.1F)`. With option A (`J = 0`), the rolling batch, `F = 150k × q × (1−ε)`, and `S = 150k × (1 − q(1−ε)) + 50k`:

```
R_rem > (w − r) × S / (r × F)
```

| `q` | `F` per flush | `S` per flush | Break-even `R_rem` (Anthropic) | Break-even `R_rem` (DeepSeek) |
|---:|---:|---:|---:|---:|
| 0.3 | 42.8k | 157k | 42 requests | **180 requests** |
| 0.5 | 71.3k | 129k | 21 requests | **89 requests** |
| 0.7 | 99.8k | 100k | 12 requests | **49 requests** |

At 500k in a 1M session there are 250 requests left, so all three pass; at 700k there are 150 left, so `q = 0.3` fails on DeepSeek; at 900k there are 50 left, so only `q = 0.7` passes. This is why the aggregate at `q = 0.5` is only −6%: the late flushes lose, the early ones barely win.

**Revised criterion #2:** *Kill or restrict the janitor if measured `q < 0.5` in the target sessions; require `q ≥ 0.6` for a ship with any margin. Do not claim a cost win at `q = 0.5`; claim cost-neutral fidelity.*

**Criterion #1 is unchanged and still the strongest attack.** Batching does not change the byte-selection question: if the deterministic rule (option A) captures ≥80% of the bytes the LLM selector (option C) would drop, the LLM layer is not worth its selection risk and its ~3–6 points of added cost. Option A is the base; C is deferred. My red-team agrees with that ordering, and this reconciliation does not weaken it.

**Criterion #3 is unchanged.** Batching does not reduce false drops; it makes each flush land more content at once, so a bad batch is a larger blast radius, not a smaller one.

### 14.3 Is the batching valid?

Three sub-claims, checked:

1. **One flush of three spans costs one invalidation, not three.** **Valid.** Provider caching is per request, not per append. The three replacements happen in one synchronous block before the next request, so the provider sees one prefix. The invalidated region is the contiguous suffix from the oldest replaced node to the tail — one re-cache, regardless of how many replacement events produced it. The three sealed segments are adjacent anyway (the seal cursor walks forward), so the replacement range is contiguous. If a native checkpoint sits between them, the suffix still starts at the oldest replacement and covers the gap; still one suffix. The design's "one invalidation per flush" is correct. *Caveat:* if any `await` or HMR interleaves a request between the three replacements, the invalidation count becomes three. The synchronous-block requirement is load-bearing; the ticket must pin it.
2. **The invalidated suffix is the pending window, not the whole surface.** **Valid for a rolling land**, provided the flush lands only the batch since the last flush and earlier replacements stay untouched. If the design ever re-lands or rewrites an older record, the suffix jumps back to that older position and the cost model collapses. Pin "never rewrite below the last landed position" as an invariant.
3. **Holding three seals unflushed defeats the purpose — partially.** **Valid criticism.** At `q = 0.5`, a 150k batch holds ~75k of evictable junk on the surface for up to 150k raw tokens. The density win is delayed by ~1.5 batches, and the transient at 500k is worse than the steady-state table shows. Worse, if native fires while a batch is pending, native summarizes the pending sealed spans, and the records (which live only in the log until landed) are shadowed — the pointer index restores ids and titles, but the in-context record is gone. Batching trades transient density and some record survival for cache cost. That trade is defensible, but it must be stated; it is not free.
4. **A fourth, unstated cost:** the batch is a bet that no native compaction and no fork happens in the next 150k tokens. If either does, the pending plan/records need re-derivation. The design has the hooks (abort on unmatched `compaction/start`, discard on fork) but the cost model does not include the wasted seals.

### 14.4 What still does not reconcile

- **`q` is unmeasured, and it is session-type-dependent.** The segmented design's own §13 says at `q = 0.5` the non-evictable user/assistant turns dominate the 500k window; records are ~4% of it. Worker transcripts are tool-heavy (high `q`, the win case); dispatcher transcripts are report- and prose-heavy (low `q`, the loss case). The owner's density goal is about the dispatcher; the economics work in the worker. **The ship gate must be measured per session type, not pooled.** If dispatcher `q` measures 0.3, the janitor is +8% to +26% there and should not run on dispatchers; it can still run on workers.
- **The 500k target is not reachable in v1.** Their §13 is honest: at `q = 0.5`, a 900k-raw conversation fits a ~496k window, but records are ~4% of it. The owner asked for "at 500k, mostly useful information"; v1 delivers "900k of raw costs 500k of window, with tool dumps removed." That is a real improvement and a different claim. Do not conflate them.
- **The LLM selector's marginal value remains unproven.** Option C costs 3–6 points more than A in my stepping, and its selection quality is exactly what the validator cannot check. Deferring it is right. My earlier claim that the LLM call is a dominant cost was wrong for a delta-reading janitor; it is right only for a full-surface reader. State which one is being built.

### 14.5 The measurement that settles it

One number, per session type: **`q` = evictable tool-result tokens ÷ total surface tokens**, measured on 20 real dispatcher sessions and 20 real worker sessions with `ctx.tokenMeter.measure()` node prices and the tool-result/source-kind classification. With `q` measured, the stepped model gives the delta directly; no provider TTL, no cache-counter attribution, and no LLM needed. Secondary: the actual native-fire rate, and whether the deterministic rule's drop set matches the LLM's (criterion #1). If dispatcher `q < 0.5`, the design as a dispatcher-density layer dies and survives only as a worker cleanup; if `q ≥ 0.6`, it ships as option A with the boundary and batching invariants above.

**Summary of the revision:** my attack #1 stands against the *unbatched, whole-suffix, LLM-per-pass* variant I originally modelled, which is not the segmented design. Against the actual segmented design (3-seal batches, rolling window, option A, no model), the cache attack reduces to a **`q` gate**: a wash at `q = 0.5`, a win at `q ≥ 0.6`, a loss below `q = 0.5`. That is a real constraint, not a project killer. The remaining killers are selection quality (attack #2), validator blindness (attack #4), and the unmeasured scope mismatch (attack #6) — none of which batching touches.
