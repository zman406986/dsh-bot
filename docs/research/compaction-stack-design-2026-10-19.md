# Context compaction stack: design proposal

- **Date:** 2026-10-19
- **Status: EVIDENCE + DESIGN PROPOSAL. NOT A RULING.** Nothing here is adopted. Every layer below needs its own ticket, and any layer that changes a recorded decision needs an explicit ADR amendment or a superseding ADR.
- **Why this document reopens ADR-0029.** ADR-0029's "microcompact only" and "no full compaction" clauses were agent extrapolation, not a human ruling. The human's actual 2026-10-18 directive (recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 6) was: adopt ZCode's **boundary marker + microcompact**. It did not ban the rest. This document designs the best stack the human can choose from, states what each option costs, and leaves the choice to him.
- **Host under inspection:** `dsh@0.2.1-rc.2` at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`. All package line references are to that tree.
- **Evidence files read for this design:** `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` (primary), `2026-10-19-grokbot-compaction-deep.md`, `2026-10-19-dsbot-compaction-deep.md`, `2026-10-18-memory-compaction.md`, `2026-10-18-zcode-lane-memory.md`, `2026-10-19-online-gemini-grok-devin.md`, `2026-10-19-online-claude-code-codex.md`, `2026-10-19-online-cursor-windsurf.md`, `2026-10-19-online-cline-kilo-roo.md`, `2026-10-19-online-kiro-aider-openhands.md`, `2026-10-19-online-trae-qoder-codebuddy.md`, `2026-10-18-open-questions-resolved.md`. All present; none missing.
- **Not verified by execution.** Everything below is code reading + composed config. No live compaction has been run on this host (the native evidence file says the same: no stored session ever crossed the threshold).

---

## 1. The recommendation in one page

dsh already ships more compaction machinery than any of the studied harnesses except Claude Code: a model-free tool-result pruner, a cache-reusing LLM summarizer, image offload, a token meter, pair-balancing helpers, and `/compact`. **The missing piece is not "compaction" — it is a cheap layer that fires before the 678k-token summarizer and a durable marker our plugin owns.**

Recommended ladder, in firing order (numbers for the live host: W=1,000,000, O=256,000):

| # | Layer | Fires at | LLM? | Owner |
|---|---|---|---|---|
| L0 | Emission + prompt/cache discipline | always | no | us (mostly exists) |
| L1 | Microcompact: clear old tool results, keep newest 5 groups | 542,771 tokens (0.80 × native threshold) | no | our plugin |
| L1b | Deep microcompact pass | 610,617 tokens (0.90 × native) | no | our plugin |
| L2 | Native head/middle/tail pruner | 678,464 (inside native) | no | dsh config |
| L3 | Native full summary | 678,464 | yes, ≤65,536 out | dsh config |
| L4 | Native overflow recovery | provider error | yes, ≤1 retry | dsh config |
| L5 | Last-resort deterministic fold + circuit breaker | provider error, no native | no | our plugin |

The single most important design constraint: **all our triggers are defined as fractions of the native threshold `T_native`, computed with dsh's own formula.** If the human changes `thresholdRatio` or `retainRatio`, our layers re-scale automatically and keep the ordering. Hard-coding 542k would break the moment the host config changes.

The single most important cost: **microcompact is cache-hostile.** Clearing a tool result rewrites the surface from that node onward, invalidating the provider prefix cache downstream of it. It is worth doing only in the band where the alternative is an LLM summary. Do not run it as routine housekeeping.

---

## 2. Verified host facts this design rests on

Only the facts the design depends on. Citations are to the installed tree.

1. **Native threshold.** `dsh-compaction-basic/lib/index.js:124-134`:
   `messageBudget = W - O`; `pressureBudget = messageBudget - headroom(65,536)`;
   `thresholdTokens = floor(min(W × 0.8, pressureBudget))`; `retainTokens = floor(messageBudget × 0.16)`.
   On this host: `744,000 - 65,536 = 678,464` threshold, `119,040` retained tail. Gate is `totalTokens >= thresholdTokens` (`:940-941`).
2. **The summarizer is one LLM call over the real prefix.** The instruction is appended as the final user message so the provider cache is reused (`:243`, `:292-338`). Output cap defaults to `headroomTokens` = 65,536 (`:63-64`).
3. **Non-shrinking summaries are rejected** (`:601`), and the replacement is one `user/message` with `surfaceOp {op:'replace', startSeq, endSeq}` (`:650-661`), bracketed by `compaction/start` … `compaction/end` (`dsh-compaction/lib/types/types.d.ts:21-76`).
4. **The pruner is model-free and deterministic.** Defaults `thresholdChars 8192 / headChars 4096 / tailChars 1024` (`dsh-compaction-tool-result-pruner/lib/index.js:10-14`). For each oversized result it appends `compaction/prune` and then a replacement `tool/result` with `surfaceOp replace` and `sourceEventSeqs:[seq]` (`:189-200`). It runs **only** when called: by `compaction-basic` after the threshold is crossed (`dsh-compaction-basic/lib/index.js:926-946`) or at overflow. It is not an early layer by itself.
5. **The write protocol is contractual.** The metering event must be appended **synchronously immediately before** its surface replacement, or the O(1) pressure projection folds a zero delta and drifts (`dsh-compaction/lib/types/types.d.ts:76-105`).
6. **Pair safety helpers exist and are exported:** `toolPairingBalancedBefore/After` (`dsh-compaction/lib/index.js:80,91,175`).
7. **A plugin can write log-only records safely** with `appendPluginRecord(session, 'plugin:owner/name', data)` (`dsh-session/lib/types/index.d.ts:94-117`). Records are `ignorable`, never enter the surface, and survive fork/resume. Unknown types without the marker make replay refuse the session (`dsh-session/lib/types/types.d.ts:495-508`).
8. **A plugin sees every agent's `agent/pre-step`** if it registers on an outer scope ("an outer scope receives descendants" — native evidence §7). Consequence: **our listener must gate on dispatcher session id**, or it would rewrite a user's ordinary chats.
9. **`agent/pre-step` is a waterfall** carrying `{agent, messages, turn, step, signal}` and returning `{kind:'enter'|'reject'}` (`dsh-agent/lib/types/runtime-types.d.ts:92-100, 304-311`). Native compaction uses exactly this hook.
10. **Measurement.** `ctx.tokenMeter.measure(session)` returns `{totalTokens, surfaceTokens, nodes[{seq,tokens,heuristicTokens}], baseline, logRevision}` (`dsh-token-meter/lib/types/types.d.ts:24-55`). The window comes from `session.requestContext()?.contextWindow`; the output reserve from `session.requestHeader()?.config.maxTokens`. Do **not** use `contextPressure.contextWindow` as the denominator (`dsh-token-meter/lib/types/projection.d.ts:41-59`).
11. **Mounting.** The web bundle disables the host-plane `compaction-basic`, `command-compact`, and `tool-result-pruner` and each preset mounts its own isolated group (`dsh-web-app/cordis.patch.yml:539-546`; `dsh-web-app/presets/standard.patch.yml:66-82`). The token meter deliberately stays host-plane. The preset group does `isolate: {compaction: true, toolResultPruner: true}`.
12. **`compaction-basic` has an `auto` switch** (`dsh-compaction-basic/lib/types/types.d.ts:36-40`). `auto:false` disables both the pressure and the overflow listeners; `/compact` still works because `command-compact` calls `compactNow` directly.

### 2.1 The one thing the current design gets wrong

The dispatcher policy is injected **once, as a user message at activation** (`src/adapter/parent-agent.ts:34-57`, `src/plugin.ts` activation path). That message sits near the head of the log. **Any full summary will shadow it.** A summary prompt may preserve "constraints" in prose, but the policy is not structurally protected — unlike the worker contract, which lives in a preset system-prompt section (`src/worker/prompt.ts`, `src/worker/preset.ts`) and therefore survives compaction by construction.

Two candidate fixes, both cheap:
- **Preferred:** move the dispatcher policy to a per-agent `agent.ctx.systemPrompt.section` (same text every turn → also byte-stable for the cache). ~60 lines, and it never needs re-pinning.
- **Fallback:** listen for `compaction/end` with no `error` and re-inject the policy as a tail user message. ~30 lines, but it re-introduces a mutable message and one more cache miss.

This matters for every option below, including "do nothing else". It should be its own ticket.

---

## 3. The recommended ladder, layer by layer

### L0 — Emission and prompt/cache discipline (no measurement)

- **Trigger:** always.
- **Action:** keep the prefix byte-stable; put every per-turn varying text at the tail; keep report clamps; do not re-inject policy or rules mid-history.
- **LLM:** no. **Owner:** us; mostly already shipped.
- **Cost:** zero.
- **What it protects:** the provider cache, and therefore the price of every request. Also the thing that makes L1 rare.
- **Already true:** policy injected once, ledger + standing rules re-injected per turn, report clamp 4,000/1,200/200/300 chars and 20 roster rows (`src/core/report-clamp.ts:17-35`).
- **New in this design:** a **pressure-aware emission mode**. When `totalTokens ≥ 0.5 × T_native` (339,232 on this host), compose wake turns in lean form: worker report clamp 1,200 chars instead of 4,000, omit the activity digest, keep the ledger. This changes only *future* text; it never rewrites history. ~80 lines. Cost: slightly less detail in a wake turn; the full report is still in the worker transcript.

### L1 — Microcompact (clear old tool results)

- **Trigger:** `measure.totalTokens >= floor(T_native × 0.80)` = **542,771** on this host. Evaluated in `agent/pre-step`, dispatcher sessions only. Also evaluated lazily on the first pre-step after ≥ 60 minutes idle, with a lower bar (see §4).
- **Action:** replace the content of selected old `tool/result` nodes with a one-line placeholder. Keep the newest **5** tool-result groups and everything inside the newest **32,000** tokens untouched. Clear oldest-first, stop as soon as **8,000** tokens have been freed. If 8,000 cannot be freed, write nothing.
- **Write protocol:** for each selected node, in one synchronous block: append `compaction/prune {shadowedRange, shadowedSeqs:[seq], shadowedTokenCount: heuristicTokens}`, then append `tool/result` copying the original data with only `content` replaced, `surfaceOp {op:'replace', startSeq:seq, endSeq:seq}`, `sourceEventSeqs:[seq]`. Exactly the native pruner's shape (`dsh-compaction-tool-result-pruner/lib/index.js:189-200`), so the pressure projection stays correct.
- **LLM:** no.
- **Owner:** our plugin.
- **Cost:** zero model tokens; a handful of appends; one cache invalidation from the oldest cleared node; milliseconds. Token savings are real but the cache rebuild on the next request can cost more than one request's savings. That is why it is gated to the band just below the summarizer.
- **What it protects:** avoids a summary (up to 65,536 output tokens plus the latency of one long call) and keeps the verbatim tool outputs the dispatcher is actually working from.
- **What it must never touch:** the system message; any `user/message`; any `assistant/message`; image blocks (offload is native); the newest 5 groups; the newest 32k of tokens; anything inside the protected tail.

### L1b — Deep microcompact pass

- **Trigger:** `totalTokens >= floor(T_native × 0.90)` = **610,617**, after L1 has already run and pressure is still above.
- **Action:** same as L1 with keep = newest **2** groups, tail protection **16,000** tokens, and error results become eligible. Minimum saving still 8,000.
- **LLM:** no. **Owner:** our plugin. **Cost:** same as L1, one more cache invalidation. **Protects:** the gap between L1 and the summarizer.
- **Hard cap:** one deep pass per turn. If pressure is still ≥ `T_native` after it, hand off to native; do not loop.

### L2 — Native head/middle/tail pruner

- **Trigger:** inside `compaction-basic`, at `T_native` or at overflow (`dsh-compaction-basic/lib/index.js:926-946`).
- **Action:** for any single tool result over 8,192 chars, keep 4,096 head + 1,024 tail and a marker in the middle.
- **LLM:** no. **Owner:** dsh config. **Cost:** ~zero.
- **Why it is not L1:** it only fires after the threshold is crossed. It handles the case microcompact cannot — one enormous result — and it is cheap enough that we keep it exactly as shipped.
- **What it protects:** a single oversized result from consuming the window in one step.

### L3 — Native full summary

- **Trigger:** `totalTokens >= T_native` = **678,464**, one attempt plus `compactionRetries` (default 1).
- **Action:** one LLM call that replays the conversation's own system prompt, tools, and prefix, appends the 8-section instruction as the final user message, and replaces the selected span with a framed checkpoint message. Retains the newest 16% (119,040 tokens) verbatim and never splits a tool pair.
- **LLM:** yes. Input up to ~678k (mostly cache-read), output capped at 65,536.
- **Owner:** dsh config.
- **Cost:** the single most expensive routine event in the session; lossy; invalidates the prefix cache from the summary position onward.
- **What it protects:** the session from hard failure when everything cheaper has been exhausted.
- **v1 configuration:** keep the defaults (`thresholdRatio 0.8`, `retainRatio 0.16`, `headroomTokens 65,536`, `compactionRetries 1`, `maxOverflowRetries 1`). Do not tune until L1 has run live for a while.

### L4 — Native overflow recovery

- **Trigger:** `agent/request-error` with `CONTEXT_WINDOW_EXCEEDED` (`dsh-compaction-basic/lib/index.js:861-887`).
- **Action:** run the pruner, then summarize with `retainTokens = 0`, then `{kind:'retry'}`; at most `maxOverflowRetries` (1) per turn.
- **LLM:** yes. **Owner:** dsh config. **Cost:** one extra call, plus the request that already failed.
- **What it protects:** the turn from dying because the estimate was low.

### L5 — Our last-resort fold and circuit breaker

- **Trigger A (fold):** `agent/request-error` with `CONTEXT_WINDOW_EXCEEDED`, and the waterfall reached our listener with no retry returned (i.e. native is absent, disabled, or out of retries), and we have not already used our one shot this session.
- **Action:** deterministically clear **every** eligible tool result except the newest group, verify a real saving, then return `{kind:'retry'}`. If no saving is possible, do not retry.
- **Trigger B (breaker):** two consecutive failed L1/L1b passes, or a non-shrinking summary seen twice. Stop attempting for the session; append one `plugin:multitask/compaction-boundary` record with `status:'failed'`; leave native to deal with it.
- **LLM:** no. **Owner:** our plugin.
- **Cost:** ~80 lines; risk of clearing more than the user would like in a genuine emergency, which is the point.
- **What it protects:** the turn (Cline's model: recover deterministically when the provider rejects), and the operator from an infinite retry loop.

---

## 4. Exact configuration

All triggers are fractions of `T_native`, computed each step:

```
W  = session.requestContext()?.contextWindow
O  = session.requestHeader()?.config.maxTokens ?? 0
M  = W - O
Tn = floor(min(0.8 * W, M - 65_536))
Rn = floor(M * 0.16)

L1  fires at  floor(Tn * 0.80)   = 542,771   (54.3% of W, 73.0% of M)
L1b fires at  floor(Tn * 0.90)   = 610,617   (61.1% of W, 82.1% of M)
L2/L3 fire at Tn                 = 678,464   (67.8% of W, 91.2% of M)
```

| Knob | Proposed value | Rationale |
|---|---|---|
| `microcompactEnabled` | `true` | master switch; default off until the live pass |
| `microcompactTriggerRatio` | `0.80` of `Tn` | leaves 20% of the native budget (135,693 tokens) for the pass to matter |
| `microcompactDeepRatio` | `0.90` of `Tn` | one last chance before the summary |
| `microcompactKeepGroups` | `5` | ZCode's keep-5; matches how a dispatcher reads its last few tool calls |
| `microcompactTailTokens` | `32,000` | the working set, much smaller than native's 119,040 retained tail |
| `microcompactMinSavingTokens` | `8,000` | Kilo requires 20k freed, ZCode 256; 8k is ~1.2% of `Tn` and enough to be worth a cache rebuild |
| `microcompactMaxFreedTokens` | `floor(Tn * 0.25)` = 169,616 | never nuke more than a quarter of the budget in one pass |
| `microcompactKeepGroupsDeep` | `2` | deep pass only |
| `microcompactTailTokensDeep` | `16,000` | deep pass only |
| `idleMicrocompactMinutes` | `60` | lazy evaluation at the next pre-step; no timer |
| `idleMicrocompactRatio` | `0.30` of `Tn` = 203,539 | below this the pass is pointless |
| `pressureLeanEmissionRatio` | `0.50` of `Tn` = 339,232 | lean wake text before the first microcompact |
| `overflowFallbackEnabled` | `true` | one deterministic fold per session |
| `nativeCompaction` | leave `auto:true`, defaults unchanged | backstop; do not tune in v1 |

**Why 0.80 and not 0.90.** A single dispatcher turn can add ~1,200 tokens (a 4,000-char report plus a reply), so a 10% gap (67,847 tokens) is plenty of room. Firing at 0.90 first would leave only one turn of headroom before the summary and would make the deep pass nearly unreachable.

**Why the idle pass is the only unambiguous win.** After ≥ 60 minutes the provider prefix cache has expired anyway (the studied harnesses converge on 1h caches; Claude Code even compacts at ~54 min to beat expiry, `online-claude-code-codex` §1.1). Rewriting the surface then costs nothing in cache terms and makes the next cold write smaller. Threshold 0.30 × `Tn` avoids doing work on short sessions.

**Ordering guarantee.** Our listener must run in the same `agent/pre-step` waterfall, before native's, and synchronously. Native's listener awaits an LLM call, so if ours is after it, native will already have summarized. Register ours first (profile boot happens before preset mount) and verify the order live. If ours runs after native, the failure mode is benign: native summarizes, pressure drops, our pass no-ops.

---

## 5. What we build vs what we configure

**dsh already ships, do not rebuild:**

| Capability | Package | Use |
|---|---|---|
| Measuring usage and per-node prices | `dsh-token-meter` | `ctx.tokenMeter.measure(session)` |
| Head/middle/tail pruning of oversized results | `dsh-compaction-tool-result-pruner` | keep as-is (L2) |
| LLM summary with cache-reusing prefix | `dsh-compaction-basic` | keep as-is (L3) |
| Overflow recovery | `dsh-compaction-basic` | keep as-is (L4) |
| Image offload | `dsh-compaction-image-offload` | keep as-is |
| Manual `/compact` | `dsh-command-compact` | keep as-is |
| Pair-balanced cuts | `dsh-compaction` exports | call in our selector |
| Surface replacement + shadow pricing | `dsh-session` | use the documented append protocol |

**Genuinely missing, ours to build:**

| Piece | Where | Size |
|---|---|---|
| Pure selector: given surface nodes + prices + config, return the node set and projected saving | `src/core/compaction-select.ts` (new) | ~180 lines + ~250 test lines |
| Pure rewriter: original event → placeholder content, guaranteed smaller | same file | ~40 lines |
| Pre-step listener: gate on dispatcher session, compute `Tn`, measure, run L1/L1b, write markers | `src/adapter/compaction.ts` (new), wired in `src/plugin.ts` | ~200 lines |
| Boundary records: planned/applied/aborted/failed, plus resume scan | same file | ~80 lines |
| Policy survival: move policy to a system-prompt section (preferred) or re-inject on `compaction/end` | `src/adapter/parent-agent.ts` | ~60 lines |
| Pressure-aware wake emission | `src/plugin.ts` `composeWakeText` + `src/core/report-clamp.ts` | ~80 lines |
| Last-resort overflow fold + breaker | `src/adapter/compaction.ts` | ~80 lines |
| Config fields (10, volatile, flat) | `src/plugin.ts` | ~40 lines |

Total: roughly **700 production lines + 400 test lines**, about **4 working days**. No new npm dependencies. No new database. No LLM seam.

**What we must not do:** mount a second `compaction-basic` at the host plane. The preset's copy is isolated, and an outer-scope copy would fire for the same agents, producing two summaries and two locks. Configure the preset's row, or do nothing to it.

---

## 6. The boundary marker

### 6.1 Shape

One plugin record type, written twice per pass:

```ts
// declared in our package via module augmentation of PluginRecordMap
interface CompactionBoundary {
  v: 1;
  passId: string;                    // uuid; the rollback unit's identity
  status: 'planned' | 'applied' | 'aborted' | 'failed';
  layer: 'microcompact' | 'native-summary';
  trigger: 'ratio' | 'deep' | 'idle' | 'overflow-fallback' | 'manual';
  at: number;                        // epoch ms
  measure: {
    totalTokens: number;
    surfaceTokens: number;
    contextWindow: number;
    outputReserve: number;
    thresholdNative: number;         // Tn at decision time
    ratio: number;                   // totalTokens / Tn
  };
  plan: {
    clearSeqs: number[];             // surface seq of each selected tool/result
    protectedSeqs: number[];         // newest K groups (ids only, for audit)
    keepGroups: number;
    plannedSavingTokens: number;
  };
  applied?: {
    replacements: Array<{
      seq: number; replacementSeq: number;
      beforeTokens: number; afterTokens: number;
    }>;
    freedTokens: number;
    durationMs: number;
  };
  error?: string;
}
// type string: 'plugin:multitask/compaction-boundary'
```

Written with `appendPluginRecord` (`dsh-session/lib/types/index.d.ts:94-117`), so it is `ignorable`, never enters the surface, survives fork/resume, and cannot break log replay.

### 6.2 When it is written

1. `status:'planned'` **immediately before** the first surface append of the pass. It names the exact node set; nothing has changed yet.
2. One `compaction/prune` + replacement pair per node, each synchronous and self-priced.
3. `status:'applied'` **immediately after** the last replacement, carrying the landed replacement seqs and the measured saving.

If the process dies between 1 and 3, the surface is still consistent — every landed pair is complete and correctly priced by itself. That is deliberate: microcompact does not need a rollback, only an honest record of what it decided.

### 6.3 How resume reads it

```
readNewestBoundary(session):
  scan backwards from session.seq-1 over pluginRecordOf(event)
  stop at the newest 'plugin:multitask/compaction-boundary' (bounded: 512 events)
  return its data, or undefined
```

- Newest record is `applied` → the pass completed; nothing to do.
- Newest record is `planned` → the pass was interrupted. **Do not replay the planned list** (the surface has moved; seqs may be shadowed). Append `status:'aborted'`, reason `interrupted`, then evaluate pressure normally and start a new pass if still needed.
- Nothing found in the bounded window → treat as clean; the surface is consistent regardless.
- Never infer state from transcript shape. The record is the only success marker.

### 6.4 How it composes with native `compaction/start|summary|end`

- Our marker is **not** a lock and must never block native compaction. Native's `compaction/start` is the lock (`dsh-compaction-basic/lib/index.js:454, 536-545`).
- Before writing `planned`, scan for an unmatched native `compaction/start`. If one exists, skip this pass — native owns the surface right now.
- Native compaction can summarize nodes we already replaced; that is fine, they are ordinary priced surface nodes.
- Native's unmatched `start` is settled by `session/end-seed` after a restore (`assertCompactionInactive` ignores a start older than the newest seed boundary). Our `planned`-without-`applied` is settled by our own `aborted` record. Two independent markers, two independent owners, no shared state.
- For a future full-compaction layer we own, the same record type grows a `layer:'native-summary'` variant that records the native `compactionId`, so the session has one uniform history view.

---

## 7. Prompt and cache discipline

**Order in the model-visible request, head to tail:**

```
[ system prompt .................... never changes per session; cached ]
[ tool schemas ..................... never change; cached ]
[ activation policy ................ once (system section preferred) ]
[ conversation history ............. append-only, rewritten only by compaction ]
[ boundary checkpoint (if any) ..... written by native compaction ]
[ newest user message .............. the current turn's input ]
[ ledger + standing rules .......... per turn, varies ]
[ wake text / reports .............. per turn, varies ]
[ peer roster ...................... per turn, varies; ADR-0027 tail rule ]
```

Rules that follow:

1. **Nothing before the newest user message may vary.** Policy, tools, and system text are set once. The ledger, roster, and wake text ride after the current input, so a change costs one cache miss on that turn's new text, never on the historical prefix.
2. **Compaction must never touch:** the system message at surface node 0; any `user/message`; any `assistant/message`; image blocks; our log-only records. Microcompact is structurally restricted to `tool/result`, which is why it cannot damage policy, roster, or ledger.
3. **The roster survives by construction** (it is a `user/message`), but only for turns after the last compaction. It is re-emitted every turn, so nothing needs re-pinning.
4. **The policy does not survive a full summary unless we fix it** (§2.1). This is the highest-value small change in the whole document.
5. **Microcompact invalidates the prefix from the oldest cleared node.** Clear oldest-first only because relevance demands it; accept the cost because the alternative at that pressure is a summary, which invalidates from the summary position and costs 65k output tokens on top.
6. **Do not clear tool results on a cold session.** Require `totalTokens ≥ 0.30 × Tn`; below that the cache damage is larger than any benefit.

---

## 8. Failure handling

| Failure | Detection | Response | Owner |
|---|---|---|---|
| **LLM summary fails** | `compaction/end` with `error`; native's pre-step listener logs and continues | Continue the turn un-compacted. Count it. After 2, our breaker stops L1/L1b (they will not help). Surface one notice. | dsh + ours |
| **Summary not smaller** | Native throws `"summary is not smaller than the shadowed content"` (`:601`) | Same as above; the lock is released by `compaction/end`. | dsh |
| **Mid-tool-call** | Pre-step runs at a step boundary; all results committed | Selector requires `toolPairingBalancedBefore/After` on every cut and never selects the newest group. No mid-stream mutation exists. | ours |
| **Provider overflow** | `agent/request-error`, code `CONTEXT_WINDOW_EXCEEDED` | Native prunes + summarizes with retain 0 and retries once. If no retry is returned, ours clears all eligible results, verifies saving, and retries once per session. | dsh, then ours |
| **Indivisible huge message** | After a last-resort pass, largest single node > 0.40 × W | Stop. Return no retry. The native error surfaces with its original text. Never loop. | ours |
| **Restart mid-compaction (native)** | Unmatched `compaction/start` newer than the newest `session/end-seed` | Native treats it as a lock; restore appends `session/end-seed`, after which it is ignored. No replay. | dsh |
| **Restart mid-microcompact** | Newest boundary is `planned` | Append `aborted`, re-evaluate, start a fresh pass if needed. Never replay seqs. | ours |
| **Two consecutive our-side failures** | In-memory counter per session, reset on success | Breaker open for the session; native remains. One honest notice, no retries. | ours |
| **Compaction races a user turn** | Pre-step only fires for the agent's own turn; native holds the lock | Our listener is synchronous and write-only, no awaits; native's lock check rejects overlap. | both |

Deliberate posture: **no silent retry loops.** Grok Build's five-state suppression ladder (`online-gemini-grok-devin` §2.1) is the model worth copying later; v1 uses one binary breaker because we have only two operations that can fail.

---

## 9. Deliberately not in v1

Not bans. Deferred, with the reason and the unlock.

| Not doing | Why | What it would take |
|---|---|---|
| Steward model call ("compact vs switch") | Needs an LLM seam in `DshHost`, which we do not have; deterministic thresholds are adequate at our turn sizes | `ctx.llm` in the host interface + a product decision on cost |
| Session-part switch / handoff note | Every core map is session-keyed (todos, wake bus, markers, ADR-0019); a switch is a re-keying project, not a policy tweak | A multi-ADR project |
| Searchable archive of cleared results | ADR-0018 U-H forbids a local content-search index | Human amendment to U-H |
| Verification probe on the summary (Gemini) | Costs a second LLM call and only applies if we own the summarizer | Own the summarizer first |
| Background "prefire" summary (Grok Build) | Requires our own engine plus a prefix fingerprint | Own the summarizer first |
| Custom 8-section summary prompt | Native's is already an 8-section prompt (`dsh-compaction-basic/lib/index.js:243`); replacing it buys little | `auto:false` + our engine, which loses native overflow recovery |
| Tuning native `thresholdRatio`/`retainRatio` | Changes loss and cost globally; no live data yet | Measure L1 for a few weeks first |
| Per-worker microcompact | Workers are the heaviest tool users, but they are the host's sessions and this doubles the blast radius | A separate ticket after dispatcher-side live proof |
| Pressure display in the sidebar glyph | UI work, not needed for correctness | Separate UI ticket |
| Re-injection of recently read files after compaction (Claude Code) | The dispatcher does not read files | Not applicable |

---

## 10. Decision table

Four coherent stacks. Pick one; each is implementable without changing the others.

### A — Native only (minimal)

- **What runs:** L0 existing discipline + L2/L3/L4 as shipped. Plus the policy-survival fix (§2.1), because otherwise every summary erases the dispatcher's role.
- **Buys:** zero new compaction risk; no new state; no cache damage; one small fix.
- **Costs:** first summary at 678k (up to 65,536 output tokens, one long call); summaries are lossy; one indivisible huge message can still fail the turn.
- **Risks:** policy loss if the fix is skipped; surprise 65k-token bill for a heavy user.
- **Effort:** ~1 day (policy fix only).

### B — Recommended (ZCode-shaped)

- **What runs:** A + L1 + L1b + boundary marker + pressure-aware emission + L5 breaker.
- **Buys:** the summary is usually never reached; deterministic, model-free, testable; the boundary marker gives resume and observability; the breaker prevents loops.
- **Costs:** ~4 days; one cache invalidation per pass; ~700 production lines; ten new config fields.
- **Risks:** a misleading trigger ratio if `measure().totalTokens` is not exactly the same quantity native compares (see Q3); listener ordering needs a live check.
- **Effort:** ~4 days plus live verification.

### C — Aggressive (tune the backstop too)

- **What runs:** B + `thresholdRatio 0.55`, `retainRatio 0.08` on the preset's `compaction-basic` row, and lean emission from 0.35 × `Tn`.
- **Buys:** a hard, predictable ceiling (summary at 409,464 tokens); a small verbatim tail (59,520), so the summary itself is cheaper and leaves more room.
- **Costs:** more frequent summaries, more loss per summary, summary-of-summary degradation sooner; the override targets a row inside a preset group and is **unverified** until a `--dump-config` pass.
- **Risks:** tuning below our own L1 trigger would invert the ladder if someone changes only one number; mitigate by deriving every trigger from `Tn` (this design already does).
- **Effort:** B + half a day, plus the config verification.

### D — Own the summarizer (not recommended now)

- **What runs:** `auto:false` on native, our own engine registered as `ctx.compaction` (or called directly), our prompt, a verification probe, and our own overflow path.
- **Buys:** full control of summary shape and quality; the only path to Gemini-style verification.
- **Costs:** we re-implement range selection, locks, surface replacement, overflow recovery, and `/compact` integration; a large ADR; we lose the shipped cache-reusing prefix call unless we copy it exactly.
- **Risks:** regressions in durability (locks, rollback) that are currently free.
- **Effort:** weeks.

**Recommendation:** B. A is defensible if the human wants zero new state today. C only after B is live and measured. D only if summary quality becomes the observed problem.

---

## 11. Open questions implementation must not guess

1. **Does `- id: compaction-basic` in the profile's `cordis.patch.yml` reach the row inside the preset's isolated group?** Unverified. Needs a `dsh --profile multitask --dump-config` run before any tuning. Option C depends on it; B does not.
2. **Is `toolResultPruner`/`compaction` resolvable from our host-plane scope?** The preset isolates both. Assume no; our design does not need them.
3. **Is `measure().totalTokens` the same quantity native compares?** Native compares it directly (`:940-941`), so yes by construction — but `TokenMeasurement.totalTokens` is documented as "request-and-response pressure", and the baseline can be heuristic. Needs one live session to confirm it rises with context as expected.
4. **Listener ordering within `agent/pre-step`.** Our listener must be registered before native's and must not await. Confirm on a live boot, and record what happens if it is after (benign no-op expected).
5. **Does `appendPluginRecord` accept a type declared only by our package?** The TypeScript generic requires declaration-merge in our own types; the runtime validates the grammar only. Confirm the merge compiles and the record survives a resume.
6. **What exactly counts as one "tool-result group"?** Proposal: the maximal run of `tool/result` nodes belonging to one assistant step, validated with `toolPairingBalancedBefore/After`. Needs a precise definition before the selector is written.
7. **How big will the peer roster be per turn?** Not built yet (ADR-0027). It adds to every turn's tail and therefore changes how fast the session grows. Re-measure after it lands.
8. **Does the dispatcher's session actually mount the `standard` preset on this profile?** The native evidence says yes by default, and flags that the composed multitask config lacked the repo's worker preset row. Needs the same `--dump-config` check.
9. **What is the honest user-visible posture when the breaker opens?** A silent breaker is dishonest; a loud notice is noise. Propose: one line in the next wake turn's ledger section, no user-facing alert.

---

## 12. Source table

| System | Trigger | Cheap layer | Summary shape | One idea worth taking |
|---|---|---|---|---|
| **dsh native** | `min(0.8W, W−O−65,536)` = 678,464 here | tool-result pruner (only after threshold) | 8-section checkpoint, 16% tail verbatim, cache-reusing prefix | The whole backstop is already ours: use it, do not rebuild it |
| **ZCode** | `(W − min(maxOut,21k)) − 13k`; microcompact at `min(0.9×T, T−2k)` or 60 min idle | clear old tool results, keep newest 5, require 256 tokens saved | synthetic user message, analysis stripped, keep newest assistant group | **Boundary part as the only success marker; microcompact is a projection, not a cut** |
| **Grok Bot 0.18** | start at 90% used, persist at 95% | none (blocking/background summary first) | 9 sections + durable blocks re-injected outside the model | **Durable blocks re-injected from outside the summary** |
| **DeepSeek-Bot** | `0.8 × usable`, hard `0.95`, regrow `check/4` | none; steward decides compact vs switch | `[Checkpoint N]` + 6 topics + verbatim user messages (16k) | **Verbatim messages-to-the-bot under a fixed token budget; cooldown 60/300/900 s** |
| **Gemini CLI** | 50% of limit (legacy); retained 65k / max 150k (pipeline) | tool masking, 50k protected, 30k prunable | `<state_snapshot>` XML, 7 fields, keep newest 30% | **A second "probe" call asking what was omitted, plus a token-inflation guard** |
| **Grok Build** | 85%; prefire 10 points earlier | none | `<summary>` 9 sections | **Prefix fingerprint guards a cached background note; 5-state failure suppression** |
| **Claude Code** | per-model, ~200k boundary / ~967k on 1M | microcompact clears whitelisted tool outputs, no API call | 9 sections; re-inject CLAUDE.md, plan, git status, 5 files from disk | **Re-inject state from disk, not from the summary** |
| **Codex** | 90% `min(config, 0.9W)`; background at 65% | trim oldest items, preserve prefix | 4-bullet handoff prompt; keep newest user messages ≤20k | **Background compaction at 65% with a real task lifecycle** |
| **Cursor** | "close to full" (percent only visible in a hook) | unknown | model-written summary; context ring shows the split | **Expose `context_usage_percent` and `is_first_compaction` as telemetry** |
| **Windsurf / Devin Local** | not documented | RAG retrieval + Fast Context subagent | not documented | **Delegated retrieval as the first defense: keep bytes out of the main thread** |
| **Cline** | 90% of usable; target 70%; preserve 20k | deterministic "basic compaction", no LLM, on overflow recovery | Goal / State / Highlights / Next / Files | **LLM-free overflow recovery that is guaranteed to shrink** |
| **Roo Code** | percent threshold (default 100) or token cap | sliding-window truncation as fallback | 9 sections, summary as user message | Non-destructive tagging: nothing deleted, only hidden |
| **Kilo Code** | provider usage or configured percent, else buffer | prune tool output: protect newest 40k, require 20k freed | Objective / Details / Completed / Active / Blocked / Next | **Prune only if it frees more than a floor** |
| **Kiro** | approaching the limit; CLI `/compact` | none documented | goals, decisions, progress, next steps | Two independent retention knobs: message pairs and window percent |
| **Aider** | soft budget, summarize after each turn | repo map is separate from history | one synthetic user message | Keep history and codebase index independent |
| **OpenHands** | tokens = HARD, event count = SOFT | observation masking every step | structured state summary; drop middle to 50% | **Snap cuts to atomic tool-call/observation units** |
| **Trae** | at window overflow, manual button | none documented | recent turns verbatim + LLM summary | Summaries retain why a file was read, not only what |
| **Qoder** | "when the runtime needs more room" | none documented | recent messages + task state + decisions | Manual compact is disabled when savings would be trivial |
| **CodeBuddy** | `min(baseline, budget) × ratio`, clamp 100k–1M | oversized tool output externalized | not published | Cache-expiry compaction: compact before a 1h idle cache dies |
| **Devin** | undocumented (`/compact` exists; blog: cap 200k of 1M) | undocumented | undocumented | The published finding is negative: self-written notes are not a substitute for a real compaction system |

---

## 13. Evidence index

| Claim area | File |
|---|---|
| Native dsh compaction mechanics, thresholds, mounting, APIs | `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` |
| Window-source ruling and `measure()` semantics | `docs/adr/0029-deterministic-microcompact-boundary-marker.md` §Settled window source; `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q5 |
| Grok Bot compaction ladder and durable blocks | `.scratch/repo-analysis/2026-10-19-grokbot-compaction-deep.md` |
| DeepSeek-Bot steward, checkpoint, failure cooldowns | `.scratch/repo-analysis/2026-10-19-dsbot-compaction-deep.md` |
| Three-tree comparison and ADR-conflict map | `.scratch/repo-analysis/2026-10-18-memory-compaction.md` |
| ZCode microcompact, boundary part, breakers | `.scratch/repo-analysis/2026-10-18-zcode-lane-memory.md` §4 |
| Gemini / Grok Build / Devin | `.scratch/repo-analysis/2026-10-19-online-gemini-grok-devin.md` |
| Claude Code / Codex | `.scratch/repo-analysis/2026-10-19-online-claude-code-codex.md` |
| Cursor / Windsurf | `.scratch/repo-analysis/2026-10-19-online-cursor-windsurf.md` |
| Cline / Roo / Kilo | `.scratch/repo-analysis/2026-10-19-online-cline-kilo-roo.md` |
| Kiro / Aider / OpenHands | `.scratch/repo-analysis/2026-10-19-online-kiro-aider-openhands.md` |
| Trae / Qoder / CodeBuddy | `.scratch/repo-analysis/2026-10-19-online-trae-qoder-codebuddy.md` |
| Owner decisions that opened this design | `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 6 |

**Package paths (installed `dsh@0.2.1-rc.2`):**
`dsh-compaction-basic/lib/index.js:15,17,63,124-134,243,292-338,400-470,536-547,601,650-661,839-855,861-887,926-946` ·
`dsh-compaction/lib/index.js:80,91,175` · `dsh-compaction/lib/types/types.d.ts:21-105` ·
`dsh-compaction-tool-result-pruner/lib/index.js:8-14,92-124,137-200` ·
`dsh-token-meter/lib/types/index.d.ts:46` · `dsh-token-meter/lib/types/types.d.ts:24-55` · `dsh-token-meter/lib/types/projection.d.ts:41-59` ·
`dsh-session/lib/types/index.d.ts:94-117,240-270` · `dsh-session/lib/types/types.d.ts:440-520` ·
`dsh-agent/lib/types/runtime-types.d.ts:92-100,304-311` ·
`dsh-web-app/cordis.patch.yml:539-546` · `dsh-web-app/presets/standard.patch.yml:66-82`

**Repo paths touched by the proposal:** `src/plugin.ts`, `src/adapter/parent-agent.ts`, `src/adapter/cordis-dsh-host.ts` (no change needed for L1; a new `src/adapter/compaction.ts`), `src/core/report-clamp.ts`, plus new `src/core/compaction-select.ts`.
