# DD-048 — Composer placeholder copy & empty-state vs none
- **Area:** composer editor (A6)
- **Type:** missing-feature (trivial but user-visible)
- **Date:** 2026-09-23

## What the reference does
The reference composer gives its empty input a visible hint. The composer component declares a default placeholder prop — the string rendered when nothing has been typed — with a default hint inviting the user to ask anything or drop a file (the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:71`). That value flows into a rich-text Placeholder extension configured with an empty-editor class and `showOnlyWhenEditable: false`, so the hint also shows while the editor is in a non-editable state (the reference tree's `rich-text-editor.tsx:676`). The copy is context-sensitive: when a reply target is active, a reply placeholder selector swaps the hint for a reply-flavored variant (the reference tree's `composer.tsx:192`, `reply-preview.tsx:78`).

## What the current build does
The build's composer is a plain `<textarea>` that carries an accessible label via `aria-label` but no `placeholder` attribute at all (`src/client/conversation.tsx:204`). An empty input renders as a fully blank field, and there is no reply-target variant of any hint, because no hint machinery exists.

## The deviation
The reference treats the empty composer as a small instructional moment (default hint, empty-state styling that survives non-editable states, reply-specific copy); the build ships no empty-state hint whatsoever. Users of the build get no affordance suggesting what the field accepts — the reference's default copy even advertises file drop, which the build's composer may or may not support, so any adopted wording must be checked against actual build capabilities.

## Verdict: INCORPORATE
Adding a `placeholder` attribute is additive polish that changes no policy stance: it changes no dispatch, submission, or safety behavior, it only makes an existing input describe itself, which the PRD's client-surface expectations favor. It should be incorporated with the build's own wording from its locale dictionary (a new message key routed through the existing `t()` lookup), never the reference's string — ADR-0018 B9 requires independent re-derivation, and the reference's copy is a candidate for verbatim contamination. The reply-variant mechanism is optional extra polish and can be deferred (DD number pending) until reply targeting itself is revisited. If the build's composer cannot accept file drops, the wording must not imply that it can.

## Incorporation notes
- **Where it would live:** `src/client/conversation.tsx` — add a `placeholder={t(<new-key>)} ` attribute on the textarea at ~line 204; add the key and build-original copy to the client locale dictionary alongside the existing `CONVERSATION_KEYS` entries.
- **Constraints:** copy must come from the build's own dictionary, not the reference tree; wording must not promise capabilities the build lacks (e.g., file drop, if unimplemented); keep it a single short string so the plain-textarea approach stays sufficient — no rich-text Placeholder extension needed at this scale.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree (including placeholder copy wording).
- **Effort/risk:** S — one attribute plus one dictionary key; the only risk is whether the wording matches what the composer can actually do.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/composer.tsx:71` (default placeholder prop), `:192` (reply placeholder selector); the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:676` (Placeholder extension, `showOnlyWhenEditable: false`, empty-editor class); the reference tree's `frontend/src/recovered/features/conversation/workspace/reply-preview.tsx:78` (reply-variant copy).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (lines 71, 192), `.../rich-text-editor.tsx` (line 676), `.../reply-preview.tsx` (line 78)
- Build: `src/client/conversation.tsx` (line 204 — textarea with `aria-label` but no `placeholder`)
