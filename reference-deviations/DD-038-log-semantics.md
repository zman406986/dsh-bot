# DD-038 — Transcript a11y semantics (role=log/article) vs plain divs
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (accessibility gap left by the text-only reduction)
- **Date:** 2026-09-23

## What the reference does

The reference treats the transcript as an accessible document structure, not just pixels. The scrolling transcript container is announced as a conversation log: it carries `role="log"` with an accessible name, `aria-live="off"` (new rows do not interrupt the screen-reader user mid-read; the log landmark itself still gives a predictable reading order), and `tabIndex={0}` so keyboard users can reach and scroll the region (`frontend/src/recovered/features/conversation/workspace/transcript.tsx:699`).

Each message row is an `role="article"` landmark (line 770) whose accessible name is composed from two visually hidden labels — a hidden author span and a hidden `<time>` element carrying an ISO `dateTime` attribute, wired up via `aria-labelledby` (lines 762, 772-773). So a screen reader hears "author, timestamp, article" per row even though the visual design hides those landmarks. Supporting semantics complete the picture: time separators and unread dividers are `role="separator"` (lines 701-702), message bodies are `role="group"` with an "Agent message" label for assistant entries (line 775), and delivery state is exposed via `aria-busy` on pending/streaming rows (line 761).

## What the current build does

The build's transcript scroll area is an unremarkable `<div>` with only a class name — no log landmark, no live-region policy, no focusability (`src/client/conversation.tsx:421`). Each transcript item is likewise a plain `<div>` with a `data-role` attribute and a *visible* text label for the sender role, but no ARIA role, no accessible name, and no hidden timestamp landmark (`src/client/conversation.tsx:350-354`). Semantics exist only in CSS and data attributes; assistive technology sees an undifferentiated list of divs and spans.

## The deviation

The reference exposes transcript structure (log, article, separator, group, hidden author/time labels, busy state) to assistive technology and keyboard users; the build exposes none of it. This is the accessibility part lost when the build chose to show text only: the build reduced content fidelity by design, but the semantic structure was dropped along with it, without a ruling. Functionally minor — sighted mouse/keyboard users are unaffected — but screen-reader and keyboard-only users get no landmarks, no per-row naming, and no focusable transcript region.

## Verdict: INCORPORATE

Nothing in the authority stack rules against this — it is an additive accessibility layer over content the build already renders, so it does not re-open the text-only reduction and no ADR or PRD clause conflicts with it; per the standing practice that unruled conflicts stop and ask, the safe reading is that adding attributes is not a conflict at all. A11y improvements of this kind are cheap, change no policy stance, and are purely additive (new attributes on existing elements, no behavior change), so no human ruling should be needed unless a doc says otherwise. Recommend porting the *pattern* — log container, article rows, hidden author/time labelling, `aria-busy` — re-derived in the build's own markup vocabulary, not the reference's class names or structure.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` — the `__scroll` container (line 421) gains `role="log"`, `aria-live="off"`, `aria-label`, `tabIndex={0}`; the item root (lines 350-353) gains `role="article"` with hidden author/time labels and `aria-labelledby`; time/attachment markers can take `role="separator"` where applicable.
- **Constraints:** keep it additive — no change to the visible text-only item layout or the delivery-state model; `aria-live="off"` must be kept (not "polite") to match the reference's no-interruption choice, or the streaming transcript would spam screen readers; re-derive attribute choices from first principles per ADR-0018 B9.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — attribute-only edits to one client file; risk is limited to getting the live-region and labelling choices right (a wrong `aria-live` value is worse than none).
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/transcript.tsx:699` (log container), `:701-702` (separators), `:760-773` (article row + hidden author/time + aria-busy), `:775` (group + agent label).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx:699,701-702,760-775`
- Build: `src/client/conversation.tsx:350-354,421-444`
