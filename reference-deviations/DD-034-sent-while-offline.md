# DD-034 — "Composed while offline" timestamp notice vs none
- **Area:** transcript delivery states (A4)
- **Type:** missing-feature (ruled out with the send journal)
- **Date:** 2026-09-23

## What the reference does
User transcript entries in the reference can carry an optional composed-at timestamp on the message model (reference tree, `workspace/model.ts:237`). When a user message was composed while the transport was down and is only delivered later, the transcript renders a status notice announcing that it was sent while offline, followed by a human-formatted composed-at timestamp (short month, day, hour, minute via `Intl.DateTimeFormat`, with an ISO-string fallback if formatting throws). The notice component is mounted per user entry whenever the entry is a user message that is not in a failed state and has a defined composed-at timestamp; entries in a queued state *without* a composed-at timestamp instead get the ordinary queued-send notice.

## What the current build does
Absent. There is no composed-at field anywhere in the code that builds transcript items (a grep for the composed-at field name across `src/` returns no matches), no composed-while-offline notice, and no composed-at field on build transcript entries. The build's transcript delivery surfaces (`src/client/conversation.tsx`, `src/client/context.ts`) handle their own delivery states without any notion of offline composition time.

## The deviation
The reference timestamps when an offline-composed user message was originally written and surfaces that moment to the recipient-facing transcript; the build has no equivalent. This is not an isolated UI nicety: the composed-at timestamp only has meaning inside send-journal semantics — a message must be retained client-side while offline and flushed on reconnect for "composed at" to differ from "sent at". ADR-0018 A4 explicitly rules out that model (no optimistic send / offline queue / flush-on-reconnect built by us; sends are direct), so the deviation is a deliberate consequence of a ruled architecture, not an oversight.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 A4 is an accepted, human-ruled top-level ADR that excludes send-journal semantics outright, and this notice shows send-journal state: a composed-at timestamp distinct from send time can only exist if messages are queued offline and flushed later. Incorporating the notice without the journal would be cosmetic (composed-at would always equal sent-at), and incorporating the journal itself would contradict the ADR. Re-opening A4 is a human decision, not one to take by absorbing reference UI. If the human ever revisits offline queueing, this deviation should be re-triaged alongside the send-journal family rather than piecemeal.

## Incorporation notes
- **Where it would live:** If ever ruled in, the notice component belongs beside the other transcript delivery-state renderings in `src/client/conversation.tsx`, with a composed-at-style field on the build's transcript entry model in `src/client/context.ts` — contingent on the send-journal machinery A4 forbids.
- **Constraints:** Requires offline queue + flush-on-reconnect semantics to be meaningful (ADR-0018 A4 conflict — needs human reversal of A4 first); timestamp formatting must degrade gracefully (reference falls back to ISO on format failure); notice shows only for user entries not in failed state.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the notice itself is trivial; the risk is entirely the send-journal machinery it depends on, which is excluded by architecture.
- **Key reference anchors:** `frontend/src/recovered/features/conversation/workspace/transcript.tsx:86-94` (the sent-while-offline notice component), `:789` (mount condition), `:788` (contrast: queued notice when the composed-at timestamp is absent), `workspace/model.ts:237` (the composed-at field).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/transcript.tsx` (lines 86-94, 788-789), `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/model.ts` (line 237)
- Build: `C:\Users\TZhen\Desktop\dsh-bot\src\client\conversation.tsx`, `C:\Users\TZhen\Desktop\dsh-bot\src\client\context.ts` (delivery-state handling, no composed-at concept); negative grep for the composed-at field name across `src/`
- Rules: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (A4 — no send-journal semantics; sends are direct)
