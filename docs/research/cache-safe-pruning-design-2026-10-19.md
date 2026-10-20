# Cache-safe context pruning: design proposal

- **Date:** 2026-10-19
- **Status: DESIGN PROPOSAL. NOT A RULING.** Nothing here is adopted. This document exists because of one owner sentence, quoted verbatim: *"we don't want our memory system cache-destructive, as in every cleanup causes LLM to not be able to use existing cache and wasting money."* Every rule below needs its own ticket; anything that changes a recorded decision needs an explicit ADR amendment.
- **What this document is not.** It does not replace native compaction, does not touch source, does not amend ADRs, and does not claim provider prices. It answers one question: **when does pruning old context save money instead of burning it on cache invalidation?**
- **Provider cache mechanics doc: absent at write time.** `.scratch/repo-analysis/2026-10-19-provider-cache-mechanics.md` does not exist. Everything about cache behaviour below is therefore derived from a **strict-prefix assumption** (§2.1), marked as an assumption, and parameterized. The parallel research, when it lands, should be used to replace the parameters, not the structure.
- **Numbers are modelled, not measured live.** The cost figures come from a small discrete simulator (166-2,500 turns, 2k-6k tokens/turn, explicit surface nodes). It is a simplification: ±40% on magnitudes is realistic. Directions and ratios are the load-bearing part. No live dsh session was run for this document.
- **Host under inspection:** `dsh@0.2.1-rc.2` at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`.

---

## 1. The recommendation in one page

**Fixed token-interval pruning is the wrong shape.** A 50k interval costs 20 cache-invalidating rewrites per 1M tokens of growth. In the model it **loses 5.6%** when half of new tokens are disposable tool output (`q = 0.5`) and **wins 15.9%** only when almost everything added is tool output (`q = 0.7`). The owner's instinct is correct: routine cleanup is often cache-destructive.

**The recommended shape is four rules, in this order:**

| # | Rule | Why |
|---|---|---|
| **R1** | **Never prune on a fixed token interval.** Delete the 50k rule. | 20 rewrites per 1M; sign of the result flips with transcript content. |
| **R2** | **Prune at cache-epoch boundaries** — ideally in the same pre-step as native compaction, before the post-compaction request re-warms the cache; failing that, on the next pre-step after `compaction/end`; plus after an idle gap longer than the provider TTL, or after a route/tool-set change. | The epoch break is already paid. Same-pre-step pruning is free; next-turn piggyback pays only a bounded band invalidation. Measured: −0.7% to −7.0% depending on `q`, never a loss. |
| **R3** | **If pressure pruning is needed, use geometric growth (×2) with a bounded late band**, above 0.5 × `T_native`, and only if projected remaining turns ≥ break-even. | **6 rewrites per 1M** instead of 20. Break-even ~12-18 turns instead of ~57. |
| **R4** | **An in-memory cache-budget controller makes the call**, using host-reported `cacheRead`/`cacheWrite`; it **fails closed** (no prune) when those fields are absent or when realized savings miss the projection 3 times. | Measurement, not a constant. |

**The single most important finding:** *where* you cut matters more than *how often*. Clearing at the head costs a full-prefix rewrite; clearing inside a band just behind the protected tail costs only the band plus tail. For a 300k prefix and 50k freed, break-even goes from **56.5 turns to 17.9 turns** for the same token saving. Placement is a 3× lever on the economics; cadence is a 3× lever on the rewrite count. Both are worth using.

**The honest headline, stated before any numbers:** pruning is not a general cost optimization. In the model, at a prunable share `q ≤ 0.5` (tool results are half or less of added tokens) **no self-scheduled prune beats native-compaction-only**; only epoch piggybacking does. Pruning pays on its own only when the transcript is dominated by disposable tool output (`q ≥ 0.7`). This matches the independent conclusion in `segmented-compaction-design-2026-10-19.md` §12.3 ("the janitor is not a cost win in general"). The controller in §6 exists to detect which regime the session is in, per session, instead of assuming.

**Do nothing until measured.** Ship the controller in shadow mode first (compute and log the decision, never prune). One week of `cacheRead`/`cacheWrite` data answers every open question in §12 for this host.

---

## 2. Assumptions and verified host facts

### 2.1 The strict-prefix assumption (load-bearing, unverified)

The design assumes **prompt caches are strict prefix caches**: a request reuses the longest cached prefix; rewriting content at byte/token position `N` invalidates every cached token after `N`. This is stated in the mission, is consistent with every provider's documented behaviour, and is what the independent provider-mechanics research is expected to confirm or refine. If the real cache is block-granular or content-addressed, the *numbers* shift slightly (§9); the *decision rules* do not.

### 2.2 Verified host facts this design rests on

1. **Surface replacement is append-only.** `surfaceOp {op:'replace', startSeq, endSeq}` is appended to the log; raw events stay. The shadowed pricing event (`compaction/prune`) must be appended **synchronously immediately before** its replacement, or the O(1) pressure projection folds a zero delta (`dsh-compaction/lib/types/types.d.ts:76-105`).
2. **Per-turn cache accounting is available.** `assistant/message.usage` in `session/event` carries `TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`, and the fields are **disjoint**: `inputTokens` is uncached input only (`dsh-llm/lib/types/types.d.ts:153-173`). The adapter proves the buckets are real, not decorative: its stream translator maps `cache_read_input_tokens → cacheReadTokens` and `cache_creation_input_tokens → cacheWriteTokens` (`dsh-llm-deepseek/lib/index.js:1826-1827`).
3. **A cumulative host projection already exists**, so we never need our own ledger: `ctx.sessionProjections.stateOf(session, "tokenUsage")` returns `{ totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last: { turn, step, buckets } }` (`dsh-token-meter/lib/types/usage-projection.d.ts`). Deltas between two reads give per-turn behaviour without persisting anything.
4. **Native compaction already pays the invalidation.** One LLM summary call over the real prefix, then one `user/message` with `surfaceOp replace` over the shadowed span (`dsh-compaction-basic/lib/index.js:292-338, 650-661`). The summarizer reuses the prefix by appending its instruction as the final user message. **The replacement still rewrites the span**, so the cache boundary is created whether we act or not.
5. **`compaction/start`, `compaction/summary`, `compaction/end`, `compaction/prune` are log-only events a plugin can observe** (`dsh-compaction/lib/types/types.d.ts:15-76`). `compaction/summary` even carries the summarizer's own `usage` — the best available measurement of what that epoch cost.
6. **`agent/pre-step` is a waterfall** carrying `{agent, messages, turn, step, signal}` (`dsh-agent/lib/types/runtime-types.d.ts:92-100`), and `agent/turn-stopping` exists for end-of-turn work. Native compaction uses `pre-step` (`dsh-compaction-basic/lib/index.js:839-855`).
7. **`ctx.tokenMeter.measure(session)`** returns `{totalTokens, surfaceTokens, nodes[{seq,tokens,heuristicTokens}], ...}`, synchronous and replay-derived (`dsh-token-meter/lib/types/types.d.ts:24-55`). This is how "how much would I free" is computed without our own accounting.

### 2.3 Constraints that bind

- **ADR-0018 U-H:** no local content-search index, no local per-stream token ledger. The controller in §6 keeps **in-memory** rolling state per session and derives turn deltas by diffing the **host's** `tokenUsage` projection. Nothing is persisted. Whether an in-memory rolling window counts as "accounting of our own" is an interpretation this document makes and **flags** in §12.
- **ADR-0006 / A5:** no second database. Prune records go through `appendPluginRecord` into dsh's session log.
- **Native compaction stays the backstop.** Nothing here disables it or replaces it.

---

## 3. The cost model

### 3.1 Definitions

| Symbol | Meaning |
|---|---|
| `P` | prefix tokens before this turn's request (system + tools + surface) |
| `P′` | prefix tokens after a prune, `P′ = P − S` |
| `S` | tokens freed by the prune (`S > 0`) |
| `N` | surface position of the **earliest** cleared node; everything from `N` onward is rewritten |
| `D` | rewritten suffix on the first post-prune request, `D = P′ − N` |
| `T` | protected tail tokens (newest content that is never cleared), e.g. 32,000 |
| `r` | cache-read price ÷ full input price |
| `w` | cache-write (or plain new-input) price ÷ full input price |
| `k` | break-even: number of subsequent turns for the saving to repay the rewrite |

Cost unit is **one full-price input token**. Output tokens are excluded because pruning does not change them.

### 3.2 Per-turn cost without pruning

```
C_turn = r·P
```

With a cache hit, the whole prefix is read at the discount. This is the baseline every prune must beat.

### 3.3 First-turn cost of a prune

```
C_prune = r·N + w·D           // prefix before the edit is still a hit; suffix is a write
C_noprune = r·P = r·N + r·D + r·S
Δ_first   = C_prune − C_noprune = (w − r)·D − r·S
```

`Δ_first` is the **one-time cost** in full-price token units. Every subsequent turn saves `r·S`. Therefore:

```
        (w − r)·D − r·S            (w − r)·D
  k  =  ─────────────────   =     ───────────  −  1
               r·S                   r·S
```

**Head-edited prune** (`D ≈ P − S`, i.e. the cut is at the start of history):

```
        (w − r)·P − w·S
  k_head = ───────────────
               r·S
```

**Band-limited prune** (`D ≈ S + T`, i.e. the cut is just behind the protected tail):

```
        (w − r)·(S + T)
  k_band = ─────────────────  − 1
               r·S
```

**The governing inequality.** A prune pays off iff the session will run more than `k` more turns.

### 3.4 The same relation solved for the freed fraction

Setting `k` to a target and solving for `S/P` on a head edit:

```
  S/P  ≥  (w − r) / (r·k + w)
```

**Table A — minimum freed share `S/P` for a head edit to break even within `k` turns**

| multipliers | k=10 | k=20 | k=50 | k=100 | k=200 |
|---|---|---|---|---|---|
| `w=1.25, r=0.1` (explicit write premium, 90% read discount) | 51.1% | 35.4% | 18.4% | 10.2% | 5.4% |
| `w=1.0, r=0.1` (no write premium, 90% discount) | 45.0% | 30.0% | 15.0% | 8.2% | 4.3% |
| `w=1.0, r=0.5` (no write premium, 50% discount) | 8.3% | 4.5% | 1.9% | 1.0% | 0.5% |

Read this table twice. Under `w=1.25, r=0.1`, a head-edited prune must free **more than a third of the entire prefix** just to repay itself inside 20 turns. That is why a 50k cleanup on a 300k prefix (17%) has a 57-turn break-even — and why the owner's worry is justified.

### 3.5 Break-even table across prefix sizes (`w=1.25, r=0.1`)

**Head edit** — `k = ((w−r)P − wS)/(rS)`:

| `P` \ `S` | 25k | 50k | 100k | 150k | 300k |
|---|---|---|---|---|---|
| 100k | 33.5 | 10.5 | — | — | — |
| 300k | 125.5 | **56.5** | 22.0 | 10.5 | — |
| 500k | 217.5 | 102.5 | 45.0 | 25.8 | 6.7 |
| 678k | 299.6 | 143.5 | 65.5 | 39.5 | 13.5 |
| 1,000k | 447.5 | 217.5 | 102.5 | 64.2 | 25.8 |

**Band-limited edit** — `D = S + 32k`, `k = (w−r)(S+T)/(rS) − 1`:

| `S` | 25k | 50k | 100k | 150k | 250k |
|---|---|---|---|---|---|
| `k_band` | 25.2 | **17.9** | 14.2 | 13.0 | 12.0 |

The band table barely depends on `P`. That is the point: **bounding the invalidation makes the economics a property of the prune, not of how deep the session already is.** Compare 300k/50k: head = 56.5 turns, band = 17.9 turns.

### 3.6 Simulated cadence comparison

Model: 1M tokens of growth, 6k tokens/turn (166 turns), base prefix 30k, `w=1.25, r=0.1`, protected tail 32k, minimum freed 8k, native threshold 678,464. `q` is the share of added tokens that are disposable tool output. All figures in millions of full-price input-token units.

**`q = 0.5`** (half tool output — an ordinary mix)

| Arm | rewrites | avg prefix | read | write | total | vs native |
|---|---|---|---|---|---|---|
| Native compaction only | 1 | 342k | 5.57 | 1.42 | **7.00** | — |
| Fixed 50k | 18 | 311k | 4.97 | 2.42 | 7.39 | **+5.6%** |
| Geometric ×2 | 6 | 329k | 5.30 | 1.97 | 7.28 | +4.1% |
| Size-triggered (0.8·Tn) | 7 | 381k | 6.13 | 2.33 | 8.46 | **+20.9%** |
| Idle-only, no idle gaps present | 1 | 342k | 5.57 | 1.42 | 7.00 | 0% (never fires) |
| Piggyback on native | 2 | 322k | 5.23 | 1.54 | **6.78** | **−3.2%** |

**`q = 0.3`** (message-heavy transcript) — every self-scheduled arm loses: fixed 50k **+17.5%**, geometric **+6.5%**, size-triggered **+21.1%**.

**`q = 0.7`** (tool-heavy worker transcript) — the sign flips: fixed 50k **−15.9%**, geometric **−12.7%**.

**`q = 0.85`** (search/read-heavy worker) — fixed 50k **−33.7%**, geometric **−31.8%**.

**5M tokens of growth** (833 turns): native 40.44, fixed 50k 43.57 (**+7.7%**), geometric ×2 40.65 (+0.5%), piggyback 39.12 (**−3.2%**).

### 3.7 What the numbers say

1. **`q` decides the sign, not the cadence.** No schedule survives `q = 0.3`. Every schedule wins at `q = 0.7`. The controller must estimate `q` per session (§6).
2. **Fixed 50k is the most expensive arm per unit of benefit.** It performs 3× the rewrites of geometric ×2 and wins only where the freed tokens are large relative to the prefix.
3. **Size-triggered-only is the worst arm** at every `q`. It fires in a dense band where the newly eligible content is small and partially cleared already, so each fire pays a suffix rewrite to free a few thousand tokens. This is the "degenerate steady state" failure mode: after the band's old results are consumed, the trigger keeps firing on crumbs.
4. **Piggyback is the only arm that is non-negative at every `q`.** Same-step piggyback shares native's invalidation outright; next-turn piggyback pays a bounded band invalidation, which is small enough that the arm still wins at every measured `q` (−0.7% to −7.0%). Every self-scheduled arm changes sign with `q`.
5. **Geometric ×2 is the best self-scheduled arm**: 6 rewrites per 1M, break-even 12-18 turns, and it stays close to native at low `q` while capturing most of the win at high `q`.

---

## 4. Cadence comparison (the design question, answered directly)

"Rewrites per 1M tokens" counts cache-invalidating surface rewrites over a session that grows from a 30k base to 1M tokens. All cost deltas are relative to native-compaction-only at the same `q`.

| Candidate | Formula | Rewrites / 1M | Estimated cache cost | Density impact | Verdict |
|---|---|---|---|---|---|
| **Fixed 50k** (owner's proposal) | `P − P_last ≥ 50k` | **20** | +5.6% at q=0.5; +17.5% at q=0.3; −15.9% at q=0.7 | Strong; prefix stays low | **Reject as a default.** Only acceptable when the controller has measured `q ≥ 0.7` and a long horizon. |
| **Geometric ×2** | `P ≥ 2·P_last` | **6** | +4.1% at q=0.5; −12.7% at q=0.7 | Moderate; prefix ~329k vs 342k native | **Accept as the pressure fallback.** Logarithmic rewrite count. |
| Geometric ×1.5 | `P ≥ 1.5·P_last` | 9 | between the two | Better density | Accept only if ×2 leaves pressure above the band. |
| Geometric ×3 | `P ≥ 3·P_last` | 4 | +1.8% at q=0.5 | Weaker; prefix ~327k | Accept if writes are expensive and turns are few. |
| **Size-triggered only** | `P ≥ 0.8·Tn`, clear to 0.55·Tn | 3-11 (unstable) | +20.9% at q=0.5 | Poor; prefix ~381k | **Reject.** Degenerates into frequent tiny prunes. |
| **Idle-timed** | prune at first pre-step after idle ≥ TTL | 0 extra (the boundary was free) | 0 at the boundary; strictly reduces the cold write | Depends on how much is freed | **Accept, but only as a *time* for a prune already due** — see §4.1. |
| **Piggyback on native** | prune in/after the native epoch (see §7.2) | **2** (1 native + 1 ours) | −0.7% at q=0.3; −3.2% at q=0.5; −5.3% at q=0.7; −7.0% at q=0.85 | Strong: the summary already collapsed the head | **Accept. Default aggressive-prune point.** |
| **Recommended hybrid** | piggyback + idle + geometric ×2 fallback | **~6-8** (2-3 paid + 4-6 self-scheduled) | −3% to −13% depending on `q` | Good | **Recommend.** |

### 4.1 The idle question, answered precisely

Two different claims get mixed up, so separate them:

- **"Prune on idle is free."** True in one narrow sense: if the cache has expired, the next request rewrites the whole prefix anyway. Pruning at that moment makes the rewrite **smaller** (`w·P′ < w·P`), so it is **strictly better than not pruning**. It is never a cost.
- **"Idle should trigger pruning."** False as a general rule. If the session is warm and will stay warm, pruning on an idle timer that does not exceed the TTL buys nothing. And if the session never resumes, the prune buys nothing either (though it costs nothing).

**Correct formulation:** idle is a **discount on the timing of a prune you already decided to do**, not a reason to invent one. Implementation: a prune that the pressure rule marks "due but not worth it" is **deferred** to the next idle boundary, where its `Δ_first` becomes 0 and it becomes worthwhile. That deferral is safe because the alternative — pruning warm — is exactly what the owner objects to.

The measured effect of idle **as a trigger** is not a win: 0% when the gap does not exceed the TTL, and a net **cost** (+5% to +12% in the model) when a small prune is performed at every gap. Do not oversell it. Its value is as a **free moment for a prune already due**, not as a schedule.

### 4.2 Rewrite-count arithmetic

| Cadence | Count for base 30k → 1M |
|---|---|
| Fixed 50k | `(1,000,000 − 30,000)/50,000 ≈ 20` |
| Geometric ×2 | `⌈log₂(1,000,000/30,000)⌉ = ⌈5.06⌉ = 6` |
| Geometric ×1.5 | `⌈log₁.₅(33.3)⌉ = 9` |
| Geometric ×3 | `⌈log₃(33.3)⌉ = 4` |
| Native only | 1 (at 678k) |

The geometric count is why the recommendation is geometric: rewrite count grows **logarithmically** with session length, and the per-rewrite cost is bounded by the band (§5).

---

## 5. Placement: can we prune without invalidating the suffix?

Short answer: **no rewrite of history avoids invalidating the suffix.** The only way to avoid it is to not have prunable content in the cached prefix in the first place, or to rewrite when the suffix is already invalid. Five layouts were evaluated.

| Option | What it means | Verdict |
|---|---|---|
| **(a) Stable immutable prefix + append-only volatile tail** | Everything before the newest user message is byte-stable; per-turn material (ledger, roster, wake text) rides at the tail | **Viable, and mandatory — but not a pruning mechanism.** This is the L0 discipline already recommended in `compaction-stack-design-2026-10-19.md` §7. It protects the cache from *accidental* churn; it does nothing about history that has grown too large. Adopt it independently, do not count it as pruning. |
| **(b) Put prunable content late in the prompt** | Reorder history so droppable material sits near the tail | **Not viable for history.** Reordering history *is* a rewrite of the prefix, so it pays the exact cost it is meant to avoid, and it breaks chronology (tool results must follow their calls; the model reads the transcript as a sequence). **Partially viable at emission time:** never put large, disposable tool output into the head in the first place — clamp or summarize at emission, before it is ever cached. This is the only genuinely cache-safe "pruning": *do not create the bytes.* It belongs in the emission layer, not the janitor. |
| **(c) Epoch model** | Accept a full rewrite; treat it as a cache-epoch boundary; re-warm once | **Viable, and it is the correct mental model.** Every self-scheduled prune starts a new epoch. The question the controller answers is not "how do we avoid an epoch" but "is this epoch worth its price". Native compaction is already an epoch. |
| **(d) Prune only when the cache is already invalid** | Native compaction, idle expiry, model/route change, tool-set change, system-prompt change | **Viable, and the best option.** Same-step with native compaction: invalidation cost 0. Next-turn after it: bounded band invalidation only (§7.2). Idle after TTL: 0, because the full rewrite is happening anyway. This is R2 and the piggyback rule (§7). |
| **(e) Bounded late band** *(new, recommended for R3)* | Never clear the oldest node first. Clear inside a band ending at `P − T`, so `D ≤ S + T` | **Viable, and it is the 3× lever.** Oldest-first makes `D ≈ P`; band-limited makes `D ≈ S + T`. This is what turns a 56.5-turn break-even into 17.9 turns. |

### 5.1 The band, precisely

```
surface:  [ system ][ tools ][ ─────── history ─────── ][ protected tail T ][ new turn ]
                                 ^                        ^
                                 |                        P − T
                                 band start = P − T − H
```

- The **protected tail** `T` (proposal: 32,000 tokens, matching the microcompact design) is never touched. This is the working set the dispatcher actually reads.
- The **band** `H` is the clearing window immediately behind the tail. Clear **oldest-first within the band**, so relevance is preserved as far as the bound allows; `D` stays bounded by `H + T` no matter the order inside the band.
- **When the band is exhausted** (no eligible nodes left), do **not** reach into the head. **Double `H`** and try again. This is the geometric cadence expressed in space rather than time: `H` grows 64k → 128k → 256k → 512k, so the number of widenings is logarithmic, and each widening is a deliberate epoch rather than a drip of tiny prunes.
- If even `H = P − T` cannot free the minimum, this session has no disposable content. **Write no prune.** The controller records `no-eligible-content` and stops trying until content changes.

### 5.2 The relevance trade-off, stated honestly

Clearing **newest-first inside the band** would push `N` later and shave a little more invalidation, but it removes the results the agent is most likely to still want. The design chooses **oldest-first inside the band** and accepts a slightly larger `D` because the band already bounds it. The compromise is real: it clears within a bounded window behind the tail, so the loss is *older than the working set* rather than *newest*. There is no layout that is both free and relevance-preserving. **The recommendation accepts bounded relevance loss in exchange for bounded invalidation cost, and only above 0.5 × `T_native` where the alternative is a summary.**

---

## 6. The cache-budget controller

### 6.1 Purpose

Decide, per session and per `agent/pre-step`, whether a prune's projected saving exceeds its projected cost. It is **not** a cadence. Cadence is an input; the controller is the veto.

### 6.2 State (in memory, per session, never persisted)

| Field | Type | Purpose |
|---|---|---|
| `samples` | ring buffer, last 20 turns: `{turn, prefixTokens, cacheRead, cacheWrite, uncachedInput, output}` | Measure realized cache behaviour |
| `prevTotals` | last `tokenUsage` projection totals | Derive per-turn deltas without a ledger |
| `hitRateEma` | `EWMA(cacheRead / (cacheRead + cacheWrite + uncachedInput))`, α=0.3 | Detect healthy caching |
| `writeEma` | `EWMA(cacheWrite / (…))` | Baseline miss rate before a prune |
| `qEma` | `EWMA(freedTokens / deltaTokens)` from prior passes | Estimate prunable share |
| `lastPrune` | `{turn, prefixBefore, prefixAfter, freed, projectedK, predictedReadDrop}` | Judge the last pass |
| `prunesJudged` | integer | Auto-disable counter |
| `missStreak` | integer | Consecutive under-delivering prunes |
| `disabled` | boolean | Session breaker |
| `deferred` | boolean | A "due but not worth it" prune waiting for idle |

All of it is a rolling window over the **host's own** usage events. Nothing is written to disk, nothing is indexed, nothing is a per-stream ledger (see §12 Q1 for the interpretation this relies on).

### 6.3 Algorithm, per `agent/pre-step`

```
on pre-step(agent):
  s = state(agent.session)                    # create empty on first sight; empty => no prune
  measure = ctx.tokenMeter.measure(session)
  P = measure.totalTokens
  Tn = thresholdNative(session)               # same formula native uses (§7.1)
  usage = lastTurnUsage(session)              # from session/event, in-memory ring

  # 0. Fail closed
  if usage.cacheRead == undefined or usage.cacheWrite == undefined:
       record('skipped-no-cache-data'); return          # cannot judge => do not prune

  # 1. Update measurements
  s.samples.push({turn, P, ...usage})
  s.hitRateEma = ema(s.hitRateEma, usage.cacheRead / max(1, usage.cacheRead+usage.cacheWrite+usage.uncachedInput))
  s.writeEma   = ema(s.writeEma,   usage.cacheWrite / max(1, ...))

  # 2. Epoch-boundary prunes (free or band-bounded; not gated by the breaker)
  if afterNativeCompaction(session) or idleExceededTtl(session) or routeChanged(session):
       prune(target = P − (T + H), band = H); return

  # 3. Pressure pruning is conditional
  if s.disabled: return
  if P < 0.5 * Tn: return                     # below the band, never prune
  if not cadenceDue(P, s): return             # geometric: P >= 2 * s.lastPrune.prefixAfter
  plan = planBand(P, target = P − (T + H))
  if plan.freed < minFree: s.deferred = true; return
  if plan.freed < 0.25 * P and s.qEma < 0.7:  # small win on a mixed transcript
       s.deferred = true; return

  k = breakEven(w, r, D=plan.rewrittenSuffix, S=plan.freed)      # §3.3
  H_remaining = expectedRemainingTurns(session)                  # see 6.4
  if H_remaining < k * safety: s.deferred = true; return          # safety = 1.5

  apply(plan); s.lastPrune = {...}; s.deferred = false
```

### 6.4 `expectedRemainingTurns` — the honest estimator

We cannot know the future. Three cheap estimators, all in memory, combined by taking the **minimum**:

1. **Turn-supply.** Estimate the owner's cadence from the median gap between user messages, `G`. Remaining turns ≈ `max(0, G − turnsSinceLastUserMessage) + G`, i.e. "time until the next message, plus one more interval". This is a heuristic, not a prediction; it is deliberately biased low so the controller errs toward not pruning.
2. **Native-distance.** `H = (Tn − P) / avgTokensPerTurn`. This is the number of turns before the next mandatory epoch. It is the most conservative bound, and it is why pruning near the threshold is often pointless: the native summary will rewrite anyway in a handful of turns.
3. **Session-age prior.** A session younger than 20 turns gets `H = 20`; older sessions decay. New sessions are exactly where pruning pays.

`H_remaining` is the **minimum** of the applicable estimators. If the minimum is below `k × 1.5`, skip. The safety factor exists because every estimator here is a guess; 1.5 is the smallest margin that keeps a wrong guess from being a net loss in the model.

### 6.5 Post-prune judgment and auto-disable

A single next turn is a noisy judge: retries, a tool-set change, or a provider hiccup can move it. Judge over a **short window** instead.

```
after a prune, collect the next up-to-5 completed turns
  realizedCostPerTurn = mean( cacheRead + cacheWrite + uncachedInput )   # full-price-normalized
  baselineCostPerTurn = pre-prune EMA over the same number of turns
  realizedSaving      = baselineCostPerTurn - realizedCostPerTurn
  predictedSaving     = r * freed * expectedTurnsInWindow
  if realizedSaving < 0.5 * predictedSaving: missStreak += 1 else missStreak = 0
  if missStreak >= 3:
      disabled = true
      appendPluginRecord('plugin:multitask/cache-budget', {status:'disabled', reason:'under-delivered'})
      # one ledger line to the user; no retries this session
```

Why a window and not one turn: the saving is `r·S` **per turn**, and the write is paid once; a one-turn sample mostly measures the write. Why 5: long enough for the read discount to dominate, short enough that the session has not changed shape. Why 3 misses: three consecutive windows in which the realized saving is under half the prediction is a modelling error, not noise. Why session-scoped: process restart is the natural reset, and persistence would violate U-H.

The breaker is **soft for epoch prunes**: if the disabled flag is set, piggyback and idle prunes still run (their invalidation is free, so they cannot be the cause of a cache loss). Only self-scheduled pressure prunes stop. This is a deliberate distinction: turning off free prunes because paid prunes failed would be an overreaction.

---

## 7. Interaction with native compaction

### 7.1 Threshold, unchanged

Native fires at `Tn = floor(min(0.8·W, W − O − 65,536))` = **678,464** on this host, with a 119,040-token verbatim tail (`dsh-compaction-basic/lib/index.js:124-134`). This design does not tune it. It uses the same formula so the two layers cannot invert.

### 7.2 Piggyback: yes, and it is the cheapest aggressive prune available

Every native compaction is a cache epoch. The summarizer's prefix call may hit the cache, but its **surface replacement rewrites the span** — the suffix after the replacement is a miss regardless.

There are two distinct timings, and they are **not equal**:

1. **Same-step (free).** Run our prune in the same `agent/pre-step` that native is about to compact in, immediately before native's listener, so the surface it summarizes is already smaller. Invalidation is shared with native's own rewrite: marginal cost 0. This requires our listener to be registered ahead of native's in the same waterfall (the microcompact design already requires this ordering, `compaction-stack-design-2026-10-19.md` §4).
2. **Next-turn (bounded, not free).** If the ordering cannot be guaranteed, prune at the first pre-step after `compaction/end`. By then the post-compaction request has already re-warmed the cache, so our band edit pays a **bounded band invalidation** (`D ≈ S + T`), not zero.

Measured in the model for the next-turn variant (1M growth, 6k/turn, `w=1.25, r=0.1`):

| `q` | Native only | Piggyback (next turn) | Delta | rewrites |
|---|---|---|---|---|
| 0.30 | 7.00 | 6.95 | **−0.7%** | 2 |
| 0.50 | 7.00 | 6.78 | **−3.2%** | 2 |
| 0.70 | 7.00 | 6.63 | **−5.3%** | 2 |
| 0.85 | 7.00 | 6.51 | **−7.0%** | 2 |

The next-turn variant is **never a loss**, and it gets better as `q` rises — the opposite of the self-scheduled arms, because it never pays a full-prefix rewrite. The same-step variant should be strictly better, but this document does not model it; it depends on the listener ordering being achievable, which is an open question.

Larger horizons behave the same way: 5M growth, 6k/turn, next-turn piggyback is −3.2% warm and −3.5% with idle gaps (`39.12` vs `40.44`, and `47.92` vs `49.68`).

**Recommendation:** attempt same-step (free); fall back to next-turn (bounded, measured non-negative). In both cases the target is aggressive — clear to `P − T` within a doubled band — because the marginal invalidation is zero or band-bounded, never full-prefix.

Two implementation notes:

1. React to `compaction/end` **without `error`**, not to `compaction/summary`. A failed summary releases the lock but did not rewrite the span the same way; do not act on it.
2. Do not run the prune in the same synchronous block as native's replacement. Native holds the lock until `compaction/end`. If same-step is not achievable, use the next pre-step with a one-shot flag — race-free by construction.

### 7.3 Don't fight the backstop

Native will summarize at `Tn` no matter what we do. A self-scheduled prune at `0.95·Tn` can therefore pay a rewrite and then be rewritten again a few turns later by the summary. **Rule: never self-schedule a prune when `(Tn − P) / avgTokensPerTurn < k × 1.5`.** Wait for the native epoch instead, then piggyback. This is estimator 2 in §6.4 and it is the strongest single guard against cache waste.

---

## 8. Warm-up cost accounting

The owner asked specifically: for a 300k prefix at 1.25× write and 0.1× read, what is the one-time cost versus the per-turn saving?

**Head edit, `P = 300k`, `S = 50k`, `w = 1.25`, `r = 0.1`:**

```
one-time cost Δ_first = (w − r)·D − r·S,  D = P − S = 250k
                     = 1.15 × 250k − 0.1 × 50k
                     = 287,500 − 5,000
                     = 282,500 full-price token units
per-turn saving      = r·S = 5,000 full-price token units
break-even           = 282,500 / 5,000 = 56.5 turns
```

**Band edit, same `P` and `S`, `D = S + T = 82k`:**

```
one-time cost = 1.15 × 82k − 5k = 94,300 − 5,000 = 89,300
break-even    = 89,300 / 5,000 = 17.9 turns
```

**Warm-up table (`w=1.25, r=0.1`; costs in thousands of full-price tokens)**

| Mode | P | S | D | One-time | Save/turn | k (turns) |
|---|---|---|---|---|---|---|
| head | 100k | 25k | 75k | 83.8 | 2.5 | **33.5** |
| head | 100k | 50k | 50k | 52.5 | 5.0 | **10.5** |
| head | 300k | 25k | 275k | 313.8 | 2.5 | **125.5** |
| head | 300k | 50k | 250k | 282.5 | 5.0 | **56.5** |
| head | 300k | 100k | 200k | 220.0 | 10.0 | **22.0** |
| head | 300k | 150k | 150k | 157.5 | 15.0 | **10.5** |
| head | 500k | 50k | 450k | 512.5 | 5.0 | **102.5** |
| head | 678k | 50k | 628k | 717.7 | 5.0 | **143.5** |
| head | 1,000k | 50k | 950k | 1,087.5 | 5.0 | **217.5** |
| band | 300k | 25k | 57k | 63.0 | 2.5 | **25.2** |
| band | 300k | 50k | 82k | 89.3 | 5.0 | **17.9** |
| band | 300k | 100k | 132k | 141.8 | 10.0 | **14.2** |
| band | 300k | 150k | 182k | 194.3 | 15.0 | **13.0** |

Three readings:

1. **Small denominations are expensive.** Freeing 25k from a 678k prefix costs 144 turns of payback at the head, 25 turns in a band. Never prune "a little".
2. **Warm-up is bounded by `(w−r)/r − 1 = 10.5` turns in the band limit.** As `S → ∞`, `k_band → (w−r)/r − 1`. That is the floor, and it is the number to remember: **a band prune needs roughly 11-18 future turns to pay for itself.** A cadence that fires more often than every ~11 turns cannot repay each rewrite, which is exactly why fixed 50k on a large prefix loses.
3. **At `w=1.0, r=0.5` the same 300k/50k head prune breaks even in ~4 turns** (Table A implies 5 turns at `S/P = 16.7%`; the exact formula gives 4.0). Provider economics change the aggressiveness dramatically — hence §9 and the parameterized controller.

---

## 9. Provider differences (conditional answers)

The provider-mechanics research is not available. These are the conditional conclusions; the controller consumes whichever regime applies without code changes, because it measures `cacheRead`/`cacheWrite` rather than assuming prices.

### 9.1 Block granularity

If a provider caches in fixed blocks (e.g. 128 tokens), a cut inside a block invalidates that whole block. Aligning the earliest cleared node to a block boundary saves **at most one block** of invalidation (128 tokens) per prune. Against a `D` of 60k-200k that is noise. **Verdict: not worth the complexity.** Align only if the API exposes block size and alignment is free. Do not build a block-aligner speculatively.

The one thing block granularity *does* change: if the provider rounds cache writes **up** to a block, then very small prunes can cost a full block of write for a few tokens of saving. This is an argument for the **minimum-freed floor** (proposal: 8,000 tokens), which already exists in the microcompact design.

### 9.2 Short TTL

If the provider TTL is short, then **any idle gap longer than the TTL is a free epoch**, and idle-time pruning becomes the dominant strategy: prune at the first pre-step after idle, aggressively, because the write is happening anyway. TTLs differ by provider and are **not verified in this repo** — vendor documentation is the only source, and it changes. **The controller must learn the TTL empirically** rather than assume: it already records `cacheRead` per turn. A turn whose `cacheRead` collapses to ~0 after a gap is an observed expiry. Track `observedTtl = max(gap with cacheRead≈P)` and use it as the idle threshold. Until one is observed, use 60 minutes (the harness consensus in `compaction-stack-design-2026-10-19.md` §4).

### 9.3 Write premium

| Regime | `w` | `r` | Consequence |
|---|---|---|---|
| Explicit cache with write premium (Anthropic-style) | 1.25 | 0.1 | Band break-even 12-18 turns; conservative |
| Automatic cache, no write premium (DeepSeek/OpenAI-style) | 1.0 | 0.1 | Slightly better; same rules |
| Automatic cache with 50% discount (OpenAI-style) | 1.0 | 0.5 | Break-even 4-5× shorter; pruning is clearly worth it; consider ×1.5 geometric |
| No caching at all | 1.0 | 1.0 | **Pruning is always free.** The cache-destructive concern vanishes. |

The last row matters: the controller should detect `cacheRead ≈ 0` across several turns and, in that case, **disable the economics veto** — pruning cannot hurt a cache that does not exist. Conversely, `cacheRead ≈ P` on every turn with `cacheWrite ≈ 0` means the cache is perfect; then the veto must be strictest, because a rewrite destroys a perfectly working cache.

### 9.4 What is actually verified on this host

The DeepSeek adapter maps Anthropic-shaped cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`). That proves the **reporting** shape, not the **pricing** or **TTL**. Do not quote a price multiplier as fact until the provider research lands.

---

## 10. The concrete rule set

### 10.1 When to prune

1. **At a successful native compaction epoch.** Preferred: same `agent/pre-step`, registered ahead of native's listener, so the surface native summarizes is already smaller and the invalidation is shared (marginal cost 0). Fallback: the next pre-step after `compaction/end` with no `error`, which pays only a bounded band invalidation (measured −0.7% to −7.0%, never a loss). Target: clear to `P − T` inside a doubled band. **Not gated by the breaker** — its cost is zero or band-bounded.
2. **At the first pre-step after an observed cache expiry** (idle gap ≥ learned TTL). Aggressive target, same reasoning. **Not gated by the breaker.**
3. **After a route or tool-set change** (`request/context` or `request/header` change) — the epoch just moved. This is available from the log and costs one event read. **Not gated by the breaker.**
4. **Self-scheduled, only when all of these hold:**
   - `P ≥ 0.5·Tn`;
   - `P ≥ 2 × prefixAfterLastPrune` (geometric ×2);
   - the band can free ≥ 8,000 tokens and ≥ 25% of `P` when `qEma < 0.7`;
   - `H_remaining ≥ 1.5 × k_band`;
   - cache data is present and the breaker is closed.

### 10.2 How much to prune

- **Never more than the band can supply.** Target = `P − (T + H)`; if the band cannot supply it, double `H` and retry; if `H` would exceed `P − T`, stop.
- **Never free less than 8,000 tokens.** No crumb prunes.
- **Never cross a tool pair.** Validate with `toolPairingBalancedBefore/After` (`dsh-compaction/lib/index.js:80,91,175`).
- **Never touch** the system message, any `user/message`, any `assistant/message`, images, or our own log-only records. Tool results only.

### 10.3 When never to prune

| Condition | Reason |
|---|---|
| `cacheRead` / `cacheWrite` absent from usage | Cannot judge; fail closed |
| `P < 0.5·Tn` | Saving is small relative to the prefix; break-even longer than the session |
| `(Tn − P)/avgTokensPerTurn < 1.5·k` | Native will rewrite anyway; wait and piggyback |
| `qEma < 0.5` and the win is under 25% of `P` | Mixed transcript; pruning loses (Table in §3.6) |
| Breaker open | Auto-disable (§6.5) |
| Native `compaction/start` unmatched | Native owns the surface right now |
| Fewer than `k` expected future turns | Break-even unreachable |
| The band has no eligible tool results | Writing nothing is the correct action |

### 10.4 Auto-disable

- **Trigger:** 3 consecutive prunes whose realized `cacheRead` improvement is under 50% of the prediction.
- **Scope:** session, in memory.
- **Effect:** stop self-scheduled prunes; keep piggyback and idle prunes.
- **Reset:** process restart only. Do not persist.
- **User visibility:** one ledger line (§11).

---

## 11. Failure handling and observability

### 11.1 Per-prune record

Written with `appendPluginRecord(session, 'plugin:multitask/cache-budget', data)` — ignorable, never enters the surface, survives fork/resume:

```ts
interface CachePruneRecord {
  v: 1;
  passId: string;
  trigger: 'piggyback' | 'idle' | 'route-change' | 'geometric' | 'manual';
  at: number;
  before: {
    prefixTokens: number;        // P
    totalTokens: number;         // measure().totalTokens
    cacheRead: number;           // last completed turn
    cacheWrite: number;
    uncachedInput: number;
    hitRateEma: number;
    writeEma: number;
  };
  plan: {
    clearedSeqs: number[];
    freedTokens: number;         // S
    earliestClearedPos: number;  // N
    rewrittenSuffix: number;     // D
    bandWidth: number;
    target: number;
  };
  economics: {
    kProjected: number;
    remainingTurnsEstimate: number;
    qEma: number;
    verdict: 'apply' | 'skip-breakeven' | 'skip-short-horizon' | 'skip-no-content';
  };
  after?: {
    prefixTokens: number;        // P'
    cacheRead: number;           // next completed turn
    cacheWrite: number;
    predictedReadDrop: number;
    realizedReadDrop: number;
    judged: 'hit' | 'miss';
  };
  error?: string;
}
```

### 11.2 What is logged per prune

Before/after prefix tokens, freed tokens, earliest cleared position, rewritten suffix length, `cacheRead`/`cacheWrite` before and after, the projected break-even, the realized drop, and the verdict. That is enough to replay the decision from the log plus the code, and it is a plain number record — not a content index, not a token ledger.

### 11.3 What the user sees

- **Routine prunes: nothing.** Silence is the correct UI for housekeeping.
- **Auto-disable: one line** in the next wake turn's ledger: `cache guard: pruning paused this session (savings below projection)`. No alert, no modal.
- **A skipped prune caused by a broken invariant** (e.g. no cache data): nothing user-facing; one diagnostic in the plugin log.
- **Never claim a saving to the user** unless `realizedReadDrop` confirmed it. The record is the truth; the UI repeats only confirmed facts.

### 11.4 Failure table

| Failure | Detection | Response |
|---|---|---|
| Prune lands, post-window cache cost higher than projected | `after.judged = miss` (5-turn window, §6.5) | Count toward breaker; keep the surface change (it is consistent and priced) |
| Prune cannot free the minimum | planner returns `freed < minFree` | Write nothing; record `skip-no-content` |
| Interrupted between `compaction/prune` and replacement | On resume: a `compaction/prune` not immediately followed by its replacement | Re-append the identical replacement, or append an `aborted` record; never guess from transcript shape |
| Native compaction starts mid-pass | `compaction/start` seen | Our writes are synchronous and small; native's lock check rejects overlap. Do not retry. |
| Cache fields missing on this provider | usage lacks both fields | Fail closed; never prune |
| Usage projection unavailable | `stateOf` returns undefined | Fall back to `session/event` ring; if neither, fail closed |
| Estimated `q` is wrong | repeated misses | Breaker opens; `qEma` resets on restart |

---

## 12. Open questions

These must not be guessed in implementation.

1. **Does an in-memory rolling window violate ADR-0018 U-H?** U-H forbids "per-stream usage/token accounting". This design keeps a 20-sample in-memory ring and diffs the **host's** projection; it persists nothing and builds no ledger. That reading is stated here as an interpretation and should be confirmed in the ticket before code. If it is not acceptable, the controller degrades to reading `usage` from the immediately preceding `assistant/message` only (no ring), which loses the EWMA but keeps the fail-closed rule.
2. **Are `cacheReadTokens`/`cacheWriteTokens` populated on this DeepSeek route?** The type permits `undefined`; the adapter maps the fields, but a route that reports only `prompt_tokens` would leave them absent. Needs one live turn. The design fails closed, so the worst case is "no pruning on this provider".
3. **What is the real provider TTL?** The controller learns it from `cacheRead` collapse after gaps, but the initial `idleThreshold` needs a value. Start at 60 minutes (the harness consensus in `compaction-stack-design-2026-10-19.md` §4) and let it adapt downward.
4. **What is the real `w`/`r` on this route?** Not recorded anywhere in this repo. The tables are parameterized. Do not quote 1.25/0.1 as fact.
5. **What is `q` for a dispatcher session?** The single most important unmeasured number in the model (§3.7). One week of measured `freedTokens / deltaTokens` answers it. Until then, `qEma` starts at 0.5 (the neutral point) and the controller requires a ≥25% win.
6. **Is `measure().totalTokens` the same quantity the cache prefix sees?** It is the same quantity native compares against (`dsh-compaction-basic/lib/index.js:940-941`), which is what matters for trigger ordering. Whether it matches the provider's tokenization exactly is unverified; a 5-10% skew changes `k` by a similar amount, well inside the ±40% model uncertainty.
7. **Does the provider cache include the tool schemas and system prompt as one prefix, or separate segments?** If separate, a system-prompt change invalidates only that segment. This does not change the rules, only the magnitude of a route-change epoch.
8. **What exactly is one "tool-result group"** for the protected tail? Same open question as the microcompact design; the selector needs a precise definition before implementation.
9. **Can two plugins act on `compaction/end` without racing?** Our piggyback and any future native listener both react to the same event. The design uses a one-shot flag consumed at the next pre-step, which is race-free by construction, but needs a live check.
10. **Should the controller ever prune assistant messages?** Not in v1. It would raise `q` and improve the economics, but it is lossy in a way tool-result clearing is not, and it needs its own ruling.

---

## 13. Decision table: what to build

| Option | What it is | Cost | Verdict |
|---|---|---|---|
| **A. Do nothing** | Native compaction only. No pruning. | Zero; cache never damaged | **Defensible.** It is what happens today, and the model says it is near-optimal at `q ≤ 0.5`. |
| **B. Piggyback + idle only** | Prune only at already-invalid boundaries. No self-scheduled pruning. | ~150 lines, no controller | **Recommended first step.** −0.7% to −7.0% in the model, never a loss. The worst case is a bounded band invalidation, never a full-prefix rewrite. |
| **C. B + geometric controller** | Adds the adaptive controller and band-limited geometric pruning. | ~400 production + 300 test lines | **Recommended target** once B has a week of measured data. −3% to −13% depending on `q`. |
| **D. Fixed 50k** | The owner's original proposal. | ~200 lines | **Not recommended.** 20 rewrites per 1M; loses money below `q ≈ 0.7`. |
| **E. Size-triggered-only** | Prune near 0.8·Tn. | ~120 lines | **Reject.** Worst arm in every scenario; degenerates into crumb prunes. |

**Recommendation:** ship **B** now, instrument it, and gate **C** on measured `q` and measured `cacheRead`/`cacheWrite`. Do not ship D or E. If B and C both prove out, the only cadence knob left to tune is the geometric factor (1.5 / 2 / 3), and the controller makes that choice per session rather than in config.

---

## 14. Evidence index

| Claim | Source |
|---|---|
| Usage buckets are disjoint and carry cache fields | `dsh-llm/lib/types/types.d.ts:153-173` |
| Adapter maps `cache_read_input_tokens` / `cache_creation_input_tokens` | `dsh-llm-deepseek/lib/index.js:1826-1827` |
| Host `tokenUsage` projection shape (cumulative + last buckets) | `dsh-token-meter/lib/types/usage-projection.d.ts` |
| Shadow-price adjacency requirement for `compaction/prune` | `dsh-compaction/lib/types/types.d.ts:76-105` |
| Compaction events and the summary's own usage | `dsh-compaction/lib/types/types.d.ts:15-76` |
| Native threshold formula and tail | `dsh-compaction-basic/lib/index.js:124-134`; `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §3 |
| Native summarizer reuses the prefix, replacement rewrites the span | `dsh-compaction-basic/lib/index.js:292-338, 650-661` |
| `agent/pre-step` waterfall payload | `dsh-agent/lib/types/runtime-types.d.ts:92-100` |
| Measurement API | `dsh-token-meter/lib/types/types.d.ts:24-55` |
| Cache warning and L0 discipline | `docs/research/compaction-stack-design-2026-10-19.md` §1, §7 |
| Independent conclusion that the janitor is not a general cost win | `docs/research/segmented-compaction-design-2026-10-19.md` §12.3 |
| Provider mechanics | **absent** — `.scratch/repo-analysis/2026-10-19-provider-cache-mechanics.md` did not exist at write time |
| Cost figures | Discrete simulation run for this document (166-2,500 turns, 2k-6k tokens/turn); ±40% on magnitudes |

**Repo paths this proposal would touch if accepted** (none edited here): `src/adapter/compaction.ts` (listener + piggyback), `src/core/compaction-select.ts` (band planner, shared with the microcompact design), and a new in-memory controller module. `docs/adr/` untouched.
