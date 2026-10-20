# DD-064 — Attachment chips & staging notices vs none
- **Area:** composer attachments (A7)
- **Type:** missing-feature (subordinate to DD-061)
- **Date:** 2026-09-23

## What the reference does
Staged attachments render as a strip above the editor: a list container announced to assistive tech as attachments (`role="list"`), holding one chip per staged file (`role="listitem"`). Each chip carries a data attribute recording the same inferred kind used elsewhere, shows the file name emphasized with a human-sized byte count from a dedicated formatter, and ends in a remove button (its accessible label names the file being removed) that filters the attachment out of the draft and invokes the remove-attachment callback so the host-side teardown runs too (`the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:166-179`). Alongside this, an optional notification prop renders as a polite live region (`aria-live="polite"` with `role="status"`) in a dedicated attachment-notice element (`composer.tsx:164`), so staging failures — rejection copy produced by the desktop staging path (`the reference tree's frontend/src/recovered/features/conversation/desktop.ts:42-55`) — are announced without stealing focus.

## What the current build does
The composer has no attachment concept at all. Its state is a single text string plus send/error flags (`const [text, setText] = useState("")` at `src/client/conversation.tsx:186`), and the rendered surface is a plain textarea over a send bar (`src/client/conversation.tsx:180-239`). There is no chip strip, no attachment notice region, and no remove affordance; the header comment in the same file, which records what the file deliberately leaves out, names "no attachments UI" as a deliberate ADR-0018 U-B exception.

## The deviation
The reference makes staged attachments visible, individually removable, and screen-reader navigable, and surfaces staging failures through a polite live region. The build has neither the presentation channel (chips) nor the announcement channel (notice), because it has no staging model underneath — DD-061 already ruled the attachment layer itself do-not-incorporate. This deviation is therefore decoration on top of a layer the build deliberately omits, not an independent gap.

## Verdict: DO-NOT-INCORPORATE
DD-061 ruled the attachment layer a deliberate divergence settled by ADR-0018 U-B's exception list (the exception that excludes rich chat ergonomics and explicitly names rich attachment ergonomics as out of scope), and this chip strip plus notice channel is pure presentation on top of that layer — building it would require the staging model DD-061 declined. The exception lives at the U-B line of the human-ruled master ADR, so only a human explicit override reopens it; any such reversal would land attachments and chips together as one effort, following the connection point DD-061 notes, not as a separate UI ticket.

## Incorporation notes
- **Where it would live:** chip strip and notice region in the build composer (`src/client/conversation.tsx`, `Composer` around lines 180-239), fed by a draft-attachments field that today does not exist; the adapter's advertised-but-unused attachments hint (`src/adapter/cordis-dsh-host.ts:135-140`, per DD-061) is the existing connection point downstream.
- **Constraints:** subordinate to DD-061 — nothing to do unless a human reverses the U-B attachment ruling; if reversed, chips must reuse the reference's semantics (kind inference, byte formatter, remove filters draft AND calls the remove callback) while being re-derived independently; live region must stay polite/status so staging failures do not steal focus.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — small render surface, but only meaningful as part of the full attachment effort (staging model, gating, transport), and it is blocked by a human ruling, not by code.
- **Key reference anchors:** chip strip and remove button `the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:166-179`; notice live region `composer.tsx:164`; staging failure copy `the reference tree's frontend/src/recovered/features/conversation/desktop.ts:42-55`; exception list `docs/adr/0018*` U-B (~line 35); gap acknowledgment `docs/research/prd-vs-reference-capability-gaps.md` (~line 36, recommendation ~line 40).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (lines 164-179), `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/desktop.ts` (lines 42-55)
- Build: `src/client/conversation.tsx` (lines 16-19 scope header, 180-239 composer), `src/adapter/cordis-dsh-host.ts` (lines 135-140)
