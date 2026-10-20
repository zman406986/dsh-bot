# DD-066 — Voice transcription transport: host-RPC vs no channel
- **Area:** voice dictation (A8)
- **Type:** missing-feature (decision about the transport channel)
- **Date:** 2026-09-23

## What the reference does
The reference frontend does not send dictation audio to a server itself. `the reference tree's frontend/src/production/ProductionRenderer.tsx` (line 1894) builds a transcribe-audio callback that forwards straight to the desktop bridge, then hands that callback down into the conversation composer (line 3528). The bridge contract declares a transcription call — audio bytes, a MIME type, and an optional language in, a promise of a transcription result out — at `the reference tree's frontend/src/recovered/contracts/desktop-bridge.ts:403`, and the host side registers it as an object-style RPC method — it appears in the method-kind table at `the reference tree's frontend/src/recovered/contracts/main-rpc.ts:20` with its payload shape at line 60. The transcriber is an injected capability: if the composition controller gets no implementation, its default rejects, so speech-to-text is host-dependent by design — the page only ever sees the bridge abstraction, never the transport.

## What the current build does
There is no equivalent channel anywhere. A search of the whole `src/` tree finds no transcription reference at all, and `src/client/` contains no audio handling of any kind — no upload path, no transcription route, no bridge call. The dsh client's only data path to the host is the session event feed (`src/client/conversation-feed.ts`, `src/client/context.ts`). The build's research note on dsh extension surfaces, `docs/research/dsh-extension-surface.md`, does not mention transcription or audio.

## The deviation
The reference made an explicit transport decision: recorded audio crosses to the host through a desktop-bridge RPC method rather than an in-page HTTP request, and the UI receives the capability as an injectable callback. The dsh build has neither the decision nor the channel — no RPC method, no HTTP route, no client-side connection point. This is not a small behavioral gap but a design choice any future voice incorporation must make against the current host API, and it cannot be copied verbatim because the build's host exposes no bridge surface to hang it on.

## Verdict: ADAPT
This is the host-side channel that would be needed by the separately recorded voice-absent deviation (DD-065), and becomes relevant only if dictation is ever adopted; on its own it changes nothing in the current build. No recorded ruling covers a voice-transcription transport. If dictation is adopted, the transport must be adapted to the dsh host — some new host-side surface (RPC method, client-side callback injection, or plugin-provided capability) has to exist before any client code can send audio anywhere. That host-side support is the real cost; the client-side connection point itself is thin.

## Incorporation notes
- **Where it would live:** a transcriber connection point in the dsh client voice feature — an injected callback in the shape of the reference's capability (audio bytes, mime type, optional language, promise of a result), wired to a new host-side surface beside the existing session event sources in `src/client/conversation-feed.ts` / `src/client/context.ts`; the transport decision itself should be recorded in `docs/research/dsh-extension-surface.md` before any implementation.
- **Constraints:** requires host-side support the build does not have today — the client can only consume session events, so audio bytes have no way out without a new host capability; the dsh host API (per the PRD's extension surface) would need to grow an RPC or plugin hook; scope limit — voice dictation is out of the current PRD scope, so this stays dormant until that changes.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the client-side connection point is small, but the host-side transcription implementation (provider integration, audio capture, permissions) dominates the work; the main risk is designing a channel against a host API that has no precedent for binary payloads.
- **Key reference anchors:** `the reference tree's frontend/src/production/ProductionRenderer.tsx:1894` (callback wrapping the bridge call), `:3528` (passed to the composer); `the reference tree's frontend/src/recovered/contracts/desktop-bridge.ts:403` (bridge signature), `:244` (listed among bridge members); `the reference tree's frontend/src/recovered/contracts/main-rpc.ts:20` (method-kind table), `:60` (payload shape).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 1894, 3528); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/contracts/desktop-bridge.ts` (lines 244, 403); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/contracts/main-rpc.ts` (lines 20, 60)
- Build: `src/` (no transcription references anywhere); `src/client/conversation-feed.ts`, `src/client/context.ts` (session event sources, the only data path); `docs/research/dsh-extension-surface.md` (no transcription or audio mention)
