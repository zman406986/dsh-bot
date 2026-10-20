# DD-073 — In-transcript attachment card vs attachment-only marker
- **Area:** message cards (A10)
- **Type:** missing-feature (deferred by a recorded ruling; adjacent to DD-045 viewer suite)
- **Date:** 2026-09-23

## What the reference does
The reference's transcript-card layer runs attachment-type transcript entries through an adapter (the reference tree's attachment projection module supplies the projection and media-resolution contracts), and the reference's attachment view renders the result as one of four shapes: (1) a **media** card that asynchronously resolves the attachment URL into image, video, or audio and renders the matching element with a loading/missing fallback and group-adjacency attributes; (2) a **box** card for the remote-computer case, titled for that surface, whose status line comes from a lookup table that maps each resolution result to a color tone — remote-computer-use adjacent, existence noted here only and not detailed; (3) a **legacy-link** projection that reuses the existing link-card view component rather than a bespoke renderer; (4) a plain anchor fallback when no richer projection applies. When no attachments provider is registered, the component renders nothing.

## What the current build does
The build reduces an attachment-only conversation message to a placeholder string: `src/client/conversation.tsx` defines `attachmentOnly: "shell.conv.attachment-only"` (line 170) and renders it inline (line 359), with the string table in `src/client/overlay.ts` supplying "(no text content)" in English and the Chinese equivalent. No attachment card exists — no media viewer, no box card, and no link-card reuse for attachments. The only other client-side attachment touches are tool-view field counts (`src/client/toolviews.ts`) and composer transaction plumbing (`src/client/actions.ts`, `src/client/context.ts`), none of which render transcript cards.

## The deviation
The reference turns in-transcript attachments into rich per-kind cards; the build collapses them to a text marker. The gap is real but explicitly ruled: ADR-0018 U-B excludes rich attachment viewers from the imitation scope, and ADR-0020 records the same U-B exclusion for the rich-chat-ergonomics area. The deferral recorded by that ruling sits next to the viewer-suite deviation tracked in DD-045.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 (the human-ruled master ADR) lists rich attachment viewers under the U-B exclusions, and ADR-0020 re-records that exclusion for this area, so incorporating the card suite now would contradict the authority stack's second level (accepted ADRs); the PRD's non-goals likewise rule out chasing feature-for-feature UI matching with the reference. The deviation is recorded, not dismissed: if the human ever reverses U-B, this card belongs to the same work stream as the DD-045 viewer suite and should be scoped with it, not built piecemeal. Until then the attachment-only marker is the compliant behavior.

## Incorporation notes
- **Where it would live:** if ever un-deferred, a projection module plus card renderers beside the message-card layer in `src/client/conversation.tsx`, with media resolution exposed through the client's host bridge and the legacy-link case reusing the build's own link card once DD-045's viewer suite lands.
- **Constraints:** ADR-0018 U-B and ADR-0020 exclusions stand until human reversal; any future work must be re-derived independently (ADR-0018 B9) and coordinated with DD-045 rather than duplicating its plumbing.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — media resolution plumbing through the client bridge plus per-kind rendering; risk low while the deferral is ruled, rising only if built ahead of DD-045.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/views/attachment.tsx` four-way projection (media/box/legacy-link/plain anchor, null bail-out without a provider), its `@evidence` byte-offset comments for box status projection, URL classification, and the media branch's shared media shell; the sibling attachment projection module (`.../transcript-card/attachment-data.ts`) for the projection kinds and media-resolution contract.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/views/attachment.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/attachment-data.ts`
- Build: `src/client/conversation.tsx` (lines 170, 359); `src/client/overlay.ts` (lines 266, 450); `src/client/toolviews.ts` (lines 98, 326-330); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-B); `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` (area-9 exclusion)
