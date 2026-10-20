# DD-069 — In-transcript email draft card vs none
- **Area:** message cards (A10)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does

The reference renders an editable email composer as an in-transcript message card — the email-draft transcript-card component. When a transcript entry carries an email-draft message, the card shows a new-email form: a To field whose comma-separated recipients are each validated against a simple email pattern, a Subject input, and a body textarea. If the body exceeds roughly 8 visual lines it collapses to plain text with a show-more/show-less expander. A Send button (enabled only when status is editable, at least one valid recipient exists, and the body is non-blank) sits next to a Discard button. The card tracks a send lifecycle: while sending it shows a sending status, and once sent it swaps the whole form for a compact sent summary naming the first recipient and subject. An optional From line appears when the draft carries one.

## What the current build does

The build has no email surface anywhere. A case-insensitive search for "email" across `src/` (core, adapter, worker, client) and the web `client/` returns zero hits: no email-draft message type, no composer card, no send/sent lifecycle, and no email connector. The build's client does have a card conversation surface (`src/client/conversation.tsx`, `src/client/approval-cards.ts`), but nothing registers an email composer view.

## The deviation

An entire message-card type present in the reference is absent from the build: the transcript can never display an interactive email draft, and the build has no protocol entry shape or card view to even receive one. Beyond the missing UI, the card's Send path implies an email-integration backend the build entirely lacks, so the deviation is two-layer: absent presentation plus absent downstream capability.

## Verdict: ADAPT
The card itself belongs to the A10 message-card area, so under ADR-0018's imitate-in-entirety master rule the composer UI should eventually exist — but only re-derived independently per B9, and only once its send target is ruled. Email integration sits adjacent to the C14 exception list (the ADR-0018 entry that rules out an org chart, routines and automations, per-agent memory, and group rooms) and the build has no email connector at all, so a Send button wired to nothing would be dead UI; the send/sending/sent lifecycle must be adapted to whatever connector decision lands (cross-ref connectors "(DD number pending)"). Adapt, don't drop: build the card behind a defined email-draft message shape and gate or stub the send action until the backend question is settled.

## Incorporation notes
- **Where it would live:** a new leaf view under the build's web client card/conversation layer (alongside `src/client/conversation.tsx` / `src/client/approval-cards.ts`), with an email-draft message type added to the client conversation protocol and registered in the card view mapping the way the reference's registry module maps its email-draft send-message kind to a lazy view.
- **Constraints:** per-address recipient validation and the non-blank body gate before enabling send; collapse the body past ~8 visual lines with an expander; read-only states for sending/sent with a one-line sent summary; no verbatim JSX or class names from the reference (ADR-0018 B9); send action must be a stub or gated until the email connector exists.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the form UI is small, but the protocol message shape, card-view registration, send-state lifecycle, and a placeholder-or-real send path push it past a quick port; risk is shipping a dead-end Send if the connector question is unresolved.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/views/email-draft.tsx` — the whole composer card (validation, collapse, send/discard, sending/sent states).
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/registry.ts` — line 8 evidence comment for the email-draft lazy view; lines 80–85 register the email-draft send-message kind with placeholder metadata.
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/protocol.ts` — the email-draft message shape the card reads.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/views/email-draft.tsx`; `.../transcript-card/registry.ts`
- Build: `src/client/` and `client/` searched for "email" — zero matches (no card, protocol entry, or connector); nearest card surfaces are `src/client/conversation.tsx`, `src/client/approval-cards.ts`
