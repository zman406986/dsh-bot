# DD-078 — In-transcript permission prompt cards vs none
- **Area:** message cards (A10)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does

The reference transcript renders permission traffic as two card kinds:

1. **Live prompt card** — `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/views/local-tool-permission.tsx` is a thin transcript card that, for a local-tool-permission message, renders the full permission prompt component (the reference's local-tool permission view) right inside the conversation flow. It pulls a permission store and a resolve callback from the providers shared by the transcript cards; its comment states the shipped lazy-loaded card just delegates to the existing prompt. Crucially it fails closed: if the card's entry is missing, the message type is wrong, or the store/resolve providers are absent, it renders nothing rather than buttons that cannot work.

2. **Retired title-only card** — `the reference tree's frontend/src/recovered/features/conversation/cards/permission-request/view.tsx` renders historical permission-request messages as a read-only title string in a wrap div. The card owns no host bridge, request id, or actions; the transcript wrapper supplies timestamp and group placement. A projection helper validates inputs and yields null on anything unrenderable.

So permission asks appear where they happen (inline, actionable) and their historical record stays visible (read-only), both backed by one prompt component and one permission store.

## What the current build does

There is no in-transcript permission card of either kind. The approval surface is the "Needs you" section of the conversation pane: `src/client/approval-cards.ts` builds exactly two card families — access-ask/secret-ask cards from what the approval relay reports (`Multitask.listPendingAccess` plus resolved-access notices) and worker-dispatch cards from the `spawn_worker` tool-call record — and `src/client/approval-pane.tsx` renders them as the "Needs you" area. Neither permission card kind appears anywhere in `src/client`; the transcript surface (`src/client/conversation.tsx`) mounts the approvals area alongside the transcript rather than interleaving approval cards into it.

## The deviation

The build never shows a permission decision at its point of occurrence: a worker access ask is surfaced only in the aggregated "Needs you" section, and there is no read-only in-transcript record of past permission decisions at all. Conversely the reference's live inline prompt depends on owning a permission store and resolve transport inside the client — machinery the build deliberately does not have, since approval semantics were re-hosted onto the structured relay.

## Verdict: ADAPT

Worker approval semantics are already settled off the reference path — accepted ADR-0008 routes access asks through the custom structured relay rather than a child approval waterfall, and ADR-0011's option set plus the ticket-69/81 rendering filings are what `src/client/approval-cards.ts` re-hosts — so porting the reference's live in-transcript prompt would add a second approval source of truth, against the build's rule that cards only display data that already exists (no second source of existing truth) and against the PRD non-goal of rebuilding dsh's tool runtime, which is where its permission bridge lives. What is worth adapting is the reference's discipline, not its mechanism: adopt the fail-closed guard (a card with no live store/transport renders nothing, never inactive buttons) and consider a read-only title-only card so transcript history honestly shows that a permission decision happened, mirroring the retired-card pattern. Whether the primary agent's own local tool permissions ever need an inline actionable surface is unresolved; under draft ADR-0017 that deviation from the reference needs written human approval before anyone builds it. See DD-077 for the related comparison of what those cards offer.

## Incorporation notes
- **Where it would live:** a transcript card component registered in the conversation surface (`src/client/conversation.tsx`), fed by the existing approval-cards store boundary only if the relay data is extended; a live prompt variant would additionally need a permission store + resolve RPC provider on the providers shared by the transcript cards, which today exists nowhere in `src/client`.
- **Constraints:** never a second approval path beside the relay "Needs you" flow (ADR-0008/0011 semantics, ticket 69/81 rendering); presentation-time display of existing data only; fail-closed rendering when the store/transport is absent; historical cards strictly read-only (no request id, no actions); ADR-0017 written human approval required before any live inline prompting ships.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M for the full adapt (a read-only historical card alone is S); main risk is duplicating approval data or drifting into rebuilding dsh's permission runtime (PRD non-goal).
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/views/local-tool-permission.tsx` — the lazy-loaded card that delegates, and its provider guard that fails closed
  - `the reference tree's frontend/src/recovered/features/conversation/permissions/local-tool/view` — the prompt component the card delegates to (named by the card's import; not re-verified here)
  - `the reference tree's frontend/src/recovered/features/conversation/cards/permission-request/view.tsx` — the retired title-only card; the wrapper owns timestamp and group placement

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/views/local-tool-permission.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/permission-request/view.tsx`
- Build: `src/client/approval-cards.ts`; `src/client/approval-pane.tsx`; `src/client/conversation.tsx`; `src/client/roster-store.ts` ("Needs you" as the pull-only stand-in note)
