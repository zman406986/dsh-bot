# Shadow context janitor: design proposal

- **Date:** 2026-10-19
- **Status: DESIGN PROPOSAL, EVIDENCE + MODELLED NUMBERS. NOT A RULING.** Nothing here is adopted. Every mechanism needs its own ticket. The LLM-in-the-loop layer changes what ADR-0029 decision 1 recorded ("no model call decides whether, when, or what to compact"), so it needs an explicit ADR amendment or superseding ADR before any code.
- **Owner's proposal (2026-10-19, relayed):** when non-pruned memory reaches ~50k tokens, summon a shadow agent to produce pruned memory, and swap it in at a window where the main session is not churning. He does not mind an LLM in the loop. He believes better ways likely exist.
- **Cache framing corrected by the owner (2026-10-19):** *"Number of rewrites is irrelevant, not something we have to optimize for. Also our 1M is effectively like 5x sessions of good context, not comparable with 1M of normal density context with lots of junk."* The earlier instruction ("do not be cache-destructive") is kept as a **cost fact**, never as the objective. §0 states the objective; §11 re-bases the cost model on retained useful context.
- **Not verified by execution.** Host API facts are code reading of `dsh@0.2.1-rc.2`; cost numbers are a parameterized simulation (§11), not measurements. Items flagged **UNVERIFIED** need a live pass.
- **Companion documents:** `docs/research/compaction-stack-design-2026-10-19.md` (§2 host facts, used as given) and `docs/research/segmented-compaction-design-2026-10-19.md` (the write-once deterministic layer this design must not duplicate). Two parallel agents produced `.scratch/repo-analysis/2026-10-19-provider-cache-mechanics.md` and `docs/research/cache-safe-pruning-design-2026-10-19.md`. **Important: the cache doc was written before the owner's correction and optimizes for invalidation count. Its mechanism facts are usable; its objective and its "fixed 50k is the wrong shape" conclusion are superseded here by §0.** Where its numbers would change a parameter, the mark is **[cache-doc dependent]**.

---

## 0. Objective

**The goal is to extend the useful working set of a long session — measured as retained useful tokens and task continuity — at an acceptable dollar cost. It is not to minimize rewrites.**

Three consequences, and they settle every tradeoff below:

1. **Rewrite count is a cost line, not a target.** If holding density needs 20 swaps in a session, 20 swaps is the right answer and the cost model states what they cost. Nothing in this design is contorted to reduce the count. Cache invalidation is still real money; it is simply not the thing being optimized.
2. **The unit of value is a dense token, not a cheap token.** A pruned 1M-token session is not comparable to an ordinary 1M-token session: the pruned one should carry roughly the useful content of **five ordinary sessions**. Comparing "our dense 1M" to "native's junk-heavy 1M" measures the wrong denominator. The honest denominator is *retained useful content* and *continuity*, and the honest competitor is **what the user does today instead**.
3. **The real baseline is the restart.** Today, a user whose session gets too fat starts fresh: re-reads files, re-explains the task, reloads conventions. That re-orientation has a token cost and a success cost, and it is the thing a dense long session replaces. §11.2 models it explicitly.

**Design rules that follow:**

| Do | Do not |
|---|---|
| Choose the seal/swap cadence for density and fidelity | Choose it for invalidation count |
| Report every rewrite's dollar cost honestly | Suppress a rewrite because it is "cache-destructive" |
| Compare against N fresh sessions + re-orientation | Compare against native's fat 1M as if it were equal goods |
| Treat a pruned 1M as ~5 sessions of useful room | Treat 1M pruned and 1M unpruned as the same product |

---

## 1. The recommendation in one page

**Adopt the mechanic, keep the owner's cadence, and make the model an escalation rather than the default.**

The owner's idea has three parts. All three survive. What changes is the *justification* and the *defaults*, not the shape.

| Part of the sketch | Verdict | Why |
|---|---|---|
| A cleanup that produces pruned memory | **Keep** | The density problem is the actual objective (§0), and the surface primitive (`surfaceOp replace`) is the right tool. |
| A shadow agent summoned to do it | **Keep, demoted to plan producer** | It never writes memory; it returns an edit plan a validator applies. That is what makes an LLM safe here. |
| A ~50k trigger | **Keep as the default cadence** | 50k is a density choice, not a cost choice. It gives 19–20 passes per 1M and a steady-state surface of ~145k instead of a 680k sawtooth. Its rewrite cost is stated in §11.3 and accepted; the cadence is not contorted to reduce it. |

**Recommended architecture (the six-line version):**

1. **Apply is synchronous and single-span.** Every janitor write is one `compaction/prune` plus one `user/message` with `surfaceOp {op:'replace', startSeq, endSeq}`, appended in one un-awaited block at `agent/pre-step` (or `agent/turn-stopping` when the turn is closing). Never mid-turn, never while native holds `compaction/start`.
2. **Plans are produced off the critical path.** Two producers: **D** (deterministic classifier, default, zero model cost) and **S** (shadow leaf agent, escalation, one LLM call). Both emit the same JSON edit plan; both are validated by the same validator.
3. **The trigger is density-driven.** Fire whenever the unpruned region reaches ~50k tokens (the owner's number). The only upper bound on a single span is a plan-input cap, so one outlier burst cannot produce an unreadable prompt. Cache state is *reported*, not obeyed: a cold cache is a reason to fire sooner, never a reason to wait.
4. **The model only proposes.** It emits seq numbers, char ranges, and short capped notes. The validator performs every byte copy from the raw log. Unmentioned nodes default to **keep**, so a truncated or hostile plan can only fail to shrink — never delete.
5. **One span, one swap, cut at the frontier.** A pass rewrites the frontier only; the suffix it invalidates is the new record plus the retained tail. That shape is chosen because it is correct and cheap to implement, not because it minimizes invalidation count. A `logRevision` compare-and-swap guards the apply; any mismatch discards the plan with no partial write.
6. **The useful ceiling is `0.5 × T_native` of records.** Above that the janitor stops and native compaction owns the session. That is a loss-fidelity boundary (records begin to crowd out raw tail), not a cache boundary.

**Ranking (see §15):** D-first hybrid (**b**, deterministic with S as escalation) > inline pre-step planner (**c**) > shadow-agent-default (**a**) > agent-authored retention (**d**). Ranking is by **density achieved per dollar of total cost**, not by invalidation count. The LLM's value is denser classification on prose-heavy spans; its cost is one span read per pass and is affordable at the owner's cadence.

---

## 2. What "non-pruned memory" means, exactly

Three different quantities get confused. Fix the vocabulary before any threshold.

| Term | Definition | Source |
|---|---|---|
| **Surface** | Ordered nodes the model sees after all `surfaceOp` folds: system, user, assistant, tool/result, checkpoints. | `session.surface.nodes` |
| **Surface tokens** | Route-priced request tokens of the current surface = `measure().surfaceTokens`. | `ctx.tokenMeter.measure` |
| **Pruned memory** | Surface nodes that a prior janitor/native pass has already replaced (records, checkpoints, cleared results). | Our pass records + native `compaction/summary` |
| **Non-pruned memory** | `surfaceTokens − tokensOf(alreadyReplacedNodes)`. This is the number the owner means. | Derived; **no host field exists for it** |

**How to compute it without a ledger (ADR-0018 U-H):** do not store per-stream prices. At each evaluation, walk `measure().nodes` and skip nodes whose seq was named in a `sourceEventSeqs` replacement of one of our own pass records or a native `compaction/summary.shadowedSeqs`. Both are in the log; both are read on demand. Cost is one linear scan of the node list — the same scan `measure()` already does. Nothing persists.

**Proposal — the trigger quantity:**

```
U = free-form growth since the last cut
  = surfaceTokens
  − Σ tokens(record nodes we wrote)
  − Σ tokens(retained tail we protected)
```

Do **not** use raw `totalTokens` as the owner's "50k": on this host that number includes the system prompt, tool schemas, the activation policy, and every record. At 500k of context most of it may legitimately be records. U is the only quantity that answers "how much unprocessed raw material is waiting to be cleaned."

---

## 3. Trigger: thresholds, hysteresis, cadence

### 3.1 Constants (derived from the native formula, never hard-coded)

```
W  = session.requestContext()?.contextWindow
O  = session.requestHeader()?.config.maxTokens ?? 0
M  = W − O
Tn = floor(min(0.8 × W, M − 65_536))        // 678,464 on this host
Rn = floor(M × 0.16)                          // 119,040
```

| Knob | Proposed | Rationale |
|---|---|---|
| `janitorStartTokens` | 100,000 (0.147 × Tn) | Below this, a pass reclaims too little to be worth a plan; it is a usefulness floor, not a cost floor. |
| `janitorSpanTokens` | 50,000 (0.074 × Tn) | The owner's number, used as the **cadence**. One pass per 50k of raw growth keeps the surface near 150k instead of a 680k sawtooth. |
| `janitorMaxSpanTokens` | 250,000 (0.368 × Tn) | A single plan's input is bounded, so one outlier burst cannot produce an unreadable 1M-token plan prompt. Not a cost device. |
| `janitorTailTokens` | 32,000 | Untouched working set; matches the segmented design. |
| `janitorRecordBudget` | `floor(0.5 × Tn)` = 339,232 | Fidelity ceiling: above it records crowd out raw tail and native should own the session. |
| `janitorMinCompression` | 0.5 (plan must halve the span) | Reject non-shrinking plans before they touch the surface. |
| `janitorCooldownPasses` | 3 → 6 → 12 | On consecutive validation failures. |
| `janitorEnabled` | false at first | Off until live numbers exist. |

**No invalidation-count knob exists, deliberately.** The cadence is `janitorSpanTokens`; the cost of that cadence is reported in §11 and accepted. Cache state is used only to *seize a free moment*, never to delay a pass that density wants.

### 3.2 Hysteresis

A bare threshold re-fires on the next request: prune at 50k, add 2k, prune again. Two brakes, both about avoiding redundant work, not about rewrites:

1. **Post-pass deadband.** No pass may fire in the same turn as a successful pass (`lastAppliedTurn === turn` → skip). This is a correctness rule: the surface just changed, so a second plan would be built on a different span.
2. **Minimum new material.** After a pass, the next one needs `janitorMinNewTokens = 20,000` of *new* raw material before it may fire. This prevents a pass whose span is almost entirely the retained tail. It is 40% of the owner's 50k and preserves the intended rhythm.

The geometric advance (`max(50k, lastSpan)`) is **removed as a trigger**; it was a cost optimization. `janitorMaxSpanTokens` remains as an input bound only.

### 3.3 The firing conditions

```
fire = (U >= janitorSpanTokens && newSinceLastPass >= janitorMinNewTokens)
     || nativeJustCompacted        // free moment: cache is already cold, so take it
```

The `nativeJustCompacted` clause is not a cost optimization; it is a **density opportunity**. Native just collapsed a span, so the surface has a fresh seam and the janitor can densify the material native summarized rather than waiting a full cadence.

**Idle-cold detection is now observability, not a trigger.** If the last N requests report `cacheReadTokens === 0`, record it in the pass record as `cacheWasCold: true`; the pass is then known to be nearly free. It does not change *whether* to fire. It is the number that makes the cost table honest.

**Piggyback semantics.** After `compaction/end` with no `error`, native has just rewritten the surface; a janitor pass in that same `pre-step` adds little marginal invalidation. Take it for the density gain and report the saving.

---

## 4. Snapshot: what the plan producer sees

**A frozen, seq-numbered rendering of one contiguous surface range.** Not a live handle, not a query API.

```
snapshot = {
  sessionId,
  startSeq, endSeq,            // surface-position span, inclusive
  logRevision: measure().logRevision,
  spanTokens,                  // sum of measure().nodes[].tokens in range
  nodeCount,
  render: string               // seq-tagged transcript, ≤ 60,000 tokens
}
```

Rules:

1. **Frozen at capture.** The render is a string built once. The main session may append freely; the shadow agent's input never changes.
2. **Seq-tagged.** Every line begins `[seq 4121]`. Without this the model cannot cite, and the plan is unusable.
3. **Span-limited.** The plan producer cannot name a seq outside `[startSeq, endSeq]`; the validator rejects it (V1).
4. **Rendered, not raw.** Tool results are rendered through the host's own `deriveMessages()` view so the model sees what the dispatcher sees. No private formatter.
5. **Boundary selection is deterministic** and runs in our process, not the model's:

```
selectSpan(session, measure, state):
  start = state.frontier ?? firstSealableNode(session)
  skip system/developer/user nodes in the protected head
  start = advance until toolPairingBalancedBefore(session, start)
  acc = 0; end = last node such that acc <= min(spanTarget, maxSpan)
  end = retreat until toolPairingBalancedAfter(session, end)
  end = retreat while tailTokens(end..newest) < janitorTailTokens
  if start > end or spanTokens < minSpan: return none
```

6. **The apply-time guard is not the snapshot.** At apply, the validator re-reads every cited node from the live log and compares `measure().logRevision`. The snapshot is an input to the model; it is never the source of truth for bytes.

**Why a rendering rather than a `read` tool.** A tool loop multiplies latency, lets the model wander outside the span, and gives it a write-adjacent surface. One prompt in, one JSON object out.

---

## 5. Shadow agent isolation

### 5.1 Which agent

A **spawned leaf subagent**, using the same host path our workers already use: `ctx.subagents.startActivation({provider: 'spawn', delivery: 'caller', request: {prompt, parent, maxDepth, outputSchema}})` (`src/adapter/cordis-dsh-host.ts:828`). `delivery: 'caller'` is load-bearing: the main session must not be woken by the janitor's completion, and the parent's model must never see janitor chatter.

| Property | Value | Why |
|---|---|---|
| Provider | `spawn` (in-process) | `dsh-subagent-spawn-in-process` advertises `outputSchema: true` and `agentPreset: true` (`lib/index.js:22-25`). |
| Depth | `parentDepth + 1` (absolute ceiling, via `workerSpawnMaxDepth`) | Same trap as ticket 83: sending the leaf budget 0 as `maxDepth` refuses every spawn. |
| Preset | **Not** the worker preset | The worker contract tells it to finish a task and report; a janitor needs a different contract. Use a dedicated `multitask-janitor` preset, or compose on `agent/created` as `applyWorkerComposition` already does (`src/worker/preset.ts`). |
| Tools | **None** | `tools.restrict({deny: allKnownGlobalToolNames})`. Our adapter already computes that set at `agent/created`; reuse `globalToolNames()`. |
| cwd | Ignored | With zero tools it cannot read or write the workspace even though the child inherits the parent's cwd. |
| Children | None | `WORKER_MAX_DEPTH = 0`; ADR-0003. |
| Output | JSON via `outputSchema` | Structured result; the model cannot answer in prose and still pass. |

**UNVERIFIED:** whether a zero-tool child is accepted by the spawn provider (a fully empty restriction is a legal deny list, but `tools.restrict` semantics for "deny all known" were not executed). Fallback: deny every tool name plus `subagent`, and accept that the child has no tools.

### 5.2 What the prompt contains

Exactly the snapshot render, the output schema, and one instruction: *classify each node; keep everything you are unsure about; never write content, only seq numbers and character ranges.* Roughly 400 tokens of instruction plus the span.

### 5.3 Why it cannot fabricate

The model's output is a **plan**, never prose that lands in memory. The validator copies the kept bytes from the raw log by offset. A hallucinated seq fails V1; a hallucinated range fails V2; a hallucinated note is capped, framed as a note, and never claims to replace content. The worst a fully hostile model can do is propose a plan that keeps everything (no-op) or fails validation.

---

## 6. Output schema

One JSON object, validated structurally before semantic checks.

```json
{
  "v": 1,
  "segmentId": "jan-1a2b3c4d",
  "snapshot": {
    "startSeq": 4120,
    "endSeq": 4188,
    "logRevision": 991,
    "sha256": "9f2c…"
  },
  "decisions": [
    { "seq": 4121, "action": "drop", "why": "no-use-signal" },
    { "seq": 4132, "action": "keep" },
    { "seq": 4155, "action": "replace",
      "keepRanges": [[120, 480], [2100, 2260]],
      "noteRef": "n1" }
  ],
  "notes": [
    { "id": "n1", "chars": 31, "text": "grep for toggleSandbox returned 0 hits" }
  ],
  "index": {
    "title": "sandbox launch wiring",
    "kinds": ["work", "search-episode"],
    "cites": [4140, 4161],
    "openThreads": ["confirm the 401 path after a double refresh failure"]
  }
}
```

### Field rules

| Field | Rule |
|---|---|
| `seq` | Must exist in the snapshot range and be a current surface node. Duplicates rejected. |
| `action` | Closed enum: `keep` \| `drop` \| `replace`. |
| `why` (drop) | Closed enum only: `no-use-signal`, `no-hits`, `superseded`, `duplicate`, `resolved-error`, `unreferenced`. **Free text is rejected** — a drop reason is not memory. |
| `keepRanges` | Character offsets `[start, end)` into the node's own rendered text, ascending, non-overlapping, in bounds. Only on `replace`. |
| `noteRef` | Must name a `notes[].id`. Only on `replace`. |
| `notes[].text` | ≤ 240 chars each; ≤ 1,200 chars total. Rendered inside a labelled `[note, not source]` block. |
| `index.title` | ≤ 120 chars. |
| `index.cites` | Every entry must be an existing seq in the snapshot. Never content. |
| Unknown fields | Rejected (`additionalProperties: false`). |
| **Unmentioned seqs** | **Keep.** The plan is a shrink-list, not an allowlist. |

The last rule is the safety property that survives every other failure. A truncated JSON object, a model that emits only three decisions, a validator bug that drops half the array — none of these can delete memory, only fail to reclaim it.

### What the renderer produces for the surface

```
[janitor] Context cleanup for seq 4120–4188. Nothing was deleted; raw content
remains retrievable by seq. 47,900 tok → 1,940 tok.

[kept seq 4132] <verbatim bytes copied by the validator>
[kept seq 4140] <verbatim bytes copied by the validator>
[excerpt of seq 4155, chars 120–480] <verbatim bytes>
[note n1, not source] grep for toggleSandbox returned 0 hits

[index] title: sandbox launch wiring | cites: 4140, 4161
[recover] read_span(4120, 4188)
```

The only authored text the model can inject is inside `[note …, not source]`. Everything else is a byte-for-byte copy performed in our code.

---

## 7. Validation checklist

Runs in our process, synchronously, against the live log — never against the model's claims.

**V1 — Well-formedness and bounds.**
Schema-valid, closed enums, every `decisions[].seq` and `index.cites[]` exists inside `[snapshot.startSeq, snapshot.endSeq]` and is a current surface node; every `keepRanges` pair is ascending, non-overlapping, and inside `[0, nodeChars)`; total note chars within cap.
*Reject:* non-JSON, unknown action, out-of-range seq, duplicate seq, note over cap.

**V2 — Verbatim provenance.**
For every `keep` and every `replace` range, re-read the node from the log (`ctx.sessionQuery.readEvent` or the live surface), slice it to the offsets, and hash the concatenation. Recompute `spanSha256` over the same span; if it differs from `snapshot.sha256`, the span changed under us.
*Reject:* hash mismatch, missing node, any range that would need bytes the model supplied.

**V3 — Structure and protected content.**
`toolPairingBalancedBefore(session, startSeq)` and `toolPairingBalancedAfter(session, endSeq)` both true; no tool pair split by any `keepRanges`; and none of the following appears in `decisions` as `drop`/`replace`: surface node 0 (system), any `user/message`, any `developer/message`, any native checkpoint, the current turn's task statement, the newest `janitorTailTokens` of surface, the newest error for the active task.
*Reject:* any protected node selected, any unbalanced cut.

**V4 — It must shrink.**
`projectedAfter ≤ janitorMinCompression × projectedBefore`, where both are computed with `estimateMessage` over the exact replacement message. If the replacement is not smaller, reject; never write a record larger than the span.
*Reject:* non-shrinking plan.

**V5 — Freshness compare-and-swap.**
At apply time: `measure().logRevision === snapshot.logRevision`, the set of surface seqs in `[start, end]` is identical to the snapshot's, no unmatched `compaction/start` exists, and no `compaction/end` landed after the snapshot.
*Reject:* any mismatch → discard the whole plan, write nothing, schedule a re-snapshot for the next safe point.

**V6 (auxiliary) — No invented identifiers.**
Every path, identifier, or number in `notes[].text` must appear as a substring of the snapshot render. This is cheap (`includes`) and catches the common hallucination shape: a note that invents a file that was never read. A failing note is dropped, not the whole plan.

**Rejection behavior.** All-or-nothing per plan. No partial apply, no "apply the good decisions." A rejected plan writes one `plugin:multitask/janitor-pass {status:'rejected', check, reason}` record and nothing else. After `janitorCooldownPasses` consecutive rejections the breaker opens for the session.

---

## 8. One janitor run, step by step

Dispatcher session, turn 42, `pre-step`, `measure.totalTokens = 412,000`, `U = 203,000`.

```
 1 [observe]  agent/pre-step fires. Gate: session is an activated dispatcher;
              janitorEnabled; no unmatched compaction/start; passInFlight false.
 2 [measure]  ctx.tokenMeter.measure(session) -> {totalTokens 412000, logRevision 991, nodes[...]}
              Compute U (non-pruned). U=203,000 >= janitorSpanTokens (50,000) and
              newSinceLastPass (203,000) >= janitorMinNewTokens (20,000). Fire.
 3 [select]   selectSpan -> {start 4120, end 4188, spanTokens 51,240}.
              toolPairingBalancedBefore(4120)=true, After(4188)=true,
              tail after 4188 = 34,100 tokens >= 32,000.
 4 [density]  Deterministic classifier yield on the span: 61% of bytes have a
              junk signal. Below the escalation floor? No -> plan locally, no model.
              (If yield were low, escalate this span to the shadow agent.)
 5 [snapshot] Render seq-tagged transcript of 4120-4188, hash it, freeze it.
              Write plugin:multitask/janitor-pass {status:'planned', snapshot}.
 6 [spawn]    ctx.subagents.startActivation({provider:'spawn', delivery:'caller',
                request:{prompt: render+contract, parent, maxDepth, outputSchema}})
              Child gets ZERO tools (scoped deny-all on agent/created).
              If spawn fails: append {status:'failed', error:'spawn'}; return next().
 7 [plan]     Child returns the JSON edit plan. Parent's turn is NOT blocked:
              step 6-8 run asynchronously; the apply happens at a LATER pre-step.
 8 [validate] V1-V4, V6 run now against the live log. A failure here costs nothing
              because nothing has been written. Record {status:'rejected', check}.
 9 [store]    Validated plan held in memory keyed by sessionId, with its snapshot
              hash and logRevision. Nothing durable is added (ADR-0018 U-H).
10 [safe]     At the next pre-step (or turn-stopping) for the same session:
              V5 CAS. logRevision unchanged? start/end still the same nodes?
              No native compaction in flight?
              -> yes: apply.  -> no: discard, go to 11.
11 [apply]    ONE synchronous block, no await between the two appends:
                compaction/prune { shadowedRange:{start,end},
                                   shadowedSeqs:[...], shadowedTokenCount }
                user/message (the render)
                  surfaceOp {op:'replace', startSeq:start, endSeq:end}
                  sourceEventSeqs: [...every shadowed seq]
12 [record]   appendPluginRecord('plugin:multitask/janitor-pass',
                {status:'applied', freedTokens, invalidatedSuffix,
                 cacheWasCold, durationMs})
              Update frontier = end; lastPassSpan = spanTokens.
              return next()  -> the model request proceeds with the new surface.
```

Step 7 is the key architectural move: **plan generation is not on the turn's critical path.** Steps 6–8 may take ten seconds; the dispatcher's turn is not waiting. Only steps 10–12 are synchronous, and they are pure appends.

---

## 9. Swap-in: exactly what lands, and when

### 9.1 The write

One `compaction/prune` (shadow price) immediately followed by one `user/message` carrying `surfaceOp {op:'replace', startSeq, endSeq}` and `sourceEventSeqs` naming every shadowed node. This is the native pruner's exact protocol (`dsh-compaction-tool-result-pruner/lib/index.js:189-200`) and native compaction's exact replacement shape (`dsh-compaction-basic/lib/index.js:650-661`). Adjacency is contractual: the metering event must be appended synchronously immediately before the replacement or the O(1) projection folds a zero delta and drifts (`dsh-compaction/lib/types/types.d.ts:76-105`).

`user/message` — not `assistant/message` — because a replacement must cite `sourceEventSeqs`, which `assistant/message` forbids structurally.

### 9.2 "Not actively churning" in host terms

| Phrase | Host fact |
|---|---|
| "a turn is open" | `agent.status === 'running'`, or an open `turn/start` with no `turn/end`. |
| "a step is in flight" | A live tool call has no matching `tool/result`. Pre-step only fires at step boundaries, so this is structurally false there. |
| "the surface is being written" | An unmatched `compaction/start` (native holds a durable lock). |
| "safe to append" | `agent/pre-step` (waterfall, before the model request) **or** `agent/turn-stopping` (serial, awaited before the turn closes) **or** `agent.runMaintenance(task)` while `status === 'idle'`. |

**Rule:** apply only at one of those three points, synchronously, in the same tick as the validity check. Because dsh is a single-writer process and the body contains no `await`, a turn cannot start between V5 and the append.

### 9.3 Why not `turn-stopping` as the primary

`turn-stopping` fires when the model owes no response; appending there rewrites the surface *after* the last request of the turn, so the invalidation is paid on the next turn's first request rather than the current one. That is fine, and it is strictly safer than `pre-step`. **Proposal: apply at `pre-step` when a plan is already validated, and use `turn-stopping` as the fallback for turns that end without another pre-step.** Both are step-boundary safe.

---

## 10. Concurrency and races

| Race | Detection | Action |
|---|---|---|
| Main session appends during the shadow run | `logRevision` differs at apply, or span node set changed | Discard the plan. Re-snapshot at the next trigger. No partial apply. |
| Two janitors for one session | In-memory `passInFlight` per session; a `janitor-pass {status:'planned'}` record with no newer `applied` | Second returns immediately. A *process-restart* second writer sees `planned` without `applied` and appends `aborted`, never replays. |
| Two dispatcher sessions | Different session ids | Independent state; no shared lock. Each session's surface is its own. |
| Session switches route/model mid-run | `session.requestContext()?.provider/model` differs from snapshot | Discard: the cache domain changed anyway, and the span pricing is route-specific. |
| A turn starts between validate and apply | Structurally impossible in-process (no `await` between V5 and append) | If it happens anyway (a second writer), the V5 CAS catches it. |
| Native compaction starts mid-run | `compaction/start` seq > `snapshot.logRevision` | Discard. Native wins every tie. |
| Native compaction starts between V5 and append | Cannot interleave in-process; cross-process, native's `compaction/start` precedes its own await | Our listener checks for an unmatched `start` in the same synchronous block as the append. |
| Process dies after `planned`, before `applied` | On resume, newest pass record is `planned` | Append `aborted`, reason `interrupted`; do not replay. The surface is consistent either way because the apply is all-or-nothing. |
| Process dies between `prune` and its replacement | On resume: a `compaction/prune` not immediately followed by a `replace` citing the same range | The surface is still the original (the prune is log-only); append `aborted` and continue. Do **not** try to re-land a plan whose snapshot may be stale. |
| Two plans validated, one superseded | Newest plan per session wins; older plan's `logRevision` no longer matches | Older plan discarded by V5 automatically. |

**No lock is durable and no lock is needed across processes.** dsh sessions are single-owner by construction; the `janitor-pass` record exists to make an interrupted pass readable to resume, not to arbitrate between writers.

---

## 11. Cost model

### 11.1 What is being measured

The owner's correction sets the denominator: **cost per unit of retained useful context**, not cost per session and not rewrite count.

Three things change:

1. **The baseline is the restart, not native's 1M.** Today, when a session gets too fat, the user starts fresh: re-reads the files, re-explains the task, reloads the conventions. That re-orientation both costs tokens and loses continuity. It is the real competitor.
2. **A dense 1M is ~5 ordinary sessions of useful room.** Comparing a pruned 1M to an unpruned 1M compares two different products. The unpruned one is mostly junk (§0).
3. **Rewrites are a line item.** They are reported, they are accepted, and they do not drive the design.

Assumptions (parameterized; none is a measured price):

| Symbol | Value | Note |
|---|---|---|
| `A` | 2,000 tokens per request | Dispatcher turn with a clamped report. |
| `r` | 0.10 | cache-read price ÷ full input price. **Unrecorded in this repo.** **[cache-doc dependent]** |
| `ρ` | 3.0 | output price ÷ input price. **[cache-doc dependent]** |
| `T_keep` | 32,000 | retained raw tail. |
| `c` | 5 | compression ratio of a span into its record. |
| useful fraction, native 1M | 0.75 | 25% of an ordinary long context is stale tool output, re-reads, dead ends. **Assumption, not measured.** |
| useful fraction, dense 1M | 0.95 | The janitor's job is to make this true. It is the target, and the thing §17 gates on. |
| re-orientation per restart | 42,000 raw tokens | 30k of re-reads + 2k of re-explained task + 10k of probing. Flows into every later request of the new session. **Assumption, not measured.** |
| restarts avoided | 4 | "our 1M is like 5 sessions" → a dense 1M replaces 5 fresh sessions, i.e. avoids 4 restarts. |

### 11.2 Absolute billing, 1M-token session (500 requests), modelled

| Configuration | Passes | Avg surface | Cache reads | Invalidated by rewrites | Plan cost | Total units |
|---|---|---|---|---|---|---|
| Native only (junk-heavy 1M) | 1 | 321,493 | 16.07M | 0.107M | 0.264M | **16.45M** |
| Janitor 50k, c=5, inline plan | 19 | 145,320 | 7.27M | 0.718M | 0.163M | **8.15M** |
| Janitor 50k, c=5, spawned plan | 19 | 145,320 | 7.27M | 0.718M | 1.018M | **9.00M** |
| Janitor 50k, c=8, inline plan | 19 | 111,975 | 5.60M | 0.654M | 0.163M | **6.42M** |
| **5 fresh sessions + re-orientation** | — | — | 5.05M | 5 × cold start | re-orientation rides each prefix: 5 × 98 req × 42k × r ≈ 2.06M | **7.11M** |

The last row is the one that matters. Each fresh session pays a cold start, and its ~42k of re-orientation is re-sent inside the prefix of every subsequent request in that session — that is where the 2.06M comes from, and it is why five restarts cost almost as much as one dense session.

### 11.3 The re-based comparison

| | Useful tokens retained | Total units | **Units per 100k useful tokens** | Relative |
|---|---|---|---|---|
| Native only (fat 1M) | 750,000 | 16.45M | **2,192,831** | 2.57× |
| Janitor 50k, c=5, inline | 950,000 | 8.15M | **857,642** | **1.00×** |
| 5 fresh sessions + re-orientation | 832,000 | 7.11M | **854,327** | 1.00× |

**The headline: the janitor costs the same per unit of useful context as restarting five times, and 61% less per useful token than letting native's 1M stay junk-heavy — while keeping continuity.**

That is the correct claim, and it is much stronger than the old "50% of native's bill" framing, because the old framing compared against a product the user would not accept (a 1M session that is 25% junk).

### 11.4 What each design choice costs, in useful-context terms

| Choice | Effect on units per 100k useful | Verdict |
|---|---|---|
| **20 rewrites at 50k cadence** | 0.718M invalidated tokens = 8.8% of the janitor's total. Removing all rewrites would improve the ratio by ~9%. | Accept. This is the "rewrite count is irrelevant" ruling in arithmetic: the whole rewrite budget is under a tenth of the total, and it buys a surface of 145k instead of 680k. |
| **Spawned plan instead of inline** | +0.85M units (+10%); ratio 857k → 947k per 100k useful. | Acceptable, not preferred. The spawn buys latency, not density. |
| **c = 8 instead of c = 5** | Ratio 857k → 675k per 100k useful (−21%). | The single largest lever. Selection quality is where engineering effort belongs. |
| **Whole-suffix rewrite instead of frontier cut** | +1.54M units (+19%). | Do not do it. Not because rewrites are sacred, but because this one is pure waste — it re-processes material that has not changed. |
| **Native only** | 2,192,831 per 100k useful. | Worst of the three. It is the thing being beaten. |
| **5 fresh sessions** | 854,327 per 100k useful. | Parity on money; loses on continuity. This is why density matters: at parity the janitor wins on the product axis (no re-orientation turns, no lost state, no repeated context). |

### 11.5 When the janitor is strictly more expensive than restarting

Two regimes, stated honestly:

1. **Short sessions.** Below `janitorStartTokens` (100k) there is nothing to do and the janitor never runs. Between 100k and ~300k, the fixed plan cost is a larger share of the bill and the ratio can exceed the restart baseline. The trigger floor exists to avoid this, not to save cache.
2. **Very long sessions past the record budget.** At 5M raw tokens the record set exceeds `0.5 × T_native`; the janitor's average surface approaches native's, and the density advantage decays. Handing off to native at that point is a **fidelity** decision (records crowd out raw tail), and it is the right one. Beyond that point the comparison returns to "native 1M vs restart", which is the pre-existing situation, not a regression caused by the janitor.

### 11.6 Native compaction cost, for scale

One call: input ≈ `Tn` mostly cache-read (`r × 678,464` ≈ 67,846 units), output up to 65,536 at `ρ` ≈ 196,608 units, total ≈ 264k units, plus one invalidation of the retained tail (~119k). At 1M that is 1.6% of the bill. The janitor's 19 plan calls cost 163k units at `r` — **about one native summary's worth of planning for the whole session.** That is the fairest one-line statement of the planning cost.

---

## 12. Cache facts (cost lines, not objectives)

The owner's correction is explicit: rewrite count is not the thing to optimize. These numbers stay in the document because they are true and because they must be reported honestly — not because they gate the design.

### 12.1 What the surface rewrite actually costs

**Strict prefix cache.** A rewrite at surface position N invalidates every cached token after N. A request's prompt is billed at `r × surface`; an invalidated suffix is billed at `(1 − r)` on top. If the provider's cache is chunked rather than strictly prefix-based, this is an overestimate and the janitor is cheaper. **[cache-doc dependent]**

### 12.2 Per-session totals at 1M

| Strategy | Passes | Invalidated tokens | Share of total bill | Hit rate |
|---|---|---|---|---|
| Native only | 1 | 107k | 0.7% | 99.93% |
| Janitor 50k | 19 | 718k | **8.8%** | 99.01% |
| Janitor 50k, whole-suffix rewrite | 19 | 2,257k | 19% | 96.9% |
| Piggyback pass (post-native) | 1 | ~0 extra | 0% | unchanged |

**Read this table as a budget, not a constraint.** The entire janitor rewrite budget is under a tenth of its bill. Twenty rewrites are affordable; that is why the cadence is set for density and not for cache.

### 12.3 The only rewrite rule that survives on merit

**Cut at the frontier, not across the whole history.** Not because invalidation count is sacred, but because re-processing unchanged bytes is waste with no density benefit. Concretely: when a pass replaces `[start, end]`, the invalidated suffix is the new record plus the raw tail — the material after the cut — not the whole surface. The whole-suffix variant costs +19% for the same density. This is an implementation rule, not a cadence compromise.

### 12.4 Two moments that are free, so use them

Both are now **density opportunities**, not cache optimizations:

- **After `compaction/end` without error.** Native already rewrote the surface and the prefix is cold from the checkpoint. A pass in the same `pre-step` adds little marginal invalidation, and it densifies the material native just summarized. Take it.
- **When the last N requests report `cacheReadTokens === 0`.** The cache is already dead (expired or broken upstream). A pass then is nearly free. Record `cacheWasCold: true` on the pass; do not change *whether* to fire on it.

### 12.5 Observability ring (in memory, per session)

```
on session/event('assistant/message') for our session:
  push {cacheRead, cacheWrite, uncached} into ring[8]

hitRate = Σ cacheRead / Σ (cacheRead + cacheWrite + uncached)
```

Used to fill `cacheWasCold` and `invalidatedSuffix` on the pass record. It does **not** gate a pass. No persistence, no per-stream ledger (ADR-0018 U-H: these are the host's own numbers, held in a bounded ring and discarded).

**UNVERIFIED:** whether `cacheWriteTokens` is reported consistently on the live route (the adapter maps both fields; a provider may omit them). If omitted, the ring degrades to "unknown" and the pass record says so.

---

## 13. Failure handling and circuit breakers

| Failure | Detection | Response |
|---|---|---|
| **Model returns junk / non-JSON** | V1 | Reject. One retry with a hardened prompt (the invalid output echoed back with "return only the schema"). Then cooldown 3 passes. |
| **Plan does not shrink** | V4 | Reject; do not write. Native remains. Count toward the breaker. |
| **Plan keeps junk** (keeps everything) | V4 passes trivially (it is the input) but the saving is 0 | Treat a plan whose projected saving is below 10% of the span as a no-op: write nothing, advance the trigger anyway (so the same span is not retried forever). |
| **Repeated validation failures** | 2 consecutive | Breaker open for the session: no more janitor passes. One `plugin:multitask/janitor-pass {status:'failed', reason:'breaker'}` record. Native handles the session from then on. |
| **Janitor spawn fails** | `startActivation` rejects, or the child settles with an error | Log-only record; no retry this pass; retry allowed next trigger. Three consecutive spawn failures → breaker. |
| **Model unavailable** | Provider error inside the child | Same as spawn failure. The dispatcher's turn is unaffected because the plan was never on its critical path. |
| **Child runs away** | Child exceeds the snapshot's span budget or takes longer than the turn's remaining work | `activation.dispose()` on a deadline; discard the plan. The child has no tools, so "running away" means only a long generation. |
| **Provider rejects the rewritten history** | `agent/request-error` immediately after an apply | Disable the janitor for the session (`failed` record), leave the surface as written, let native compact. One occurrence is enough. |
| **Native compacts while a plan is held** | V5 | Discard the plan silently. No user-visible effect. |
| **Record budget exceeded** | `liveRecordTokens > 0.5 × Tn` | Stop the janitor for the session; one record; native owns it. |
| **Process restart with `planned` and no `applied`** | Resume scan | Append `aborted`; never replay. |

**Posture: no silent retry loops.** One retry, then a cooldown, then a session breaker. The backstop is always native.

---

## 14. Interaction with native compaction

1. **Native wins every tie.** If `totalTokens ≥ T_native`, or an unmatched `compaction/start` exists, the janitor does not fire. The host is the backstop and holds the durable lock.
2. **The janitor must make native rarer, not replace it.** Every pass keeps the surface below `T_native` in the normal case. That is the intended effect.
3. **What if native fires while a janitor is running?** Nothing breaks. The plan's V5 fails (`logRevision` moved, or a `start` appeared), the plan is discarded, and the next trigger recomputes the span against the new surface. The janitor holds no lock and never blocks native.
4. **What if native fires immediately after a janitor apply?** Possible if the janitor's projected saving was optimistic. Native summarizes the records plus the tail. That is the residual loss the segmented design already documents: our records can be summarized by the host, and we cannot exempt them. The mitigation is the pointer index appended after `compaction/end` (ids and titles only), not a second compaction.
5. **The piggyback pass.** After `compaction/end` with no error: (a) reset the frontier to the node after the checkpoint; (b) run one aggressive pass (max span, best compression) because the cache is already cold and the surface already has a seam; (c) append the pointer index. It is the moment of least marginal rewrite cost — a free opportunity, not the primary cadence.
6. **Ordering inside `agent/pre-step`.** Our listener must register before native's and must **not await**. Registration order is set by profile boot order (ours before the preset mount) and is **UNVERIFIED** on a live boot. The reverse order is benign: native compacts, pressure drops, our pass no-ops.

---

## 15. Alternatives, ranked

### (a) Shadow janitor as specified

A spawned leaf produces the plan asynchronously; the plan is validated and applied at the next safe point.

- **Pro:** no latency on the user's turn; full model reasoning on the span; genuinely "like any other background agent".
- **Con:** the child reads the span with no shared prefix cache: +10% of the janitor total at 1M (9.00M vs 8.15M units), which is +12% per 100k useful tokens. It adds a session, a spawn lifecycle, and a snapshot/CAS protocol. It needs a new preset.
- **Score:** correct, and the most faithful to the owner's sketch. It loses to (b) on density-per-dollar and to (c) on cost, and wins on latency.

### (b) Deterministic janitor with a cheap LLM reserved for ambiguous spans — **RECOMMENDED**

Default path is the segmentation classifier already designed in `segmented-compaction-design-2026-10-19.md` (failed-search episodes, edit-target tracking, quote matching, dedupe). When a span has no deterministic junk signal above a floor, escalate *that span* to the shadow agent.

- **Pro:** zero model cost on the majority of spans (the bytes are in tool results, which the deterministic rules already catch); no fabrication risk on the default path; the LLM is spent only where it adds information. Best density per dollar of the four, because the expensive classifier runs only on spans with no deterministic yield.
- **Con:** two selection engines to maintain; the escalation rule needs a threshold that only live data can set.
- **Score:** highest density per dollar and lowest risk. **This is the recommendation.**

### (c) Inline pre-step planner (small model, strict validator)

No background agent: at `pre-step`, one small model call over the dispatcher's own prefix, then validate and apply.

- **Pro:** the call is a genuine prefix of the dispatcher's request, so its input is cache-read at `r` — the cheapest *model* option (+0% vs the deterministic default, vs +10% for (a)). No spawn, no snapshot protocol, no second session. The validator is identical.
- **Con:** the user's turn waits on the generation. At a 50k cadence that is a multi-second stall roughly every 25 requests. Tolerable, not free.
- **Score:** second. Best model-based shape; loses to (b) only because it pays a model call on every span rather than on ambiguous ones.

### (d) Agent-authored retention

The working agent calls `retain(seq, lines, why)` when it uses something.

- **Pro:** the only mechanism that captures *derived* use — the agent read five files, used nothing, learned a fact. Zero janitor cost; the write happens during work already being done.
- **Con:** adoption is the whole bet; an agent that forgets to mark loses exactly the content that mattered; over-prompting produces over-retention. It is also write-time, not cleanup-time, so it does not address a session that is already fat.
- **Score:** best as a **complement** to (b) inside the same cleanup pass, not as the architecture.

### Ranking

```
1. (b) deterministic default + shadow-agent escalation     <- recommend
2. (c) inline planner at pre-step
3. (a) shadow janitor as specified
4. (d) agent-authored retention (as a complement to b, not standalone)
```

**Does deterministic-only win now that rewrites are not the objective?** Less decisively than before, and the reason is instructive. Rewrite count never distinguished the options: the swap is identical whether a model or a rule chose what to keep. What distinguishes them is **density per dollar**:

- Deterministic-only: zero plan cost, but leaves prose-heavy spans unscored (keeps junk it cannot classify).
- (b): deterministic by default, model on ambiguous spans — buys density exactly where the deterministic rules yield nothing.
- (c): model on every span — same density as (a), cheaper input, but a stall on every pass.
- (a): model on every span, off the critical path — same density as (c), 10–12% more cost, no stall.

The owner's ruling removes the cache argument that used to favour the cheapest-input option. What remains is a straight density/cost tradeoff, and (b) wins it because it spends the expensive classifier only where the cheap one is blind.

---

## 16. ADR and constraint compliance

| Constraint | Status |
|---|---|
| **ADR-0018 U-H** — no local content-search index, no per-stream token ledger | **Holds.** Trigger uses `measure()`; retrieval is by seq; the cache observability ring is in-memory and discarded. The pass records are log-only, like ADR-0029's boundary marker. |
| **ADR-0006 / A5** — no second database | **Holds.** Everything durable is `plugin:multitask/*` records in the session log. |
| **ADR-0003** — workers are leaves | **Holds.** The shadow agent spawns nothing (`maxDepth` ceiling, no delegation tool). |
| **ADR-0024** — stock dsh UI never displaced | **Holds.** No UI surface. |
| **ADR-0029 decision 1** — deterministic decision, no model in the loop | **DOES NOT HOLD for the shadow path.** The whole point of (a)/(c) is a model deciding what to drop. This needs an explicit ADR amendment. Design (b) keeps the default path compliant and isolates the model to the escalation, which is the smallest possible amendment. |
| **ADR-0029 decision 3** — boundary is the success marker resume reads | **Holds** if the `janitor-pass` record is written `planned` → `applied`/`aborted`/`failed`, as specified. |
| **ADR-0027** — roster rides at the prompt tail | **Holds.** The roster is a `user/message` in the protected set; never selected. |

---

## 17. Open questions implementation must not guess

1. **Is the provider cache actually a strict prefix cache, and what is its granularity and TTL?** The DeepSeek adapter README says an unchanged assembled prefix is eligible for reuse and any history change prevents reuse "from the first affected token" (`dsh-llm-deepseek/README.md:181`). §12's cost lines rest on this. **UNVERIFIED** — the parallel cache doc owns this. It changes the reported cost, not the design: the cadence is chosen for density either way.
2. **Are `cacheReadTokens`/`cacheWriteTokens` reported on the live route?** The adapter maps both (`dsh-llm-deepseek/lib/index.js:1826-1827`); whether the provider emits them consistently is unverified. Without them the pass record says `cacheWasCold: unknown`; nothing else changes.
3. **Does a zero-tool spawned child start at all?** `tools.restrict({deny: [every known name]})` is legal, but "deny all" was not executed. Fallback: deny everything except no-op tools.
4. **Is `startActivation` with `outputSchema` accepted by the `spawn` provider on this profile?** Capability is advertised (`dsh-subagent-spawn-in-process/lib/index.js:22-25`); not executed.
5. **Can a plugin append `compaction/prune` outside the native pruner?** The type says "any surface-replacing producer may use it"; runtime gate not exercised. This is a hard dependency.
6. **Is `measure().totalTokens` the same quantity native compares?** Native compares it directly, so yes by construction; needs one live confirmation that it rises as expected.
7. **Listener ordering inside `agent/pre-step`.** We must run before native and must not await. Verify on a boot; the reverse is benign.
8. **Exact `user/message` replacement acceptance when the span starts on an assistant node.** Native does this; our spans differ.
9. **Does the token meter price a replacement `user/message` exactly with `estimateMessage`**, so the pressure projection does not drift? Verify once.
10. **What is a real span's compression ratio `c`, and what is the real useful-content fraction of a long session?** §11 uses c=5 and 0.75/0.95; both are assumptions. These two numbers decide whether the density claim holds. Measure on 20 real worker transcripts and a handful of long dispatcher sessions before enabling.
11. **What does re-orientation actually cost?** §11.1 models 42k tokens per restart (re-reads + re-explanation + probing). Nobody has measured it. It is the entire competitor term, so it deserves a measurement before the comparison is quoted to the owner.
12. **Does `agent/turn-stopping` fire for aborted and errored turns?** If not, `pre-step` is the only apply point and some turns will not apply until the next.
13. **The escalation threshold in (b)** — what deterministic yield makes a span "ambiguous enough" to spend a model call? No data yet.
14. **Whether the janitor should touch worker sessions at all.** The bytes are in worker transcripts, but the blast radius is every worker. Product decision, not engineering.
15. **Provider prices** for `r` and `ρ`. The repo records none; every figure above is in cost units, not money.

---

## 18. Evidence index

| Claim | Source |
|---|---|
| `T_native = 678,464`, `R_native = 119,040`, threshold formula | `docs/research/compaction-stack-design-2026-10-19.md` §2; `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §3 |
| `measure()` shape, `logRevision`, `heuristicTokens` | `dsh-token-meter/lib/types/types.d.ts:24-55` |
| `surfaceOp replace`, `sourceEventSeqs`, surface-eligible types | `dsh-session/lib/types/types.d.ts:440-476` |
| `compaction/prune` adjacency and shadow-price protocol | `dsh-compaction/lib/types/types.d.ts:76-105` |
| Native pruner write shape | `dsh-compaction-tool-result-pruner/lib/index.js:189-200` |
| Native replacement shape | `dsh-compaction-basic/lib/index.js:650-661` |
| Pair-balance helpers | `dsh-compaction/lib/index.js:80, 91` |
| Pre-step / turn-stopping / `runMaintenance` | `dsh-agent/lib/types/runtime-types.d.ts:174, 304-311, 387` |
| Cache usage fields | `dsh-llm/lib/types/types.d.ts:152-174`; `dsh-llm-deepseek/lib/index.js:1826-1827` |
| Prefix-cache assumption | `dsh-llm-deepseek/README.md:181` |
| Spawn provider capabilities / `toolFilter` composition | `dsh-subagent-spawn-in-process/lib/index.js:22-25`; `dsh-subagent/lib/index.js:370-395` |
| Our spawn path, `workerSpawnMaxDepth`, tool barrier | `src/adapter/cordis-dsh-host.ts:800-850`; `src/worker/agent-def.ts`; `src/worker/preset.ts`; `src/worker/tool-barrier.ts` |
| Activation policy injected once (compaction-vulnerable) | `src/adapter/parent-agent.ts:34-57, 322` |
| Worker contract survives by construction | `src/worker/prompt.ts`; `src/worker/preset.ts` |
| U-H, A5, A5/ADR-0006 | `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:41` |
| ADR-0029 decisions 1–7 | `docs/adr/0029-deterministic-microcompact-boundary-marker.md` |
| Cost figures | Parameterized simulation, this document §11; **modelled, ±30%**, not measured |

**Files this design would touch (estimation only; nothing was edited):** new `src/core/janitor-plan.ts` (schema + renderer), `src/core/janitor-validate.ts` (V1–V6), `src/core/janitor-select.ts` (span selection + 50k cadence), `src/adapter/janitor.ts` (spawn, apply, pass records, cache observability ring), `src/worker/janitor-prompt.ts`, `src/plugin.ts` (config + wiring). Roughly **900 production lines + 500 test lines**. No new npm dependencies, no new database, no new UI.
