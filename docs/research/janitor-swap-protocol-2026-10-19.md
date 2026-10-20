# Janitor swap protocol: validated plan schema and atomic surface swap

- **Date:** 2026-10-19
- **Status: DESIGN. NOT A RULING.** Nothing here is adopted. This is the deterministic half of an LLM janitor: the validator and the swap. It assumes the model is hostile or simply wrong and must never be trusted with bytes.
- **Scope.** Only the validator and the apply path. Trigger cadence, selection quality, cache economics, and whether the LLM janitor should exist at all are out of scope; `docs/research/janitor-redteam-2026-10-19.md` argues against the cadence and should be read first. This document is written so that the safety machinery is correct *if* the product decision is to build it.
- **Host under inspection:** `dsh@0.2.1-rc.2` at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`. Citations are to that tree.
- **Constraint acknowledged:** no dsh type is imported in our repo, so `npm run typecheck` cannot catch an API mistake here. Every host-dependent claim is tagged **[verified]** (read in `.d.ts`/`.js` in the installed tree) or **[live-check]** (must be confirmed by a boot before the code is trusted).

---

## 0. The three rules this document exists to enforce

1. **The model never supplies bytes that reach the surface.** It supplies seq ranges and, for one op kind, a short labelled note. Every kept span is hash-checked against the log; every dropped span is copied by the host, never by the model.
2. **A plan is applied whole or not at all.** One mutable contiguous span per plan (see §3.3). No partial application, ever — not after a crash, not after a rejected check, not after a race.
3. **A plan computed against a different revision is discarded.** No merging, no rebasing, no "apply the still-valid subset". The janitor is cheap to rerun; a corrupted surface is not.

---

## 1. Verified host facts the protocol rests on

Each is quoted from the installed tree; the line is the authority for the predicate that follows.

| # | Fact | Source | Predicate it enables |
|---|---|---|---|
| H1 | `surfaceOp {op:'replace', startSeq, endSeq}` requires both seqs to be **current surface nodes**, `startIdx <= endIdx`, and both `< event.seq`. | `dsh-session/lib/index.js:364-374`, `:359` [verified] | C08, C09 |
| H2 | `sourceEventSeqs` must **include every shadowed node**, be unique, and all be earlier than the new event. | `dsh-session/lib/index.js:314-333` [verified] | C21 |
| H3 | A `tool/result` replacement must shadow **exactly one** node and may change **only** `message.content`; `turn`, `step`, `error`, `meta`, `toolCallId`, `isError`, `source` must be byte-identical. | `dsh-session/lib/index.js:394-411` [verified] | C22 |
| H4 | Surface node 0, when it is a `system/message`, may be rewritten only by a `system/message` over exactly that node. | `dsh-session/lib/index.js:413-423` [verified] | C20 |
| H5 | `compaction/prune` is log-only, carries `{shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount}`, and **the replacement MUST be appended synchronously right after it**. `shadowedTokenCount` is the heuristic price. | `dsh-compaction/lib/types/types.d.ts:76-105`; `dsh-token-meter/lib/types/types.d.ts:44-52` [verified] | §6 step 5-6 |
| H6 | `appendPluginRecord(session, 'plugin:<owner>/<name>', data)` writes an `ignorable`, JSON-only record that never enters the surface and survives fork/resume. Returns the committed `SessionSeq`. | `dsh-session/lib/types/index.d.ts:94-117` [verified] | §7, §8 |
| H7 | `ctx.tokenMeter.measure(session)` returns `{logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes[{seq, tokens, heuristicTokens}]}`. `logRevision` equals the next unread seq. | `dsh-token-meter/lib/types/types.d.ts:24-52` [verified] | C03, §6 step 1 |
| H8 | `toolPairingBalancedBefore/After(session, seq)` exist and **throw** when `seq` is not a current surface node. | `dsh-compaction/lib/index.js:66-93` [verified] | C15 |
| H9 | `session.surface.nodes` is the ordered current surface; `session.seq` is the next event seq. `session.append` is synchronous and validates before committing. | `dsh-session/lib/types/index.d.ts:141`, `:240-268` [verified] | C08, §6 |
| H10 | An unmatched `compaction/start` is the native lock; it is settled by a newer `session/end-seed` after a restore. | `dsh-compaction-basic/lib/index.js:536-548`, `:706-734` [verified] | C25 |
| H11 | `approval/asked {id, toolName, callId?, reason?}` and `approval/decided {id, outcome}` are log-only and pair by `id`. | `dsh-user-approval/lib/types/types.d.ts:29-60` [verified] | P4, C24 |
| H12 | `agent/pre-step` is a waterfall `{agent, messages, turn, step, signal}`, scope-filtered to the agent's own scope. | `dsh-agent/lib/types/runtime-types.d.ts:304-310` [verified] | §5(b), §6 step 0 |
| H13 | A `user/message` may be used as a replacement node; `assistant/message` **cannot** carry `sourceEventSeqs`. | `dsh-session/lib/index.js:320`; `:350` [verified] | C22 |

Two facts are **not** verified and gate implementation: whether a plugin may append `compaction/prune` from outside `dsh-compaction` (it is a known `SessionEventMap` member, so structurally yes — but no production caller was found), and how the incremental `contextPressure` projection treats a `compaction/prune` whose replacement never landed (§6.3). Both are [live-check].

---

## 2. The plan schema

JSON, produced by the model, parsed and validated by the host. The model sees a **frozen snapshot** rendered from the session log and returns this object. It never returns message content.

```json
{
  "v": 1,
  "janitorId": "jan-9f2c4b1e7a0d3c5b8e6f1a2b3c4d5e6f",
  "sessionId": "session-cd03250b-...",
  "snapshot": {
    "logRevision": 4123,
    "surfacePrefixSha256": "sha256:5c1e...",
    "surfaceTokens": 182400
  },
  "cursor": { "startSeq": 190, "endSeq": 1180 },
  "ops": [
    { "op": "keep", "spanId": "k1", "startSeq": 190, "endSeq": 340,
      "sha256": "sha256:aa11..." },
    { "op": "drop", "spanId": "d1", "startSeq": 341, "endSeq": 902,
      "sha256": "sha256:bb22...", "reason": "stale-tool-results" },
    { "op": "replaceWithNote", "spanId": "n1", "startSeq": 903, "endSeq": 1010,
      "sha256": "sha256:cc33...",
      "note": "Read 6 files under src/auth; one edit to refresh.ts. Details retrievable." },
    { "op": "keep", "spanId": "k2", "startSeq": 1011, "endSeq": 1180,
      "sha256": "sha256:dd44..." }
  ],
  "declared": { "savingTokens": 21400, "noteChars": 84 }
}
```

Three lines, in words:

1. **A janitorId, a snapshot fence (`logRevision` + a hash of the surface prefix), one cursor window, and a total partition of that window into ops.**
2. **`keep` carries a sha256 of the exact derived bytes; `drop` carries the same hash and no text; `replaceWithNote` carries the hash plus a ≤400-char note; `merge` names adjacent `keep` spans and is a normalization only, not a write.**
3. **No op may carry a message body, a rewritten block, an assistant message, or a tool result. The only model-authored text in the whole plan is `note`, and it is rendered with a fixed `[janitor] note, not verbatim` label.**

### 2.1 Op semantics, exactly

| Op | Meaning | What the host writes |
|---|---|---|
| `keep` | Retain this positional span **verbatim**. | Nothing. It exists so the plan proves it saw the bytes (hash) and so the partition has no silent holes. |
| `drop` | Remove this positional span from the model-visible surface. | One replacement node: a host-built stub, `[janitor] span d1 evicted (563 nodes). Raw: read_span(341,902)`. The model supplies no text. |
| `replaceWithNote` | Remove the span and place one short note. | One replacement node: `[janitor] note, not verbatim: <note>` plus the same recovery pointer. |
| `merge` | Declare adjacent `keep` spans one logical unit. | Nothing. It is normalization; the validator verifies the union is contiguous and hashes correctly. A merge never allows a later plan to split the group, because a new plan must re-cover the window from scratch. |

**Why there is no `summarize` op.** Reducing arbitrary content to new prose is exactly the fabrication risk this layer exists to avoid. `replaceWithNote` is not a summary: it is a pointer with a label, and the validator never checks whether the note is true (it cannot). The label is what keeps the agent honest about what it is reading.

### 2.2 Why a total partition

Every surface node in `[cursor.startSeq, cursor.endSeq]` is covered exactly once. This turns "the model forgot to mention a span" into a schema error instead of an implicit keep. It also makes the shrink calculation auditable: the validator can sum the whole window.

### 2.3 Why one mutable run in v1

`cursor` may contain several `keep` spans but **at most one contiguous run of `drop`/`replaceWithNote` ops**. With one run, the apply is a single `compaction/prune` + single replacement — an atomic pair. Multi-run plans need per-run applied records and resume reconciliation; they are deferred until the single-run path has survived a live crash test. The cost is real and stated: the janitor cannot clean two distant regions in one pass. It can run twice.

---

## 3. Validator checks, in execution order

Notation: `nodes = session.surface.nodes` (positional list), `pos(seq) = nodes.indexOf(seq)`, `rev = session.seq`, `m = ctx.tokenMeter.measure(session)`. A **span** is a positional interval `[pos(startSeq) .. pos(endSeq)]`. `spanHash(span)` = sha256 over the canonical JSON of `deriveEventMessage(event)` for every node in the span, in order, each prefixed by its seq.

On any failure the whole plan is rejected. The validator never returns a "reduced" plan.

| # | Check | Exact predicate | Failure action and code |
|---|---|---|---|
| C01 | Envelope | It parses as a JSON object; serialized ≤ 256 KiB; `v === 1`; exactly the keys `v, janitorId, sessionId, snapshot, cursor, ops, declared`. | Reject; `SCHEMA`. |
| C02 | Identity | `janitorId` matches `^jan-[0-9a-f]{32}$`; `sessionId` equals the target session id. | Reject; `IDENTITY`. |
| C03 | Revision fence | `snapshot.logRevision === rev` **at validation time** and at apply time. Not `<=`; equality. | Reject; `STALE_REVISION`. The plan is discarded, never rebased. |
| C04 | Snapshot hash | `snapshot.surfacePrefixSha256` equals the hash of `nodes[0 .. pos(cursor.startSeq)-1]`. | Reject; `STALE_SURFACE`. |
| C05 | Cursor bounds | `pos(cursor.startSeq)` and `pos(cursor.endSeq)` both resolve (not `-1`); `startIdx <= endIdx`. | Reject; `SPAN_NOT_ON_SURFACE`. |
| C06 | Cursor balance | `toolPairingBalancedBefore(session, cursor.startSeq)` and `toolPairingBalancedAfter(session, cursor.endSeq)`; both calls are wrapped because H8 says they **throw** on a non-member. | Reject; `PAIR_BOUNDARY`. |
| C07 | Op shape | 1 ≤ `ops.length` ≤ 64; each op's key set is exactly the keys its `op` kind defines; unknown keys are a hard error (this is what bans `content`, `text`, `rewrite`, `summary`). | Reject; `FREEFORM_CONTENT`. |
| C08 | Op discriminant | `op ∈ {keep, drop, replaceWithNote, merge}`; `spanId` matches `^[a-z][0-9]{1,3}$`, unique. | Reject; `SCHEMA`. |
| C09 | Seq sanity | Every seq is a safe integer, `> 0`, `< rev`. | Reject; `SEQ_OUT_OF_RANGE`. |
| C10 | Surface membership | Every span seq is a **current** member of `nodes`. A seq shadowed by native compaction is rejected here. **This is the surface-vs-log check the red-team names.** | Reject; `SPAN_NOT_ON_SURFACE`. |
| C11 | Partition | Ops are in surface order; `ops[0].startSeq === cursor.startSeq`; `ops[n-1].endSeq === cursor.endSeq`; each `pos(ops[i].startSeq) === pos(ops[i-1].endSeq) + 1`. No gap, no overlap. | Reject; `COVERAGE`. |
| C12 | Anti-fabrication (kept) | For every `keep`: `sha256` equals `spanHash(span)` computed from the log. | Reject; `BYTES_MISMATCH`. |
| C13 | Anti-fabrication (dropped) | For every `drop` and `replaceWithNote`: `sha256` equals `spanHash(span)`. The model must prove which bytes it was looking at. | Reject; `BYTES_MISMATCH`. |
| C14 | Drop has no text | A `drop` op carries no `note` key, or its `note` is exactly the host template built from `spanId`. | Reject; `DROP_HAS_TEXT`. |
| C15 | Note grammar | `replaceWithNote.note`: ≤ 400 chars; no control chars except `\n`; must not contain `<verbatim>` or `[janitor]`; must not contain a substring ≥ 40 chars that is also a substring of the dropped span's text (a note may describe, never reproduce). | Reject; `NOTE_INVALID`. |
| C16 | Note budget | Σ note chars ≤ 1,600 per plan. | Reject; `NOTE_BUDGET`. |
| C17 | Tool-pair integrity | For every `tool/call` whose `callId` has a `tool/result`, both nodes lie in the **same** op. For every replacement boundary, `toolPairingBalancedBefore/After` hold (H8). No op may split a pair, and no op may separate a call from its result. | Reject; `PAIR_SPLIT`. |
| C18 | Protected regions | `protectedSeqs ∩ mutableSeqs === ∅`, where `protectedSeqs` is computed live per §4 and `mutableSeqs` is every node in a `drop`/`replaceWithNote` span. | Reject; `PROTECTED_TOUCHED`. This is the catastrophic-failure check; it is checked twice (validate and apply). |
| C19 | System head | `pos(cursor.startSeq) !== 0` when node 0 is a `system/message`. | Reject; `SYSTEM_HEAD`. |
| C20 | No assistant replacement | The replacement kind chosen in C22 is `tool/result` or `user/message`; never `assistant/message` (H13). | Reject; `REPLACEMENT_KIND`. |
| C21 | Source coverage preflight | The shadowed set computed from positions has ≤ 512 entries and is exactly the set that will be passed as `sourceEventSeqs` (H2). | Reject; `SOURCE_COVERAGE`. |
| C22 | Replacement kind | If the mutable run is exactly one `tool/result` node → replacement is `tool/result` copying `turn`, `step`, `error`, `meta`, `message.toolCallId`, `message.isError`, `message.source`, changing only `message.content` (H3). Otherwise → `user/message` with source kind `plugin:multitask-dispatcher`. | Reject; `REPLACEMENT_KIND`. |
| C23 | Real shrink | Let `before = Σ heuristicTokens` over shadowed nodes; `after = estimateMessage(replacement)`. Require `after < before` **per run**. | Reject; `NOT_SMALLER`. |
| C24 | Minimum saving | `before - after >= max(8_000, ceil(0.05 × m.surfaceTokens))`. The validator computes this; it never trusts `declared`. If `declared.savingTokens` differs from the computed value by more than 5%, reject as `SUSPICIOUS_DECLARATION`. | Reject; `UNDER_MINIMUM`. |
| C25 | Blast radius | Shadowed tokens ≤ `floor(0.25 × m.surfaceTokens)`; shadowed nodes ≤ `floor(0.40 × nodes.length)`. | Reject; `BLAST_RADIUS`. |
| C26 | Native lock | No unmatched `compaction/start` newer than the newest `session/end-seed` (H10). | Reject; `NATIVE_LOCK`. |
| C27 | No open approval | No `approval/asked` without a matching `approval/decided` (H11). | Reject; `APPROVAL_OPEN`. |
| C28 | Turn fence | `snapshot.logRevision >= seq(turn/start of the current turn)`; no node from the current turn is in `cursor`; no `turn/end` appears between the snapshot and apply. | Reject; `TURN_FENCE`. |
| C29 | Plan freshness | `plan.at` is within one turn of `rev`; the plan was produced from the snapshot at `logRevision`, not cached across a turn. | Reject; `STALE_PLAN`. |
| C30 | Replay guard | No `janitor-pass` record with this `janitorId` already at `status:'applied'`, and no replacement event whose message source carries this `janitorId` (H6, §7). | Reject; `ALREADY_APPLIED` (treated as success, not error). |

### 3.1 What the validator provably cannot check

It proves well-formedness: spans exist, bytes match, pairs are intact, protected regions are untouched, the plan shrinks. It cannot prove **sufficiency** — that the kept content is what the next task needs. A plan that keeps 9,900 tokens of junk and drops 100 tokens of gold passes every check above. This document must not be read as claiming otherwise. The deterministic floor (C15-C19, C24-C25) is the veto; selection quality is measured separately (re-read/regret rate), per the red-team's §5.

### 3.2 The anti-fabrication guarantee, stated once

There are exactly two ways bytes reach the surface from a janitor pass:
- **copied from the log** (the stub text, the preservation of every kept node — nothing is written for kept nodes at all), and
- **model-authored note text**, capped, labelled `[janitor] note, not verbatim`, and rejected if it reproduces 40+ chars of the dropped span.

A model cannot insert a sentence into the conversation under the guise of retained history. That is the property the hash checks buy.

### 3.3 Why one mutable run

`surfaceOp replace` replaces one **positional** span with one node. Two disjoint drops are two replacements, and two replacements are not atomic: a crash between them leaves a half-applied plan. v1 therefore requires the mutable ops to be contiguous. This is a hard schema rule (C11 plus the single-run condition, checked in C07's shape pass).

---

## 4. Protected regions

Computed live at validate time and again at apply time. Never cached as a seq list: a native compaction or a fork invalidates the positions, not the source kinds.

| Protected set | Host signal that identifies it | Why |
|---|---|---|
| **System prompt** | The event at `nodes[0]` when `type === 'system/message'` (H4). | Rewriting it changes the agent's identity. |
| **Dispatcher policy** | Any `user/message` whose `message.source.kind === 'plugin:multitask-dispatcher'` and whose text begins with the policy preamble. | The policy currently rides an activation user message (`src/adapter/parent-agent.ts:34-57`). **Prerequisite:** move it to a per-agent system-prompt section before enabling any janitor on dispatcher sessions; otherwise this check is the only thing standing between the model and the agent's role. |
| **Most recent N tokens** | Walk `m.nodes` from the tail, accumulate `tokens`, stop at `N = 32_000`; every visited seq is protected. | The working set. Matches the compaction-stack design's tail rule. |
| **In-flight turn** | Backward scan for the newest `turn/start` without a matching `turn/end`; every event with that `turn` number is protected. Mirrors native's `inspectCompactionEntryState` (`dsh-compaction-basic/lib/index.js:706-734`) but is our own bounded scan. | Never mutate the turn being served. |
| **Open approval** | Backward scan for `approval/asked` with no `approval/decided` of the same `id` (H11). Protect: the referenced `callId`'s `tool/call` and `tool/result`, and every node after the ask. | The model is mid-decision; the evidence must not move. |
| **Content quoted this turn** | Build a set of 64-char normalized shingles from (a) `assistant/message` text and `tool-call` argument text within the current turn, excluding our own janitor notes. A node is protected if any shingle occurs in its projected text. | The agent is demonstrably using this content right now. |
| **Janitor notes and stubs** | Any `user/message` whose `source.kind === 'plugin:multitask-dispatcher'` and whose text starts with `[janitor]`. | Prevents recursive eviction of the pointers (red-team §3.3). |
| **Roster / wake tail** | `user/message` with the same source kind, inside the protected tail. | Re-emitted every turn; dropping the current copy loses peer awareness for that turn. |
| **Native checkpoint** | `user/message` whose `source.kind === 'compact-checkpoint'`. | Native's boundary is not ours to move. |
| **Images** | Any node whose projected content contains an `image` block. | Offload is native (`dsh-compaction-image-offload`); janitor must not race it. |
| **Tool-pair partners** | Implied by C17. | A split pair is a provider error or a lost result. |

**Protected-list staleness is designed out.** The set is recomputed from the current surface, the current `measure()`, the current turn, and message source kinds — not from a seq list captured at activation.

---

## 5. Race table

### 5.1 The governing rule

**A plan is bound to one `logRevision`.** If the revision changed, the plan is discarded. Not "revalidate and apply what still fits" — the model's judgment was made about a conversation that no longer exists, and partial application is the failure mode that produces a surface whose notes describe content that was not dropped. The only acceptable outcomes are *apply the whole plan* and *write nothing*.

This is affordable because the automatic path runs **synchronously inside `agent/pre-step`**: the snapshot, validation, and apply happen in one JS turn with no `await` between them. The window is zero in-process. Every race below is about a plan that was produced earlier (an LLM call necessarily awaits), and the answer is always the fence.

### 5.2 The table

| # | Interleaving | Detection | Resolution |
|---|---|---|---|
| **(a)** | New events appended between snapshot and apply (a turn ran, a tool finished, a wake landed). | `measure().logRevision !== plan.snapshot.logRevision` (C03), or `surfacePrefixSha256` mismatch (C04). | **Discard.** Append `janitor-pass {status:'aborted', reason:'revision-changed'}`. Recompute from the new surface on the next step. The model call is wasted; that is the cost of a stale plan, and it is cheaper than corruption. |
| **(b)** | A turn starts mid-apply. | Cannot happen in-process: the apply block has no `await`, and JS is single-threaded. If the pass is triggered from `agent/turn-stopping` instead, the turn boundary is the fence. | No action needed. If the design ever moves the apply off the step boundary, it must re-check `turn/start` inside the same synchronous block. |
| **(c)** | Two janitors overlap (two dispatcher sessions, or a re-entrant pass). | Per-session in-memory `passInFlight` boolean; plus a log scan for a `janitor-pass` at `status:'planned'` with no `applied`/`aborted` for **this session**. | The second pass returns immediately (`busy`). Cross-process is out of scope: dsh sessions are single-owner. If that ever changes, the `planned` record is the lock — a second process seeing `planned` without `applied` appends `aborted` and does not touch the surface. |
| **(d)** | The session is forked or resumed mid-run. | Fork: the child's `session.id` differs (C02). Resume: the process restarts over the log; the newest `janitor-pass` is `planned` without `applied`. | Fork: the child never inherits a pending plan — plans live in memory, keyed by session id, and the id check rejects a smuggled one. Resume: append `aborted{reason:'interrupted'}`; **never replay the seqs**; the surface is consistent because every landed replacement was self-priced (H5). Recompute. |
| **(e)** | Native compaction fires mid-run. | Unmatched `compaction/start` (C26) and, after it, the span seqs are no longer current surface nodes (C10). | **Discard.** Native owns the surface. The plan is aborted, not merged into native's checkpoint. Native may later summarize our notes; that is allowed (they are ordinary nodes). |
| **(f)** | HMR reload (plugin code replaced mid-pass). | The pass is synchronous, so a reload cannot interleave with an apply. It can land between passes. | In-flight state (`passInFlight`, cached snapshot) is lost with the module. On re-apply, the session is new; the `planned` record without `applied` is settled by an `aborted` on the next pass. Idempotency marker (§7) makes a re-run safe. |
| **(g)** | A second dispatcher's janitor touches another dispatcher's worker session. | Ownership check: the target session's `parentSession` must be this dispatcher's session id (not a global `workerIdOf`). | Refuse; `NOT_OWNED`. ADR-0019 makes multiple dispatchers real, so ownership is per parent, not per process. |
| **(h)** | A worker session settles and is disposed while a plan is pending. | `session.disposed` / the plan's `sessionId` no longer resolves. | Drop the plan. Nothing to apply to. |

### 5.3 What "discarded" writes

One log-only record: `plugin:multitask/janitor-pass {status:'aborted', janitorId, reason, at}`. It is the honest trace that a plan existed and did not land. It is not an audit trail of content (ADR-0018 U-H); it records the decision, not the evidence.

---

## 6. Atomic apply sequence

Precondition: C01-C30 passed against the live surface at time `t0`, and `passInFlight` was set.

| Step | Action | Crash immediately after this step |
|---|---|---|
| **0** | **Gate.** Set `passInFlight`. Re-scan for an unmatched `compaction/start` and an open `approval/asked`. Re-check ownership (§5.2 g). | Nothing written. Resume is clean. |
| **1** | **Re-measure.** `m = ctx.tokenMeter.measure(session)`; require `m.logRevision === plan.snapshot.logRevision` (C03) and the prefix hash (C04). | Nothing written. Plan discarded; `aborted{reason:'revision-changed'}`. |
| **2** | **Revalidate against the live surface.** Rerun C05-C30 with the current `nodes`. This is cheap (hash the window, no I/O). | Nothing written. `aborted{reason:'validation'}`. |
| **3** | **Precompute every payload.** Build, before any append: the `janitor-pass planned` data, the `compaction/prune` data, the replacement message (a `user/message` or a single-node `tool/result` per C22), and the `janitor-pass applied` data. Nothing in steps 4-6 may do work that can throw. | Nothing written. |
| **4** | **Append `compaction/prune`** with `{shadowedRange:{start:cursor.startSeq, end:cursor.endSeq}, shadowedSeqs, shadowedTokenCount: Σ heuristicTokens}` (H5). | The log holds an orphan prune with no replacement. On restart the meter rebuilds from the full log, so the projection is recomputed; the risk is the live in-memory projection if the process **survived** but the next append threw. Mitigation: step 3 precomputed the payload, and a throw in step 5 triggers a compensating replacement of the original bytes in the same synchronous block. **How the incremental projection handles an orphan prune across a hard kill is [live-check].** |
| **5** | **Append the replacement node** synchronously, with `surfaceOp {op:'replace', startSeq, endSeq}` and `sourceEventSeqs = shadowedSeqs` (H1, H2). Nothing may be appended between step 4 and step 5 (H5). | The pair is complete and self-priced. The surface fold is consistent; replay is exact. The plan has landed but no `applied` marker exists — resume appends `aborted{reason:'interrupted', landed:true}` after detecting the replacement's `janitorId`. |
| **6** | **Append `janitor-pass {status:'applied'}`** with `janitorId`, `planHash`, `replacementSeq`, `beforeTokens`, `afterTokens`, `noteChars`, `model`, and the model call's own `usage` if the host supplied it (not a running ledger). | The replacement landed and is marked. Resume sees `applied`; nothing to do. |
| **7** | **Release the lock.** Clear `passInFlight`. Optionally request a `session/flush` (durability checkpoint) — do not await it on the turn path. | Lock is in memory only; a hard kill clears it. Resume re-derives state from the log. |

**Step 4-5 are one atomic unit in practice** because both payloads were built in step 3, both appends are synchronous, and the only throw sources (schema, serialization, surface validation) were exercised in step 2/3. That is the property the crash table relies on.

### 6.1 Why the prune comes first and the record last

The prune is what keeps the O(1) pressure projection from folding a zero delta (H5). The `applied` record is last so that its presence means "the replacement definitely landed". The `planned` record is not used in this single-run design; step 4 begins the mutation directly. If a future version allows multiple runs, a `planned` record must precede the first prune and the apply becomes recoverable-but-partial, which is exactly why v1 forbids it.

### 6.2 What the replacement node looks like

```
[user/message]
  source.kind: 'plugin:multitask-dispatcher'
  source.form: 'notice'
  content: [{ type:'text', text:
    "[janitor] 563 nodes evicted from this position (341-902). Not verbatim: tool output,
     shell logs, and file reads. Recover with read_span(341,902)." }]
  surfaceOp: { op:'replace', startSeq:341, endSeq:902 }
  sourceEventSeqs: [341,342,...,902]      // every shadowed node (H2)
```

For a single `tool/result` span, the replacement is a `tool/result` copying every field except `message.content` (H3). This preserves tool pairing and provider replay shape by construction.

### 6.3 The one residual apply risk

An orphan `compaction/prune` (step 4 landed, step 5 did not) is only dangerous if the process **survives** the failed second append. In-process, the compensating replacement in the catch block restores adjacency. Across a hard kill, the projection is rebuilt from the log on resume, so the orphan is inert — **assuming the projection ignores a prune with no following replacement, which is [live-check]**. If it does not, the fallback is to make the prune optional for our writes and accept a projection drift until the next full measure; that is worse, so the live check gates the feature.

---

## 7. Idempotency and replay

Three independent mechanisms; any one of them stops a double replacement.

1. **In-process lock.** `passInFlight` per session id. Re-entry returns `busy` without reading the plan.
2. **Applied marker.** Before apply, scan backward over the log (bounded: 4,096 events, matching the compaction-stack design's resume scan) for a `plugin:multitask/janitor-pass` record whose `janitorId` equals the plan's. If its status is `applied`, return success and write nothing. If it is `aborted`, return the abort reason and do not apply.
3. **Surface revalidation.** A second application of the same plan fails C10: the span's original seqs are no longer members of `session.surface.nodes` (the replacement shadowed them). It fails before any append. This is the strongest guard because it depends on the host's own fold, not on our bookkeeping.

The `janitorId` is also carried in the replacement message's `source` as `janitorId`, so a resume can attribute a landed replacement to its plan without trusting seq arithmetic.

**Replay semantics.** A `janitor-pass` record is `ignorable` (H6), so a reader that does not know it skips it and reconstructs the same surface. The replacement itself is an ordinary surface event. There is no janitor state outside the log, so there is nothing to replay beyond reading the newest record. This is ADR-0012's shape: replay reconstructs, it does not re-run.

**What is deliberately not stored:** a per-session plan cache, a token ledger, an index of dropped content, or a per-pass history beyond the newest record. ADR-0018 U-H and ADR-0006 forbid all four. The log is the store.

---

## 8. Observability

### 8.1 The record

One log-only record per run, written with `appendPluginRecord` (H6):

```ts
interface JanitorPassV1 {
  v: 1;
  janitorId: string;
  status: 'planned' | 'applied' | 'aborted' | 'failed';
  at: number;
  reason?: 'revision-changed' | 'validation' | 'interrupted' | 'native-lock'
         | 'busy' | 'not-owned' | 'model-error';
  planHash: string;              // sha256 of the canonical plan JSON
  window: { startSeq: number; endSeq: number };
  measure: { totalTokens: number; surfaceTokens: number; logRevision: number };
  planned: { savingTokens: number; noteChars: number; droppedNodes: number };
  applied?: {
    replacementSeq: number;
    beforeTokens: number;
    afterTokens: number;
    freedTokens: number;
    keptNodes: number;
    droppedNodes: number;
    durationMs: number;
  };
  model?: { provider: string; model: string; usage?: TokenUsage };  // the host-reported call usage, not a ledger
  error?: string;                // machine code from §3, never a transcript
}
// type string: 'plugin:multitask/janitor-pass'
```

**ADR-0018 U-H tension, stated plainly.** U-H bans a per-stream usage ledger and an action audit trail. This record is neither: it is the boundary marker ADR-0029 already requires, scoped to the minimum needed to settle an interrupted pass and to show the agent what happened. It carries **no content**, **no per-event history**, and the `usage` field is the one model call's own reported numbers, not a running account. If the owner reads U-H more strictly, drop `model.usage` and keep the rest; the safety properties do not depend on it.

### 8.2 What the user sees

Nothing in the chat transcript beyond the replacement note itself (which is model-visible and honest: `[janitor] ... evicted ...`). The user may inspect the record through the existing trajectory/log view. No new UI is required. No toast, no banner.

### 8.3 How the agent learns content was evicted, and can ask for it back

Two channels, both already in the surface:

1. **The replacement note** sits exactly where the content was. It says what was evicted (counts, kinds), that it is not verbatim, and the exact `read_span(startSeq,endSeq)` call that returns it. This is the primary channel and it costs only the note bytes.
2. **One ledger line** in the next wake turn, composed by the existing tail assembler (`assembleTurnReminder`): `context: 21k tokens evicted at seq 341-902 (recover: read_span)`. One line, ≤ 120 chars, only on the turn after a pass, and only when the agent did not itself cause the pass. This is the honest alternative to silent amnesia, and it is bounded.

The agent is **not** told "your memory is being deleted"; it is told retrieval is exact and cheap. That is the red-team's recommended posture (§6), and it is the only one that does not incentivise defensive re-reads.

---

## 9. Retrieval API

| Item | Decision |
|---|---|
| **Tool name** | `read_span` (shared with the segmented-compaction design; one retrieval verb, no synonyms). |
| **Identifier** | `startSeq` and `endSeq` — inclusive surface-position span, exactly the numbers printed in the note. Optional `offsetChars` and `maxChars`. There is **no** free-text query, no embedding, no index (U-H). |
| **Response shape** | A status header, then the raw content in order: `[read_span 341-902 | 563 nodes | 41,200 tok | complete]`, then the concatenated projected text of each node, each prefixed by its seq and type. A truncated read ends with `[... truncated at 12,000 chars; resume with offsetChars=12000]`. A missing/never-existent span returns an error naming the first seq not on the surface. |
| **Size limits** | `maxChars` default 12,000, hard cap 48,000 per call. One call per tool invocation; no ranges concatenation. A response over the cap is truncated with an exact resume offset, never silently cut. |
| **Does it re-enter the surface?** | **Yes, but only as an ordinary `tool/result` appended at the tail.** It is never spliced back into the evicted position. This is deliberate: re-splicing would be another history rewrite and another cache invalidation; a tail tool result costs one new block. The returned bytes are as large as the agent asked for, so the agent controls the cost. |
| **Idempotency** | Reading is pure; it appends only the normal tool result, which the host does for every tool call. Repeated reads are allowed and land as separate results; the agent is expected to read narrowly. |
| **What it can read** | Any range of real log events, including content shadowed by the janitor, by native compaction, or by our own notes. It skips log-only events and reports them as positions (H6 keeps them out of the surface but they are in the log). |
| **What it must not do** | Return content from a *different* session; search by text; return more than the hard cap; bypass the recorded usage of the tool call. |

This satisfies U-H: retrieval is by seq only. There is no inverted index, no content table, no second database. The note's pointer is the index the agent scans for free.

---

## 10. Testing plan

### 10.1 Offline, with a fake host (no dsh import)

The repo already has `src/core/fake-host.ts`. The validator and the swap driver must be pure functions over a structural host surface (`nodes`, `seq`, `eventAt`, `append`, `measure`, `appendPluginRecord`), so all of the following run in `npm test` with no boot:

**Validator (pure, table-driven):**

1. A valid plan over a synthetic 200-node surface passes all checks.
2. Schema: unknown op key `content` → `FREEFORM_CONTENT`.
3. Schema: `v: 2` → `SCHEMA`.
4. Duplicate `spanId` → `SCHEMA`.
5. A seq not in `nodes` (simulating a native-shadowed span) → `SPAN_NOT_ON_SURFACE`.
6. A seq beyond `session.seq` → `SEQ_OUT_OF_RANGE`.
7. Reversed span (`start` after `end` positionally) → `SPAN_NOT_ON_SURFACE`.
8. Gap in the partition → `COVERAGE`.
9. Overlapping ops → `COVERAGE`.
10. A `keep` whose hash was altered by one byte → `BYTES_MISMATCH`.
11. A `drop` whose hash does not match → `BYTES_MISMATCH`.
12. A `drop` carrying a `note` → `DROP_HAS_TEXT`.
13. A 401-char note → `NOTE_INVALID`.
14. A note reproducing 60 chars of the dropped span → `NOTE_INVALID`.
15. A split tool pair (call outside, result inside) → `PAIR_SPLIT`.
16. A cursor boundary in the middle of a tool pair → `PAIR_BOUNDARY`.
17. Node 0 (system) inside the mutable run → `SYSTEM_HEAD`.
18. The policy message inside the mutable run → `PROTECTED_TOUCHED`.
19. The newest-32k tail inside the mutable run → `PROTECTED_TOUCHED`.
20. The in-flight turn's messages inside the run → `PROTECTED_TOUCHED`.
21. A span quoted this turn inside the run → `PROTECTED_TOUCHED`.
22. A `janitor` note as the drop target → `PROTECTED_TOUCHED`.
23. Saving of 5,000 tokens → `UNDER_MINIMUM`.
24. A run of 30% of surface tokens → `BLAST_RADIUS`.
25. Two disjoint mutable runs → `SCHEMA` (single-run rule).
26. An unmatched `compaction/start` → `NATIVE_LOCK`.
27. An open `approval/asked` → `APPROVAL_OPEN`.
28. `declared.savingTokens` differs by 20% → `SUSPICIOUS_DECLARATION`.
29. A single `tool/result` span produces a `tool/result` replacement with only `content` changed (assert every other field equals).
30. A multi-node run produces a `user/message` replacement.

**Swap driver (fake host with a controllable `seq`, `measure`, and `append`):**

31. Happy path: `compaction/prune` is immediately followed by the replacement, in that order, with the right `shadowedSeqs` and `shadowedTokenCount = Σ heuristicTokens`.
32. `append` of the replacement throws → no `applied` record; the surface is unchanged or compensated; `passInFlight` is cleared.
33. `logRevision` bumped between validate and apply → `aborted`, zero appends of `compaction/prune`.
34. Applying the same `janitorId` twice → the second call writes nothing and returns success (applied marker found).
35. Applying a plan whose span was already replaced → `SPAN_NOT_ON_SURFACE`, zero appends.
36. Resume with `planned` without `applied` → `aborted{interrupted}`, no replay.
37. Two concurrent calls → second returns `busy`, no appends.
38. `session.seq` advances during the synchronous block (simulated by a getter) → the apply must not re-read it after step 1; assert a single measure per pass.
39. Fork with a pending plan: child id mismatch → `IDENTITY`, no appends.
40. Ownership: a plan for a sibling dispatcher's worker → `NOT_OWNED`.

**Invariants (property-style, deterministic seeds):**

41. For any accepted plan, `after < before` per run and the total saving equals the validator's own sum.
42. For any rejected plan, the fake host's append log is empty.
43. The apply is idempotent: applying twice yields one replacement.

### 10.2 Needs a live boot (cannot be faked honestly)

| # | What to verify | Why it cannot be offline |
|---|---|---|
| L1 | `session.append('compaction/prune', ...)` from our plugin is accepted at runtime and priced by the projection. | The type is declared by `dsh-compaction`; our structural call is untyped. **This is the highest-risk assumption in the document.** |
| L2 | A `user/message` replacement over a multi-node span including `tool/result` nodes folds and replays correctly. | Only the host's fold validates `sourceEventSeqs` coverage and pairing in situ. |
| L3 | A hard kill between the prune and the replacement leaves a log that restores to a consistent projection. | The orphan-prune behavior is not readable from the `.d.ts` (§6.3). |
| L4 | `ctx.tokenMeter.measure(session).logRevision` equals `session.seq` at the pre-step boundary, and does not move inside one synchronous block. | The measurement is projection-backed; only a live turn shows it. |
| L5 | `appendPluginRecord` accepts a type declared only by our package augmentation and survives resume. | The compaction-stack design lists this as open question 5. |
| L6 | Native `compaction/start` really blocks our pass on the same agent, and our listener order in `agent/pre-step` is as assumed. | Scope routing and registration order are runtime facts. |
| L7 | `read_span` returns the exact bytes of an evicted span after a native compaction has shadowed it. | Depends on the log surviving and on `deriveEventMessage` with projections. |
| L8 | The reconciliation: a full pass over a real 500k session, with the surface diffed before/after and the log replayed from scratch, comparing derived messages byte-for-byte. | The only end-to-end proof. One boot, one session, one pass, one restart. |

---

## 11. Failure posture

**Default: do nothing and say so once.**

| Situation | Behaviour |
|---|---|
| A single plan fails validation | Append `janitor-pass {status:'failed', error:<code>}`. Apply nothing. Do **not** ask the model to repair it in the same turn: a repair loop against a hostile model is a way to wear down the validator. Retry once on the next pass with a fresh snapshot. |
| Two consecutive plans fail validation | Open the breaker for the session. Stop trying. Append one record `{status:'failed', reason:'breaker'}`. Add one line to the next wake-turn ledger: `janitor paused after 2 rejected plans; native compaction unaffected`. Nothing else. |
| The model call itself fails (timeout, provider error) | Count it; no surface change. Same breaker after two. |
| The revision changed (stale plan) | `aborted`, not `failed`. Does not count toward the breaker; staleness is expected under bursts. But if 3 consecutive plans are stale, the breaker opens with `reason:'too-slow'` and the ledger says so. |
| An apply throws after the prune | The compensating replacement restores the original bytes; `failed`; breaker counts it. If the compensation also throws, stop the session's janitor permanently and surface the error once. |
| Native compaction fires during a pass | `aborted{native-lock}`, no breaker count. Native is the backstop, not a competitor. |
| The breaker is open | The session runs exactly as if the janitor did not exist. Native compaction, the model, and the user are untouched. The only trace is one log record and one ledger line. |
| The user wants it off | There is no runtime toggle (ADR-0005/0018: no flag). The config field is read at activation. State this plainly; do not imply a live switch. |

**What the agent experiences when validation keeps failing:** nothing at all. No error, no retry prompt, no partial history. That is the correct posture: a safety check that fails is not a task failure.

---

## 12. Assumptions that need live verification (complete list)

| # | Assumption | Consequence if wrong |
|---|---|---|
| A1 | A plugin may append `compaction/prune` and the metering projection consumes it. | The whole swap protocol has no valid pricing event. **Blocking.** |
| A2 | The projection tolerates a prune whose replacement never landed across a hard kill (or the compensating write always lands). | Resume could show a drifted `contextPressure`. **Blocking.** |
| A3 | `measure().logRevision` is stable inside one synchronous pre-step block and equals `session.seq`. | The revision fence can spuriously reject every plan. |
| A4 | A `user/message` replacement may span nodes of any surface type, including tool results, as long as `sourceEventSeqs` covers them. | Multi-node drops must be split, which breaks single-run atomicity. |
| A5 | `appendPluginRecord` accepts our declared record type and the record survives resume and fork. | Observability and idempotency marker unavailable; fall back to a `developer/message` log-only? (there is none — would need a different design). |
| A6 | The tool-pairing helpers accept every seq in the cursor window and throw only on non-members (H8). | Boundary checks must be reimplemented locally. |
| A7 | `deriveEventMessage` is stable for our replacement nodes after replay (no projection needed). | Hash checks would fail after a restart. |
| A8 | The dispatcher policy can be moved to a system-prompt section before the janitor is enabled. | The policy lives in a mutable user message; C18 protects it only by source kind, which is a narrower guarantee. **Prerequisite for touching dispatcher sessions.** |
| A9 | Native compaction does not treat our `[janitor]` user messages as checkpoints. | A native summary could summarize a note into prose, eroding the pointer. Native summarizes everything anyway; `read_span` still works. |
| A10 | A per-session `passInFlight` is enough; there is no second writer per session. | Cross-process locking is unbuilt. |
| A11 | The inline snapshot renderer the model sees is byte-stable enough that its reported `sha256` matches the host's canonical hash. | C12/C13 reject every plan. The renderer and the validator must share one canonicalization function; this is an implementation rule, not an assumption to verify live. |

A11 is the sharpest implementation trap: **one canonicalization function, used by both the renderer and the validator.** If they differ by whitespace, every plan fails.

---

## 13. What this design deliberately does not do

- No multi-run plans in v1 (atomicity).
- No line-level or block-level editing inside a message (whole-node spans only).
- No model-authored content except a labelled note.
- No local content index, token ledger, or second database (U-H, ADR-0006).
- No plan replay after a restart (ADR-0012).
- No retry loop against the model.
- No tuning of native compaction; it remains the backstop.
- No janitor on sessions it does not own (per-parent ownership).

---

## 14. Source index

| Claim | Source |
|---|---|
| Surface replacement rules, source coverage, tool-result rewrite restriction, system-head protection | `dsh-session/lib/index.js:314-423`; `dsh-session/lib/types/types.d.ts:440-520` |
| `compaction/prune` shape and adjacency requirement | `dsh-compaction/lib/types/types.d.ts:76-105` |
| Prune pricing unit (`heuristicTokens`) | `dsh-token-meter/lib/types/types.d.ts:44-52` |
| `measure()` shape and `logRevision` | `dsh-token-meter/lib/types/types.d.ts:24-52` |
| Pairing helpers and throw-on-missing | `dsh-compaction/lib/index.js:66-93` |
| Plugin records | `dsh-session/lib/types/index.d.ts:94-117` |
| Native lock state machine | `dsh-compaction-basic/lib/index.js:536-548, 706-734` |
| Approval audit events | `dsh-user-approval/lib/types/types.d.ts:29-60` |
| `agent/pre-step` | `dsh-agent/lib/types/runtime-types.d.ts:304-310` |
| Policy injection today | `src/adapter/parent-agent.ts:34-57`; `src/adapter/wake-copy.ts:32` |
| Red-team findings this design answers | `docs/research/janitor-redteam-2026-10-19.md` §4.3 (surface vs log), §3.3 (notes), §5.2 (validator limits) |
| Compaction stack and cache economics | `docs/research/compaction-stack-design-2026-10-19.md` §2, §6 |
| Retrieval shape and U-H position | `docs/research/segmented-compaction-design-2026-10-19.md` §9 |
| Native mechanics evidence | `.scratch/repo-analysis/2026-10-19-native-dsh-compaction.md` §8 |
