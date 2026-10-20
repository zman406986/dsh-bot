# DD-049 — @-mention suggestion machinery vs none
- **Area:** composer editor (A6)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference composer's rich-text editor wires a TipTap-style Mention extension triggered by the `@` character, configured to allow spaces inside a query and matched with a custom multi-word matcher that scans roughly the last ~200 characters of context rather than stopping at whitespace. Suggestion items are merged from injected providers — conversation members, trigger-eligible workflows, and MCP references — into one ranked list (the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:450-486`). Selecting an entry inserts either a mention atom node or a workflow-reference chip node (with icon attributes) into the document, and records the pick as a recent for future ranking. A custom renderer draws a fixed-position listbox with proper listbox/option ARIA semantics (`aria-activedescendant`, `role="option"`, `aria-selected`), ArrowUp/ArrowDown cycling, Enter/Tab selection, Escape dismiss with event containment, close on editor blur, and distinct empty-state messages for a query with no matches versus an empty query (the reference tree's `rich-text-editor.tsx:305-448`). A separate workflow-suggestion path reuses the same renderer (line 488 onward).

## What the current build does
Nothing. There is no mention extension, no interface for injecting suggestion providers, and no listbox renderer anywhere under `src/client`. A search for mention/suggestion/listbox across the client sources returns a single incidental hit — the word "mentioned" in a doc comment in `src/client/shell-mirror-feed.ts:93` — with no code behind it. The composer has no addressable-entity insertion of any kind.

## The deviation
An entire interaction layer — @-trigger parsing, provider-based item sourcing, keyboard-navigable accessible listbox, atom-node insertion, recents tracking — exists in the reference and is absent from the build. This is a clean missing feature, not a behavioral difference: the build's composer never resolves a typed token to an entity.

## Verdict: ADAPT
The interaction itself is worth having, but under ADR-0018 (U-B) it must be re-derived independently for this codebase's own editor, not ported — and it depends on something the build largely lacks: an addressable-entity model (peers, agents, workflows) that mention entries can point at. That model is the subject of a separate deviation (DD number pending, peer directory); without it the suggestion providers have nothing to enumerate. Treat the reference as a behavioral spec (trigger rules, ARIA roles, keyboard behavior, empty states) and build the feature on our own components once the entity directory exists; if sequencing is contested, this is an ASK-HUMAN-style prioritization call, but the design direction itself is ADAPT.

## Incorporation notes
- **Where it would live:** composer/editor surface under `src/client` (alongside the mirror-feed composer work), with an interface for injecting suggestion providers so members/workflows/MCP entries can be supplied once their sources exist.
- **Constraints:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree. Blocked by the addressable-entity model (DD number pending, peer directory). Keep the accessibility contract (listbox/option roles, active-descendant, Escape containment, blur close) as first-class requirements, not polish.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — new editor extension plus renderer plus a provider interface, dependent on the entity-directory work; empty-state copy must be paraphrased, not lifted.
- **Key reference anchors:** `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:450-486` (mention extension, provider merge, node insertion); `:305-448` (fixed-position listbox renderer, ARIA roles, keyboard handling, blur close, empty states); `:488+` (workflow-suggestion reuse).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (lines 303-448 renderer, 450-486 mention suggestion, 488+ workflow suggestion)
- Build: `src/client` (grep for mention|suggestion|listbox — the only hit is a doc comment at `src/client/shell-mirror-feed.ts:93`)
