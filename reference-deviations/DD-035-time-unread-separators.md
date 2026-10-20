# DD-035 — Time separators and unread divider vs none
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (likely covered by the same rule as U-C)
- **Date:** 2026-09-23

## What the reference does

The reference transcript renders two separator row kinds inline with the chat entries: a time-separator label row (an entry kind of that name draws a separator-styled div carrying a human-readable label) and an unread-divider row (its own entry kind draws a separator carrying a count label reporting how many new messages arrived). Both are first-class entry kinds in the reference's transcript model — a time-separator entry type (carrying a string label) and an unread-divider entry type (carrying a new-message count) — so the divider reflects how many messages arrived while the view was elsewhere, and the time separator groups the stream by wall-clock gaps.

## What the current build does

The build's conversation store materializes only user/assistant/tool/streaming items. Its module contract lists the skipped vocabulary (`turn/*`, `step/*`, `request/*`, `system/message`, `assistant/attempt`, `session/end-seed`, plugin/unknown types) as log/derived-only, skipped because U-C excludes timeline/log cards — the transcript is chat turns, not a log view — and names this a recorded gap. The switch's default branch drops everything not explicitly handled. Neither a time-separator nor an unread-divider concept exists anywhere in the build's store vocabulary, and no read-state/unread-message concept exists host-side in what I could verify (the only "unread" hits in the client are "unreadable" window states, i.e. read-failure handling, not message-read tracking).

## The deviation

The reference has two kinds of separator row — time grouping and an unread position marker with a count; the build has neither. Time grouping is a display-only affordance derivable from timestamps already present on message entries; the unread divider is a stateful feature requiring the host or client to track which messages were already seen, which the build does not have. U-C (ADR-0018 item 14, "no timeline/housekeeping cards in chat") plausibly motivated the skip, but neither row is obviously a timeline/log entry — they are delivery/read-state UX, so U-C's recorded scope does not clearly settle them.

## Verdict: ASK-HUMAN

ADR-0018's U-C excludes timeline/log cards, and the build's skip of log vocabulary is recorded and intentional; but separator rows are not clearly within that exclusion, and no recorded decision I could find rules on transcript separator rows specifically. The two halves also differ in cost: time separators are a small client-side derivation (adapt), while the unread divider needs a read-state concept that does not exist in the build (host-side state was not found in the conversation store; I can only speak to what I verified there, not the roster snapshot). Since the ruling order says conflicts with no recorded decision go to the human rather than being silently picked, this one goes up: incorporate time separators as client-derived presentation, and rule separately on whether an unread divider is wanted at all.

## Incorporation notes
- **Where it would live:** time separators — presentation layer over the store's materialized items (derive from entry timestamps at render/aggregation time in `src/client/conversation-store.ts` output shaping or the transcript component); unread divider — would need a new seen/read marker on the session window, i.e. a host or client-store state addition, not just rendering.
- **Constraints:** U-C must be respected in the ruling (these are arguably presentational rows, not log cards — the human decides); no unread state may be invented host-side without a decision; separator labels should derive from local timestamps already on entries; when there is no unread data, show no divider rather than a made-up count.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — time separator alone is S (pure client derivation); the unread half is the risk, since it introduces a new read-state concept the host does not currently have.
- **Key reference anchors:** separator render branches at `frontend/src/recovered/features/conversation/workspace/transcript.tsx:701-702`; the two separator entry types at `workspace/model.ts:287-297`; U-C mapping noted at reference `conversation.tsx:14-15` (per enumeration, not re-verified).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 701-702: time-separator and unread-divider render branches); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/model.ts` (lines 287-297: the two entry interfaces)
- Build: `src/client/conversation-store.ts` (lines 52-56 module contract: non-chat vocabulary skipped, recorded gap; lines 450-452: default case drops unhandled kinds); grep over `src/` and `client/` shows "unread" only as "unreadable" read-failure wording, no message-read state; `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` line 36 (item 14, U-C)
