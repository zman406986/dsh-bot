# DD-052 — ":" emoji picker listbox vs none
- **Area:** composer editor (A6)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does

The reference's rich-text editor carries an emoji suggestion feature wired as a ProseMirror suggestion plugin. Typing a colon starts the trigger; a custom match function only accepts a query of two or more characters drawn from lowercase letters, digits, underscore, plus, and hyphen (the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:280-295`). While the trigger is live, a listbox offers at most 96 rows from a catalog provider, with recently used entries recorded per session; choosing a row replaces the trigger text with the entry's native glyph followed by a space, and the popup is headed with an emoji label (the emoji extension, same file at `:544-577`). The catalog itself is fed by the emojibase dependency (whether it is actually present was not re-checked here — DD number pending).

## What the current build does

The build has no emoji machinery at all: a case-insensitive search for "emoji" across `src/client` returns nothing, and there is no suggestion/listbox infrastructure of any kind in the client. The composer in `src/client/conversation.tsx` is deliberately minimal — a plain textarea plus send button with no inline assistance surfaces (see its own header comment at `src/client/conversation.tsx:16` and `:179`).

## The deviation

The reference turns the composer into a lightweight emoji search: `:` + a short token opens a catalog-backed picker with recents and inserts the glyph on selection. The build's textarea has no trigger scanning, no popup listbox, and no catalog source, so this entire interaction is absent rather than degraded.

## Verdict: INCORPORATE

ADR-0018 (the top human ruling) says to imitate the reference in its entirety, with an exhaustive exception list of deliberate deviations; an emoji insert picker is not on that list (U-B excludes rich chat ergonomics such as reactions and threads, which are about conversation structure, not text-entry assistance, so it does not cover this). The composer is ours to build under the same ADR's "we build the whole UI" clause, so the feature falls inside the imitation standard. It must be re-derived independently under the B9 copy policy rather than copied, and its absence today is a straightforward missing feature, not a ruled exclusion.

## Incorporation notes
- **Where it would live:** a new suggestion module beside the composer in `src/client` (likely a `composer-suggestions` helper used by `conversation.tsx`), with a trigger scanner over the textarea value, a positioned listbox, and a catalog/recents provider; the choice of catalog dependency (emojibase vs. a small hand-written list) is a follow-up decision (DD number pending).
- **Constraints:** plain-textarea implementation, not ProseMirror — the reference's match/insert logic must be re-derived against raw string indices; keep the popup consistent with the plain composer's minimal design, which keeps no draft state, as noted in `conversation.tsx`; keyboard navigation and dismissal must not conflict with the send keybinding; re-derive independently per B9 (structure and thresholds may match, code may not).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — trigger matching and insertion are small, but the listbox component, positioning, keyboard handling, and a catalog source are all new to a client that has no suggestion infrastructure yet.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:280-295` — trigger match: `:` prefix, 2+ char query, a lowercase-alphanumeric-plus-underscore/hyphen alphabet.
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:544-577` — suggestion plugin: 96-row cap, recents recording, native-glyph-plus-space insertion, an emoji-headed popup.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:280-295,544-577`
- Build: `src/client` (grep for "emoji": zero hits); `src/client/conversation.tsx:16,118,179` (plain textarea composer, no suggestion surfaces)
