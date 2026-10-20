# DD-051 — "#" pull-request reference chips vs none
- **Area:** composer editor (A6)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does

The reference composer is a Tiptap/ProseMirror rich-text editor with a suggestion system. Typing `#` opens a pull-request picker (a PR-suggestion provider triggered on the `#` character): candidates come from a provider callback, filtered live by whether the typed query matches a PR's number or its title (case-insensitive substring), capped at 8 rows. Selecting one inserts an inline, atom PR-reference node carrying number, title, and URL attributes; the node renders as a chip showing a hash-prefixed number (falling back to a bare hash when the number is not a positive integer). Anchors: the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:516-542` (trigger, filter, cap, insert command, listbox) and `:210-240` (the PR-reference node and its number-formatting helper).

## What the current build does

The build has none of this. Its chat surface is a plain textarea with a send action, with no suggestion triggers, no listboxes, and no rich-text node model at all — the file's own header comment states the composer is deliberately minimal, citing the U-B ruling. A repo-wide search of `src/` and `client/` for the node name, the suggestion entry point, or a `#` trigger char returns nothing.

## The deviation

The reference turns `#` into a PR-reference affordance backed by a candidate source; the build offers no equivalent — the user cannot reference a pull request as a first-class chip, and there is no rich editor for such a chip to live in. This is a genuine missing feature in area A6, but it sits squarely inside ergonomics the build has ruled out, and it needs a capability the build also lacks.

## Verdict: DO-NOT-INCORPORATE

ADR-0018 rule 13 (U-B) — "No rich chat ergonomics" — is an accepted human-ruled decision (level 2 of the authority stack), and it is exactly why the build's composer is a plain textarea (`src/client/conversation.tsx` cites U-B for this). A `#` PR chip requires both a rich inline-node editor and a source of PR numbers/titles from a git host; the build has neither, so the deviation is doubly out of scope for the current product. A reversal would be a human call to reopen U-B and first set up a PR data source; nothing in the authority stack today permits incorporating it.

## Incorporation notes
- **Where it would live:** (if ever revisited after a U-B reversal) a future rich composer under `src/client/`, alongside a new interface for host data; no current module is a fit.
- **Constraints:** requires a PR candidates source the build does not have (no host/PR integration exists — scope DD number pending); requires an inline atom-node editor model; A6/U-B forbids rich chat ergonomics today.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — needs a rich-text editor framework plus a PR data source before the trigger itself is even buildable.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:516-542` (the PR-suggestion provider: `#` trigger, number/title substring filter, 8-row cap, insert command); `:210-240` (the PR-reference atom node, hash-prefixed rendering); `:237-240` (the reference-formatting helper).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (lines 210-240, 237-240, 516-542 — spot-verified this session)
- Build: `src/client/conversation.tsx` (plain-textarea composer, lines 16, 179, 204); absence checks: no PR-reference node, PR-suggestion provider, or hash trigger-char bindings anywhere under `src/` or `client/`
