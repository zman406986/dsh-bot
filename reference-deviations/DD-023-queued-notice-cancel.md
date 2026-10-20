# DD-023 — Queued-send notice with Cancel vs none
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (ruled out with the send journal)
- **Date:** 2026-09-23

## What the reference does

When the user submits a turn that cannot go out immediately, the reference transcript renders a dedicated notice row under the message instead of leaving the turn invisible. The row is shown only for entries whose delivery state is queued and that carry no composed-at timestamp — i.e. a turn written now and held back, not one recovered from an offline window. Its text has two variants: a plain waiting-to-send status normally, and a will-send-once-the-transport-returns variant when the transport is down. Beside the text sits a cancel button wired through the transcript actions interface (an optional cancel-queued-send callback). It calls the submission journal's cancel-queued entry with the turn's nonce. That call only fires for records still in the queued phase; it removes the record, resolves the submission as cancelled, and emits a cancelled phase event to its caller. A separate "sent while offline" notice (with its composed-at timestamp) covers the recovered-window case and is out of scope here.

## What the current build does

The build has no queued delivery state at all. A grep for queued/reconnect across `src/client` finds only doc comments: `conversation.tsx:151` ("the user's own queued turn"), `actions.ts:129,143` and `context.ts:200,217` (a submitted turn is "queued" only in the sense that the host sink accepted it), and `shell.tsx:37`, which records the surface as deliberately retry-less — no retry control and no reconnect banner. `conversation-feed.ts:15` states the window is push-updated with no retry model (ADR-0018 U-A). There is no cancel affordance and no transport-down wording anywhere in the client.

## The deviation

The reference gives the user visibility and control over sends waiting to go out: a status row distinguishing "waiting" from "transport down, will send later", plus a per-turn cancel that actually removes the turn from the send journal before it flushes. The build shows nothing: a submitted turn silently enters the host sink, and if the transport is down the user gets no signal and no way to withdraw the turn. This is not an oversight — it is the user-visible part of send-journal semantics (optimistic send, offline queue, flush-on-reconnect), which ADR-0018 A4 explicitly rules out ("sends are direct", no queue/flush machinery built by us).

## Verdict: DO-NOT-INCORPORATE
ADR-0018 is the human-ruled top-level ADR (level 2 of the repo's ruling order), and its A4 exception rules out exactly the mechanism this feature presupposes: optimistic queuing with offline flush. The notice, the transport-down variant, and the cancel button all depend on that ruled-out send-journal model, so importing the UI without the model is impossible and importing the model violates a recorded human ruling. The build's own decision records (`shell.tsx:37`, `conversation-feed.ts:15`) restate the same ruling for the wrapper UI. If the no-signal-when-transport-down gap ever bothers a human, the path is a new dated human ruling amending A4 — not silent incorporation.

## Incorporation notes
- **Where it would live:** n/a under A4. Hypothetically the transcript row would sit in the conversation feed renderer and the cancel action in the client actions layer beside the existing send path — but only if A4 were reversed.
- **Constraints:** ADR-0018 A4 (no send-journal semantics; sends are direct); U-A no-retry-model note on the feed; the build's delivery states are host-owned, so any queued notion would have to come from the host sink, not the client.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — requires a queued send path in the host/client boundary plus lifecycle wiring; blocked by a standing human ruling regardless of effort.
- **Key reference anchors:** queued-notice component `frontend/src/recovered/features/conversation/workspace/transcript.tsx:71-76`; render condition `:788`; cancel action slot `:43`; journal cancel `workspace/submission.ts:127-134` (queued-phase guard at `:129`).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 71-76, 43, 788); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/submission.ts` (lines 110-134)
- Build: `src/client/shell.tsx:37`; `src/client/conversation-feed.ts:15`; `src/client/conversation.tsx:151`; `src/client/actions.ts:129,143`; `src/client/context.ts:200,217`; `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (A4)
