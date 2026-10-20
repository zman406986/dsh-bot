# DD-077 — In-transcript approval card affordances vs Needs-you section cards
- **Area:** message cards (A10)
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does

The auto-review approval is a **card component rendered inside the transcript** (the reference's auto-review approval card): it renders inside the conversation flow, at the history entry where the paused action happened. Its interactive controls:

- **Per-surface title copy.** A lookup table keyed by surface gives each approval surface its own heading and subject noun — host/box shell asks read as a command request, MCP as a connected-service request, subagent as a task request, and computer/automation/cloud surfaces fall back to an auto-review-paused style heading.
- **Location line.** Shell and computer surfaces carry a one-line where-it-runs note (local machine vs the bot's machine); other surfaces omit it.
- **Collapsible summary.** The command/summary text renders inside a `<details>` disclosure (with generic boilerplate summaries suppressed), truncated at **340 characters** with an explicit omitted-chars marker.
- **Pending affordances.** Three buttons — allow-once, always-allow, and deny — disabled unless the approval is pending, an action transport exists, an agent scope is known, and the history entry has not gone stale.
- **Rich settled labels, including failure paths.** A lookup table of status labels covers allowed-once, always-allowed, denied, and expired — plus a **failed** action state rendered as a status-unavailable label and a **stale** resolution rendered as expired. The action state machine (the reference's auto-review actions module) distinguishes pending / submitting / settled / stale / failed.
- **Settled rule note with redaction.** After an always-allow answer, a follow-up line announces that a rule was added to the auto-review settings, and shows the proposed rule after passing it through a redactor: it strips URL credentials/query/fragment, masks secret assignments written as key/value pairs (the usual set of secret-word keys), masks Bearer tokens and common vendor key-prefix shapes, and collapses whitespace.

## What the current build does

Access-ask / secret-ask cards (`src/client/approval-cards.ts`, ticket 69 chunk B, frozen shapes rendered by ticket 81) are **built at render time from what the approval relay reports** — pending access tickets plus resolved-access notices — and render in the **"Needs you" section** (`src/client/approval-pane.tsx`), which `createConversationPane` (`src/client/conversation.tsx`) mounts **above the transcript**, as a separate block. They are not placed at any position inside the conversation history.

- **Option set.** Allow / Always allow (this session) / Deny — the option set defined by ticket 30, re-hosted here; degrades to Allow/Deny when the target carries a wildcard, so consent can never cover a pattern (ADR-0011's session-scoped always, wildcard-fenced).
- **Settled presentation.** One card transitions through `pending → resolved | expired` (`AccessAskCardStatus`); the settled card shows a single status line plus where the decision came from (core `AccessDecision.reason` labels, e.g. a deny from the review-posture table or the ADR-0008 timeout deny). A transport failure renders an honest one-line submit-failure notice — but there is **no stale/unavailable state on the card itself**, and no per-card failed label once settled.
- **Detail handling.** The reason renders as one clamped string with an omission marker (`clampApprovalDetail`); there is no collapsible disclosure. There is **no proposed-rule concept**: the always answer is session-scoped memory, not a persisted rule, so there is no settled rule note and no redaction pipeline for one.

## The deviation

Four differences in what the card offers, of different kinds:

1. **In-flow placement vs section placement.** The reference answers the ask at the exact point in history where it happened; the build collects all asks into one "Needs you" area above the transcript. Partly a deliberate design choice (tickets 69/81), partly a host limitation: the build's cards are built from what the approval relay reports (`Multitask.listPendingAccess` plus notices), and that data carries **no transcript position**, so placing a card in-flow needs a join the current projection does not have (the dispatcher's own `spawn_worker` tool-call record — which the dispatch card already uses — is the plausible anchor).
2. **Summary presentation.** Collapsible disclosure with 340-char truncation vs a single clamped line. Cosmetic to moderate; the clamp already omits text honestly.
3. **Lifecycle honesty.** The reference keeps failed/stale visible on the card (an unavailable status label, stale shown as expired); the build's card states are pending/resolved/expired only, with failure expressed (if at all) as a transient submit line. This is a real gap in telling the user the truth, measured against ADR-0018 U-A's requirement.
4. **Settled rule note + redaction.** The reference tells the user what rule was just created and shows it scrubbed of URLs/credentials/tokens; the build has no persisted-rule concept, so there is nothing to show. Whether a rule note belongs here depends on the approval-flow semantics (rule persistence, always-scope) — owned by the DD-215..222 filings, not re-derived here.

## Verdict: ADAPT

Under ADR-0018 (the human-ruled master: imitate the reference in its entirety except the enumerated list), these deltas are genuine deviations, but they split cleanly. **In-flow placement is primarily a question about what the host exposes**: the relay-derived projection has no history position, so in-flow cards require anchoring to the dispatcher's own `spawn_worker` record (or whatever anchor the DD-215..222 flow filings choose) — adopt the reference's placement *intent* (answer where the ask happened) once that connection point is chosen, and raise it with the human only if the anchor choice conflicts with the pull-only relay design (ADR-0008). **Stale/unavailable handling is incorporable now** as a pure presentation extension of the existing projection — it strengthens, not fights, the build's own ADR-0018 U-A requirement to show failure states honestly. **The redacted rule note is a policy question that depends on the flow decision**: without a persisted-rule concept (ADR-0011's session-scoped always) there is nothing to display; if the flow DDs introduce rules, import the *technique* (secret/URL scrubbing before display), re-derived under B9. Summary presentation can stay as a clamped line unless the human asks for exact matching.

## Incorporation notes
- **Where it would live:**
  - `src/client/approval-cards.ts` — extend the frozen projection with stale/unavailable status derivations (the status set gains an unavailable case, reported honestly; keep pure/replay-safe).
  - `src/client/approval-pane.tsx` — render the added settled labels; optionally a collapsible detail body if exact matching is wanted.
  - `src/client/conversation.tsx` (or the flow DDs' chosen location) — in-flow mounting anchored at the spawn/tool record for asks traceable to a dispatcher-side action; keep the "Needs you" section as the aggregate for asks that came through the relay with no anchor.
- **Constraints:**
  - Cards are presentation-time views of data that already exists — never a second source of it (approval-cards.ts header invariants B1/B3); an in-flow anchor must come from a durable record, not the relay.
  - Secrets: names only, never a credential value (`access-types` hard rule) — any rule/summary display must re-derive the reference's redaction independently (B9), it cannot be copied.
  - Option-set/always-scope semantics are governed by ADR-0011 and the DD-215..222 flow filings — this DD does not re-open them.
  - No new `access-types.ts` shapes (chunk-B invariant); stale/unavailable must derive from relay data that already exists or from transport outcomes.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — status additions and label rendering are S; in-flow anchoring is the M part and depends on where the flow DDs rule placement; risk is low except for the anchor choice, which can attribute an ask to the wrong origin if joined carelessly.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/views/auto-review-approval.tsx` — the per-surface lookup table of headings, a helper mapping a surface to its location line, summary truncation (340 chars), the status-label table (failed→unavailable, stale→expired), the redactor for proposed rules (URL/credential/Bearer/vendor-key scrubbing), the settled note after an always-answer, and the predicate that gates actions (a stale entry disables actions).
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/auto-review-actions.ts` — the approval action-state union (pending/submitting/settled/stale/failed) and the resolver that handles stale entries.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/views/auto-review-approval.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/auto-review-actions.ts`
- Build: `src/client/approval-cards.ts` (ticket 69/81 header; `AccessAskCardStatus`; `accessAskOptionSet`; `clampApprovalDetail` use); `src/client/approval-pane.tsx` ("Needs you" section, status line, submit-failure honesty); `src/client/conversation.tsx` (`createConversationPane` mounts the cards area above the transcript)
