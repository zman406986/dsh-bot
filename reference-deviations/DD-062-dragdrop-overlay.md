# DD-062 — Drag-and-drop file intake with overlay vs none
- **Area:** composer attachments (A7)
- **Type:** missing-feature (subordinate to DD-061)
- **Date:** 2026-09-23

## What the reference does
The reference composer's shell is a drag-and-drop target with depth-tracked hover state. A depth-counter ref counts nested dragenter/dragleave pairs (`the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:74`), and every drag handler first gates on the drag payload's type list carrying the files kind, so text-only internal drags are ignored (`composer.tsx:60-64,130-153`). While files hover over the shell, dragover sets the drop effect to a copy, and an aria-hidden overlay div renders a badge telling the user to drop files to add them to the chat (`composer.tsx:137-141,162-163`). A drop resets the depth counter, clears the hover state, and stages the dropped file list through the same slot-capped staging path the file picker uses (`composer.tsx:147-153`, staging at `composer.tsx:119-128`). The composer's default placeholder also advertises the affordance, inviting the user to ask something or drop a file (`composer.tsx:71`).

## What the current build does
The build's composer is a plain textarea plus send (`src/client/conversation.tsx:180-230`, textarea at ~204). A grep of `src/client` finds no `onDrop`, `onDragEnter`, `onDragOver`, `onDragLeave`, or `dataTransfer` usage anywhere, and no drag-depth counter — there is no drag target, no hover overlay, and no drop staging. The build's scope header, which records what the composer deliberately leaves out, describes the composer as a plain textarea with no attachments UI under the ADR-0018 U-B exception (U-B is the exception entry for "no rich chat ergonomics") (`src/client/conversation.tsx:16-19`).

## The deviation
Reference: file drags over the composer are detected, visually acknowledged with a hover overlay badge, and accepted into the capped attachment-staging path; the placeholder advertises the capability. Build: the composer has no drag/drop behavior at all — nothing detects a file drag, nothing renders an overlay, and a dropped file would trigger the browser's default load-the-file-as-page behavior since no drop handler calls `preventDefault`. The gap is total, but it depends entirely on the attachment intake that DD-061 ruled out.

## Verdict: DO-NOT-INCORPORATE
Drag-and-drop is a second entry point into the same attachment intake, and DD-061 ruled that intake a deliberate divergence under ADR-0018 U-B (no rich chat ergonomics: no attachments UI; text-only sends). With no intake, staging path, or attachment chips, an overlay and drop handler would have nothing to stage into — incorporating this alone would add a drag overlay that cannot accept anything, on top of a ruled-out feature. This verdict inherits DD-061's: any reopening is a human explicit override that supersedes ADR-0018, and it must arrive at the human first, not as a ticket default. If that override ever lands, this file's incorporation notes describe the drag layer that goes on top.

## Incorporation notes
- **Where it would live:** client composer (`src/client/conversation.tsx`, the `Composer` component) — drag handlers and hover state on the composer wrapper, the overlay as a conditional sibling of the textarea; staging would reuse whatever capped file-acceptance path DD-061's reversal creates (DD-061 incorporation notes; the placeholder there now points to DD-062).
- **Constraints:** handlers must gate on the drag containing files (not text) to avoid hijacking internal text drags; `preventDefault` on dragover is required for a valid drop target; a depth counter (or equivalent) is needed because nested elements fire enter/leave pairs; the overlay must be hidden from assistive tech; cap enforcement at drop time goes through the same path as the picker, not a separate one. All logic re-derived independently.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S (on top of DD-061's L) — the drag layer itself is small and self-contained, but it is worthless without the intake, and overlay copy/visuals must be designed fresh rather than mirrored.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:60-64` (files-only gate), `:71` (placeholder), `:74-75` (depth ref + hover state), `:119-128` (capped staging), `:130-153` (dragenter/over/leave/drop), `:162-163` (shell handlers + aria-hidden overlay badge).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx`
- Build: `src/client/conversation.tsx` (no drag/drop handlers anywhere under `src/client`, verified by grep)
- Intent docs: `docs/adr/0018*` (U-B exception list); `docs/adr/README.md`; related ruling `reference-deviations/DD-061-attachments-absent-with-limit.md`
