# DD-045 — Attachment viewer suite (media/PDF/spreadsheet) vs attachment-only marker
- **Area:** rich rendering (A5)
- **Type:** missing-feature (explicitly recorded deferral)
- **Date:** 2026-09-23

## What the reference does
The reference renders user attachments rather than merely acknowledging them. A transcript attachment gallery infers each attachment's kind and renders inline media cards for images, video, and audio; selecting one opens a fullscreen portal-based viewer with a 1x–5x zoom range, pan/drag interaction, keyboard arrow navigation between attachments, a filmstrip of thumbnails, and focus restoration on close (the reference tree's `frontend/src/recovered/features/conversation/workspace/media-viewer.tsx`). The gallery mounts two specialist viewers in the same reference-tree `workspace/` folder: a PDF viewer (`pdf-viewer.tsx`) that lazily loads a pdfjs runtime plus worker, draws a text layer, virtualizes pages with a look-ahead margin, caps input at a byte ceiling, and offers a download action; and a spreadsheet viewer trio (`spreadsheet-viewer.tsx`, `spreadsheet-viewer-model.ts`, `spreadsheet-viewer-provider.ts`) that lazily loads a vendored xlsx runtime, parses sheets, and shows a preview capped to a bounded number of rows.

## What the current build does
The conversation client (`src/client/conversation.tsx`) has no attachment gallery and no viewer of any kind. A user turn that carries attachments but no text is reduced to a single localized "attachment-only" marker (key `shell.conv.attachment-only`, defined near line 170 and rendered near line 359). Attachments are thereby acknowledged as present but their content is never displayed — no inline media, no PDF, no sheet preview.

## The deviation
The entire viewer set — gallery, media portal viewer, PDF viewer, spreadsheet viewer — is absent from the build. Where the reference shows the user the attachment content, dsh shows a placeholder line. This absence is not an oversight: ADR-0018's exception list records it under the general exclusion "no rich chat ergonomics", and the dispatcher-behavior research doc independently lists rich attachment viewing (PDF/spreadsheet/media, plus mermaid) among known gaps that the dispatcher experience silently assumes someone else will fill. The related U-B deferrals (find-in-chat, reactions, drafts, URL cards) are separate deviation files (DD numbers pending).

## Verdict: DO-NOT-INCORPORATE
ADR-0018 — the top human ruling (level 2 of the authority stack) — explicitly excepts rich attachment viewers from the imitate-in-entirety mandate (exception 13, U-B), so the build currently *complies* with its ruling, and the research doc records the gap as known rather than actionable. Incorporating would silently reverse a recorded human exception, which only an explicit human ruling can do; the authority stack settles such cases and does not re-open them itself. The verdict therefore stands as do-not-incorporate unless the human re-opens U-B, in which case the notes below describe where the work would go.

## Incorporation notes
- **Where it would live:** `src/client/` alongside the conversation surface — a gallery component in the same directory as `conversation.tsx`, with the PDF and spreadsheet viewers as separate lazily-imported modules so the base client bundle does not carry pdfjs/xlsx weight.
- **Constraints:** viewer runtimes must be lazy-loaded (pdfjs worker + vendored or npm xlsx per ADR-0001's TypeScript-core ruling); byte caps and row caps are needed to keep worker memory bounded; arrow-key nav and focus restore must respect the client's existing keyboard/focus conventions; scope limited to media/PDF/spreadsheet — mermaid is tracked separately.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree. (pdfjs-dist/xlsx are independent OSS.)
- **Effort/risk:** L — three viewer sets with two heavy lazy runtimes, a portal viewer with zoom/pan/keyboard state, and code that infers each attachment's kind; only worth funding if the human lifts exception 13.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/media-viewer.tsx` — gallery + fullscreen portal viewer (zoom 1–5, pan, arrow-key nav, filmstrip, focus restore)
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/pdf-viewer.tsx` — lazy pdfjs runtime + worker, text layer, page virtualization, byte cap, download
  - the reference tree's `frontend/src/recovered/features/conversation/workspace/spreadsheet-viewer.tsx` / `-model.ts` / `-provider.ts` — lazy vendored xlsx runtime, sheet parse, capped preview rows
  - `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` line 35 — exception 13 (U-B): "rich attachment viewers" excluded
  - `docs/research/always-on-dispatcher-behavior.md` line 73 — known-gap list entry

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/media-viewer.tsx`, `pdf-viewer.tsx` (395 lines), `spreadsheet-viewer.tsx` (179), `spreadsheet-viewer-model.ts` (258), `spreadsheet-viewer-provider.ts` (108)
- Build: `src/client/conversation.tsx` (attachment-only key line 170, render line 359; no gallery/viewer)
