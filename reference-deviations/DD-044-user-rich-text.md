# DD-044 — User rich-text rendering (persisted ProseMirror doc) vs plain text
- **Area:** rich rendering (A5)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
User turns in the reference transcript are not limited to plain text. Each transcript entry carries an optional persisted rich-text string alongside its plain text (declared in the conversation model and preserved through entry comparison/parsing). The user-message content component in the reference tree's `frontend/src/recovered/features/conversation/workspace/transcript.tsx` feeds that string through a read-only TipTap 3 schema built once from a prompt-editor extension factory (the reference tree's `WS/rich-text-editor.tsx`, same extension set the composer uses) and hand-renders the resulting ProseMirror document to React: bold/italic/strike/underline/code/link marks, headings h1–h6, blockquote, bullet and ordered lists, list items, code blocks, hard breaks, horizontal rules, plus mention, workflow-reference and PR-reference chips. Parsing is defensive: the JSON must parse, be an object, and be `type: "doc"`, otherwise the renderer returns null and the component falls back to the plain text span. Rendering is display-only — no editing surface is mounted for transcript entries.

## What the current build does
The build has no rich-text path at all. There is no TipTap/ProseMirror dependency anywhere (`src/`, `client/`, `package.json` all clean), and no rich-text field exists on any build-side message type. In `src/client/conversation.tsx` a user turn renders the same as an assistant text span: a single pre-wrap plain `<span>` of the message text (with an "attachment only" marker variant when empty). Assistant turns get block-level parsing; user turns get none.

## The deviation
The reference renders persisted rich documents for user messages with a plain-text safety fallback; the build renders user turns as plain pre-wrapped text only, with no parse, no fallback model, and no host data to render even if it could.

## Verdict: ASK-HUMAN
ADR-0018 U-B excludes "rich chat ergonomics" but its enumerated list covers interaction/management surfaces (find-in-chat, threads, reactions, drafts, attachment viewers, URL cards); read-only display of a persisted user document is adjacent to, not literally inside, that list, so ADR-0018's default of whole-surface imitation pulls toward incorporation while ADR-0017 makes any deviation a human call. The deciding question is on the host side: does the dsh host ever persist rich-text user turns at all? If the host's conversation store is plain text only, the feature cannot exist in this build and resolves to DO-NOT-INCORPORATE as inapplicable; if the host does carry such documents, the human should rule on whether user-message rich display falls inside U-B's exclusion.

## Incorporation notes
- **Where it would live:** user-turn branch of the transcript renderer in `src/client/conversation.tsx` (next to the assistant block parser), plus a rich-text field on the conversation-feed item model in `src/client/`; extension set shared with whatever composer-side rich input deviation lands (see related composer/input deviation, DD number pending).
- **Constraints:** read-only rendering only (no editor instance per message); must keep the plain-text fallback for malformed or absent documents; new rendering dependency would be a new client bundle surface under the ADR-0020 wrapper shell; U-B scope ruling required before any of this is built.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a renderer that turns ProseMirror JSON into elements, with no new dependency, is small, but the host data-model question and the U-B scope ruling dominate; the risk is building a renderer that nothing in the host can feed.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/transcript.tsx` (the user-message content component, read-only schema setup, node/mark renderers, fallback path), the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (the prompt-editor extension factory), the reference tree's conversation model file (a rich-text field on entries).
- **Related rulings:** ADR-0018 U-B; ADR-0020 area-9 table (the rich chat ergonomics exclusion row).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (imports the prompt-editor extension factory; read-only extensions/schema; node and mark renderers; JSON-parse of the persisted rich-text document with plain-text fallback; the user-message content component; transcript wiring of the entry's rich-text field), `.../workspace/rich-text-editor.tsx` (TipTap 3 imports: @tiptap/core, extension-link, extension-mention, starter-kit, @tiptap/pm), `.../workspace/model.ts` (an optional rich-text string on the entry model)
- Build: `src/client/conversation.tsx` (user turn renders plain pre-wrap `<span className="…__text">{text}</span>`; `white-space:pre-wrap` text style), `package.json` (no TipTap/ProseMirror dependency), `src/` and `client/` (no tiptap/prosemirror/rich-text matches)
