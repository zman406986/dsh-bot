# DD-072 — Bare-URL link preview card vs plain text
- **Area:** message cards (A10)
- **Type:** missing-feature (explicitly recorded deferral)
- **Date:** 2026-09-23

## What the reference does
When a text message contains a single bare https link (or a legacy attachment that is just a URL), the reference replaces the plain text with a rich link preview card. The view (`views/link-card.tsx`) renders an anchor styled as a card showing a preview image (as a data URL), a title (falling back through site name → hostname → the raw URL), an optional description, and the hostname, with an `aria-busy` loading state while metadata is being fetched. Clicking the card calls `preventDefault` and opens the URL through the desktop bridge's external-open method rather than in-app navigation.

Metadata supply and message projection are separated: `url-card.ts` defines a URL-card provider type (sourced from the bridge's link-metadata and external-open members), a per-URL subscribable resource state, and the projection and extraction helpers — URL normalization, bare-link extraction (with a rich-text variant), send-message text-link extraction, legacy-attachment link extraction, metadata projection, and the provider factory. Per the shared message-card seam code (`message-card-seam.ts`), a bare link is recognized both from raw message text and from markdown/richText link marks; the legacy-attachment path passes a fallback flag naming the URL-card kind.

## What the current build does
The build renders message text plainly. A search of `src/client/` for any link-card, url-card, or link-metadata identifier returns nothing — there is no link-card branch in message rendering and no link-metadata provider or desktop-bridge binding anywhere in the client surface. Bare links display as ordinary text (consistent with DD-040, plain inline/link text rendering), and no metadata fetch or external-open handoff exists for them.

## The deviation
The reference converts a lone bare URL in a message into a live preview card backed by a metadata provider; the build has no equivalent at all — not even a degraded one. This is not an oversight: ADR-0018's exception list records ruling **U-B** ("no rich chat ergonomics", the ADR-0018 entry that excludes find-in-chat, threads and replies, reactions, per-agent drafts, rich attachment viewers, and URL cards), which explicitly names URL cards among the excluded surfaces. The capability-gaps research doc does not list it because that study scoped the frontend client out entirely, so ADR-0018 U-B is the operative recorded ruling. The feature also depends on a desktop-bridge link-metadata backend (the bridge's link-metadata and external-open calls) that the build does not have (DD number pending, link metadata).

## Verdict: DO-NOT-INCORPORATE
ADR-0018 — the human-ruled master in the ordering of ruling documents defined in `docs/agents-rulebook.md` — explicitly excludes URL cards under U-B, and that ordering settles conflicts rather than re-opening them, so the default is to keep bare links as plain text (DD-040) and not build the card. Incorporating it would require an explicit human reversal amending U-B, at which point the sensible order is the link-metadata backend first (DD number pending, link metadata) since the card is only a projection over it; the UI itself would then be an ADAPT-style independent re-derivation under B9. Until such a ruling exists, this file stands as the record that the gap is known and deliberately deferred.

## Incorporation notes
- **Where it would live:** a card view beside the existing message-card views in `src/client/` (the build's equivalent of the reference's transcript-card views), with provider/extraction helpers kept in a separate module mirroring the reference's view/projection split, wired through the projection rules in `message-card-seam.ts` for bare links and markdown link marks.
- **Constraints:** requires the desktop-bridge link-metadata + external-open support to exist first (DD number pending, link metadata); only fires on a single bare link per message (plus the legacy-attachment URL case); loading state must be non-blocking; opening must go through the external-open bridge, never in-app navigation. Reversal of ADR-0018 U-B by dated human ruling is a precondition, not a formality.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — moderate UI plus state-subscription plumbing, but only after the backend support lands; risk is low and mostly deferred along with the deferral itself.
- **Key reference anchors:** `views/link-card.tsx` (the card view and its body layout, external-open click handling); `url-card.ts` (the URL-card provider type and its factory, bare-link extraction, metadata projection); projection entry points in `message-card-seam.ts`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/views/link-card.tsx`; `.../transcript-card/url-card.ts`; `.../transcript-card/message-card-seam.ts` (projection rules)
- Build: `src/client/` — grep for link-card/url-card/link-metadata identifiers returns zero matches (verified 2026-09-23)
- Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (U-B, explicitly excluding URL cards); `docs/research/prd-vs-reference-capability-gaps.md` (frontend client out of scope); cross-refs DD-040 (plain link text) and link-metadata backend (DD number pending)
