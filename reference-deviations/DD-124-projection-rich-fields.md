# DD-124 — Rich-field transcript projection vs text-only reduction
- **Area:** inference routing & streaming (A15)
- **Type:** missing-feature (moot in the build's architecture)
- **Date:** 2026-09-23

## What the reference does
The reference's inference-router layer stores and re-emits transcript entries that carry presentation-rich chat fields. Its projection function turns a stored user entry into a message-shaped payload that can include a rich-text variant of the body, a client-generated nonce for dedupe/identity, and a reaction list, always marking the entry as settled (not streaming); assistant entries are re-shaped as send-message payloads. Turn ids are numbered per turn and reconciled against the remote coordinator's tail so routed turns line up with what the remote session already shows. It also implements message reactions locally: a react method toggles a reaction authored as the local user on or off for a given emoji, rewriting the stored entry's reaction list. The evident purpose is to make turns that were routed through the coordinator render in the local UI exactly like turns typed into a native session — same fields, same shapes, same visual result.

## What the current build does
The build has no notion of any of these fields. A search across `src/core` and `src/adapter` finds zero occurrences of a rich-text variant, a client nonce, or reactions — the concepts do not exist in the build's vocabulary. The client's only transcript projection is the conversation store, which reduces the host session's event window in a single pass into a text-only turn model: user turns and assistant turns are text blocks joined verbatim, live chunks accumulate into one streaming item per attempt, and tool call/result pairs collapse into per-call rows. Everything the pane shows besides text (interrupted flag, tool views, dispatch cards, derived running state) is derived from the host's own event window, and assistant delivery is kept text-only by design decision (U-E). There is no reconciliation problem to solve: dispatcher and worker channels are host-native sessions, so the window the client reduces is the same window every other surface of the host reads.

## The deviation
The reference needs a rich-field projection layer because its routed turns arrive through a side channel and must be cosmetically merged back into a native-looking transcript, including decorative state (reactions) and identity plumbing (client nonces) that survive the round trip. The build has no side channel: worker results are delivered as ordinary assistant messages in the host session's window (the core's delivery obligation), so routed and native turns are indistinguishable by construction, not by projection. The build's text-only reduction is a deliberate, ticketed choice (ticket 80, ADR-0020 slice 4), not an omission of the reference's richer fields.

## Verdict: DO-NOT-INCORPORATE
The motivating problem — routed turns needing to look identical to native-session turns in the UI — does not exist in the build, where dispatcher and worker channels are themselves host-native sessions, so the deviation is moot rather than missing. Adding nonce, rich-text, or reaction plumbing would import coordinator-era identity machinery with nothing to dedupe against and no UI that renders it, contradicting the build's text-only delivery decision (U-E) and the PRD's host-native architecture. Reactions are a new product surface, not a gap in matching the reference, and would need a human-routed PRD amendment before any work. Should the build ever grow a non-host transport for agent traffic, revisit this deviation as an ADAPT with the integration point named; until then the recorded gap in the conversation store's module comment already covers the honest text-only scope.

## Incorporation notes
- **Where it would live:** (if ever revisited) the reduction layer in `src/client/conversation-store.ts` — item variants would carry the extra fields; nothing in `src/core` or `src/adapter` needs to change, since the host window is the source of truth.
- **Constraints:** any change must respect U-E (text-only delivery), the honest-degradation rule of the reduction (never a fabricated field), and pull-only derived state; reactions in particular are a PRD-level feature, not a client detail.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S if ever needed (client-side field passthrough), but only after a PRD amendment; risk is scope creep, not complexity.
- **Key reference anchors:** reference tree `source/node-agent-coordinator/inference-router.ts` — projection function (~line 46) emitting message/send-message shapes with optional rich fields; stored-entry type with the optional rich fields (~lines 14–17); local reaction toggle helper (~lines 111–115) and its dispatch hook (~line 191).
- (DD number pending) for any cross-file counts not cited above.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/node-agent-coordinator/inference-router.ts` (projection function, stored-entry fields, reaction toggle; spot-verified lines 14–17, 46–49, 111–115, 140, 191).
- Build: `src/client/conversation-store.ts` (window → text-only transcript reduction; `ConversationItem` variants carry only text/streaming/tool state); repo-wide search of `src/core` and `src/adapter` returned zero hits for the rich-field concepts.
