# DD-053 — Dual plain/rich send serialization vs verbatim plain text
- **Area:** composer editor (A6)
- **Type:** missing-feature (relevant only if rich input exists)
- **Date:** 2026-09-23

## What the reference does
The reference composer keeps two representations of the same draft in sync: every edit produces a pair — the plain-text prompt string, plus a rich-text TipTap JSON document (carried in the draft model, omitted when empty). The plain-text output is not the editor's built-in text extraction; it is a custom serializer (the reference tree's `rich-text-editor.tsx:141-163`). Text nodes carrying a link mark render as the visible text followed by the href in parentheses, except when the visible text already spells the href (then the parenthetical is dropped so the URL is not printed twice) and except when the adjacent sibling shares the same link (then no re-expansion mid-link). A hard line break becomes a newline character, and top-level document children are joined with newlines. The inverse direction (the prompt-content accessor, lines 113-129) rebuilds an editor document for external content: it JSON-parses the persisted rich document and falls back to converting the plain prompt line-by-line into paragraphs when the JSON is absent or invalid. The code that emits both outputs on each edit is at lines 779-781.

## What the current build does
The composer holds exactly one state: a plain string in a textarea (`src/client/conversation.tsx:180-199`), handed to `onSend(sessionId, text)` on submit (line 195). The actions layer forwards that string untouched — `sendPrompt` resolves the scoped sink and awaits `sink.send(text)` (`src/client/actions.ts:260-271`), with the module's own comment at the neighbouring command boundary recording that the intent is to send the line verbatim. There is no document model, no link marks, and therefore nothing to serialize or project.

## The deviation
The reference maintains two representations and a plain-text output written by hand that preserves information a naive text dump would lose — bare links stay resolvable with their href in parentheses, line structure survives hard breaks. The build has only the plain representation and sends it verbatim, which is trivially faithful because there is no richer source to lose detail from. The gap is the entire dual-output architecture: it exists solely to feed a rich editor, and in a plain-text composer there is no second representation to maintain.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's U-B (rule 13, no rich chat ergonomics) is a human ruling that settles the composer as plain text, and DD-047 has already ruled the editor framework itself DO-NOT-INCORPORATE, explicitly naming this finding as depending on that ruling — under the authority stack the framework decision governs, and a serializer for a document model that does not exist cannot be actionable on its own. The finding does not apply unless DD-047 is ever reopened: in that case this becomes an ADAPT (the approach of building the plain text from the document — link expansion with href-match dedup, hard-break-to-newline — is the right pattern for the send side of any future rich composer), but it must not be incorporated before the framework it depends on.

## Incorporation notes
- **Where it would live:** a pure projection function beside the composer send path (`src/client/conversation.tsx` or a small helper file next to it), feeding the existing `sendPrompt` boundary in `src/client/actions.ts:260-271`; only meaningful once a rich draft model exists (see also the host-persistence question in DD-044 — if the dsh host never stores rich-text user turns, there is no way to build it at all).
- **Constraints:** must remain a pure function of the document; standalone links expand to visible text plus href in parentheses, with dedup when the visible text matches the href; adjacent same-link text nodes merge without re-expansion; hard breaks and paragraph boundaries both become newlines; lossy by design — the rich document stays authoritative in the draft, not the plain-text output.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a small pure function plus tests, but entirely conditional on DD-047 being reversed; the risk is ambiguity when link text partially matches the href (the reference's trim/scheme-prefix matching is a heuristic, and an independent re-derivation may reasonably differ).
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:113-163` (round-trip in, serializer out), `:779-781` (per-edit emit of the plain/rich pair).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (lines 113-129, 131-163 verified; 779-781 per enumeration)
- Build: `src/client/conversation.tsx:180-199` (verified line 195); `src/client/actions.ts:260-271` (verified)
