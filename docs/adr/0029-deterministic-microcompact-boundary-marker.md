# Compaction starts with deterministic microcompact, and the compaction boundary is the success marker resume reads

**Status:** agent-drafted 2026-10-18 from the owner's decision 6 (see `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"); **owner-reviewed and corrected 2026-10-19** — this ADR records what we adopt first, not a ban on anything else. No prior compaction ADR exists. ADR-0018 U-H and ADR-0006 bind. The window source and constants in §Starting window source are first-implementation choices, not an owner ruling.

**Numbering:** 0029, the fifth free number at filing (2026-10-18; 0024 was the highest in use before this pass). No prior ADR covered compaction or context — a search of `docs/adr/` for "compact", "compaction", and "microcompact" returned nothing before this filing. Filed by the records pass from the owner's 2026-10-18 decision, recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 6. The human ruled the direction; the text below is the agent's draft of it. Implementation is ticketed separately per repo rule; no source was edited in this pass.

## Context

We have no compaction today. `report-clamp.ts` clamps report text (4000/1200/200/300, 20 roster rows); policy is injected once; the ledger and standing rules are re-injected per turn. There is no window measurement, no compaction, no parts, and no memory (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"What each source offers" → Compaction and memory).

The three studied trees differ. Grok Bot compacts deterministically on provider-reported usage at roughly 90% and persists at roughly 95%, with a model-written fixed 9-section summary; the system prompt and the latest user message stay verbatim. DeepSeek-Bot does deterministic threshold math **plus a cheap steward model call** returning `{"action":"switch"|"compact"}`, and keeps a checkpoint. ZCode is **fully deterministic with no model call**: `threshold = (contextWindow − min(maxOutput, 21k)) − 13k`, checked before every request; three layers — **microcompact** clears old tool results at 0.9× threshold keeping the newest 5; full compact at threshold writes a summary; reactive compact runs only after provider overflow. Its boundary part carries `lastSummarizedMessageId` plus the preserved segment head/tail as the **only success marker**, written as one rollback unit, and resume reads it.

The owner adopted ZCode's deterministic boundary-as-success-marker and microcompact as the starting point.

## Decision

1. **Compaction is deterministic in the first implementation.** The decision is a check against a measured threshold, so the same state produces the same decision; no model call decides whether, when, or what to compact. This is the shape we build first. A future layer that wants a model in the loop needs a ticket that states the tradeoff and the determinism it gives up.
2. **Microcompact is the first layer.** Clear **old tool results** when the measured usage crosses a **ratio of the usable window**, keeping the **newest few** tool results intact. The newest messages and tool results the agent is actually working from survive; older tool results are the first thing dropped. The exact ratio, the "newest few" count, and what a cleared result is replaced with are the implementing ticket's, stated there before implementation.
3. **The compaction boundary is the success marker resume reads.** If a compaction step is interrupted, resume reads the boundary marker to decide where to continue. The boundary is written as **one rollback unit**: either the whole boundary (and the rewritten segment it describes) is present, or the compaction did not happen. A future compaction layer extends the same marker or writes a new one explicitly; it does not leave resume guessing from transcript shape.
4. **The first implementation uses no steward model call.** DeepSeek-Bot's cheap-model switch/compact decision is not part of the first implementation. It remains an available option; adopting it needs a ticket that states the tradeoff against decision 1.
5. **The first implementation clears old tool results only.** Full compaction — summarizing older messages into one synthetic message — is not part of the first implementation. It remains an available option; adopting it needs a ticket that states the tradeoff, not a fresh ruling.
6. **The usable window is measured from the host, not guessed.** The ratio is taken over a usable window the host provides. **First implementation:** the source is `session.requestContext()?.contextWindow`, with `ctx.tokenMeter.measure(session)` as the measurement and `agent/pre-step` as the trigger point — see §Starting window source.
7. **ADR-0018 U-H and ADR-0006 bind.** U-H: no per-stream usage/token accounting of our own, no local content-search index. The compaction boundary and any usage measurement are held through the host, not added as our own ledger or index. ADR-0006: no second database — any durable marker lives in dsh's session/job store.

## Constraints that stay in force

- **ADR-0018 U-H**: no local content-search index and no per-stream usage/token accounting. The first implementation does not make cleared tool results searchable as a compensation; a future ticket that wants that must first address U-H.
- **ADR-0006 / ADR-0018 A5**: persistence stays in dsh's session/job store; no second database.
- **ADR-0012** (wording loosened 2026-10-18 to "current shape, revocable"): a boundary marker may be replayed across a restart; work may not. Compaction is a rewrite of stored context, not a re-run.
- **ADR-0018 C15** is unaffected: compaction creates no wake kind.
- The prompt tail carries the peer roster (ADR-0027). Microcompact clears **old tool results**, not injected system text or the tail.

## Starting window source (first implementation)

The window number **exists, is produced per request by the adapter, is logged durably, and is readable deterministically by a plugin**. Decision 6's "measured, not guessed" is satisfied by the following, all verified against `dsh@0.2.1-rc.2` in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q5:

1. **The adapter owns the window.** `dsh-llm-deepseek/lib/index.js:510-523` resolves `contextWindow` per request as `configured?.contextWindow ?? connection.defaultContextWindow` and returns it inside `context: { contextWindow }`. This is provider/adapter **configuration**, not provider-reported usage.
2. **The agent loop logs it into the session.** `dsh-agent-loop/lib/index.js:1262-1271` reads `preparedCall?.context?.contextWindow`, builds `requestContext`, and appends a durable `request/context` event whenever it changes. `Session.requestContext()` is the cached fold of that event.
3. **Read it two ways.**
   - `ctx.tokenMeter.measure(session)` — implementation `dsh-token-meter/lib/index.js:722`, returns `TokenMeasurement`. Synchronous, deterministic, no model call, no I/O, no timer; derived from the session log on each call (so it creates no local ledger — ADR-0018 U-H is satisfied).
   - `session.requestContext()?.contextWindow` — the same durable value the loop will use for the request it is about to make.
   - Use `requestContext()` as the window; fall back to the measurement only when the request context has none. The trigger and the request then agree by construction.
4. **Trigger from an `agent/pre-step` listener.** That is exactly what the host's own compaction does (`dsh-compaction-basic/lib/index.js:839-855`), and it fires before every request. Determinism is preserved: same state, same decision.
5. **The first implementation does not read `contextPressure.contextWindow` as the trigger denominator.** It is documented as *not* one atomic request observation — last-wins slots can pair a fresh capacity with the previous route's pressure (`dsh-token-meter/lib/types/projection.d.ts:18-36`). It is a user-facing display value; using it as a gate can fire on a mixed pair.

**What remains ticket-level (open question 2).** The trigger **ratio** and the **keep count** are the ticket's to pick and record before implementation. This record covers where the denominator comes from, not the constants multiplied against it.

**Two environment facts that bound the ticket.** (a) In this profile `compaction-basic` and `tool-result-pruner` are **disabled on the web host plane** (`dsh-web-app/cordis.patch.yml:539-546`) and mounted **inside each agent preset** instead. (b) A spawned child **inherits the parent's preset**, so under the current shape a worker does get host compaction; our microcompact is therefore an **additional layer**, not the only one. Neither fact changes this ADR's decisions; both matter when the ticket writes acceptance criteria.

## Consequences

- Compaction can be tested without a model: given a measured usage and a message list, the decision and the resulting list are deterministic.
- The boundary marker is a resume contract. A future compaction layer extends the same marker or writes a new one explicitly; it does not leave resume to infer from transcript shape.
- The first implementation clears only tool results, so very long sessions keep their message bodies. What happens when microcompact alone cannot bring usage under the window is **unresolved** — the ticket states the honest posture (for example, surface the limit) or adopts full compaction by stating the tradeoff.
- The worker and dispatcher prompts are unaffected by the ratio; compaction operates on conversation history, not on the contract text.
- **PRD sections needing amendment (ticket-owned, not amended here):** §6.1 (dispatcher policy, if the limit becomes user-visible), §7.5 (data model — the boundary marker's home), §14 (risks — long-session handling gains a mitigation), §16 (glossary — microcompact, boundary marker).

## Open questions

1. ~~**Where does the usable-window number come from** on dsh 0.2.1, and is it stable enough to trigger on?~~ **First implementation:** `session.requestContext()?.contextWindow`, measured with `ctx.tokenMeter.measure(session)`, triggered from `agent/pre-step`; stable enough to trigger on, with the recorded caveat that `contextPressure.contextWindow` is not atomic and is not the denominator (§Starting window source).
2. **The trigger ratio and the keep count** — both are the ticket's, and both must be recorded before implementation.
3. **What a cleared tool result leaves behind** — a placeholder, an id, or nothing — and whether the model is told.
4. **The posture when microcompact alone is insufficient** — surface the limit, add full compaction, or something else. The first implementation does not adopt full compaction; a ticket may, stating the tradeoff.
5. **Where the boundary marker lives** in dsh's session/job store and how it is written atomically (ADR-0006's obligation-marker idiom is the precedent, not a mandated shape).

## Traceability

- Ruling: `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 6 (level-1 dated human ruling; the ADR text is the agent's draft of it). The human's words are "Adopt ZCode's boundary-as-success-marker and microcompact"; the three-tree comparison and ZCode's shape are in the same file, §"What each source offers" → Compaction and memory, with per-source detail in `.scratch/repo-analysis/2026-10-18-memory-compaction.md` (untracked, disposable).
- Window-source evidence: `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q5 (`dsh-llm-deepseek/lib/index.js:510-523`, `dsh-agent-loop/lib/index.js:1262-1271`, `dsh-token-meter/lib/index.js:722`, `dsh-compaction-basic/lib/index.js:839-855`). The source choice recorded here is the first implementation's, not a ruling.
- ADRs: 0018 (U-H and A5 bind; C15 unaffected), 0006 (no second database; durability split), 0012 (boundary replay is not work replay), 0027 (the tail roster is not compaction material).
