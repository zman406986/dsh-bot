# DD-127 — Typed token-limit error classification vs coarse stop-reason mapping
- **Area:** inference routing & streaming (A15)
- **Type:** missing-feature (limited by what the host interface exposes)
- **Date:** 2026-09-23

## What the reference does
The reference gives provider token-limit failures a typed identity. `token-limit-error-classification.ts` inspects a provider error's message text against a dozen-plus substring and regex families, each capturing a distinct provider phrasing of the same underlying condition (long prompt, oversized request body, context-window overflow, per-request byte caps, and a max-output-tokens marker). The classifier emits either an input-token-limit error or an output-tokens-limit-exceeded error — both plain error subclasses declared in the reference's prompt-executor module — or nothing when nothing matches. Because the failures arrive as typed instances rather than raw text, upstream code can branch on the class: an input-limit condition is a shape problem the caller may be able to shrink out of, while an output-limit condition is a different failure with a different recovery.

## What the current build does
The build has no token-limit classifier. Its adapter boundary flattens every ending other than a normal completion: `mapStopReason` in `src/adapter/cordis-dsh-host.ts` keeps `completed` and `aborted` as-is and sends everything else — the doc comment names max-tokens, refusal, and unknown together — to the single `"error"` worker status. The accompanying `normalizeSettleReport` and `normalizeWorkerErrorReport` only shape the human-readable report string (placeholder text, message passthrough, clamping); they add no structure. The settle notification the adapter emits, `SettledEvent` in `src/core/types.ts`, carries `workerId`, `status`, `report` (a string), and an optional `transcriptRef` — there is no typed error channel of any kind crossing that boundary.

## The deviation
The reference can tell an input-limit failure from an output-limit failure and from everything else; the build cannot. When a worker dies on a token limit, the build reports the same coarse `"error"` status and a text blob as it would for any other crash, so a differentiated policy — e.g. treating an input-limit settle as recoverable-with-a-smaller-prompt rather than a hard failure — is inexpressible at that boundary: the core receives only `status` plus prose. The classifier's message-matching families are the reference's mechanism; the build's settle event is too narrow to carry the distinction, which is why the build has no equivalent.

## Verdict: ADAPT
Do not port the classifier wholesale: the `SettledEvent` boundary carries only a status string and report text, so typed error classes cannot reach the core without widening an interface the ADRs treat carefully, and the substring families encode third-party provider phrasings that would be fragile and hard to re-derive independently if copied. The feasible option is build-side and narrow: the adapter already sees the raw stop reason (including the max-tokens case) before mapping, so it could recognize a token-limit settle there and either widen the settle event minimally or attach a recovery hint, letting the core express an input-limit-specific liveness/recovery policy instead of treating all errors alike. Any such widening changes the host contract, so route that change through an ADR before implementing. No recorded ruling covers token-limit classification itself; the recommendation above stays within the existing ADRs about the host interface.

## Incorporation notes
- **Where it would live:** detection in `src/adapter/cordis-dsh-host.ts` (beside `mapStopReason`/`normalizeSettleReport`, which already see the raw stop reason and report text); the recovery policy on the core side of the settle path (exact ticket site pending); any `SettledEvent` extension in `src/core/types.ts`.
- **Constraints:** the DshHost settle event's shape limits what can cross that boundary — a typed-error channel means widening it, which needs an ADR; provider-specific message substrings must be re-derived independently, not copied; classification based on report prose is inherently lossy.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — adapter-side recognition is small, but widening that boundary plus a core recovery policy reaches across several modules; risk is medium because it touches the host contract and could misclassify when provider wording changes.
- **Key reference anchors:** `token-limit-error-classification.ts` (message families, classifier entry point); `prompt-executor.ts` error-class declarations (input-limit, output-limit).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/chat-inference/token-limit-error-classification.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/chat-inference/prompt-executor.ts`
- Build: `src/adapter/cordis-dsh-host.ts`; `src/core/types.ts`
