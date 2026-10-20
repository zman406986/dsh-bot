# DD-079 — Timeline event rows vs none
- **Area:** message cards (A10)
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference transcript renders four kinds of system happenings — channel connect and disconnect, agent-name change, and automation change — as compact single-line rows rather than rich cards. A frozen registry (the reference's timeline-event registry) keys each by an event-prefixed protocol key carrying metadata — entry kind event, a 32px placeholder height, an optional calendar icon (used only by the automation entry) — and projects/validates incoming payloads per kind. Shared describe-copy and an automation action-verb lookup table are pulled from a shared timeline-events module. The event card module supplies a timestamp rendered by the row itself (locale hour:minute formatter) plus single-line ellipsis text behavior for that card; the resolver and automation card modules complete the set of card components (not individually re-read this pass). The registry documents four `@evidence` byteOffset anchors into the shipped renderer bundle marking the recovered card metadata blobs, and the event card module adds a further anchor for the shared row timestamp plus per-variant placeholder discriminants.

## What the current build does
Nothing. There is no event-card registry, no event row component, and no resolver anywhere under `src/client/`. The only occurrences of "timeline" in the client are comments in `conversation.tsx` and `conversation-store.ts` recording that the U-C exception excludes timeline cards from the transcript — i.e., the absence is documented by the build itself.

## The deviation
Four categories of system events that appear as timestamped one-line rows in the reference transcript have no counterpart in the build's chat surface. Unlike most A10 (message cards) gaps, this absence is a deliberate exclusion under ADR-0018, not unfinished imitation.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's exception list rules this out twice over: U-C excludes timeline/housekeeping cards in chat outright, and the producers of three of the four events are themselves excluded concepts — the automations subsystem falls under C14 and the connection-lifecycle model under U-A, so the build has nothing that would emit those events. The remaining name-change row presupposes agent-identity/rename surfaces curtailed by C13 and U-G. Incorporation would therefore require a human reversal of the exception list first, then the producing subsystems; the build's existing comments already record the U-C exclusion, so this entry records conformance rather than a defect.

## Incorporation notes
- **Where it would live:** Only if U-C/C14/U-A are reversed: an event registry plus row component alongside the other transcript card code in `src/client/` (a cards/ directory next to `src/client/conversation.tsx`), fed from the conversation store's entry stream.
- **Constraints:** Blocked by ADR-0018 exceptions U-C (timeline cards), C14 (no routines/automations subsystem), U-A (no connection-lifecycle model), and also affected by C13/U-G (agent identity/runtime management). Any reversal is a human ruling — amend the ADR and re-base the PRD via the tracker before implementation (see `Issue-tracker/issue-tracker.md`).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for the row rendering itself (single-line timestamped rows are small), but M+ end to end because it depends on reversing multiple human-ruled exceptions and building the event-producing subsystems; the real risk is governance, not code.
- **Key reference anchors:**
  - the reference's timeline-event registry `@evidence` byteOffsets — four card metadata blobs in the shipped renderer bundle (byteOffsets ~5102791–5103190).
  - the reference's event card module row-timestamp anchor (byteOffset 5249131) and the 32px placeholder discriminants for the three shipped event views.

## Evidence
- Reference:
  - `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot\frontend\src\recovered\features\conversation\cards\timeline-event-registry.ts`
  - `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot\frontend\src\recovered\features\conversation\cards\timeline-event.tsx`
  - `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot\frontend\src\recovered\features\conversation\cards\timeline-event-resolver.tsx`
  - `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot\frontend\src\recovered\features\conversation\cards\timeline-event-automation.tsx`
- Build:
  - `C:\Users\TZhen\Desktop\dsh-bot\src\client\conversation.tsx` (line 14 comment: U-C excludes timeline cards)
  - `C:\Users\TZhen\Desktop\dsh-bot\src\client\conversation-store.ts` (line 54 comment: timeline cards skipped)
  - `C:\Users\TZhen\Desktop\dsh-bot\docs\adr\0018-imitate-reference-in-entirety-exception-list.md` (U-C, C14, U-A, C13, U-G, B9)
