# DD-043 — Fenced code blocks with per-block copy vs plain lines
- **Area:** rich rendering (A5)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
Assistant message text is first split into content blocks by a parser in the reference transcript component that pulls fenced code out of surrounding prose. Each fence is then rendered not as text but as a figure: a horizontally scrollable container holding a `pre`/`code` element carrying a language-marker class (or a fallback class when no tag was given), plus a small copy button scoped to that one block. The button writes the block's text to the clipboard and flips to a brief copied-confirmation state (a check icon) that resets after 1200 ms. Notably, the reference applies no real syntax highlighting anywhere — that language class is decoration only; there is no highlighter dependency behind it.

## What the current build does
Message text is a single block styled `white-space:pre-wrap` (`.conversation__text` in `src/client/conversation.tsx`), so fences appear as literal back-tick lines flowing with the prose. There is no fence parser, no code figure, no scroll container, and no per-block copy affordance anywhere in `src/client/`. (Copy exists only at the whole-message level — see DD-029.)

## The deviation
The reference treats a fenced code region as a first-class block with its own presentation and its own copy control; the build flattens it into pre-wrapped text with no structure and no block-scoped copy. The gap has two layers: block parsing (the prerequisite, tracked as DD-039, currently ASK-HUMAN) and the presentation affordances on top (this file).

## Verdict: ASK-HUMAN
U-B in ADR-0018 records a deferral of "no rich chat ergonomics," and this item belongs to that group even though U-B's itemized list does not name code blocks specifically — so no recorded ruling covers it exactly, and the authority stack says stop and ask rather than silently pick. The counterargument, stated honestly: this repo is a coding tool, and readable, copyable code fences are plausibly the single highest-value rich-rendering item for daily use — more defensible than cards, reactions, or threads. If the human re-opens the U-B group at all (or rules on DD-039's parser), this should be first in line for incorporation, at small marginal cost; the per-block copy part in particular uses the same pattern already ruled ADAPT for whole-message copy (DD-029).

## Incorporation notes
- **Where it would live:** the client surface under `src/client/` — fence splitting where message text is composed/rendered (`src/client/conversation.tsx`, feed assembly in `src/client/conversation-feed.ts`), plus CSS for the figure/scroll container alongside the existing `__text` styles; depends on the block parser from DD-039.
- **Constraints:** clipboard write and transient feedback only — no toast/overlay (per DD-010 overlay rules); no syntax-highlighter dependency unless separately ruled (the reference has none, so none is implied); classes re-derived, not copied.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the figure + copy button is S once fenced blocks exist, but the whole item depends on the DD-039 parsing decision; risk is low, and the scope risk is where the U-B boundary falls.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/transcript.tsx` — the content-block splitter (~line 419), copy-button timer resetting at 1200 ms (~line 441), the code-block figure markup (~lines 453-454), block-kind dispatch in the prose renderer (~lines 541-542).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx`
- Build: `src/client/conversation.tsx` (single pre-wrapped text style, ~line 74); absence of fence/copy handling verified across `src/client/`
