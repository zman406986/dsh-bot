# DD-046 — Find-in-chat vs none
- **Area:** rich rendering (A5)
- **Type:** missing-feature (explicitly recorded deferral)
- **Date:** 2026-09-23

## What the reference does

The reference exposes a full find-in-chat feature on the conversation transcript. A controller module in the reference tree (`find-in-chat-controller.ts`) enumerates matches across transcript entries — including message and card payload text — tracking each hit by entry id plus occurrence index within that entry, keeping a scope filter, a query string, the ordered match list, and a current-match cursor, and exposing forward/back step navigation plus a close action. A transcript handle method lets the bar jump the viewport to a matched entry without painting selection ranges on it. The React surface (`find-in-chat.tsx`) renders a find bar that defers query execution while typing, shows an ordinal match count, steps through matches with Enter / Shift+Enter, closes on Escape, and uses the CSS Custom Highlight API to paint ranges for all matches with the current one distinguished. The feature is reachable via a global find-in-chat shortcut bound to mod+f in the reference tree's `global-keyboard-shortcuts.ts` (line 71) and is mounted in the reference tree's `ProductionRenderer.tsx` (line ~3493).

## What the current build does

Nothing. A grep across `src/client/` for find / find-in-chat / highlight terms finds no find bar, no hotkey registration for search, no match-enumeration machinery, and no highlight-range code. The chat pane is scoped as a text-only surface, and pane CSS forbids animation, so there is no existing place the feature could be added quietly.

## The deviation

The reference lets a user search the visible conversation with a standard mod+f bar, match highlighting, and next/previous stepping; the build offers no in-conversation search at all. This is a deliberate absence, not an oversight: ADR-0018 exception 13 (U-B "no rich chat ergonomics") names find-in-chat explicitly, and ADR-0020's area-9 row (the rich chat ergonomics exclusion row) records it as excluded from the wrapper shell (the UI container ADR-0020 proposed).

## Verdict: DO-NOT-INCORPORATE

Both authority documents that govern this surface rule the feature out by name: ADR-0018 exception 13 is an accepted human ruling at the top level, and ADR-0020's exclusion row carries it forward into the current choice of UI container. The authority stack settles this rather than re-opening it, so the deviation is recorded but not actioned. If product demand for in-chat search emerges, that is a new ruling to request from the human, not a gap to quietly fill.

## Incorporation notes
- **Where it would live:** If ever reversed, the natural home is the client chat pane module under `src/client/` (controller and bar component next to the transcript renderer), with the shortcut registered wherever pane-level key handling lives.
- **Constraints:** Must remain an independent re-derivation — written without copying from the reference implementation; ADR-0018 B9 forbids verbatim copying. Pane scope is text-only and animation-free by current rules, so a highlight-paint approach would itself need a ruling. Any reversal amends ADR-0018 exception 13 and the ADR-0020 area-9 row (the rich chat ergonomics exclusion) first.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a deferred-query search over pane text with scroll-to-match is moderate work, but the risk is a process risk (two ADRs name it excluded), not a technical risk.
- **Key reference anchors:** the reference tree's `find-in-chat-controller.ts` (match enumeration with occurrence tracking, forward/back and close actions, scroll-to-entry without highlighting, a view-commit subscription); `find-in-chat.tsx` (deferred query, ordinal count, Enter/Shift+Enter stepping, Escape close, CSS Custom Highlight API ranges for all matches + current); `global-keyboard-shortcuts.ts:71` (mod+f); `ProductionRenderer.tsx:3493` (mount).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/find-in-chat-controller.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/find-in-chat.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts` (line 71); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (line 3493)
- Build: `src/client/` — grep for `findinchat` / `find-in-chat` / `highlight` returns no matches (absence verified 2026-09-23); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (exception 13); `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` (area-9 exclusion row: rich chat ergonomics)
