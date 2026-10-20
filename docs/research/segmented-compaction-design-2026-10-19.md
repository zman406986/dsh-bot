# Segmented retention: a density cleanup layer for dsh context

- **Date:** 2026-10-19
- **Status: DESIGN PROPOSAL, EVIDENCE LEVEL. NOT A RULING.** Nothing here is adopted. Every mechanism below needs its own ticket. Anything that changes a recorded decision needs an explicit ADR amendment (ADR-0029 in particular, and ADR-0018 U-H for retrieval).
- **This document does not replace compaction.** Native `compaction-basic` stays mounted and stays the backstop. The host still summarizes when the surface crosses its threshold. This layer makes the body it summarizes denser, and makes the threshold harder to reach.
- **Organizing constraint (owner, 2026-10-19):** *"We can't solve it by just forcing a summary-style compaction every 50k, because each time a normal summary would lose information, and the items that are summaries of summaries of summaries keep losing info."* Frequency alone is not the answer. The structural answer is **write-once records**: each record is written once from raw log content, never rewritten, never fed back into a summarizer, and evicted by pointer rather than by re-summary. This is the first property of the design, not a refinement.
- **The layer is a cleanup layer, not a compaction engine (owner, 2026-10-19):** *"The point is not to entirely replace existing compaction technology. It's basically extending the useful context window — keep throwing junk out, so when our context reaches 500K, it is mostly useful information instead of normally being mostly junk."*
- **Flagship rule:** failed search then hit. The owner's example: *"Agent is searching for something. They read five files, and none of it has what they need, and in the sixth file they found it — keep sixth and drop previous waste reads (at most keep a summary saying 'xxx not in these five, these five are respectively what')."* This is rule #1 of the junk classifier and the first thing to implement.
- **Objective (owner, 2026-10-19):** extend the useful working set of long sessions — measured in retained useful tokens and task continuity — at an acceptable dollar cost. Rewrite count and cache-invalidation count are cost lines, not design targets. The full statement is the Objective paragraph below.
- **The proposal's density predictor has now been measured once, and the population is split.** `q` = the share of context that is evictable tool output. A read-only census of the 20 session logs on this machine found a **median `q` of 0.02**, with only 3 sessions above 0.2 and one at 0.467 (§15.5). Those sessions are short and conversation-heavy; the long tool-heavy worker transcripts this design targets are **not in the sample**. `q` is therefore a **predictor of density gain per session class**, not a global ship gate. It must be measured again on worker transcripts before any threshold is fixed.
- **No evidence currently justifies an LLM selector.** Option A (deterministic access tracking + cross-reference matching) implements the flagship rule with zero model calls. Option C is an escalation, not a peer of A (§17).
- **Not verified by execution.** Code reading plus one read-only log census. No live janitor pass has been run. Every number marked *(modelled)* is an estimate from the formulas in §12, not a measurement.
- **Prior art exists for every mechanism.** Span-level verbatim retention ships in Gemini CLI; evict-by-pointer/restore at record granularity ships in Context Surgeon, Letta MemFS/recall storage, Zep, LCM, and TierMem; failure memory ships in SearchOS and trimwire. Only the post-hoc answer-relevance judgment is new (§7.7). We are adopting known patterns, not coining one.
- **Parallel-input status:** `.scratch/repo-analysis/2026-10-19-empirical-junk-census.md` did **not** exist when this was written, so §15.5 gives the protocol and the first local census instead.

**Objective.** The goal is to extend the useful working set of long sessions — measured in retained useful tokens and task continuity — at an acceptable dollar cost. Rewrite count and cache-invalidation count are cost lines, not design targets. The correct baseline is not native compaction at the same token count, and not a dollar comparison at equal token count: it is what the user does today — **N fresh sessions plus re-orientation cost** (restart the chat, lose the thread, re-read the files, re-explain the task). A pruned 1M-token context is not the same artifact as an ordinary 1M-token context; it holds roughly **5x the useful content** of one. Cost is reported honestly; it does not decide the design.

---

## 0. Evidence base, and what was missing

Read in full:

| Input | State |
|---|---|
| `docs/research/compaction-stack-design-2026-10-19.md` | present; §2 host facts used as given, not re-derived |
| `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` | present |
| `src/core/report-clamp.ts`, `src/adapter/parent-agent.ts`, `src/worker/preset.ts` | present |
| `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-H) | present |
| `docs/adr/0029-deterministic-microcompact-boundary-marker.md` | present |

**Missing when this was written** (a parallel agent was still producing them; nothing below depends on them):

- `.scratch/repo-analysis/2026-10-19-dsh-pruning-surface.md` — absent.
- `.scratch/repo-analysis/2026-10-19-nonllm-pruning-rules.md` — absent.
- `.scratch/repo-analysis/2026-10-19-incremental-compaction-research.md` — absent.

Additional host facts checked directly for this design (installed tree `dsh@0.2.1-rc.2`):

- `dsh-session` exposes a **non-deprecated exact read path**: `ctx.sessionQuery.readEvent({sessionId, seq, before, after})` and `listEvents(sessionId)` (`dsh-session-query/lib/types/index.d.ts`). `session.eventAt` and `session.snapshotEvents` are explicitly deprecated for new callers. Retrieval should use the query service, not the deprecated methods.
- The query service is mounted in this deployment with `openAt: never` (`dsh-base/cordis.patch.yml:150-161`, restated in `dsh-web-app/cordis.patch.yml:20-30`). Exact reads, titles, and traces work; **full-text search is disabled** and returns `SESSION_QUERY_SEARCH_DISABLED`.
- `dsh-tool-session-query` registers `session_event_read` and `session_event_trace`, but they are **not mounted** in the base or web bundle rows checked. Do not assume they exist in the dispatcher preset.
- Read-family tool names are `read` (`dsh-tool-fs/lib/index.js:251`), `write` (`:549`), `edit` (`:690`), `glob` and `grep` (`dsh-tool-fs-search/lib/index.js:782,1090`).
- `agent/pre-step` is a waterfall; `agent/turn-stopping` is serial. `agent.runMaintenance(task)` exists for idle work.
- `appendPluginRecord` is synchronous and returns a `SessionSeq`; the record type must match `plugin:<segments>` grammar and be declared via `PluginRecordMap` augmentation.

---

## 1. What this layer is, and what it is not

### Is

A **cleanup layer** that runs at step boundaries, keeps the useful parts of old context verbatim, and drops the rest to the durable log behind a pointer. It never calls a model in options A and B. It never writes prose about content it did not quote.

### Is not

- Not a replacement for `compaction-basic`. The host summary still fires if the surface reaches `T_native`.
- Not a frequency-tuned summarizer. A record is not a short summary of the span. It is a **structured set of verbatim excerpts plus pointers**.
- Not lossless in the absolute. Exactly one lossy step exists: choosing which spans to keep at seal time. Nothing is allowed to lose information twice (§2).
- Not a new database and not a search index (ADR-0006, ADR-0018 U-H).

### Success metric

> At a given context size, how much of it is information the agent still needs — and how many more turns does the session stay effective before a summary is forced?

Not "did we avoid a summary," and not "did we save dollars per token." The wins, in the order they matter:

1. **Task continuity.** The session keeps working past the point where the user would otherwise restart in a fresh chat, losing the thread, the decisions, and the file knowledge. This is the baseline to beat, and it is not measured in tokens (§12.4).
2. **Density.** At 500k of context, the share that is content the agent still uses, rather than dumps it never reread. `q` predicts this (§12.1).
3. **Delayed forced summarization.** Native fires later because the same raw session occupies fewer tokens.
4. **A denser summary when native does fire.** The same ~65k output budget carries more real information.
5. **Cost: acceptable, not optimal.** The measured delta at `q = 0.5` is −8% to −1%; at `q = 0.7`, −37%; at `q = 0.3`, +14% *(modelled)*. State the number honestly and do not design around it. Rewrite count is an implementation detail (§12.3).

---

## 2. The organizing constraint: write-once records

### 2.1 Three rules

1. **Written once, from raw.** A record's bytes are a pure function of (the raw events in its span, the config). No record is built from another record. No record is edited after append. No record is ever an input to a summarizer that produces another record.
2. **Composition is not paraphrasing.** When the in-context set must shrink, prior records are carried forward as **data**: separate messages, pointers, id lists. Never folded, merged, or rewritten.
3. **Eviction is pointer substitution.** A record leaves the window only by being replaced with a stub that carries its own id and title. The full bytes stay in the log and come back byte-identical **if the retrieval path is ever used** — which, per §2.2, is the exception rather than the retention mechanism.

### 2.2 The only permitted loss, and the proof that it happens once

**Rule.** For raw segment `i`, the only transformation is `select_i : rawEvents(span_i) → excerpt set`. `render_i` is a deterministic byte-for-byte formatter over that set. Everything after is identity or pointer substitution.

**Composition, stated exactly.** Let `R_i` be the immutable record bytes for segment `i`. Define the in-context population at time `t`:

```
I(t)  =  rawTail                       (never sealed, fully verbatim)
      ∪  { render(R_i) : i ∈ live(t) } (each one a separate surface message)
      ∪  { stub(R_i)   : i ∈ evicted(t) }
```

Every shrink operation is one of these three, and nothing else:

| Operation | Before | After | Content changed? |
|---|---|---|---|
| Evict | `render(R_i)` | `stub(R_i) = (id, title)` | No — both are fields of `R_i` |
| Coarsen stubs | `stub(R_i) … stub(R_j)` | `rangePointer(k, i..j)` | No — a range of ids |
| Correct | `render(R_i)` | `render(R_i)` + new `render(R_k)`, `R_k.supersedes=[i]` | No — `R_i` untouched |

**Retrieval is identity — but retrieval is a backstop, not the retention mechanism.** `segment_read(id)` returns `R_i` with a SHA-256 check against the hash stored at seal; a mismatch returns an error and no content.

That makes eviction *lossless on paper*. It is **not lossless in practice**, and the doc must not claim otherwise: an empirical study of 176 matched harness settings found that making elided content recoverable "yields no accuracy gain" because agents seldom invoke the retrieval machinery (arXiv:2609.20804, in `.scratch/repo-analysis/2026-10-19-failed-search-eviction-prior-art.md` §5.4). Treat the pointer as an audit trail and a rare escape hatch. **The in-context record must carry the value on its own**, which is why the record keeps verbatim excerpts and an explicit "not in these files" fact rather than a bare id.

**Therefore:** the pipeline is `raw → (select once) → immutable bytes → (identity | pointer) → window`. There is no second transformation. The sole information loss is `select_i`, applied exactly once per raw segment, and the discarded bytes remain in the log in full.

**Terminology.** Use the established names: *observation masking*, *context editing* / *tool result clearing*, *context pruning*, and *context offloading* for the removal; *failure memory* / *anti-recurrence store* for the negative record; *retrieval cue* for the pointer; *tiered memory* / *lossless context management* for the tier model. "Failed-search eviction" is **our label for this specific rule**, not an established term; do not present it as one.

**Hard invariant that enforces "no record of a record".** A monotonic seal cursor walks forward:

```
sealCursor = first surface position not yet sealed
every new span starts at sealCursor, so every node in a new span is a raw node
assert for every node in span: node is not our record message,
                               node is not a native checkpoint,
                               node is not already shadowed
```

Because records only replace positions **below** the cursor, a new span can never contain a prior record. If native compaction lands, the cursor is reset to the position after the checkpoint (§11).

**The cursor is derived, not stored.** On resume, `sealCursor` = the greater of (a) the position immediately after the newest landed segment's `span.end`, (b) the position after the newest native checkpoint, (c) the position immediately after the newest sealed-but-unlanded record's span end. All three are readable from the log. A crash costs at most one re-seal of the unlanded span, which is idempotent by `(span, recordSha256)` (§14). No mutable cursor state exists outside the log.

**Stub coarsening obeys the same rule.** A range pointer is written as a replacement of the stubs themselves, all of which sit below the cursor. It never touches a live record or a raw node.

### 2.3 Corrections: new records that cite old ids

A later segment sometimes learns that an earlier record is stale (a file changed, a fact was superseded, a decision was reversed). The rule:

- **Never edit `R_i`.** Append `R_k` with `supersedes: [i, ...]` (max 4 ids) and `kind: 'correction'`.
- `R_k` quotes the new evidence verbatim (the diff, the new value, the new instruction). It does not paraphrase `R_i`.
- `segment_read(i)` returns `R_i` plus `superseded_by: [k]`, newest first. A reader can never see the stale record without seeing that it is stale.
- Automatic detection is limited to two deterministic triggers: (a) an explicit `supersedes` argument on the `retain` tool (option B); (b) a `write`/`edit` whose path appears as an excerpt source in an earlier record. Semantic contradiction between two prose decisions is **not** detected automatically — that is out of scope and must not be guessed.
- If the old record was already evicted, its stub is replaced with `stub'(R_i, supersededBy=k)`. That is a pointer addition, not a content change.

### 2.4 The residual loss we cannot prevent — flag this loudly

Native compaction summarizes the **surface**, and our records live on the surface. When `T_native` is crossed, the host may summarize a range that includes our records. That is, structurally, a summary of records. We cannot exempt nodes from native's range selection; no such knob was found in the installed tree.

So:

- Our guarantee holds for **our layer only**: we never re-summarize a record.
- The host may still do it. That is a known, residual loss, owned by the host policy and mitigated only by keeping the surface below `T_native` most of the time.
- **Mitigation (cheap, allowed):** on `compaction/end` without error, append one tail user message listing live segment ids and titles:

```
[janitor] Retained segment index after host compaction:
  seg-1a2b3c4d "auth middleware refactor" (superseded by seg-9f8e7d6c)
  ...
  Retrieve any of these with segment_read(id).
```

That is a pointer index — ids and titles only, no content, no summary. It costs ~30 tokens per live record, once per native compaction. It restores the retrieval affordance that the host summary may have dropped.

If this residual loss is unacceptable, the only fix is owning the summarizer (Option D in `compaction-stack-design-2026-10-19.md` §10), which is out of scope here.

---

## 3. Tier model

Ordered by value density, not by age.

| Tier | Lives in | Verbatim? | Pointer? | What a reader loses |
|---|---|---|---|---|
| **T0 raw tail** (newest ≤ 50k tokens) | surface | Yes, 100% | — | Nothing |
| **T1 live records** (≤ `recordBudgetTokens`) | surface | Excerpts verbatim; metadata exact | Ids, spans, source seqs | Everything not selected at seal. This is the **only** loss. |
| **T2 evicted records** | log | Full record bytes, retrievable | In surface: `id + title` stub (≤ 160 chars) | Direct visibility. One tool call restores it exactly, but agents rarely make that call (arXiv:2609.20804), so T2 is an audit trail and a rare escape hatch, not the retention mechanism. |
| **T3 raw events** | log | Full original event | Surface span `[start, end]` and source seqs | Nothing. `read_span(start,end)` returns them. |
| **Host summary** (native) | surface, if it fires | No | Checkpoint preamble | Whatever the host drops. Outside our control. |

The tiers are not a hierarchy of summaries. T2 is a pointer to T1's exact bytes. T3 is a pointer to the original bytes. No tier is derived from another tier's prose.

---

## 4. Segment model

### 4.1 Definition

A **segment** is a contiguous, tool-pair-balanced range of surface nodes, sealed once, containing no prior record, no native checkpoint, and no system message.

- **Size target:** `SEGMENT_TARGET_TOKENS = 50,000` measured with `measure().nodes[].tokens`.
- **Minimum:** 20,000 tokens. Below that, fixed record overhead dominates the density gain; wait.
- **When sealed:** only at a step boundary (`agent/pre-step`), synchronously, before the model request. Also at `agent/turn-stopping` as a fallback for turns that end without another pre-step.
- **How identified:** `id = "seg-" + first 8 hex of SHA-256(firstSourceSeq, lastSourceSeq, recordSha256)`. Not a UUID (non-deterministic) and not a seq string (a fork can renumber). Deterministic, stable across fork/resume, collision-resistant enough for one session.

### 4.2 Boundary selection (exact algorithm)

```
selectSpan(session, measure, state):
  if no dispatcher/worker ownership for this session: return none
  if measure.totalTokens < JANITOR_START_TOKENS:     return none   // default 100,000
  if an unmatched native compaction/start exists:    return none   // native owns the surface
  start = state.sealCursor ?? firstSealableNode(session)
  start = skip system/message, developer/message, native checkpoints, our records
  acc = 0; end = none
  for node in measure.nodes from start forward:
      if node is the newest surface node: break        // never seal the live tail
      acc += node.tokens; end = node.seq
      if acc >= SEGMENT_TARGET_TOKENS: break
  while tailTokens(end .. newest) < TAIL_KEEP_TOKENS:   // default 32,000
      end = previousSurfaceNode(end)
  while not toolPairingBalancedAfter(session, end):     // dsh-compaction export
      end = previousSurfaceNode(end)
  if start > end or not toolPairingBalancedBefore(session, start): return none
  return {start, end, rawTokens: acc}
```

Notes that matter:

- `toolPairingBalancedBefore/After` are the only cut validators. Never invent one.
- The span is a **surface-position range**, exactly the shape `surfaceOp {op:'replace', startSeq, endSeq}` takes. After a prior replacement at an older position, `startSeq` may be numerically greater than an older replacement's — this is explicitly supported (`dsh-compaction/lib/types/types.d.ts:104-118`).
- `JANITOR_START_TOKENS = 100,000` avoids churning short sessions where fixed overhead beats any density gain.

### 4.3 One replace per segment, tail untouched

Yes: **one `surfaceOp replace` per segment**, over the contiguous span, and the newest tail is never in a span. The replacement is a single `user/message` whose content is the rendered record. This is the same surface primitive native compaction uses (`dsh-compaction-basic/lib/index.js:650-661`), so the surface fold, replay, fork, and restore all already handle it.

### 4.4 Scope: workers, not just the dispatcher

**The flagship rule only has material to work on in worker sessions.** Workers do the file reading; the dispatcher mostly reads worker reports. A dispatcher-only janitor would never see the five failed reads.

Gate:

```
owns(session) =
     lifecycle.isDispatcherSession(session.id)          // our activated dispatcher
  || host.workerIdOf(session.id) !== undefined          // a session we spawned as a worker
```

Anything else — ordinary user chats — is untouched. This is the same gate the compaction design calls for, extended to workers deliberately. Risk: the blast radius grows to every worker transcript. Mitigation: per-session kill switch, and the pass record names the session.

### 4.5 Seal versus land

Two moments, deliberately separated:

- **Seal** (every 50k): build the record from the raw span and append it as a log-only `plugin:multitask/segment` record. Record fidelity is determined here, from a fresh 50k span. **Sealing costs zero cache invalidation** — `appendPluginRecord` writes an `ignorable` log-only event that never enters the surface (`dsh-session/lib/index.js:1248-1268, 1548-1562`).
- **Land** (every `FLUSH_EVERY_SEGMENTS = 3` seals, i.e. ~150k): append the `compaction/prune` + surface replacement for all sealed-but-unlanded records **in one synchronous block inside one `agent/pre-step`**, before the model request is built.

#### What "one flush" means mechanically, and whether the batching claim survives

A provider prefix cache is keyed on the exact byte prefix of the request. A cache hit survives only up to the **earliest** changed position. That gives three cases:

| Case | Requests between replaces | Divergence points | Invalidations |
|---|---|---|---|
| Three replaces in one synchronous `pre-step`, no request between | 0 | earliest landed position | **1** |
| Each replace in its own `pre-step` | 3 | three positions | **3** |
| Replaces interleaved with a model call | ≥1 | one per interleaved request | **3+** |

**The claim survives, but only under the first row and two further conditions.** (i) All replacements land in one synchronous block with no interleaved request: mechanically, all three `surfaceOp replace` appends happen in one synchronous block; the surface fold applies them in order; when the request is assembled afterwards, the message array differs from the previous request's array first at the oldest landed span. Everything after that point is rewritten once; everything before it still hits cache. (ii) The design never rewrites below the last landed position within that block — sealing is forward-only, so the three new spans are the only changed positions and no older record is rewritten in the same flush. A rewrite of an older position (for example, an eviction of a live record) is a separate invalidation and is not covered by this count. Non-contiguity of the three spans does not matter, because replacing an older span already invalidates the entire tail that contains the two newer spans.

**Host mechanism and verification status.** A surface rewrite invalidates from the earliest changed position, and provider caching is per request, so a batched flush pays one invalidation only when the request is built after the whole block (`dsh-session` surface fold; `docs/research/compaction-stack-design-2026-10-19.md` §2). **This is argued from the host contract and has not been verified live.** Measure cache-read tokens across one batched flush before relying on the one-invalidation claim.

**What breaks it:** any `await` between the first and last replace, any model call, any turn boundary, or landing on different `pre-step` invocations. The implementation must therefore land the whole pending batch in one synchronous call and assert `measure.logRevision` is unchanged across the block.

**What this does not save:** the rewrite volume is the **whole surface after the oldest landed span**, not three small spans. My simulation already charges this (`cost += 0.9 × surface` per flush), so the numbers in §12.2 stand. Batching cuts the *count* of invalidations by ~3x and the total rewritten bytes by the same factor; it does not reduce the cost of a single one.

---

## 5. Record format

### 5.1 Surface rendering (what the model reads)

Exactly this shape, byte-stable, no timestamps that vary between renders:

```
[janitor] Context cleanup. Earlier turns in this span were compressed into the
record below. Nothing was deleted: raw content stays retrievable by seq.
== SEG seg-1a2b3c4d == span seq 4120-4188 | raw 47,900 tok -> record 1,940 tok | turn 12-14
TITLE: auth middleware refactor; token refresh bug
KIND: work            (work | search-episode | decision | correction)
SUPERSEDES: (none)
DECISIONS (verbatim quotes):
  D1 (seq 4140): "Keep the refresh token in the httpOnly cookie; do not move it to localStorage."
  D2 (seq 4161): "Batch size stays 32 until the load test passes."
OPEN THREADS:
  O1: "Need to confirm the 401 path after refresh fails twice."
EXCERPTS:
  [E1] seq 4132 path=/repo/src/auth/refresh.ts lines 40-72 why=edited quote
       ...verbatim lines...
  [E2] seq 4170 tool=grep pattern="refreshToken(" why=error evidence
       ...verbatim match block...
DROPPED: 17 tool results, 41,200 tok. All recoverable with read_span(4120,4188).
  - seq 4055 read /repo/src/auth/session.ts - not referenced (8.2k tok)
  - seq 4061 grep "refreshToken(" /repo/src - no hits (12 tok)
NEXT: "Run the auth integration test after the batch-size change."
```

Rules for the renderer:

- `DECISIONS` entries are **quotes copied from assistant messages**, never authored prose. If no verbatim sentence states the decision, the entry is omitted. We do not write a sentence the agent did not write.
- `TITLE` is deterministic: first user instruction or first decision quote in the span, truncated to 120 chars; else the first path; else `turn N steps A-B`.
- `EXCERPTS` are contiguous verbatim slices. Each carries its source seq and line range (or char range for non-file results).
- `DROPPED` is orientation only. The exhaustive recovery is the span; individual seqs need not all be listed.
- The last line always tells the reader how to get content back.

### 5.2 Caps

| Field | Cap | Rationale |
|---|---|---|
| `TITLE` | 120 chars | one line in a stub and in the native-survival index |
| record total (rendered) | **12,000 chars** hard / 2,500 tokens soft | ~5% of a 50k span |
| `EXCERPTS` count | 5 | more than 5 usually means the span had no clear focus |
| excerpt text | 1,600 chars each | ~400 tokens |
| excerpt total | 7,000 chars | leaves room for metadata |
| `DECISIONS` | 6 × 240 chars | quotes only |
| `OPEN_THREADS` | 5 × 200 chars | quotes or todo text only |
| `DROPPED` notable entries | 12 × 160 chars | + one aggregate line |
| `SUPERSEDES` | 4 ids | chains beyond 4 are followed by `segment_read` |
| `sourceSeqs` | 512 | larger spans must be split |
| stub | 160 chars (~40 tokens) | id + title + status |
| `SEGMENT_TARGET_TOKENS` | 50,000 | §4.1 |
| `TAIL_KEEP_TOKENS` | 32,000 | working set |
| `recordBudgetTokens` | default `floor(0.5 × T_native)` = 339,232 | The simulation (§12.2) shows this budget barely moves cost; it is set to bound the stub list rather than to save tokens. Plan at ~2,500 tokens per record (5% of a 50k span). |
| `JANITOR_START_TOKENS` | 100,000 | no churn on short sessions |
| `FLUSH_EVERY_SEGMENTS` | 3 | implementation detail (batching), not a design target; see §4.5 for its one-invalidation condition |

### 5.3 Data model: plugin records

All written with `appendPluginRecord`; all `ignorable`, never on the surface, survive fork/resume.

```ts
// plugin:multitask/segment      — written ONCE at seal, before the surface write
interface SegmentRecordV1 {
  v: 1;
  id: string;                        // seg-<8 hex>
  sessionId: string;
  span: { start: number; end: number };       // surface positions, inclusive
  sourceSeqs: number[];                       // every shadowed node, ascending, <=512
  seal: { at: number; turn: number; step: number;
          trigger: 'size' | 'turn-end' | 'episode-hit' | 'manual' };
  rawTokens: number;                 // sum of heuristicTokens at seal
  recordTokens: number;              // estimateMessage(record message)
  recordChars: number;
  recordSha256: string;              // hash of the exact rendered text
  renderer: 1;                       // renderer version, so re-render is deterministic
  title: string;
  kind: 'work' | 'search-episode' | 'decision' | 'correction';
  supersedes: string[];              // <=4
  excerpts: Array<{
    id: string;                      // E1..E5
    seq: number;                     // source event seq (raw)
    path?: string;                   // canonical path for file results
    startLine?: number; endLine?: number;
    startChar?: number; endChar?: number;   // for non-file results
    why: 'quoted' | 'edited' | 'cited' | 'error' | 'reread' | 'agent-retained';
    chars: number;
  }>;
  dropped: {
    count: number; tokens: number;
    notable: Array<{ seq: number; tool: string; target: string;
                     reason: 'not-referenced' | 'no-hits' | 'duplicate' | 'superseded';
                     tokens: number }>;
  };
}

// plugin:multitask/segment-evicted   — one per eviction
interface SegmentEvictedV1 {
  v: 1; id: string; replacedRecordSeq: number; stubSeq: number;
  at: number; reason: 'budget' | 'count'; title: string;
  supersededBy?: string[];
}

// plugin:multitask/segment-range     — one per stub coarsening
interface SegmentRangeV1 {
  v: 1; fromId: string; toId: string; ids: string[]; stubSeq: number; at: number;
}

// plugin:multitask/janitor-pass      — planned / applied / aborted / failed
// (same shape as ADR-0029's compaction boundary, plus the fields below)
interface JanitorPassV1 {
  v: 1; passId: string;
  status: 'planned' | 'applied' | 'aborted' | 'failed';
  sessionId: string;
  at: number;
  measure: { totalTokens: number; surfaceTokens: number;
             contextWindow: number; thresholdNative: number; recordBudget: number };
  plan: { segments: string[]; spans: Array<{ start: number; end: number }>;
          plannedSavingTokens: number };
  applied?: { replacementSeqs: number[]; freedTokens: number; durationMs: number };
  error?: string;
}
```

Note the ordering consequence: the `segment` record is written **before** the surface replacement. A crash between them leaves a sealed record with no landed message, which resume can re-land idempotently from the stored bytes and hash. There is no window in which the surface has a record whose index is missing.

The surface replacement must be preceded immediately by `compaction/prune` (the shared shadow-price protocol: "The replacement MUST be appended synchronously right after this event"). So the exact write order is:

```
plugin:multitask/janitor-pass {status:'planned'}
plugin:multitask/segment      {sealed}          // log-only, does not break adjacency
compaction/prune                                // shadow price
user/message (render)         surfaceOp replace // adjacent to the prune
plugin:multitask/janitor-pass {status:'applied'}
```

---

## 6. Choosing excerpts without a model

### 6.1 The five candidates

| | Mechanism | What it catches | What it misses | Failure mode | Host fit | Deterministic | Cost |
|---|---|---|---|---|---|---|---|
| **a** | **Cross-reference extraction**: find shingles from tool results that reappear in later assistant text | quoted lines, copied code, error strings, identifiers the agent repeats | derived use that never quotes; reformatted content; reasoning that consumed a fact silently | false positives on boilerplate (license headers, imports) | pure function over the log at seal | Yes | O(span) string work, ~10-40 ms |
| **b** | **Agent-authored retention**: agent calls `retain(seq, lines, why)` when it uses something | derived use, decisions from reading, "I used this to decide X" | anything the agent forgets to mark | low adoption; over-retention if prompted too hard | one small tool + a policy line; needs write-time discipline | Yes (no model invoked by us) | ~30 tokens per call |
| **c** | **Access tracking**: edit/write to the read path, re-read of the same path, path appearing in later tool args | files actually acted on, files returned to | read-only research tasks; use of a different file's knowledge | no writes means no signal | pure function over `tool/call` args | Yes | cheap |
| **d** | **Positional/size heuristics**: newest N, head/tail of large outputs | recency; the edges of huge dumps | relevance entirely | keeps new junk, drops old gold | works but that is what native's pruner does | Yes | trivial |
| **e** | **Cheap LLM span selection**: model returns ranges only, excerpts stay verbatim | semantic relevance without prose | — | model cost; non-determinism; a bad range set drops gold silently | needs an LLM seam and a route; segment-sized inputs | No | 1 call per segment (§16) |

Details worth recording:

- **(a) needs shingle normalization.** Strip the read tool's line numbers, normalize NFC, collapse whitespace, then match contiguous token shingles of length ≥ 8 (or ≥ 40 non-space chars). Reject a shingle that appears in more than 3 distinct results in the span — that is boilerplate, not use. Prefer the longest match and expand to line boundaries.
- **(b) is the only mechanism that captures derived use.** It is also the only one that depends on the agent's cooperation. Make it cheap: tiny schema, ~20-token ack. Put one standing rule in the dispatcher policy and the worker contract: "When a tool result matters and you are about to move on, call `retain` with the exact lines."
- **(c) over-triggers on `edit`**: an edit means the file was used, but the *read* that preceded it may be entirely superseded by the edit. Keep the edited region, not the whole read.
- **(d) is a fallback only.** If no signal fired for a span, keep the newest result plus head/tail 2k/1k of the largest one. Never rely on it as the primary rule.
- **(e) does not violate the write-once constraint, but only if it returns ranges.** If an implementation ever lets the model return prose, it becomes a summarizer and violates §2.1. State that in the ticket.

### 6.2 Recommendation

**Implement `c` + `a` first, in that order, because `c` is what makes the flagship rule work and `a` is the second-highest precision signal. Add `b` next as an opt-in. Defer `e`.** `d` is the fallback inside the selector, not a mode.

Priority when the excerpt budget binds (drop from the bottom):

```
1. agent-retained (b)            always keep, up to 2
2. edited/cited (c)
3. quoted (a)
4. error evidence on an open thread
5. re-read / duplicate
6. fallback head/tail (d)
```

### 6.3 The large single document case

The owner's requirement "keep that section verbatim, drop the rest" is not the failed-search rule; it is span selection inside one result:

- For a `read` result larger than 8,000 tokens: run (a) against later assistant text. For each surviving shingle, expand ±5 lines, merge overlapping ranges, cap at 3 ranges × 400 tokens.
- If (b) marked lines, those win.
- If nothing matched, the result is either useless (failed-search case) or used without quoting (unknowable deterministically — keep the newest 2k + the first heading region, and record the drop).

---

## 7. Rule #1: failed search, then hit

This is the first rule to implement. It carries the most bytes and has the cleanest deterministic signal. *Failed-search eviction* is **our label for this rule**, not an established term; the standard names are failure memory / anti-recurrence store for the record and observation masking / context pruning for the removal (§2.2).

### 7.1 Signals, evaluated

| Signal | Cheap? | Reliable? | Needs agent cooperation? | Verdict |
|---|---|---|---|---|
| `read` result → another `read` of a **different** path, no intervening `write`/`edit` | yes | high (it is literally what a search looks like) | no | **use** |
| same query/path repeated (grep loop) | yes | very high | no | **use** (dedupe) |
| later `write`/`edit` on the read path | yes | very high precision | no | **use as the hit anchor** |
| later assistant text quotes ≥ 40 chars from the result | yes, cost is string work | high precision, medium recall | no | **use as hit, and as keep-anyway** |
| later tool args cite the path | yes | medium precision | no | **use as weak hit** |
| assistant says "not here / let me check X" | parsing natural language | low | — | **do not use** |
| agent stops reading and acts | yes | high but ambiguous | no | **use only as episode close, not as hit** |

No mechanism in this table needs a model. The one signal we reject is the one that would need the agent's words parsed.

### 7.2 Episode model

- **Family (v1):** `read`, `grep`, `glob`. `bash` is excluded in v1 — parsing shell commands is fragile and a mis-parse here evicts the wrong thing.
- **Start:** a `grep` or `glob` result; or a `read` followed by another `read` of a different path with no `write`/`edit` between.
- **Membership:** subsequent read-family results while no `write`/`edit` intervenes.
- **Close (sealable):** first of (i) a `write`/`edit` (episode resolved); (ii) a new `user/message`; (iii) the containing segment seals; (iv) 8 read-family results accumulate without a hit (split the episode; seal the first 6).
- **Cross-turn:** a turn boundary does **not** close an episode. Only the four events above.

### 7.3 The negative record — adopt Gemini CLI's shape

**This is not a new format.** Gemini CLI ships span-level verbatim retention in `packages/core/src/context/contextCompressionService.ts` (Apache-2.0): every old read is classified `FileLevel = FULL | PARTIAL | SUMMARY | EXCLUDED`, with `FileRecord { level, startLine?, endLine?, contentHash? }`, and `PARTIAL` renders as a verbatim line-numbered excerpt plus:

```
[Showing lines X–Y of N in file. Full file available via read_file.]
```

and `EXCLUDED` renders as:

```
[<basename> omitted as not relevant to current query. Request via read_file if needed.]
```

We adopt that shape, replacing Gemini's *query-relevance* classifier with our *post-hoc answer-sufficiency* judgment (§7.1). **Our span record therefore aligns with an established, shipped pattern rather than introducing a new one.** Concretely, each failed read gets the `EXCLUDED` treatment, and the batch gets one line naming the target:

```
[memory] Search "toggleSandbox" — not in these 5 files:
  launch.ts (412 lines, 8.2k tok) — omitted, not used
  policy.ts (98 lines, 2.1k tok)  — omitted, not used
  caps.ts (61 lines, 1.4k tok)    — omitted, not used
  env.ts (210 lines, 3.0k tok)    — omitted, not used
  index.ts (44 lines, 0.9k tok)   — omitted, not used
  Kept: bootstrap.ts (2.8k tok) — edited at seq 4160.
  Request any omitted file via read, or exact bytes via read_span(4121,4152).
```

What stays:

- **Path, line count, size, and the target.** That is the "respectively what" the owner asked for, and it is metadata, not a summary.
- **A title inference** (first markdown heading, else the first non-empty non-import line 20-120 chars, else basename) — deterministic, ≤120 chars. Optional; Gemini's `EXCLUDED` line is only a basename, so a title is an addition, not a requirement.
- **The retrieval cue**, in Gemini's exact spirit ("Full file available via read_file" → "omitted as not used; request via read").

What must **not** stay: the result body. Replaying a failed call verbatim measurably raises repetition (0.06 → 0.54), while a written description of the failure removes 76% of the inversion (arXiv:2608.23651, §5.2 of the prior-art file). The scope limit there is small models (135M-1.7B), so treat the direction as a caution, not a law; it agrees with the owner's one-line-per-file instinct either way.

Budget: one entry ≤160 chars; batch ≤1,200 chars (~300 tokens). Typical saving: 5 reads × 3k tokens ≈ 15k → ~100 tokens, about 100-150x.

**If no hit is found in the episode:**

```
[memory] Search "..." — no use found yet in 5 reads. Newest 2 kept verbatim, rest omitted.
```

Add a recurrence count when the same query or path family repeats (`attempts: 3`), following SearchOS `Failure Memory`'s counted "do not retry" strength. That is the one piece of established vocabulary worth copying verbatim.

### 7.4 The hit

The hit is the first result satisfying, in priority order:

1. **H1 act** — a later `write`/`edit` whose `file_path` equals the result's path.
2. **H2 quote** — later assistant text contains a contiguous ≥ 40-char (whitespace-normalized) shingle from the result.
3. **H3 cite** — the path appears in a later non-read tool call's arguments.
4. **H4 return** — the same path is read again later.

The hit is kept **fully verbatim** (subject to the 1,600-char excerpt cap; if it is larger and H1 targeted a region, keep that region plus 10 lines of context). It becomes the episode's `FOUND` anchor, and the record references it by seq. Every other member is a negative entry.

If **two** results have H2 hits, both are kept. "One hit" is not an assumption.

### 7.5 Generalization beyond file reads

| Family | Same pattern? | Note |
|---|---|---|
| `glob` directory listings | yes | a listing that led to no read is one line: `glob src/**/*.ts -> 412 files, none opened` |
| `grep` with no hits | yes | the result is already tiny; dedupe repeated identical greps, keep the last |
| doc/README fetches (`read` on `.md`) | yes | same rule |
| log tails via `bash` | no in v1 | needs shell parsing; deferred |
| **one large file, one section used** | **no** | that is §6.3 span selection, not failed search |
| a read used without quoting (learned API, wrote a different file) | no | only mechanism (b) catches it |

### 7.6 Risk of sealing too early — quantified honestly

If the agent returns to a dropped file, it re-reads it. Cost: one read, typically 2-8k tokens (~$0.001-0.01 at typical input prices — the exact price is not recorded in this repo and must not be asserted). Benefit of dropping: 2-8k tokens removed from **every subsequent request** for the rest of the session.

Break-even: dropping wins if the file is not revisited, or if the session has more than roughly one request left per 2-8k of freed context. For a session with hundreds of requests, the odds strongly favor dropping. The real risk is not cost; it is latency (one extra turn) and the agent's confusion. That is why the negative record names the path: a re-read is one call away, and the record says what each file was.

Measure it, do not trust the argument: metric 2 in §15 counts re-reads of dropped paths.

---

### 7.7 Prior art, and what is genuinely novel

Source: `.scratch/repo-analysis/2026-10-19-failed-search-eviction-prior-art.md` (present when this revision was written). It surveyed arXiv, authenticated GitHub code search, and vendor docs. General web search was unreachable from that lane, so blog-level prior art may be missing.

**Nobody ships the exact rule.** No system found (i) judges which past reads *failed to contain the answer*, (ii) evicts those, and (iii) leaves a terse negative pointer set. The three ingredients exist separately in shipping code:

| Ingredient | Shipping prior art | What they do | What we add |
|---|---|---|---|
| **Span-level verbatim retention** | **Gemini CLI** `contextCompressionService.ts` (Apache-2.0): `FULL / PARTIAL / SUMMARY / EXCLUDED`, `startLine`/`endLine`, verbatim excerpt + "Full file available via read_file" | classifies by **query relevance** with a flash-lite model | classify by **post-hoc answer sufficiency**, deterministically |
| **Evict-by-pointer / restore at record granularity** | **Context Surgeon** (MIT): `evict` / `restore` / `replace` by permanent ids over append-only JSONL, transactional ops | generic mechanism, agent-driven | trigger it from a policy, not from the agent's whim |
| | **Letta / MemGPT**: MemFS and recall storage, evicted messages retrievable indefinitely | tiered memory framework | we stay inside dsh's session log (ADR-0006) |
| | **Zep / Graphiti** (Apache-2.0): bi-temporal invalidation — "invalidated — not deleted", with validity windows | non-destructive negative knowledge at fact level | apply the same pattern to read records |
| | **LCM** (arXiv:2605.04050): pointers to every original; **TierMem** (arXiv:2602.17913): immutable raw log + sufficiency router | summary default, verbatim on demand | same shape, no summary index |
| **Negative / failure memory** | **SearchOS** `Failure Memory` (arXiv:2607.15257): typed failure, recurrence count, "do not retry" strength. **trimwire** `failed_input_purge`: keeps `command`/`file_path`/error, drops bulk. **SIx Harness** "anti-recurrence store" | keyed on *errored* calls or *search queries* | keyed on *a completed read that turned out irrelevant* |
| **Append-only log + tombstone + projected view** | **OpenHands SDK** `Condensation` / `View` design; dsh's own `surfaceOp replace` | — | nothing; copy both |

**What is genuinely novel (small, and stated as such): only the post-hoc answer-relevance judgment is new.** Every other ingredient has shipping prior art.

1. **The post-hoc answer-relevance judgment.** Deciding after the fact that reads A-E did not contain the answer while F did. Every surveyed system selects by query relevance at compression time, by error status, or by age. None judges answer sufficiency of a *completed, successful* read.
2. **The composite policy is new only as a composition** — evict the failed reads, keep the hit fully verbatim, leave one line per failed file, and count recurrences. Each piece is shipping prior art; the composition is not.

**What we should explicitly not invent:** the record envelope (copy Gemini CLI's `[Showing lines X–Y of N ... Full file available via read_file.]`), evict/restore semantics (copy Context Surgeon's stable-id model), the negative-record vocabulary (failure memory / anti-recurrence store), and the tier names (main context / recall storage). Use the canonical terms listed in §2.2; avoid coining.

**Two prior-art findings that change our design:**

- **Recoverable elision yields no accuracy gain in practice** because agents rarely call the retrieval path (arXiv:2609.20804, 176 matched settings). Consequence: retrieval is a backstop (§2.2), and the in-context record must carry the value.
- **Replaying the failed attempt verbatim increases repetition** (0.06 → 0.54), while a written failure description removes 76% of the inversion (arXiv:2608.23651). Consequence: §7.3 keeps metadata, never the result body. Caveat: that study covers 135M-1.7B models; do not treat it as proven at frontier scale.

## 8. What "junk" means here

The classifier's false positive costs a needed fact; the false negative costs tokens. We bias toward keeping.

### 8.1 Evicted, with rule

| # | Class | Rule |
|---|---|---|
| 1 | **Failed search reads** | §7. Flagship. |
| 2 | **Large read, one section used** | §6.3. Keep the used section verbatim; drop the rest. |
| 3 | **Re-read superseded** | Same path read again at the same or a newer version: keep the newest, drop the older, record the pointer. |
| 4 | **Verbose command output** | Keep exit code, failing test names, the first error block (≤ 400 tokens). Drop the body. |
| 5 | **Listings that led nowhere** | §7.5, one line. |
| 6 | **Exact duplicates** | Same content hash in the span: keep one, pointer the rest. |
| 7 | **Resolved error output** | A later successful run of the same command: keep the success; the error is historical. |
| 8 | **Stale file contents** | A `write`/`edit` after the read: the read is historical; correctness comes from the correction rule (§2.3). |

### 8.2 NOT junk — never selected for eviction

- Every `user/message` (the user's words, the dispatcher policy message, the worker contract restatements).
- The system prompt and every `system/message`.
- Any `developer/message`.
- The **current turn's** task statement and the todo ledger.
- The **newest 32k tokens**, whatever they are.
- The most recent `read` of any path touched by a `write`/`edit` in the current turn.
- The newest error for the active task (the one the agent is working on now).
- Decisions. A decision quote is kept even when the surrounding text is dropped.
- Tool-call/result pairs. Never split.
- Worker reports (`deliver_result` payloads) — they are the dispatcher's input.

### 8.3 Explicitly out of scope for eviction in v1

Assistant reasoning messages and user messages. Dropping the model's own chain is a different risk class; it needs its own evidence. v1 touches tool results and tool-pair-balanced spans only.

---

## 9. Retrieval

### 9.1 Tool surface

Two tools, registered on dispatcher sessions and worker sessions the plugin owns:

```
segment_read(id: string) -> text
  Returns the record bytes exactly as sealed, prefixed with a status header.
  If superseded: appends "superseded_by: [ids]" and, with `follow: true`, the
  newest correction record too.
  Hash-verified. On mismatch: error, no content.

read_span(startSeq: int, endSeq: int, offsetChars?: int, maxChars?: int) -> text
  Returns raw event content from the log for the given surface span, in order.
  Skips non-raw events (records, stubs, checkpoints) and lists them as positions.
  Default maxChars 12,000; truncation says exactly where it stopped.
```

No third tool. No query string. `id` and `seq` are the only identifiers.

### 9.2 Identifiers

- Segment id: `seg-<8 hex>`, deterministic from the span and record hash (§4.1). Stable across fork/resume because it does not encode a mutable seq.
- Raw content: `seq` numbers, exactly as the log uses them. `read_span` takes the span printed in the record header.
- The log's own `sourceEventSeqs` on the replacement is the durable mapping; a reader can trace it with `ctx.sessionQuery.traceEvent`.

### 9.3 Response shape

```
[segment seg-1a2b3c4d | span 4120-4188 | raw 47,900 tok | record 1,940 tok | kind work]
<record body, verbatim>
---
sources: seq 4120-4188 (69 events). Raw: read_span(4120,4188)
```

Bounded. If the agent needs more, it narrows its range.

### 9.4 ADR-0018 U-H position

U-H bans "a local content-search index." This design does not build one:

- Retrieval is **by id or seq only**. There is no inverted index, no token table, no embedding store, no separate database (ADR-0006).
- The stub list is pointers plus titles, which is the same class of data as a filename list, not a search index.
- The janitor's in-memory state during a pass is discarded; nothing is persisted except log records (§15).

**Full-text search would be needed** for one case only: the agent remembers a phrase but not the segment. That case is out of scope. The host *could* serve it — `ctx.sessionQuery.searchEvents` exists — but this deployment runs it with `openAt: never`, and enabling it would be a host-policy change plus an argument about U-H's spirit. Say so plainly in the ticket; do not quietly enable it.

Fallback for "I don't know the id": `read_span` over a seq range with `maxChars`, or the in-context stub list (ids + titles) which is exactly the coarse index the agent can scan for free.

---

## 10. Background execution, locking, and mid-turn behavior

### 10.1 Where the work runs

- **Primary:** `agent/pre-step`, synchronously, before the model request. No `await`, no LLM, no I/O beyond the in-memory log. Measured guard: if a pass exceeds 50 ms, move it to `agent/turn-stopping` for that session.
- **Fallback:** `agent/turn-stopping`, same function. Covers turns that end without a further pre-step (and worker sessions that finish).
- **Never:** a timer. No interval, no wall clock. Determinism requires the decision to depend only on log state.

### 10.2 Why "background" is honest here

It is not a worker thread. It is a step-boundary pass that runs between model calls, does no model work, and adds only CPU. The user never waits on a model for it. That is the property that matters; do not claim otherwise in the ticket.

### 10.3 Locking

- **In-process:** a per-session `passInFlight` boolean. Single-threaded JS plus a synchronous body means no interleaving. Re-entry returns immediately.
- **Cross-process:** dsh sessions are single-owner; there is no second writer. If a future deployment breaks that, the `janitor-pass planned` record is the lock: a second process seeing `planned` without `applied` appends `aborted` and does not touch the surface.
- **Native compaction is the higher-priority lock.** An unmatched `compaction/start` means native owns the surface; skip the pass (§11).

### 10.4 What happens if a turn starts mid-pass

It cannot, within the process: the pass contains no `await`. The only exposure is process death, handled in §14. If a turn is already open (worker mid-tool-call), `pre-step` only fires at step boundaries, so all tool results are committed and every pair is complete.

### 10.5 What the agent sees if it is compacted mid-conversation

A user-role message inserted at an old position, with the `[janitor]` preamble. The agent's next request sees raw recent tail plus records. Nothing signals an error, no turn is interrupted, and no tool result changes mid-call. The record itself tells the agent how to get dropped content back.

---

## 11. Interaction with native compaction

### 11.1 Ordering contract

1. Our listener registers first and runs before native's in the same `agent/pre-step` waterfall. Registration order must be verified on a live boot; the failure mode if reversed is benign (native compacts, pressure drops, our pass no-ops).
2. **Native wins any tie.** If `measure.totalTokens >= T_native`, or an unmatched `compaction/start` exists, we do not seal. The host is the backstop and holds the lock.
3. Our seals reduce how fast the surface approaches `T_native`, by roughly `q` of the sealed span. At high `q` native may rarely fire; at low `q` it still will. Both are acceptable — native is the backstop, not a failure.
4. After `compaction/end` without error: reset `sealCursor` to the position immediately after the checkpoint message; never seal a `compact-checkpoint` node; append the pointer index (§2.4).

### 11.2 What native does to our records

It may summarize them. That is the residual loss in §2.4. Raw events and segment records survive in the log, and `segment_read` still works; only the in-context rendering is gone. The pointer-index message restores ids and titles.

### 11.3 Thresholds

| Event | Value on this host |
|---|---|
| `T_native` | 678,464 |
| our start | 100,000 |
| seal every | 50,000 |
| default `recordBudgetTokens` | 339,232 (0.5 × `T_native`) |
| native retained tail | 119,040 |

We never tune `thresholdRatio`/`retainRatio` here. Those stay as shipped (`compaction-stack-design-2026-10-19.md` §4).

---

## 12. Cost, and why cost is not the objective

**Rewrite count is not a design constraint.** Owner, 2026-10-19: *"Number of rewrites is irrelevant, not something we have to optimize for. Also our 1M is effectively like 5x sessions of good context, not comparable with 1M of normal density context with lots of junk."*

Consequences, stated once so the rest of the doc obeys them:

1. Strict-prefix invalidation is real — every replacement invalidates the prefix from the replaced position. Keep it as a **cost line**.
2. The batching implementation detail (§4.5) stays because it is free, not because the design turns on it.
3. **Comparing dollar cost at equal token count against native-only is invalid.** A pruned 1M is not the same artifact as an unpruned 1M. Section 12.2 reports what the layer costs; it does **not** decide whether to build it.
4. The design is judged on **density and continuity** (§12.4), not on cost.

### 12.1 `q`, the density predictor

- `q` = the share of accumulated context that is evictable tool output.
- `q` predicts **density gain per session class**: high-`q` sessions (search-heavy worker transcripts) shrink a lot; low-`q` sessions barely shrink.
- Other terms: `G` = raw tokens added; `A` = tokens per request (2,000); `s` = 50k seal; `f` = 3 flush batching; `B` = record budget; `T` = 50k raw tail; `ε` ≈ 0.05; `r` = cache-read ÷ input price (assume 0.1, **unrecorded**); `ρ` = output ÷ input price (assume 3, **unrecorded**).

**v1 evicts only tool results.** Assistant messages, user messages, and the system prompt stay verbatim forever, so growth is not bounded by this layer; native compaction remains the only hard bound.

```
surface(t) = (1−q)·raw(t)                     // assistant/user/system: unremovable
           + q · min(TAIL, raw(t) − sealed)   // raw tail, verbatim
           + min(B, ε · q · sealed)           // live records
           + stubs(sealed)                    // ~40 tok per evicted record
I_jan      = ceil((G/s) / f)                  // flushes; one invalidation each
C_jan      = r × Σ surface + I_jan × surface_at_flush + 0
```

### 12.2 Cost, reported not argued *(modelled; the first version of this table was wrong and was corrected by stepping the model)*

Stepped at 2,000 tokens/request, `f = 3`, `r = 0.1`, `ρ = 3`, native allowed to fire in both arms. Millions of full-price input-token units.

`G = 1,000,000` (500 requests):

| `q` | Native only (avg surface / cost) | Janitor (avg / cost) | Delta |
|---|---|---|---|
| 0.3 | 321k / 17.8M | 328k / 20.3M | +14% |
| 0.5 | 321k / 17.8M | 275k / 16.3M | −8% |
| 0.7 | 321k / 17.8M | 185k / 11.3M | −37% |

`G = 5,000,000` (~2,500 requests):

| `q` | Native only | Janitor | Delta |
|---|---|---|---|
| 0.3 | 386k / 107.4M | 376k / 115.3M | +7% |
| 0.5 | 386k / 107.4M | 350k / 106.7M | −1% |
| 0.7 | 386k / 107.4M | 331k / 99.0M | −8% |

### 12.3 What these numbers mean, and what they do not

1. **They are a cost line, not a verdict.** The layer is near-neutral when tool output is half the context, cheaper when it dominates, more expensive when marginal. None of that decides whether to build it.
2. **Batching is an implementation detail.** `f = 1` → `f = 3` cuts invalidations and rewritten bytes 3x **only if all three replaces land in one synchronous `pre-step` with no model call between them** (§4.5). Free when it works, irrelevant to the policy either way.
3. **A rewrite is bounded by current surface, not by `Tn`.** It starts at the oldest landed position, so it costs roughly one surface, not one full context. The simulation charges exactly that.
4. **Observation masking's published economics point the same way.** arXiv:2508.21433: basic observation masking halves cost versus a raw agent while matching or slightly exceeding LLM summarization's solve rate. That supports choosing A over a summarizer, as a quality/cost argument.
5. **Cold sessions are free.** After cache expiry a pass costs nothing in cache terms.
6. **Uncertainty is large.** `q`, `r`, `ρ`, record size, and CPU are unmeasured in the target population; treat magnitudes as ±40%.

### 12.4 The baseline we should actually compare against

The alternative is not "native compaction at 678k." It is **N fresh sessions plus re-orientation cost**: start a fresh session, lose the thread, re-explain the task, re-read the same files.

For an unpruned 1M-token session, the owner's own framing is that it is worth about **five good sessions** — and reaching it means the user did not have to restart four times. The correct comparison is therefore **five fresh sessions plus what it costs to re-orient in each**, not one session at the same token count. A pruned 1M-token context is not an ordinary 1M-token context: it holds roughly **5x the useful content** of one, because the junk has been removed rather than carried.

Measure it from the same logs, before making any cost argument:

- **Restarts after a long session** in the same workspace (new session whose first user message restates the prior task).
- **Repeated file reads across sessions** — the same absolute path read in session A and again in B.
- **Task-restatement bytes** — first 2 user messages of a new session against the last assistant message of the previous one.

If those are large, the value is "one 300k-token session instead of three 100k-token sessions," and rewrite count is noise beside it. **The census in §15.5 did not capture any of this.** Until it does, the claim that this layer beats restarting is a hypothesis, and must be written as one.

### 12.5 Density, stated as the target

> At a given context size, how much of it is information the agent still needs, and how many more turns does the session stay effective before a summary is forced?

Operational form:

```
density(D) = (retained bytes later referenced or acted on)
           / (bytes in window)
continuity = turns before the first forced native summary
```

Both are measurable from the log (§15). Neither is a dollar figure. A design that raises density while costing more is acceptable if the user would otherwise have restarted; a design that saves dollars while losing a needed fact is not.

**Expected density improvement (report `q`, do not gate on it).** From the first local census (§15.5): median `q = 0.02` across 20 stored sessions, with 3 sessions above 0.2 and a maximum of 0.467. Those are short, conversation-heavy sessions where this layer should not run at all. The tool-heavy worker sessions it targets are absent from the sample. Report `q` per session class as the expected shrink factor: roughly `1 − q(1 − ε)`.

---

## 13. Growth math, eviction, and steady state

**The honest headline: v1 does not bound growth.** It removes tool-result bytes from sealed spans; assistant messages, user messages, and the system prompt stay verbatim forever. Growth is therefore `(1−q) × G` plus records, not a constant. Native compaction remains the only hard bound. Do not claim otherwise.

```
Segment cadence: one seal per 50,000 raw tokens; one land per 3 seals (~150,000 raw).
Record size:     ~2,500 tokens at ~5% of the span (soft cap 2,500 tokens / 12,000 chars).

Segments before the record budget binds:
  B / 2,500 = 339,232 / 2,500 ≈ 135 segments ≈ 6.8M raw tokens

What the window holds at raw token count G:
  raw tail            ≤ 50,000
  live records        min(B, 0.05 × q × sealed)
  evicted stubs       40 tokens each, one per record beyond B/2,500
  everything else     (1 − q) × sealed   <- the term that grows without limit
```

| Raw tokens | Sealed | Live records | Evicted stubs | Non-evictable | Window (`q = 0.5`) |
|---|---|---|---|---|---|
| 200k | 150k | 3,750 | 0 | 75k | ~129k |
| 500k | 450k | 11,250 | 0 | 225k | ~286k |
| 1M | 950k | 23,750 | 0 | 475k | ~549k |
| 5M | 4.95M | 123,750 | 0 | 2.48M | ~2.65M |
| 7M | 6.95M | 173,750 | 160 | 3.48M | ~3.70M |
| 14M | 13.95M | 339,232 (cap) | 5,760 | 6.98M | ~7.37M |

Consequences that must be stated in the ticket:

1. **Eviction is a second-order mechanism.** At `q = 0.5`, the record budget is not reached until ~13.6M raw tokens, and by then the non-evictable 6.8M dominates anyway. Eviction exists for correctness and for the stub list, not to make the window constant.
2. **The 500k target, honestly.** At `q = 0.5`, a 900k-raw-token conversation fits in a ~496k window: 425k non-evictable turns, 21k of records, 50k raw tail. So 500k of window now carries what used to cost 900k — a 45% reduction — but **records are only ~4% of the window**. The bulk is user/assistant turns the janitor cannot touch. The density win is real but comes from dropping tool dumps, not from records carrying the session.
3. **If the owner wants the window to actually stay near 500k**, v1 cannot do it. That needs either (a) raising the evictable share by also sealing assistant messages (a bigger product decision, §8.3), or (b) the native summary as the hard bound. Say this plainly; do not promise a constant window.
4. **The hierarchy beyond the stub cap is pointers and titles, never a summary index:**
   - 1-256 evicted records: one stub each (`id`, `title`, ≤ 160 chars).
   - 257+: group 32 consecutive evicted records into one range stub (`segments 257-288: see segment_list(257,288)`). `segment_list` walks the log and returns ids and titles on demand, off-context.
   - `segment_list` takes a numeric range only. No query string, no index. That is the whole hierarchy.

---

## 14. Failure modes

| Failure | Detection | Response | Owner |
|---|---|---|---|
| **Record not smaller than span** | `recordTokens >= 0.5 × rawTokens` after building | Drop excerpts in priority order (§6.2) until under. If still over: write no surface replacement, leave raw content in place, append `janitor-pass {status:'failed', error:'not-shrinking'}`. Never write a record larger than the span. | ours |
| **Interrupted between `compaction/prune` and its replacement** | On resume: a `compaction/prune` not immediately followed by a `replace` citing the same range | The span is still intact and the sealed record exists → re-append the identical bytes (hash-verified) and the prune, then `applied`. Idempotent by `(span, recordSha256)`. No compensating guess. | ours |
| **Crash between the segment record and the surface write** | `segment` record exists, span not shadowed | Same repair: re-land from the sealed bytes. The index cannot be lost, because it is written first. | ours |
| **Crash after the surface write, before `applied`** | `planned` without `applied`, but the span is shadowed and the message hash matches | Append `applied`; do not re-land (would double-replace). Hash is the discriminator. | ours |
| **Excerpts exceed budget** | Pre-render check against caps | Deterministic truncation: keep priority order, shrink excerpts to head/tail, then drop the weakest. Caps are enforced before append, never after. | ours |
| **A segment is sealed too early and the agent returns** | Re-read of a dropped path (metric 2) | Nothing breaks. The agent pays one read; the record named the path. Track the rate; if high, raise the episode close threshold. | ours |
| **Native compaction summarizes records** | `compaction/start` while records are on the surface | Unavoidable (§2.4). Append the pointer index after `compaction/end`. Retrieval still works. | host + ours |
| **`appendPluginRecord` rejects our type** | throws at append | The pass fails closed: no surface write, `failed` record attempted, one diagnostic. This must be proven before implementation (open question 1). | ours |
| **Span too large to record** | `sourceSeqs > 512` | Split the span at the nearest pair-balanced cut and seal twice. Never exceed the cap. | ours |
| **Non-dispatcher, non-worker session** | Ownership gate | No pass. This is the safety property, not a failure. | ours |
| **Two passes in one step** | `passInFlight` | Second returns immediately. | ours |
| **Provider rejects the rewritten history** | `agent/request-error` right after a land | Disable the janitor for that session (`failed` record), leave the surface as written; native compaction still applies. One occurrence is enough to stop. | ours |

Deliberate posture: **no retries inside a pass, no silent reformatting.** A pass either lands exactly what it sealed or records a failure and does nothing.

---

## 15. Measurement (respecting ADR-0018 U-H)

The objective is density and continuity (§12.5), so the signals are ordered by how directly they measure it.

### 15.1 Signals

| # | Signal | Definition | How |
|---|---|---|---|
| **D1** | **retained reuse rate** (density) | of the excerpt bytes kept in record `i`, the fraction later matched by H1/H2/H3 in a later segment | pure log scan at the next seal; stored as a number on the next `janitor-pass` record |
| **D2** | **density of the window** | later-referenced bytes ÷ all bytes in the window, sampled at each seal | derived from D1 plus per-node `tokens`; stored on the pass record |
| **D3** | **continuity** | turns and tokens before the first `compaction/start`, and count of crossings per session | host events, already in the log |
| **D4** | **re-read regret** | later `read` calls for paths in a sealed record's dropped set | compare new read paths to the in-memory dropped sets of recent records; emit a count per pass |
| **C1** | surface before/after | `measure.totalTokens` at the start and end of each pass | already in `janitor-pass` |
| **C2** | freed vs kept bytes | sum of `shadowedTokenCount` vs record tokens per pass | already in the pass record |
| **C3** | cost delta | `r × Σ surface + rewrites` versus the session's own pre-janitor trajectory | derived; reported, not optimized |

D1-D3 are the ones that decide the design. C1-C3 are reported so the dollar cost is honest.

### 15.2 Where it lives

- Per-pass numbers live in the `janitor-pass` plugin records, in the session log. That is the ADR-0029 boundary-marker pattern, not a separate ledger.
- Aggregation is on demand: a read-only `/janitor-stats` command folds those records for one session and prints the six numbers. No database, no index, no background aggregation.
- Nothing is written outside the session log. No per-stream usage accounting of our own: measurement inputs are the host's `measure()` and host events, and the pass's own delta — the same thing ADR-0029 already authorizes.

### 15.3 What cannot be measured this way

Semantic usefulness. D1 and D4 measure **literal reuse** and **re-read regret**. Derived use that never quotes is invisible to option A. If D1 is low and D4 is low too, records are neither used nor missed — acceptable. If D4 is high, selection is too aggressive. There is no deterministic signal for "the agent used a fact silently"; that gap is the argument for option B, not something to paper over.

### 15.4 Success gate before any tuning

Run option A on real dispatcher and worker sessions and require:

- D4 (re-read of dropped paths) < 10% of dropped reads;
- D1 (reuse) > 40% of records having at least one referenced excerpt;
- D3 (continuity) improves: later first crossing, or fewer crossings, in high-`q` sessions;
- no provider rejection after a land.

`q` on worker sessions is **reported, not gated**. Expect ~0.5 in search-heavy worker transcripts; at ~0.2 the density win is small and the layer should be scoped or delayed, not rejected. `q` predicts the shrink factor, and shrink factor predicts continuity, which is the objective (§15.5).

### 15.5 Measuring `q` before writing any code

`q` is the share of accumulated surface tokens that are `tool/result` nodes. It predicts how much the window can densify per session class. It is not a dollar gate.

**What to read.** Existing session logs under `$DSH_HOME/sessions/**/session.v3.jsonl.zstd`. These are multi-frame zstd: split on the frame magic `28 b5 2f fd` and decompress each frame separately (a single-frame `zstdDecompressSync` on the whole file returns only the first ~213-byte JSON header — that mistake was made and caught while writing this doc).

**What to count.** Per session, over **surface-visible** events only (apply the same `surfaceOp` replace/shadow logic dsh uses, or approximate by ignoring events with `sourceEventSeqs` pointing into an already-replaced range):

```
q = Σ chars(tool/result content)  /  Σ chars(tool/result + assistant/message + user/message + system/message)
```

Extra outputs worth recording in the same pass:

- **failed-search rate:** read-family episodes with ≥3 reads, and what fraction proved unused (no later edit, quote, or path citation). This is the flagship rule's hit rate.
- **re-read regret:** how often a path is read, dropped from attention, and read again. Proxy: consecutive duplicate path reads.
- **median read size**, so the 1,600-char excerpt cap can be checked against reality.
- **session length distribution**, so `JANITOR_START_TOKENS = 100,000` is checked too.

**Sample size and time.** At least 20 sessions spanning ≥2 workspaces, and ≥500 read-family tool results total. On the logs present at drafting time that is a single afternoon.

**What `q` looks like from the first local census.** A read-only census of the 20 stored session logs on this machine (all workspaces, ≥5 events, ≥1KB of model-visible text; raw JSONL char share, surface replacements not applied) gives:

| Statistic | Value |
|---|---|
| Sessions | 20 |
| Median `q` | **0.02** |
| Sessions with `q > 0.20` | 3 |
| Maximum | 0.467 |
| Sum of tool-result chars | ~560k of ~1.5M |

**Interpretation.** The stored population is dominated by short, conversation-heavy sessions where tool results are a rounding error. The long, tool-heavy worker transcripts this design targets are **not in the sample** — no stored session has crossed the native threshold. So this does not refute the design; it says the layer must be gated **per session class** and must not run on low-`q` chats at all. The `JANITOR_START_TOKENS = 100,000` gate already helps, but `q` should be checked explicitly.

Caveats: char share is a proxy for token share (heavier for CJK and JSON); surface replacement was not applied, so already-shadowed events are counted; 20 sessions from one machine is a convenience sample.

**Decision rule (density, not cost).**

- High-`q` session class (worker transcripts, `q` expected around 0.5): build A there first, gate per class, measure density.
- Mixed population: enable per session class, not globally.
- If `q` stays ≤ 0.2 in **every** class after a larger census: the layer has nothing to clean and should not ship.
- **Do not** use `q` as a dollar gate. It predicts shrink factor, and shrink factor predicts continuity, which is the objective.

**If `.scratch/repo-analysis/2026-10-19-empirical-junk-census.md` appears**, prefer its numbers over this one-machine sample; it is doing the same census with more care. It was absent at drafting time.

**What this census did not measure and the next one must:** cross-session re-reads, task restatement, and restart frequency after long sessions (§12.4). Those are the baseline the layer must beat.

---

## 15b. What would make us abandon this

Concrete results that mean "do not ship option A either." Each is checkable before or shortly after a prototype. The thresholds are **density and continuity** first; cost appears only as a floor, because a design that saves dollars while losing a needed fact is worthless.

| # | Measurement | Threshold | Why it kills the design |
|---|---|---|---|
| 1 | **Density in the target session class** | **no measurable improvement** in retained-and-later-referenced share across 10 real worker sessions | This is the product claim. If the window does not get denser, nothing else matters. |
| 2 | **Task continuity** | **no increase** in turns before the first forced native summary in high-`q` sessions | The second half of the product claim. |
| 3 | **`q` after a wider census** | **≤ 0.20 in every session class** | Nothing to clean. Do not ship. |
| 4 | **Failed-search episodes** | **< 10%** of tool-result bytes | The flagship rule is the whole mechanism. If file searches rarely fail, the machinery is not worth it. |
| 5 | **Re-read rate of dropped paths** | **> 25%** | We are churning: the agent keeps returning to what we removed. Sealing too early. |
| 6 | **Retained-excerpt reuse** | **< 30%** of records have any excerpt later referenced | We are choosing the wrong spans. |
| 7 | **Provider rejection or malformed history after a land** | **any occurrence, twice** | The surface rewrite is unsafe on this host. Stop. |
| 8 | **Cost** | worse than **+25%** in the target class | Acceptable dollar cost is part of the objective; a large regression is not. A small regression is fine if 1 and 2 pass. |
| 9 | **Pass CPU time** | **> 50 ms p95** after moving to `turn-stopping` | Felt as latency; the step-boundary budget does not work. |
| 10 | **Any eval regression** | **any** | Fidelity is the entire claim. Zero tolerance. |

Two more that would kill the *ticket*, not the mechanism:

- **`appendPluginRecord` cannot carry our types across resume/fork** (open question 1) — then the durable record has no home and the write-once guarantee has no storage.
- **A later segment's correction cannot cite an evicted record by id** — then corrections are broken and staleness is undetectable.

State all of this in the ticket's acceptance criteria. A human reading this should see, before approving, exactly which number stops the work.

If those fail, do not tune frequency; change the selection rules.

---

## 16. Cost table

All model costs assume the janitor performs **zero** model calls in A and B. `A = 2,000` growth per request; prices are parameterized because this repo records no provider price sheet. **These are cost lines, not the basis for choosing the design** (§12).

| Workload | Option A/B model cost | CPU | Rewrites | Compared with native |
|---|---|---|---|---|
| **One seal+land (50k span)** | 0 tokens | ~10-40 ms *(unmeasured)* | 0 if batched (f=3); 1 otherwise | n/a |
| **Per 100k tokens of conversation** | 0 | ~20-80 ms | ~0.67 (f=3) | native: 0 |
| **Per 1M-token session** | 0 | ~0.3-0.8 s total | ~6 | native: 1 summary, ~678k input (mostly cache-read), ≤65,536 output; cost delta +14%/−8%/−37% at `q` = 0.3/0.5/0.7 |
| **Per ~5M-token session** | 0 | ~1.5-4 s | ~35-41 | native: ~8 summaries; cost delta +7%/−1%/−8% at `q` = 0.3/0.5/0.7 |
| **Option C adds** | 1 call per segment: ~50k input (mostly not cacheable across segments) + ~200 output | +1 call latency per seal | unchanged | +20 calls/1M ≈ **1M input + 4k output**; at 1M this would roughly double total cost |

The CPU estimate is string scanning over ~50k tokens of text (~200k chars) plus JSON appends; it is not measured. If it exceeds 50 ms, move to `turn-stopping` (§10.1) rather than optimizing.

Native's cost is dominated by the 65,536-token output cap, not its input, because its input is a cache-reused prefix. The janitor inverts that: it spends cache writes and saves output.

**Read the "Compared with native" column as cost at equal raw tokens only.** It is not a value comparison: the two arms do not hold the same amount of useful information (§12.4). A +14% row at `q = 0.3` says the layer costs more per raw token there; it does not say native is the better product.

---

## 17. Decision table

**Compliance column legend:** *write-once* = never re-summarizes a record; *flagship* = implements the failed-search rule (our label for it; §2.2).

| | **A — deterministic only** | **B — deterministic + agent retention** | **C — deterministic + LLM span selection** |
|---|---|---|---|
| **Selection mechanisms** | (c) access tracking + (a) cross-reference, (d) fallback | A + (b) `retain` tool | A + (e) ranges-only model call |
| **Model calls** | 0 | 0 by the janitor (the agent is already running) | 1 per segment (~50k input) |
| **Write-once compliant?** | **Yes** — selection runs once, records never touched again | **Yes** — `retain` only marks ranges at write time | **Yes, only if the model returns ranges.** Any prose output makes it a summarizer and violates §2.1. The ticket must make ranges the only output schema. |
| **Implements failed-search rule with no model?** | **Yes.** Signals are read-family adjacency, edit/write targeting, and quote matching. | Yes | Yes |
| **Catches** | failed searches, edited files, quoted content, re-reads | + derived use, learned API, silent decisions | + semantic relevance in spans where no literal signal exists |
| **Misses** | use without quoting, cross-file inference | reads the agent forgets to mark | less than A, but still misses anything the model judges irrelevant |
| **Benefit** | the bulk of the achievable byte win in high-`q` (search-heavy) sessions; zero cost; fully testable offline | closes A's biggest gap, still no model cost in the janitor | marginal over B in most spans; useful for prose-heavy research sessions |
| **Risk** | false negatives on derived use; re-read regret; **no density gain in low-`q` sessions** (must be gated per session class) | adoption failure; over-retention | model cost, non-determinism (violates ADR-0029 decision 1 unless ticketed), silent bad ranges |
| **Effort** | ~10-13 working days: ~1,470 prod + ~900 test lines. The span/episode/priority logic is the bulk (~600 prod); the rest is renderer (~200), records and resume (~220), retrieval tools (~200), wiring (~250). | A + ~3 working days (~100 prod + ~150 test), plus prompt changes in `src/core/policy/prompts.ts` and `src/worker/prompt.ts` | A + ~6 working days (selector call, route config, ranges-only schema, evaluation harness) |
| **Recommendation** | **BUILD THIS FIRST.** It implements the flagship rule with zero model calls, is fully testable offline, is deterministic (satisfies ADR-0029 decision 1 without amendment), and is the only option with shipping prior art behind every ingredient (§7.7). | Add second, only after §15.4/§15.5 are measured and signal 1 shows A losing silent derived use. | **Defer.** No evidence currently justifies an LLM selector: A captures the literal signals, the prior-art lane found LLM summarization did not beat observation masking on solve rate (arXiv:2508.21433) at an extra per-segment call, and C adds non-determinism. Its input is also not cacheable, which is a cost line rather than the deciding reason. Revisit only if A/B measurably lose information in prose-heavy sessions. |

**No option depends on re-summarization.** None is demoted on that ground.

**Demoted anyway:** any design that keeps a "rolling index record" or "hierarchical summary of records." That is a summary of records by another name. §13's range pointers plus titles are the only permitted hierarchy.

**Re-ranking rationale (prior art changed the order).** Before the prior-art lane, A and B looked like near-peers and C looked like a quality upgrade. Three findings invert that:

1. **Recoverable elision yields no accuracy gain in practice** (arXiv:2609.20804). A design whose strength is "retrievable later" is weak; the strength has to be the in-context record. That is A's design, and it needs no model.
2. **Observation masking matches LLM summarization's solve rate** (arXiv:2508.21433), at half the cost — a cost line, but also a fidelity argument: the simpler mechanism does not lose accuracy, so the burden of proof sits on C.
3. **Every ingredient of A ships somewhere** (Gemini CLI spans, Context Surgeon evict/restore). C's ingredient — a model judging span relevance — also ships (Gemini's flash-lite router), but it buys *query relevance*, not *answer sufficiency*, and it adds a per-segment call and non-determinism.

**Recommended stack:** A now; B as a follow-on ticket; keep native `compaction-basic` untouched as the backstop; C only if measurement shows A/B lose information. Do not start C before §15.5 produces a `q` and §15.4 produces a reuse rate.

---

## 18. Event sequence for one compaction (seal + land)

Concrete, in order. `pre-step` for turn 42, step 3, dispatcher session, `measure.totalTokens = 412,000`.

```
1.  [read]      agent/pre-step fires for our session.
2.  [check]     no unmatched compaction/start; 412,000 >= 100,000; passInFlight false.
3.  [select]    selectSpan -> {start: 4120, end: 4188}, rawTokens 47,900,
                toolPairingBalancedBefore/After both true.
4.  [build]     read the 69 raw nodes via the live surface / sessionQuery exact read.
                - episode e-7c3d (grep toggleSandbox + 5 reads) -> hit at seq 4152
                  -> 5 negative entries, anchor kept verbatim (excerpt E1)
                - cross-reference: quote at seq 4161 -> excerpt E2
                - access: edit at seq 4160 on 4152 -> E1 marked 'edited'
                - decisions: verbatim quotes at seq 4140, 4161
                - drops: 17 results, 41,200 tok
                render -> 7,760 chars, 1,940 tokens
5.  [gate]      1,940 < 0.5 x 47,900. Pass.
6.  [append]    plugin:multitask/janitor-pass {status:'planned', plan:{segments:[seg-1a2b3c4d], spans:[4120..4188]}}
7.  [append]    plugin:multitask/segment {id, span, sourceSeqs[69], recordSha256, excerpts, dropped}
                (log-only; no surface change yet)
8.  [append]    compaction/prune {shadowedRange:{4120,4188}, shadowedSeqs[69], shadowedTokenCount: 47,900}
                (heuristic price, computed with ctx.tokenMeter.estimateMessage per node)
9.  [append]    user/message (the rendered record)
                surfaceOp {op:'replace', startSeq:4120, endSeq:4188}
                sourceEventSeqs: [every one of the 69 shadowed seqs]
                -> this is the ONE surface write. Adjacent to step 8. No await between 8 and 9.
10. [append]    plugin:multitask/janitor-pass {status:'applied',
                applied:{replacementSeqs:[...], freedTokens:45,960, durationMs:23}}
11. [evict?]    live record tokens > recordBudget? Evict oldest:
                compaction/prune + user/message(stub) with surfaceOp replace of that
                record's own position, then plugin:multitask/segment-evicted.
12. [reindex]   if the live set changed, no surface index is emitted here.
                The pointer index is emitted only after a native compaction (§2.4).
13. [return]    next() -> the model request proceeds with the new surface.
```

If the process dies at any point, §14's table says exactly what resume does. The only non-recoverable state would be a surface write without a preceding record, and the order above makes that impossible.

---

## 19. Open questions implementation must not guess

1. **Does `appendPluginRecord` accept a type declared only by our package after `PluginRecordMap` augmentation, at runtime and across resume/fork?** ADR-0029 lists this as open. The whole data model depends on it.
2. **May a plugin emit `compaction/prune` outside the native pruner? — VERIFIED YES for 0.2.1-rc.2, with one caveat.** Evidence, read directly in the installed tree:

   - `compaction/prune` is in `KNOWN_SESSION_EVENT_TYPES` at `dsh-session/lib/index.js:90`, so `surfaceOpOf` (`:301`) treats it as a normal non-surface event rather than rejecting it as unknown.
   - The only validation it receives is `validateSessionEventData` (`dsh-session/lib/index.js:242`), which switches on `developer/message` and `request/header` only and does nothing for `compaction/prune`.
   - There is no caller check: the pruner emits it with a plain `session.append("compaction/prune", {…})` at `dsh-compaction-tool-result-pruner/lib/index.js:159-166`, with no capability, scope, or service check.
   - The token meter consumes it as a **shadow price**, not as a pruner claim: `dsh-token-meter/lib/index.js:213, 283` treat `compaction/summary` and `compaction/prune` identically. Any producer's `compaction/prune` before a `replace` is therefore priced correctly.

   **Caveat, and the third-party pattern you asked about:** `appendPluginRecord` carries a **documented repository policy gate**, not a runtime gate — `dsh-session/lib/types/index.d.ts:104-106` says "Only production source under `packages/experimental/` may call this function; the `verify-plugin-record-callers` gate rejects any other production caller in this repository." That gate is a source-tree lint in the dsh repo, not a check in the shipped package: the runtime path is `appendPluginRecord` → module-private `commitPluginRecord` → `Session.#appendRecord` (`dsh-session/lib/index.js:1270, 1295-1297, 1540, 1548-1562`), which validates only the `plugin:` grammar (`PLUGIN_RECORD_TYPE`, `:1248`) and JSON-serializability. **The same pattern under a different name** is exactly this: a *repository policy comment plus a CI verifier*, with no runtime guard. So an out-of-repo plugin can call it, and it will work in 0.2.1-rc.2 — but it is an unsupported extension point that a future release may gate. Record that as an accepted risk, and isolate the call behind one adapter function so a host change is a one-line fix.

   Remaining true risk: `surfaceOp replace` for our case must also work, and it does — see open question 3 for the one unverified provider-facing consequence.
3. **Does replacing a span that begins with an assistant message produce provider-valid history?** Native does exactly this (`dsh-compaction-basic:650-661`), but our spans are chosen by a different algorithm and may start at an assistant node more often. Verify with a real session.
4. **Does `agent/turn-stopping` fire for aborted and errored turns?** If not, `pre-step` is the only path and some turns will not seal until the next one.
5. **What are the actual cache read/write price ratios on the live provider?** §12 reports cost but does not decide on it, so this is no longer blocking. Needed only to print an honest dollar figure in the ticket.
6. **What is the real average record size?** 2,000-3,000 tokens is synthetic. Measure on 20 real worker transcripts before fixing `recordBudgetTokens`.
7. **Exact text format of `read` results.** The line-number prefix must be stripped by a stable rule. `formatReadOutput` was read but not against a live result.
8. **Exact text format of `grep`/`glob` results**, and whether paths appear in a parseable position.
9. **Does `sessionQuery.readEvent` work on the live session from our scope, and what is its latency?** If it is slow, `read_span` needs an in-memory fallback for current nodes.
10. **Does the dispatcher preset mount `read`/`grep`/`glob` for workers?** If workers are restricted by `src/worker/tool-barrier.ts`, the flagship rule has fewer subjects than assumed.
11. **Can native compaction's range selection start below our `sealCursor` and swallow land-able records?** Expected yes. Confirm, and confirm the cursor reset after `compaction/end`.
12. **Fork id stability.** `seg-<hash>` avoids seq encoding, but a fork that renumbers inherited events still needs its records to be findable. Verify `inheritedEventCount` semantics with a real fork.
13. **Whether the token meter prices a replacement `user/message` exactly with `estimateMessage`**, so the pressure projection does not drift (the protocol says it must; verify once).
14. **Whether the 50k segment target is right.** It is 7.4% of `T_native`. At 10k the fixed record overhead (~250 tokens) becomes 2.5% of the span and invalidations multiply 5x; at 100k the record budget per span grows and selection has to be smarter. 50k is argued, not measured.
15. **Whether workers should get the `retain` tool in option B.** If workers do not, the flagship "used but not quoted" gap stays open exactly where file reads happen.
16. **Whether `read_span` must redact anything** (secrets in tool output). No policy was found; do not invent one.
17. **Whether the janitor should run on worker sessions in v1 at all**, given the blast radius. This document says yes because otherwise the flagship rule has no material. That is a product decision, not an engineering one.

---

## 20. Source index

| Claim | Source |
|---|---|
| Native threshold, retained tail, replacement shape, lock events | `docs/research/compaction-stack-design-2026-10-19.md` §2 (host facts, not re-derived) |
| Native compaction mechanics and mounting | `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §3, §7, §8 |
| `surfaceOp replace` contract and `sourceEventSeqs` | `dsh-session/lib/types/types.d.ts:440-520` |
| `compaction/prune` shadow-price protocol and adjacency requirement | `dsh-compaction/lib/types/types.d.ts:76-105` |
| `appendPluginRecord` semantics and grammar | `dsh-session/lib/types/index.d.ts:94-127` |
| Token meter fields and heuristic price | `dsh-token-meter/lib/types/types.d.ts:24-55` |
| Pair-balanced cut helpers | `dsh-compaction/lib/index.js:80,91` |
| Exact-read path, search disabled | `dsh-session-query/lib/types/index.d.ts`; `dsh-base/cordis.patch.yml:150-161`; `dsh-web-app/cordis.patch.yml:20-30` |
| Read/write/edit tool names and parameters | `dsh-tool-fs/lib/index.js:251,549,690` |
| Glob/grep tool names | `dsh-tool-fs-search/lib/index.js:782,1090` |
| U-H (no local content-search index, no own token ledger) | `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` item 19 |
| Boundary-marker pattern and window source | `docs/adr/0029-deterministic-microcompact-boundary-marker.md` |
| Report clamp behavior (unchanged by this design) | `src/core/report-clamp.ts` |
| Policy injected once, survives nothing by construction | `src/adapter/parent-agent.ts:34-57, 322` |
| Worker contract survives by construction | `src/worker/preset.ts:12-23` |
| Owner directives (write-once, density, failed search, rewrite count irrelevant) | coordinator relay of the owner's 2026-10-19 messages; quoted in the header and §12 |
| Prior art for every mechanism; Gemini CLI span shape; arXiv:2609.20804 and :2608.23651 findings | `.scratch/repo-analysis/2026-10-19-failed-search-eviction-prior-art.md` |
| `q` census, 20 stored sessions, median 0.02 | run 2026-10-19; raw result `.scratch/testing/2026-10-19-q-census/result.json` (git-ignored, per the testing-artifacts rule) |

**Files this design would touch (for estimation only; nothing was edited):** new `src/core/janitor-select.ts` (span selection, episodes, excerpt priority), new `src/core/janitor-record.ts` (renderer, caps, hash), new `src/adapter/janitor.ts` (pre-step/turn-stopping wiring, pass records, eviction), new `src/adapter/janitor-tools.ts` (`segment_read`, `read_span`, `segment_list`), `src/plugin.ts` (config + wiring), `src/core/policy/prompts.ts` + `src/worker/prompt.ts` (the `retain` standing rule, option B only).
