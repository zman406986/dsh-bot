# DD-033 — Transcript load-error surface with Retry vs static unavailable notice
- **Area:** transcript delivery states (A4)
- **Type:** deliberate-divergence (no-retry rule)
- **Date:** 2026-09-23

## What the reference does
A recovered component gives transcript loader failures their own error surface: an `role="alert"` container holding a titled heading, a detail line telling the user the conversation could not be loaded and to check their connection, and a Retry button. The button's only job is to invoke a retry callback handed down by the parent — the component owns no subscription and no dismissal lifecycle of its own. The copy set (title / detail / retry label) lives in one exported constant block, and the whole surface is keyed by accessibility ids for the heading and the detail line (`frontend/src/recovered/features/conversation/workspace/transcript-load-error.tsx`).

## What the current build does
When a conversation pane's state is not ready, the build renders a single static translated notice carrying a `data-state` attribute — the same treatment whether the session is still waiting or is unavailable — with no retry control anywhere in the branch; only the ready-but-empty case gets a separate notice (`src/client/conversation.tsx:405-412`). The store is what produces that state: an incoming window that reduces to nothing collapses the session to an `unavailable` marker, and an explicit mark-unavailable call sets the same state (`src/client/conversation-store.ts:506-517`). No reload-or-retry action exists on the pane's action surface, so an unreadable window offers no way forward except the static notice.

## The deviation
The reference treats "couldn't load this conversation" as a first-class alert state with a way out (Retry); the build reduces it to the same inert notice used for waiting, with no re-attempt path. The no-retry rule is recorded as deliberate in the feed adapter's header notes (per enumeration findings: `src/client/conversation-feed.ts:14-15`, "no retry model", under ADR-0018 U-A context) (the related deviations are not yet numbered for any sibling transcript-state deviations).

## Verdict: DO-NOT-INCORPORATE
ADR-0018's U-A exception removes the connection-lifecycle model — transport state phases, reconnect banners, failure states — from the imitation mandate, and a loader-failure alert whose copy talks about the connection plus a retry control is that machinery in miniature; the static-unavailable treatment is the rule already recorded in the feed adapter under that same U-A context. The reference surface is also inseparable from its retry-callback contract, so adopting the markup without a retry model would be a hollow affordance. U-A's text does not name transcript loaders explicitly and the ruling order permits human reversal, so a fidelity-minded human could reopen this as a cheap adaptation — but absent that ruling the recorded rule stands.

## Incorporation notes
- **Where it would live:** the non-ready branch of `createConversationPane` in `src/client/conversation.tsx` (a distinct alert-styled variant for `data-state="unavailable"`), plus a reload action threaded through `ConversationActions` and a store path that re-issues `applyWindow` for the session.
- **Constraints:** must not grow into a retry/reconnect lifecycle model (U-A boundary); all copy re-derived independently (B9); a Retry button with no real reload path behind it must not ship; keep the existing single-notice styling family unless the human rules otherwise.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one conditional variant plus a store re-apply call; the real risk is making a failure state look normal, which U-A deliberately leaves unmodelled.
- **Key reference anchors:** `transcript-load-error.tsx` — `role="alert"` container, exported copy constants (title / detail / retry), parent-owned load-error surface component taking a retry callback prop with no internal lifecycle.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript-load-error.tsx`
- Build: `src/client/conversation.tsx:405-412`; `src/client/conversation-store.ts:506-517` (applyWindow/markUnavailable); `src/client/conversation-feed.ts:14-15` (per enumeration findings, not re-verified); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-A at line 34, B9 at line 27, exhaustive-list rule at lines 19-21)
