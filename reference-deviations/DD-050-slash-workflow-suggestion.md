# DD-050 — "/" skill-reference suggestion listbox vs manual slash text
- **Area:** composer editor (A6)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference web composer's rich-text editor registers a second suggestion provider next to its `@`-mention one, keyed on the `/` character (the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:488-514`). Typing `/` opens a floating listbox headed with a reference-a-skill label whose entries are the available workflows plus static actions, filtered to entries without a trigger. Choosing an entry does not run anything: it splices an inline atom node into the document — a workflow-reference chip carrying id/label/icon attributes and rendered as an at-prefixed label (the reference tree's `rich-text-editor.tsx:182-208`). The chip is data for the agent that receives the prompt (a way to reference a reusable skill/workflow inside the prompt), not a command invocation.

## What the current build does
The build's composer has no suggestion machinery at all: no listbox provider, no inline chip node, and no workflow-reference concept anywhere under `src/` or `client/`. The only "/" behavior is plain text. The dispatcher's slash commands live on the host side: commands like `/dispatcher-start` and `/dispatcher-steer` are registered host commands (`src/adapter/steer-command.ts`, `src/plugin.ts`), and the web client merely prefills the composer draft with the literal line `/dispatcher-steer <workerId> ` (`src/client/actions.ts`, `DISPATCHER_STEER_LINE`) for the user to complete by hand. Typing any slash text in the composer gets submitted verbatim; nothing pops up.

## The deviation
The reference turns "/" into an editor-embedded way to discover skills, producing inert reference chips; the build does nothing with "/" at the editor layer — its slash features are host commands that must be typed or prefilled manually. Two independent gaps: (1) no suggestion listbox UI in the composer, and (2) nothing to list, since the build has no skills/workflows registry to enumerate (see the A18 prompt-section and A19 tool-surface findings, DD number pending).

## Verdict: ASK-HUMAN
The build's slash-command behaviour is settled at the host-command layer (ADR-0009 chose explicit slash-command activation as the point where the user gives consent; ADR-0018 supersedes its mode premise but keeps commands as the visible affordance), and those slashes execute — they are categorically different from the reference's decorative chips. Incorporating the reference feature verbatim is impossible anyway: it presupposes a workflow/skill catalog the build deliberately does not have (A18 prompt sections / A19 tool surface, DD number pending). A cheap adaptation exists — composer autocomplete over the dispatcher's own host commands when the user types "/" — but that changes what "/" means in the composer (executable command hints vs inert skill references) and touches the consent boundary ADR-0009 establishes, so whether to build it, and over what vocabulary (host commands now, skills if A18/A19 are ever built), is a human product call.

## Incorporation notes
- **Where it would live:** a composer suggestion module under `src/client/` (alongside the overlay/actions composer helpers), fed by a list of dispatcher host commands from the adapter; a future skills feed would come from whatever the A18 prompt-section and A19 tool-surface work establishes.
- **Constraints:** suggestions must advertise host commands only (executable, namespaced `dispatcher-`) unless the human rules on a skills concept; must not fake the reference's chip insertion — the build has no chip node and sending one verbatim would not parse; must not blur the ADR-0009 consent boundary (suggesting `/dispatcher-start` is a hint, not auto-activation); keyboard-only operation and i18n to match the existing client surfaces.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the listbox UI is the small part; the risk is the meaning (command hints vs chips) and the dependency on a skills concept that does not exist.
- **Key reference anchors:** the reference tree's `frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx:488-514` (the workflow-suggestion provider, keyed on the slash character, with a reference-a-skill listbox, a filter that keeps only entries without a trigger, and chip insertion), `rich-text-editor.tsx:182-208` (the workflow-reference atom node/chip).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (lines 182-208, 488-514; a related PR-suggestion provider at 516+ follows the same pattern)
- Build: `src/client/actions.ts` (prefill of literal `/dispatcher-steer <workerId> `, `DISPATCHER_STEER_LINE`), `src/adapter/steer-command.ts`, `src/plugin.ts` (host command registration), `src/client/overlay.ts` (manual-typing fallback message); repo-wide grep shows no suggestion/listbox/chip code in `src/` or `client/`
