# DD-025 — Message reactions (pills, picker, feed) vs none
- **Area:** transcript delivery states (A4) / message cards (A10)
- **Type:** missing-feature (ruled exception)
- **Date:** 2026-09-23

## What the reference does
The reference ships a full message-reaction system across the transcript and its card surface:

- **State:** transcript message entries carry a reaction list (each entry pairing an emoji with the reacting identity) and a set of the emojis the current user has applied, taken from authoritative data (`frontend/src/recovered/features/conversation/workspace/model.ts:241-242`).
- **Transport + controller:** `cards/transcript-card/reaction-actions.ts` defines a react-to-message transport built on the coordinator's matching RPC method, a small fixed six-emoji quick set, a normalizer for the incoming reaction data, and a controller whose react method applies the state change immediately (optimistic — the owner callback fires before the transport call) and then deliberately ignores any transport failure without showing an error message (`reaction-actions.ts:8,26-41,101-114`; the ignore is at 107-113).
- **Card surface:** `cards/transcript-card/message-actions.tsx` reserves a reaction slot in the per-message action row; `emoji-catalog.ts` + `emoji-picker-content.tsx` back the full emoji picker beyond the quick set.
- **Live updates + handoff:** `reaction-feed.ts` (feed rendering), `reaction-picker-handoff.ts` + `reaction-workspace-handoff.ts` (picker/workspace handoffs for react and authoritative reaction updates, including the reference's reconciliation and authoritative-clear flows).
- **Mounting:** the transcript mounts reaction pills and hover reaction actions per message that allows them (`workspace/transcript.tsx:55-60,749-757,786`).

## What the current build does
Nothing. The build has no reaction state on transcript messages, no react-to-message transport, no picker, no feed, and no pill/hover UI — a case-insensitive search for "reaction" across `src/` and `client/` returns zero hits. The absence is deliberate, not an oversight.

## The deviation
The reference treats reactions as first-class transcript/card behavior with an optimistic local update, a coordinator-backed transport, authoritative reconcile updates, and a picker spanning quick-set and full catalog. The build has none of this layer. This is one of the consciously excluded "rich chat ergonomics" features, not a missed enumeration.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 (the human-ruled top-level decision, level 2 of the repo's ruling order) explicitly lists reactions under exception U-B — "no rich chat ergonomics: no find-in-chat, threads/replies, reactions, …" — so the reference's reaction system is ruled out of scope for the rebuild, and the build's absence matches the ruling. The ruling settles the question and is not reopened: incorporating reactions would contradict an accepted, human-ruled ADR. Only a new dated human override can change this; until then the deviation is recorded, not closed.

## Incorporation notes
- **Where it would live:** (if ever re-ruled in) reaction state on transcript message entries in the conversation workspace model, a react-to-message transport over the dispatcher's coordinator client surface, and pill/picker UI on the transcript card — mirroring the reference's split into state, transport, and UI under `src/` and `client/`.
- **Constraints:** would require a dated human override reversing ADR-0018 U-B first; which files the change would touch (message state, coordinator transport, web client) is not yet worked out here (not yet filed as a numbered deviation).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — the complete feature (reaction state, transport, reconcile, picker UI, feed) spans three layers, and is currently blocked by a standing ADR exception regardless of effort.
- **Key reference anchors:**
  - `frontend/src/recovered/features/conversation/workspace/model.ts:241-242` — the reaction-list and self-applied-set message fields.
  - `frontend/src/recovered/features/conversation/cards/transcript-card/reaction-actions.ts:8,10-59,101-114` — quick emoji set, the reaction record and react-to-message transport types, optimistic apply plus deliberate ignoring of failures.
  - `frontend/src/recovered/features/conversation/cards/transcript-card/message-actions.tsx` — reaction slot in message actions.
  - `frontend/src/recovered/features/conversation/cards/transcript-card/emoji-catalog.ts`, `emoji-picker-content.tsx` — picker content.
  - `frontend/src/recovered/features/conversation/cards/transcript-card/reaction-feed.ts`, `reaction-picker-handoff.ts`, `reaction-workspace-handoff.ts` — feed and handoffs.
  - `frontend/src/recovered/features/conversation/workspace/transcript.tsx:55-60,749-757,786` — pill and hover-action mounting.

## Evidence
- Reference: `frontend/src/recovered/features/conversation/workspace/model.ts`, `frontend/src/recovered/features/conversation/cards/transcript-card/{reaction-actions.ts,message-actions.tsx,emoji-catalog.ts,emoji-picker-content.tsx,reaction-feed.ts,reaction-picker-handoff.ts,reaction-workspace-handoff.ts}`, `frontend/src/recovered/features/conversation/workspace/transcript.tsx` (all under `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`)
- Build: `src/`, `client/` — zero case-insensitive matches for "reaction" (grep verified 2026-09-23)
- Ruling: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` line 35 (U-B); `docs/adr/README.md`
