# 124 — Microcompact + compaction boundary marker (deterministic, no model call)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 114 (0.2.1 host port; the window surface must be verified on the booted tree)
**Related:** ADR-0029 (§Settled window source), ADR-0018 U-H (no local accounting or search index), ADR-0006 (no second database), ADR-0012 (restart replays durability, never work), ADR-0018 C15 (no wake kind)

## Problem

Nothing compacts today. Long sessions grow without bound and no boundary is recorded, so a resume has no marker to read. ADR-0029 rules deterministic microcompact in: clear old tool results when measured usage crosses a ratio of the usable window, keep the newest few, and write the boundary as the single success marker resume reads.

Where the window number comes from was open; it is now settled.

## What to do

**Window and trigger (settled — build to this, do not re-derive)**

- [x] Register an `agent/pre-step` listener. It fires before every request — the same hook the host's own compaction uses (`dsh-compaction-basic/lib/index.js:839-855`).
- [x] Read the window as `session.requestContext()?.contextWindow`. That value is produced per request by the adapter (`dsh-llm-deepseek/lib/index.js:510-523`) and logged durably as a `request/context` event (`dsh-agent-loop/lib/index.js:1262-1271`).
- [x] Measure usage with `ctx.tokenMeter.measure(session)` (`dsh-token-meter/lib/index.js:722`). It is synchronous, deterministic, and derived from the session log per call — no local ledger.
- [x] Fall back to the meter's `contextWindow` only when the request context has none.
- [x] **Do not** use `contextPressure.contextWindow` as the denominator. It is documented as not one atomic observation — last-wins slots can pair a fresh capacity with the previous route's pressure (`dsh-token-meter/lib/types/projection.d.ts:18-36`).

**Thresholds (ticket-level — record before implementing)**

- [x] Pick and record the trigger **ratio** and the **keep count**. The host's shape is `window - reservedCompletionTokens - headroomTokens` with `thresholdRatio 0.8` and `headroomTokens 65536`; ZCode's is `window - min(maxOutput, 21k) - 13k`. Both are the same shape with different constants. State the choice and why.
- [x] Pick and record what a cleared tool result is left as (placeholder, id, or nothing) and whether the model is told.

**Microcompact**

- [x] Clear **old tool results** only. Never system text, never the injected prompt tail (the peer roster from ticket 121 lives there).
- [x] Keep the newest few tool results intact.
- [x] Deterministic: the same measured usage and the same message list produce the same decision and the same resulting list. A test must assert this without a model.

**Boundary marker**

- [x] Write the compaction boundary as **one rollback unit**: either the whole boundary (and the record of what it describes) is present, or the compaction did not happen. No partial layout, no second marker, no inference from transcript shape.
- [x] Resume reads **only** this marker to decide where to continue.
- [x] Home it in dsh's session/job store (ADR-0006). Do not add a second database, a plugin record (`appendPluginRecord` is not licensed for third-party callers), or a local search index.
- [x] Replay of the marker is not replay of work (ADR-0012).

**Honest limit**

- [x] Full compaction is not adopted. State plainly what happens when microcompact alone cannot bring usage under the window (for example, surface the limit). Do not invent a fallback this ADR did not rule.

## Constraints

- No model call decides whether, when, or what to compact. No steward model.
- No local usage/token accounting and no content-search index (ADR-0018 U-H); clear results are not made searchable by us.
- No wake kind is created (C15).
- Note for acceptance criteria: host `compaction-basic` and `tool-result-pruner` are mounted **inside each agent preset** in this profile, and a spawned child inherits its parent's preset — so workers already get host compaction. Ours is an additional layer, not the only one.

## Comments

### 2026-10-18 — filing

Filed for ADR-0029. Open question 1 (window source) was settled on 2026-10-18 with host evidence in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q5 and is written into the ADR; this ticket still owns the ratio, the keep count, the cleared-result shape, and the boundary's home.

Blocked by 114: the window surface must be re-verified on the booted 0.2.1 tree before the trigger is trusted.

### 2026-10-18 — implementation decisions (recorded before code)

**Trigger ratio: 0.55 of the advertised window.** `windowTokens` is
`session.requestContext()?.contextWindow` — the route capacity the adapter
resolves per request and the loop logs durably (`dsh-llm-deepseek/lib/index.js:510-523`,
`dsh-agent-loop/lib/index.js:1262-1271`). Why 0.55:
- Native `compaction-basic` fires at `floor(min(W×0.8, W−O−headroom))`; on the
  live route (W=1,000,000, O=256,000, headroom 65,536) that is **678,464**.
  0.55 × W = **550,000**, i.e. 128,464 tokens below the native summary, so our
  model-free pass lands first and native still owns the hard floor.
- ~0.543 × W is the firing point proposed in
  `docs/research/compaction-stack-design-2026-10-19.md` §L1 (0.80 × native
  threshold = 542,771). 0.55 keeps that placement while staying a plain ratio
  of the advertised window, with no dependency on host config.
- Below ~0.5 the pass would run during ordinary work; microcompact rewrites the
  surface and therefore invalidates the provider prefix cache from the oldest
  cleared node. It is worth doing only in the band below the summarizer.

**Keep count: newest 5 tool results.** Matches ZCode's keep-5 precedent cited
in ADR-0029's context; a dispatcher reads its last few tool calls.

**Cleared shape.** A `tool/result` replacement whose only block is one fixed
text line: `[old tool result cleared to save context; full output remains in
the session log]`. The message keeps its role, `source.callId`, `toolCallId`
and `isError`, so tool pairing is intact. The model is told by the line itself;
the full output stays in the session log (not searchable by us — U-H).

**Minimum saving: 8,192 heuristic tokens.** A pass that would free less does not
run (`insufficient-saving`). Rationale: each pass invalidates the cached prefix
from the oldest cleared node; below ~1.2% of the native threshold the rebuild
costs more than the freed context. Same 8,000 figure as the design note §L1.

**Boundary home.** One row per dispatcher session in the plugin's EXISTING
`multitask_dispatcher` storage domain (`ctx.storageDomain`, ADR-0006), new
table `compaction_boundaries`, key = session id. Payload: `sessionId`,
`passSeq`, `status` (`planned` | `applied`), `trigger` (`ratio`), `ratio`,
`keepNewest`, `usedTokens`, `windowTokens`, `clearedSeqs`,
`replacementSeqs`, `clearedCount`, `clearedChars`, `clearedBytes`,
`freedTokens`, timestamps. Resume reads the newest row: `applied` is the success
marker; a `planned` row means the pass did not complete and is never replayed
(ADR-0012 — the marker replays, the work does not). No second database, no
`appendPluginRecord` (not licensed for third-party callers).

**Domain version stays 2.** `dsh-storage-json` single layout rejects ANY stored
version != the declared one (`lib/index.js:100-102`), so bumping to 3 would
refuse to open every existing marker store. The added table reads as empty on
old stores. A downgrade loses the new table only; downgrades are not supported.

**What happens when microcompact cannot bring usage under the window:** the
native pruner + summarizer at 678,464 remain the host-owned fallback. We add no
fallback of our own (ADR-0029 decision 5); our layer simply stops firing when
nothing is eligible (`nothing-eligible`).

## Answer

Resolved 2026-10-21 — audited against the shipped tree; every claim below was spot-checked at the cited line.

**Window and trigger (as ADR-0029 settled; not re-derived).** The listener is `agent/pre-step` — the same hook the host's compaction uses (`src/adapter/microcompact.ts:90`; `registerMicrocompact` :536-582, wired per dispatcher session in `src/plugin.ts:961-1010`). The window is `session.requestContext()?.contextWindow` (`src/adapter/microcompact.ts:369`, structural slot :142) — the durable per-request value the adapter resolves and the loop logs; `contextPressure.contextWindow` is deliberately NOT read (:25-27), per ADR-0029 §Starting window source. Usage is `ctx.tokenMeter.measure(session).totalTokens` (:18-21, :374-376) — synchronous, deterministic, derived from the session log per call, so no local usage ledger exists (ADR-0018 U-H). The pure trigger `shouldMicrocompact` (`src/core/microcompact.ts:140-165`) gates on `usedTokens >= floor(window × ratio)`, matching the native engine's boundary.

**One recorded deviation from the bullet sketch — no meter fallback.** The bullet "fall back to the meter's `contextWindow` only when the request context has none" is NOT implemented as written: when the request context has no window, the pass declines with `window-unavailable` and writes nothing. The meter's surface in this plugin carries no `contextWindow` at all (`src/adapter/microcompact.ts:150-161` — only `measure` + `estimateMessage`), ADR-0029's settled record makes the meter the MEASUREMENT, not a window source (`docs/adr/0029-deterministic-microcompact-boundary-marker.md:40`, :44), and the no-guess posture is the recorded design constraint: "an unavailable or implausible window … decline with a stated reason. There is no fallback estimate and no default window" (`src/core/microcompact.ts:131-134`). Pinned by tests at both levels (`test/microcompact.test.ts:89-97`, `test/adapter-microcompact.test.ts:275`).

**Thresholds — exactly the decisions recorded in this ticket's 2026-10-18 comment.** Ratio 0.55 (`src/core/microcompact.ts:51`; on the live 1M route that is 550,000, 128,464 below native's 678,464, so the model-free pass runs first and native keeps the hard floor — :23-31). Keep newest 5 (:54). Minimum saving 8,192 heuristic tokens (:60; a pass under it declines with `insufficient-saving`). Cleared shape: one fixed line, `CLEARED_TOOL_RESULT_TEXT` = "[old tool result cleared to save context; the full output remains in the session log]" (:68-69); the model is told by the line itself, and the replacement keeps every original field except `content` — role, `source.callId`, tool pairing intact — as a single-node replace (`src/adapter/microcompact.ts:452-469`).

**Clearing scope and determinism.** Only `role === "tool"` nodes are ever eligible; system/developer/user/assistant text — and therefore ticket 121's injected prompt tail — are structurally ineligible (`src/core/microcompact.ts:238-242`; pinned by `test/microcompact.test.ts:186`, :207). Determinism without a model is pinned: identical inputs give identical decisions (:138) and identical selections (:276); already-cleared nodes are never eligible again, so a repeat pass is a no-op (:235).

**Boundary marker — one rollback unit.** The boundary row is written ONLY after every replacement landed, and it describes exactly what was replaced; the ordering rationale is recorded at the write site (`src/adapter/microcompact.ts:479-517`): the surface appends cannot be undone, so writing the row first could record a false success — written second, a crash leaves a consistent surface and NO marker. `CompactionBoundary` (`src/core/durability.ts:64-112`) records the semantics, including one deliberate tightening of the 2026-10-18 comment's `planned | applied` sketch: `status` is always `"applied"` and there is NO `planned` half-state (:69-74) — an incomplete pass leaves no row at all, which satisfies the rollback-unit bullet more strictly and ADR-0012 (the marker replays, the work does not; :47-56). Resume reads only the newest row for the session and continues after `boundarySeq`; it never infers a boundary from transcript shape (:57-59, :96-101).

**Home.** The SAME `multitask_dispatcher` storage domain (ADR-0006), new table `compaction_boundaries` keyed by session id (`src/adapter/durable-marker.ts:33-38`; write/read :375-393 — a newer pass overwrites the row, so the newest row IS the session's boundary state). The domain version stays 2: the table is added WITHOUT a version bump so `dsh-storage-json` still opens every existing marker store (:44-53). No second database, no `appendPluginRecord`, no search index. Round-trips pinned in the shared domain: `test/adapter-durable-marker.test.ts:260-267` (one open domain, boundary beside worker markers) and `test/plugin-microcompact.test.ts:362` (through the plugin's durability).

**Native-conflict rules.** Our 0.55 ratio fires below native's threshold; we never write native's `compaction/start` lock but decline with `native-compaction-active` while it is open; we take no lock of our own (`src/adapter/microcompact.ts:45-63`, scan :312-322, guard :396-398).

**Honest limit.** No fallback of our own: when nothing is eligible or the saving is too small the pass declines with a stated reason (`src/adapter/microcompact.ts:417-421`, :477) and the native pruner + summarizer remain the host-owned floor — recorded in `src/core/microcompact.ts:23-31` and in this ticket's 2026-10-18 comment. The plugin wires the listener ONLY on activated dispatcher sessions (`shouldHandle = lifecycle.isDispatcherSession`, `src/plugin.ts:976-977` — workers keep host compaction via inherited preset, so ours is an additional layer), reads the host-plane meter through a guarded getter (:994-1005), and logs one audit line per applied pass (:982-987).

Tests: `test/microcompact.test.ts` (trigger / selection / cleared shape), `test/adapter-microcompact.test.ts` (pass :254, boundary round-trip :573, listener :629), `test/plugin-microcompact.test.ts` (wiring :312, store through plugin durability :362), `test/adapter-durable-marker.test.ts` (:260).
