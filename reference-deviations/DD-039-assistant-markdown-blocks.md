# DD-039 — Structured assistant markdown blocks vs raw pre-wrap text
- **Area:** rich rendering (A5)
- **Type:** missing-feature (recorded deferral)
- **Date:** 2026-09-23

## What the reference does
Assistant turn text is decomposed into a typed block list before it reaches the DOM. A union type in the reference tree's `frontend/src/recovered/features/conversation/workspace/transcript.tsx` (line 236, an assistant-text-block union) describes: plain paragraphs; headings at levels 1–3; ordered and unordered lists whose items can carry task-list checkboxes; quotations; a horizontal rule; pipe tables built from a header row plus a separator row; and math. A line scanner written by hand for this purpose (line 297) walks the raw text and accumulates multi-line lists and quotes, and a per-kind component (line 397 onward) renders each block as a real element carrying the shipped class names — so a table is a table and a quotation is a `<blockquote>`, not a run of characters.

## What the current build does
`Item()` in `src/client/conversation.tsx` (line 298) emits a turn's text as one string child inside a single span (line 356). That span's only structure comes from CSS: preserved newlines plus anywhere-wrapping (line 74: `white-space:pre-wrap;overflow-wrap:anywhere`). A grep over `src/client/` and `client/` finds no markdown handling of any kind, so headings, lists, tables, and quotes in assistant output all arrive as flat preformatted text.

## The deviation
The reference presents structured reply content as real elements; the build presents it as one preformatted run. This is visible in the product itself, not incidental: the reference's own prompt contract promises that replies will include a rendering contract covering markdown, KaTeX, and mermaid (`docs/research/reference-agent-prompt-inventory.md:117`), and the build honors none of the markdown part.

## Verdict: ASK-HUMAN
The nearest recorded deferral is ADR-0018 exception 13 (U-B, "no rich chat ergonomics", `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:35`), and ADR-0020's area-9 exclusion table (the rich chat ergonomics row) repeats the same list (`docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md:65`). But both enumerate specific features — find-in-chat, threads/replies, reactions, per-agent drafts, attachment viewers, URL cards — and neither names markdown block rendering, so the deferral covers this case only because the features are similar, not because it names it. The inventory line recording the reference's rendering contract is research evidence, which the authority stack ranks below rulings and which can never settle a question on its own. Since no recorded decision squarely covers this item, the authority stack's stop-and-ask rule applies: if the human reads rich text blocks as part of the U-B group of excluded features, the build stays as it is; if outside, the notes below describe an adaptation path that stays inside the no-copying rule.

## Incorporation notes
- **Where it would live:** a small parse-and-render step in a separate module next to `src/client/conversation.tsx`, called from `Item()` at the point where the `__text` span is emitted today; protocol layer, stores, and the dispatcher's plain-text contract untouched — this is presentation-time only.
- **Constraints:** independent re-derivation per B9 (never port the reference parser or its class names); streaming turns should keep the plain pre-wrap span until the turn settles, so the parser never re-blocks text while it is still arriving; scope block kinds to what our own prompt contract actually asks for — the full inventory contract also names KaTeX/mermaid, which is a separate and larger decision.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a block scanner written by hand plus per-kind renderers is a contained UI module with no new dependency for the basic kinds; extending it to full KaTeX/mermaid support would push the effort to L.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/transcript.tsx` — block union at line 236, scanner at line 297, per-kind renderer from line 397.

## Evidence
- Reference: `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot\frontend\src\recovered\features\conversation\workspace\transcript.tsx` (lines 236, 297, 397, 400)
- Build: `C:\Users\TZhen\Desktop\dsh-bot\src\client\conversation.tsx` (lines 74, 298, 356); absence confirmed by grep across `src/client/` and `client/`
