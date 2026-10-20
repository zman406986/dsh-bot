# DD-047 — Rich-text editor framework vs plain textarea
- **Area:** composer editor (A6)
- **Type:** deliberate-divergence (ruled scope)
- **Date:** 2026-09-23

## What the reference does
The reference composer's prompt input is a full TipTap/ProseMirror rich-text editor, not a bare input. A factory (the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:643`) assembles a curated extension list: StarterKit configured with most of its marks and nodes switched off (bold, italic, code, headings, lists, blockquote, link, etc. all disabled — leaving essentially paragraph + undo/redo grouping), a custom link extension that does not inherit arbitrary marks, a Placeholder extension, an extended Mention node with a suggestion provider, custom workflow-reference and PR-reference node types each wired to a Suggestion plugin, an optional emoji extension, plus caret-scroll and Emacs-style line-motion behaviors. The editor instance is created via TipTap's `useEditor` and rendered with `EditorContent` (:711 onward), and paste is bridged through a global clipboard handler that stages files and restores focus (:690-709). Editor state is ProseMirror document JSON (a dedicated prompt-content accessor at :113), not a plain string.

## What the current build does
The build composer is a native HTML `<textarea>` bound to plain React string state (`value`/`onChange`) — `src/client/conversation.tsx:204-223`, inside the `Composer` component (:180-239). Key handling is written by hand in `onKeyDown`: plain Enter submits, Shift+Enter keeps the newline, Ctrl/Meta+Enter submits, and IME composition Enter never sends. A grep for `tiptap` across `src/client` returns zero matches — no TipTap or ProseMirror dependency exists anywhere in the client surface. Send is a string handed to the host's plain-prompt sink; there is no document model, no suggestion machinery, no paste staging.

## The deviation
The framework underneath differs: a ProseMirror document editor with a curated, deliberately constrained extension set versus an unstyled native textarea with string state. This is not an oversight. The build module comment declares the scope outright: "the composer is a plain textarea + send" (`src/client/conversation.tsx:16-17`), and the same comment records that U-B excludes rich ergonomics (lines 14-15). Every reference feature that depends on the rich editor — mention/workflow/PR suggestion popups, emoji insertion, styled links, document-JSON prompt state — depends on this one framework choice.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's U-B exclusion rules the composer as a plain textarea with no rich ergonomics, and the module comment records that ruling at the exact site of the divergence; under the authority stack the ruled scope settles this rather than leaving it open. Adopting TipTap would bring a document-model editor, a new dependency, and ProseMirror class/attribute conventions into a surface whose styling contract requires namespaced classes and host `--dsw-alias-*` tokens only — extra work with no benefit under U-B. This finding is the framework decision for the editor-feature deviations that depend on it (DD-048 through DD-053, plus DD-044): each of those should be read as blocked by this ruling rather than independently actionable. If the human later wants rich composer ergonomics (an amendment to the exception list), this file is the record that would reopen it; until then, DO-NOT-INCORPORATE.

## Incorporation notes
- **Where it would live:** (if ever ruled in) a new `src/client` editor module behind the same injected-actions interface `Composer` already uses; the textarea at `src/client/conversation.tsx:204-223` is what would be replaced, and the send path (`onSend` string sink, :195-199) must keep receiving plain text regardless of internal document model.
- **Constraints:** U-B scope (module comment :11-23) forbids rich ergonomics and any draft persistence; styling contract (ticket 49, comment :33-38) requires namespaced classes and alias tokens — a ProseMirror editor's generated DOM must be fully class-mapped; send outcomes must stay honest (no optimistic echo); IME Enter handling (:218) must be preserved in any editor substitution.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree. (TipTap is independent OSS.)
- **Effort/risk:** L — new dependency plus a document-to-plain-text boundary at the sink, suggestion-provider wiring, and restyling of editor DOM to the token contract; the risk is scope growth against the ruled U-B line.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:643` — the prompt-editor extension factory
  - `:657-685` — curated extension list (the starter kit with marks/nodes disabled, a custom link extension, a placeholder extension, the mention node, workflow/PR reference nodes, optional emoji)
  - `:711` — the prompt rich-text editor component (TipTap `useEditor`/`EditorContent`)
  - `:690-709` — clipboard/paste bridge (file staging, focus restore)
  - `:113` — the prompt-content accessor (ProseMirror document JSON prompt state)

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (TipTap imports at :2-6; extension factory :643-688; editor component :711+)
- Build: `src/client/conversation.tsx` (textarea :204-223; `Composer` :180-239; scope ruling :16-17); grep for `tiptap` in `src/client` — zero matches (verified 2026-09-23)
