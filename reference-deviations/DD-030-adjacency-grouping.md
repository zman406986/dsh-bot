# DD-030 — Turn adjacency/grouping & bubbles vs flat list
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (unruled but consistent with text-only reduction)
- **Date:** 2026-09-23

## What the reference does

The reference computes, before rendering the transcript, which rows continue which other rows. A pure function (`frontend/src/recovered/features/conversation/workspace/transcript-adjacency.ts:111-145`) walks the loaded window once and outputs, for each entry, a fixed six-field record: continued-from-previous, continued-to-next, group-start, run-start, followed-by-thread-chip, and group-end (`transcript-adjacency.ts:13-20`).

Group identity comes from a composite key of role and author (`transcript-adjacency.ts:73`); user messages with attachments are deliberately grouped with plain user messages, so an attachment does not split a run of user messages (`transcript-adjacency.ts:51-53,71-73`). Rows that cannot be grouped (unknown kind / null key) get an all-false boundary record and never take on a neighbouring row's identity (`transcript-adjacency.ts:31-38,118`).

A row is also marked as able to be drawn as a bubble only when it is a plain text message: non-empty text, no attachments, not image-only markdown, not a standalone emoji (user rows), and not a URL-card presentation (`transcript-adjacency.ts:75-80`). Assistant card entries fall back to the assistant group without bubble status since the card protocol carries no author (`transcript-adjacency.ts:86-91`). The renderer consumes these fields for grouping classes, group-boundary data attributes, and card-adjacency spacing decisions (`workspace/transcript.tsx:693-697,739-741,775`).

## What the current build does

The conversation pane renders the transcript as a flat list. Each item carries its own role label span and text span with no continuation, grouping, or bubble logic anywhere in the item renderer; row identity for React keys is built from `kind:seq` (plus call/attempt ids), not from any group key (`src/client/conversation.tsx:349-373,431-443`). The pane reads only the reduced transcript from the conversation store (ticket 80, ADR-0020 slice 4) and states its scope plainly: "text-only" surface, with U-B excluding rich ergonomics, U-C excluding timeline cards, U-E keeping delivery text-only (`src/client/conversation.tsx:11-15`).

## The deviation

Every adjacency/grouping affordance of the reference transcript is absent: consecutive turns from the same role each show a role label again instead of continuing a group, there are no group/run boundaries, no bubble presentation for plain text turns, and no way to show a run interrupted by a thread chip (thread chips themselves being already excluded under U-B). The file-level comment notes the text-only scope, but turn grouping and bubble styling are not among the named U-B exclusions (find-in-chat, threads/replies, reactions, per-agent drafts, rich attachment viewers, URL cards — `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:35`), and ADR-0018 declares its exception list exhaustive: anything not listed is held to the imitation standard (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:21,46`). So the flat list is a real fidelity gap, currently unruled at the item level rather than covered by an exception.

## Verdict: ADAPT

ADR-0018's exception list is the definition of imitation scope, and neither U-B nor U-E names turn grouping or bubbles; by the main rule the grouping behavior defaults to in-scope, so this should not be silently dropped as "rich ergonomics." It cannot be incorporated wholesale, though: the reference's eligibility check is tied to features this build excludes (reactions, thread chips, URL cards, attachments), and its group key needs an author identity the reduced item model may not carry, so the function must be written again for the build's `kind`-based items. Adapt the concept — role-continuation grouping with continued-run suppression of repeated role labels, and simple bubble styling for plain text turns — while dropping every eligibility check tied to excluded features. If the team prefers to treat grouping as out of scope under the intent behind U-B, that is a human call to record, not a silent omission.

## Incorporation notes
- **Where it would live:** a small pure module beside the pane (e.g. `src/client/conversation-adjacency.ts`) that reads the store's reduced items and returns the per-item continuation flags, consumed by the `Item` renderer in `src/client/conversation.tsx`; styles in the pane's existing `CONVERSATION_CSS` block.
- **Constraints:** re-derive from behavior, not source (ADR-0018 B9); drop eligibility checks for excluded features (reactions, thread chips, URL cards, attachments viewers — U-B/U-C/U-E); group key falls back to role level (`user`/`assistant`) unless the reduced item model carries an author — decide explicitly; streaming assistant rows need a defined continuation behavior; for unknown kinds use the all-false boundary, mirroring the reference's rule of never borrowing a neighbour's identity; keep the pane display-only (no store changes required if items are groupable by `kind`).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a pure function plus CSS plus offline tests is small, but the group-key/author question and streaming-row behavior need one recorded decision before the work can start.
- **Key reference anchors:**
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript-adjacency.ts:13-20` (six-field record)
  - `transcript-adjacency.ts:51-53,71-73` (user-attachment grouping, role-and-author group key)
  - `transcript-adjacency.ts:75-80` (bubble eligibility check)
  - `transcript-adjacency.ts:111-145` (the walk over the window, all-false boundary for ungroupable rows)
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx:693-697,739-741,775` (renderer consumption)

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript-adjacency.ts` (spot-verified lines 13-20, 51-53, 71-93, 111-145); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (consumption per enumeration, not re-verified)
- Build: `src/client/conversation.tsx:11-15` (scope comment, spot-verified), `src/client/conversation.tsx:349-373` (flat item render with per-item role label, spot-verified), `src/client/conversation.tsx:431-443` (`kind:seq` keys, flat map, spot-verified); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:35` (U-B wording), `:21,46` (exhaustive-list rule)
