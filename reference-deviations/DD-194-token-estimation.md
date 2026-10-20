# DD-194 — Token estimation (heuristic budget accounting) vs raw character caps
- **Area:** A24 context management
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference carries a dedicated token-estimation module that converts message content into an approximate token count. It sums the characters of the text parts it chooses to count, divides by a fixed characters-per-token ratio (recorded as 2.5), and rounds up; it also adds a flat per-message overhead (recorded as +25) to every message and a larger flat overhead (recorded as +50) to tool-call and tool-result parts, so structural framing is priced alongside payload text. A second, simpler estimator lives elsewhere in the reference and divides a string's length by a different ratio (recorded as 4) — the reference therefore holds two mutually inconsistent heuristics rather than one calibrated one.

Those estimates feed budget decisions. A separate constant (recorded as 0.9) takes a fraction of the model's maximum context window as the effective working budget, and the summarization path compares estimated usage against that reduced ceiling to decide when to compress or summarize. The safety fraction leaves headroom: the reference deliberately acts before the hard limit rather than at it. Because the constants are hard-coded per ratio and per message shape, the estimate is an approximation of the real model limit, not a reading of it, and it is tuned to particular model families.

## What the current build does
The build accounts in raw characters and never converts to tokens. Its report-clamp thresholds are plain character counts — a completed-report body bound, an error-body bound, a check-row activity bound, and a roster recent-result excerpt bound (4000 / 1200 / 200 / 300, in `src/core/report-clamp.ts` lines 17–32). There is no ratio, no per-message or per-part overhead addition, and no safety fraction anywhere in the clamp path; `src/core/report-clamp.ts` measures with string length and cuts at the limit.

The model-facing policy text in `src/core/policy/prompts.ts` carries the wake and standing-rule instructions but contains no character or token budget accounting at all — the policy half of the wake path states what the dispatcher should do with a settled worker, while the clamp half decides how much of the report reaches it. The build's choice here is recorded, not accidental: ADR-0018 exception D21 (line 32) records the clamp bounds as the adopted route, and exception U-F (line 39) records context hygiene as achieved by clamping inline rather than by spilling large outputs to storage with prompt-side references.

## The deviation
The two sides are not measuring the same quantity, and the asymmetry is worth stating plainly. The reference estimates a token budget for context it intends to hold and compress, and its estimator exists to drive that decision. The build's clamps govern what it *delivers* — the length of a worker report, an error body, or a roster excerpt as it enters a wake notice — not a model-facing context budget it owns and manages. The build delegates the actual context window to the host model runtime and does not attempt to model it; its clamps keep the text the build passes along within a size limit, applied in characters because characters are exactly what it is limiting.

The trade is genuine in both directions. Character caps are simpler, deterministic, cheap, and require no model-specific tuning: the same input always yields the same output, and the bound is exactly the number a reader can count. Token estimation is more accurate against real model limits — a 4000-character ceiling can be a very different fraction of a context window depending on the content, whereas a token estimate tracks the limit the model actually enforces — but it buys that accuracy with an estimation error, a set of hard-coded model-specific constants, and the burden of keeping those constants honest. The reference's own two conflicting ratios (2.5 and 4 characters per token) are direct evidence of that maintenance cost: the same string can be priced 60% differently depending on which module asks.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 D21 records the build's character-based clamp bounds as the adopted route, and U-F records inline clamping as the context-hygiene decision, so the character approach is recorded rather than accidental and is not open to a silent swap. D21 is specifically about clamp bounds, though, and does not reach token accounting as such — the build has no model-facing budget to account against, so token estimation has no job to do here and there is no recorded ruling that forecloses it should that ever change. Importing a ratio-plus-overhead estimator now would add an approximation error and model-specific constants to solve a problem the build does not have. The correct reading is DO-NOT-INCORPORATE on present scope, with the door explicitly left open rather than a claim that the question is fully unruled.

## Incorporation notes
- **Where it would live:** If it were ever taken up, a new pure helper module beside `src/core/report-clamp.ts` (the clamp path is where a budget-aware bound would be computed), with any budget constants landing near the clamp thresholds rather than in `src/core/policy/prompts.ts`, which is prompt copy and not a place where budgets are accounted.
- **Constraints:** The clamp path is pure and host-free by construction (`src/core/report-clamp.ts` header), so any estimator must be a pure function with no runtime calls. A character-clamp behaviour is covered by the existing wire/parse agreement rule — the roster excerpt bound applies to the whole kept string including the ellipsis — and any budget-aware variant would need to preserve that exactness rather than reintroduce off-by-one drift. Any ratio or overhead constant would be model-family-specific and would need to be re-derived, not imported.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S to build a pure estimator; the real risk is ongoing — hard-coded model-specific constants drift as models change, and the reference's own two inconsistent ratios show how that drift appears in practice.
- **Key reference anchors:**
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent-summarization/token-estimate.ts` — the message-aware estimator: ratio constant at line 3, per-message overhead at line 4, tool-part overhead at line 5, overhead applied at lines 43 and 45, per-message overhead applied at line 85, ratio division and round-up at line 87.
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/utils/token-estimate.ts` — the second, simpler string estimator, a single division and round at lines 1–3; its ratio differs from the module above.
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/self-summary/constants.ts` — the safety fraction at line 3.
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/summarization-orchestrator.ts` — the fraction applied to the maximum context window at line 310.
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/self-summary/self-summary.ts` — the same fraction applied at line 91.

## Evidence
- Reference:
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent-summarization/token-estimate.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/utils/token-estimate.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/self-summary/constants.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/summarization-orchestrator.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/self-summary/self-summary.ts`
- Build:
  - `src/core/report-clamp.ts` (character thresholds at lines 17–32; length-based comparison and cut at lines 60–74)
  - `src/core/policy/prompts.ts` (model-facing policy copy; no budget accounting)
  - `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (D21 at line 32; U-F at line 39)
