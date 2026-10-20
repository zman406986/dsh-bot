# DD-125 — Delta-streaming event protocol vs host event-window tail
- **Area:** inference routing & streaming (A15)
- **Type:** deliberate-divergence (equivalent outcome, different owner)
- **Date:** 2026-09-23

## What the reference does
The reference coordinator's inference router owns the streaming protocol itself. It wires a text-delta callback (delta plus accumulated text) into the provider runner and, on each delta, re-emits the same assistant transcript entry id: the first emission is an append transcript event, every subsequent one is an update event carrying a streaming flag, until the final non-streaming emit settles the entry. The provider layer beneath it is uneven: two of the direct executors feed real token-by-token deltas through the shared routed-provider loop, but the third collects the whole answer first and then yields a single full-text delta event at the end — so that backend's turns only ever "stream" once, as one whole-text chunk.

## What the current build does
Streaming is host-owned by design. The adapter never sees per-token deltas; its only stream-adjacent observation is the `session/event` firehose, filtered to `tool/call` events, used to surface tool-activity phrases for worker status. The visible streaming effect comes from the client tailing the host's `SessionEventWindow`: the conversation store folds `assistant/live-chunk` text-delta transients into one streaming item per attempt that accumulates in place, and the durable settlement supersedes the transients because the host replaces the attempt's rows in the window on settle and the reduction recomputes from the full window — no client-side cleanup protocol needed.

## The deviation
The reference's append/update-with-streaming-flag event protocol is a hand-rolled re-implementation of exactly what the host session event window already provides to the build: an append-then-refine stream of assistant state that a tailing view can reduce into streaming-in-place text. The build gets the same user-visible outcome (text that grows in place, then settles durably) by reading the host's window instead of by defining its own transcript event grammar over raw deltas. Reference-internal asymmetry (one backend's single end-of-turn whole-text delta vs the others' token streams) does not carry over as a build problem — the client's reduction is driven by whatever chunk cadence the host window carries.

## Verdict: DO-NOT-INCORPORATE
This is a conformant re-hosting, not a loss: the host event window is the build's sanctioned streaming surface, and the reference's append/updated protocol duplicates that mechanism at the application layer. Porting it would introduce a second, competing streaming grammar beside `assistant/live-chunk`/`SessionEventWindow` for no behavioral gain, and would drag reference protocol code across the ADR-0018 B9 license line for something the host already owns. Nothing here is missing from the build; at most, the reference's per-provider cadence note (the third backend collapsing to one delta) is a known property of the underlying providers, not a protocol to adopt.

## Incorporation notes
- **Where it would live:** Nowhere — if ever revisited, the only touch point would be `src/client/conversation-store.ts` (the `assistant/live-chunk` reduction), not a new event protocol in the adapter or worker.
- **Constraints:** Any streaming display must keep deriving from the host `SessionEventWindow` (settlement replaces transients; the client recomputes from the full window); the adapter must not grow a delta-level channel; tool activity stays on the `session/event` `tool/call` firehose.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no action required; only risk is a future contributor re-introducing a parallel streaming protocol while porting other router behavior.
- **Key reference anchors:**
  - the reference tree's `source/node-agent-coordinator/inference-router.ts` — the transcript-emit helper with its append/update variants; the assistant-emit helper re-using one assistant entry id; the text-delta callback re-emitting accumulated text with the streaming flag set; the comment about a perceptible rendered interval before streaming begins.
  - the reference tree's `source/host/extensions/inference/provider-session.ts` — the third executor yielding one whole-text delta event from the final result; the shared routed-provider dispatch loop with its per-event text-delta callback.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/node-agent-coordinator/inference-router.ts` (the transcript-emit helper ~:79, the assistant-emit and text-delta callback ~:150–180); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/inference/provider-session.ts` (the third executor ~:203–224, the shared routed-provider loop ~:270–296)
- Build: `src/client/conversation-store.ts:34–40` (`assistant/live-chunk` transients, streaming-in-place reduction, settlement supersedes); `src/adapter/cordis-dsh-host.ts:496–515` (`session/event` firehose filtered to `tool/call` for activity phrases)
