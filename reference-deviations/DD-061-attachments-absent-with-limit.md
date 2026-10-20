# DD-061 — Hard-capped attachment intake vs text-only sends
- **Area:** composer attachments (A7)
- **Type:** deliberate-divergence (ruled)
- **Date:** 2026-09-23

## What the reference does
The reference composer accepts file attachments as first-class draft payload, hard-capped at six per message. The cap constant lives in `the reference tree's frontend/src/recovered/features/conversation/workspace/model.ts:6` and is enforced three ways: incoming selections are trimmed to the remaining free slots by the composer's file-selection helper (`composer.tsx:66-69`), the attach control is disabled once the cap is reached (`composer.tsx:83,200`), and a hidden multi-file input drives the picker (`composer.tsx:124-128,218`). An attachment alone is enough to send: the draft-emptiness check requires both prompt text and attachments to be empty (`model.ts:43-45`, wired in at `composer.tsx:77,82`). There are no per-kind acceptance rules — a ten-kind classifier with a generic fallback (`model.ts:8-19,170-184`) shapes chip display only; size enforcement lives in staging, not the composer.

## What the current build does
The build's composer is a plain textarea plus a send button (`src/client/conversation.tsx:180-204`). Sending is gated on non-blank text only (`conversation.tsx:118-120`) — attachments cannot carry a message because they cannot exist. The transport layer always passes an empty attachments array when executing a command (`src/client/actions.ts:252-253`, called out in a comment as the composer's exact transaction), even though the host-side `commands.execute` signature accepts an attachment list (`src/client/context.ts:323-331`). The adapter even advertises an `attachments?: boolean` input hint (`src/adapter/cordis-dsh-host.ts:135-140`), but no client code reads it.

## The deviation
Reference: hard-capped (six-slot) attachment intake where attachments count as sendable payload on their own. Build: no attachment intake at all — text-only sends, an empty array hardcoded at the transport, and an unused capability hint left dangling on the adapter. The gap is total (no UI, no payload path, no gating change) rather than partial (no reduced cap or subset of kinds).

## Verdict: DO-NOT-INCORPORATE
This is a ruled deliberate divergence, not an accidental gap. The build's own header comment, which records what the file deliberately leaves out, names "no attachments UI" as an ADR-0018 U-B exception — U-B is the exception entry for "no rich chat ergonomics" (`src/client/conversation.tsx:16-19`). That matches the exception list in `docs/adr/0018*` (~line 35), and `docs/surfaces.md` (~lines 218-219) declares the host composer's behavior not rebuilt. ADR-0018 is the human-ruled master in the ordering of ruling documents defined in `docs/agents-rulebook.md`, so it settles this without re-opening. The nearest existing connection point if a human ever reverses the ruling is the advertised-but-unused `attachments` hint on the adapter (`src/adapter/cordis-dsh-host.ts:135-140`): the host already accepts an attachments argument through `commands.execute` (`src/client/context.ts:323-331`), so the plumbing exists end-to-end except for UI, gating, and the transport's hardcoded empty array. Any future reversal is a human explicit override, so it goes to the human first, not to a ticket default.

## Incorporation notes
- **Where it would live:** client composer (`src/client/conversation.tsx`) for UI and gating; transport (`src/client/actions.ts`) to pass a real attachments array instead of the hardcoded empty one; the adapter hint (`src/adapter/cordis-dsh-host.ts:135-140`) is already in place and would finally get a reader. Related deviation tickets pending numbering (DD number pending).
- **Constraints:** a reversal must be a dated human override superseding ADR-0018 U-B; attachments would need to count as payload for send-gating (empty text + attachment = sendable); cap and any kind/size rules must be re-derived independently (the reference's ten-kind classifier is display-only — do not copy its taxonomy).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — UI (picker, chips, cap enforcement), send-gating semantics, transport payload plumbing, and host-side acceptance all need design plus offline tests; the existing hint helps but nothing downstream of the transport has ever carried an attachment.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/workspace/model.ts:6,8-19,43-45,170-184`; `the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:66-69,77,82-83,124-128,200,218`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/model.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx`
- Build: `src/client/conversation.tsx`; `src/client/actions.ts`; `src/client/context.ts`; `src/adapter/cordis-dsh-host.ts`
- Intent docs: `docs/adr/0018*` (U-B exception list, ~line 35); `docs/surfaces.md` (~lines 218-219); `docs/research/prd-vs-reference-capability-gaps.md`
