# DD-022 — Send-journal delivery states and optimistic echo vs direct sends
- **Area:** transcript delivery states (A4)
- **Type:** deliberate-divergence (ruled)
- **Date:** 2026-09-23

## What the reference does

The reference treats per-message delivery state as a first-class transcript concern. The message model carries an optional delivery field typed as a four-value vocabulary — sent, pending, queued, failed (`workspace/model.ts:215`), present on every transcript message (`workspace/model.ts:235`). That field is fed by a renderer-side submission journal: an outbound message moves through pending, queued, failed, sent (with a cancelled phase as well), the journal queues messages while the transport is down (`workspace/submission.ts:116-118`), serializes sends per agent, and flushes the queue once the connection returns (`workspace/submission.ts:7,55-148`). The transcript view surfaces the state visually with row-level pending/failed attributes (`workspace/transcript.tsx:730-767`). Net effect: the user sees their message immediately with a provisional look, plus queued/failed handling across outages.

## What the current build does

The build has no delivery-state model and no optimistic echo at all. A send resolves through the host's plain-prompt sink: on success the composer clears its draft and the pane waits for the durable user turn to arrive through the host event window; on rejection or a missing sink it shows a plain error line and keeps the draft. The only in-flight indication is composer-local — a busy flag that swaps the send button to its sending label (`src/client/conversation.tsx:107-127,191-199`). The module header records the reasoning in place: the host owns the journal, A4 rules out a client-side one, and there is explicitly no optimistic echo, success copy, or retry model (`src/client/conversation.tsx:24-28`). The store's reduced transcript confirms it — its item union (user/assistant/streaming/tool) is keyed only by the durable event sequence number, with no delivery concept anywhere (`src/client/conversation-store.ts:117-152`).

## The deviation

The reference makes delivery state a message-level, client-journal-owned concern (optimistic echo, offline queue, per-agent serialization, reconnect flush); the build deliberately has none of it — delivery visibility stops at the composer (draft kept or cleared, busy label), and the transcript only shows what the host's event window reports. This absence is not a gap: it is recorded exception A4, cited where the divergence happens in the pane's own header.

## Verdict: DO-NOT-INCORPORATE

ADR-0018's exception list rules this exactly: item A4 — no send-journal semantics (no optimistic send, offline queue, or flush-on-reconnect built by us); sends are direct (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:24`), restated for the wrapper UI and reinforced by ADR-0020's mapping of the send path to the host sink. The build implements the rule where the divergence happens and the pane only displays state and never keeps its own copy over the reduced window. Adding a delivery field or echo would contradict accepted ADRs; only a dated human reversal can change that, and until then the reference's richer model stays deliberately unincorporated.

## Incorporation notes
- **Where it would live:** only if A4 were ever reversed — a `delivery` field on the user item in `src/client/conversation-store.ts` plus a composer-owned pending/failed queue in `src/client/conversation.tsx`; never in the pane itself, which must only display state and never keep its own copy over the reduced window.
- **Constraints:** any reversal requires a dated human ruling amending ADR-0018 A4; sends must still travel the host's plain-prompt sink (ADR-0020 keeps the send path host-side); state names, UI copy, and journal design would have to be re-derived independently, not mirrored from the reference.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a client journal with offline queueing and reconnect flush touches the send path and duplicates state the host already owns, so the main risk is two journals disagreeing about what was delivered.
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/model.ts:215,235` (delivery field and type); `frontend/src/recovered/features/conversation/workspace/submission.ts:7,55-148` (journal phases, per-agent serialization, offline queue at 116-118); `frontend/src/recovered/features/conversation/workspace/transcript.tsx:730-767` (pending/failed row attributes).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/model.ts:215,235`; `.../workspace/submission.ts:7,55-148`; `.../workspace/transcript.tsx:730-767`
- Build: `src/client/conversation.tsx:24-28,107-127,191-199`; `src/client/conversation-store.ts:117-152`; `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:24`
