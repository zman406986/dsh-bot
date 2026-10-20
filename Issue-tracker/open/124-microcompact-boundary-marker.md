# 124 — Microcompact + compaction boundary marker (deterministic, no model call)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 114 (0.2.1 host port; the window surface must be verified on the booted tree)
**Related:** ADR-0029 (§Settled window source), ADR-0018 U-H (no local accounting or search index), ADR-0006 (no second database), ADR-0012 (restart replays durability, never work), ADR-0018 C15 (no wake kind)

## Problem

Nothing compacts today. Long sessions grow without bound and no boundary is recorded, so a resume has no marker to read. ADR-0029 rules deterministic microcompact in: clear old tool results when measured usage crosses a ratio of the usable window, keep the newest few, and write the boundary as the single success marker resume reads.

Where the window number comes from was open; it is now settled.

## What to do

**Window and trigger (settled — build to this, do not re-derive)**

- [ ] Register an `agent/pre-step` listener. It fires before every request — the same hook the host's own compaction uses (`dsh-compaction-basic/lib/index.js:839-855`).
- [ ] Read the window as `session.requestContext()?.contextWindow`. That value is produced per request by the adapter (`dsh-llm-deepseek/lib/index.js:510-523`) and logged durably as a `request/context` event (`dsh-agent-loop/lib/index.js:1262-1271`).
- [ ] Measure usage with `ctx.tokenMeter.measure(session)` (`dsh-token-meter/lib/index.js:722`). It is synchronous, deterministic, and derived from the session log per call — no local ledger.
- [ ] Fall back to the meter's `contextWindow` only when the request context has none.
- [ ] **Do not** use `contextPressure.contextWindow` as the denominator. It is documented as not one atomic observation — last-wins slots can pair a fresh capacity with the previous route's pressure (`dsh-token-meter/lib/types/projection.d.ts:18-36`).

**Thresholds (ticket-level — record before implementing)**

- [ ] Pick and record the trigger **ratio** and the **keep count**. The host's shape is `window - reservedCompletionTokens - headroomTokens` with `thresholdRatio 0.8` and `headroomTokens 65536`; ZCode's is `window - min(maxOutput, 21k) - 13k`. Both are the same shape with different constants. State the choice and why.
- [ ] Pick and record what a cleared tool result is left as (placeholder, id, or nothing) and whether the model is told.

**Microcompact**

- [ ] Clear **old tool results** only. Never system text, never the injected prompt tail (the peer roster from ticket 121 lives there).
- [ ] Keep the newest few tool results intact.
- [ ] Deterministic: the same measured usage and the same message list produce the same decision and the same resulting list. A test must assert this without a model.

**Boundary marker**

- [ ] Write the compaction boundary as **one rollback unit**: either the whole boundary (and the record of what it describes) is present, or the compaction did not happen. No partial layout, no second marker, no inference from transcript shape.
- [ ] Resume reads **only** this marker to decide where to continue.
- [ ] Home it in dsh's session/job store (ADR-0006). Do not add a second database, a plugin record (`appendPluginRecord` is not licensed for third-party callers), or a local search index.
- [ ] Replay of the marker is not replay of work (ADR-0012).

**Honest limit**

- [ ] Full compaction is not adopted. State plainly what happens when microcompact alone cannot bring usage under the window (for example, surface the limit). Do not invent a fallback this ADR did not rule.

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
