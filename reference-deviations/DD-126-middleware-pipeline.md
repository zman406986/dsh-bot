# DD-126 — Executor middleware chain vs no middleware seam
- **Area:** inference routing & streaming (A15)
- **Type:** missing-feature (mostly host-owned)
- **Date:** 2026-09-23

## What the reference does
The reference inference package (the reference tree's `source/packages/chat-inference/`) is built as a chain of decorators: each stage subclasses a base middleware, which implements the executor interface (message-append, stream, and state accessors) by delegating to an inner executor and optionally transforming the call or the message list (`base.ts`). Stages composed around the base executor include:

- **Image resizing** — downscales user- and tool-result images before inference (bounded concurrency, oversized images dropped and replaced by a text placeholder).
- **Tracing** — records time-to-first-token, time-to-first-tool-call, end-to-end latency and input-size histograms, plus per-run outcome counters.
- **Continuation injector** — when the transcript's final message is an assistant message (i.e. the turn ended without a user reply), it appends a synthetic user turn whose content nudges the model to pick up where it stopped, so a run that halted mid-intent resumes instead of stalling.
- **Trailing empty assistant removal** — strips a trailing assistant message that carries no content before sending.
- **Effort-level stage** — nominally adjusts reasoning-effort plumbing; in the captured tree the file is reduced to a logger stub.

A separate labeling module (the reference tree's `source/host/extensions/inference/sand-labeling.ts`) wraps the same extension point to attach followup/post-turn labels to runs, confirming the extension point is the package's general place to hook in.

## What the current build does
The build has no middleware layer and no executor to decorate: the dsh host owns the provider loop and the provider message array end to end, so there is no extension point in the inference package to wrap (only an unrelated comment in `src/core/tools.ts` even uses the word "middleware"). All prompt shaping happens at spawn boundaries in `src/adapter/cordis-dsh-host.ts` (spawn composition roughly lines 628-673):

- a host-rendered `persona` system section containing the worker contract, re-resolved each spawn/turn so it cannot be compacted away;
- the task delivered as the child's first user turn (`prompt`);
- a deny-list `toolFilter` resolved against live global tool names and omitted when empty;
- wake/steer text composition delivered after spawn.

Mid-run influence exists only as explicit delivery: `sendMessage` at step boundaries (`cordis-dsh-host.ts:704-714`, used by the access relay) and `agent.followup` with a structured wake message (`cordis-dsh-host.ts:744`, `src/adapter/parent-agent.ts:63-76`, `src/core/wake-copy.ts`).

## The deviation
The reference solves cross-cutting inference concerns by decorating the executor; the build has no such extension point because the host owns media handling (image resizing is moot), telemetry (tracing is moot — the host already instruments runs), and conversation assembly (trailing-message cleanup and effort plumbing are host-side or stubbed). What has no build counterpart is the continuation-injector's semantics: the build can *steer* or *wake* a worker when the dispatcher or user chooses to, but nothing detects "the last turn ended on the assistant's own output" and automatically injects a resume nudge into the provider message array.

## Verdict: DO-NOT-INCORPORATE
The chain as an architecture is not incorporable and not wanted: the PRD's non-goals forbid rebuilding the dsh inference runtime, and four of five stages are moot because the host already owns media, telemetry, and message-array assembly (per `docs/adr/README.md` and the PRD authority level). The only live semantic — auto-resume when a turn ends on an assistant message — has a partial analog in the build's `sendMessage`/`agent.followup` wake path, and any future desire for interrupted-turn auto-continuation should be raised with the human and implemented as dispatcher-level wake policy, not as a way to inject messages into the provider message array. Record it, do not build it.

## Incorporation notes
- **Where it would live:** nowhere today; if continuation semantics are ever ruled in, the natural home is the dispatcher's worker lifecycle (near the wake/steer delivery in `src/adapter/cordis-dsh-host.ts` / `src/adapter/parent-agent.ts`), reusing `agent.followup` — never a new inference wrapper.
- **Constraints:** the build never constructs the provider message array, so any per-turn message transformation is out of reach by design; host-rendered `persona` and task-as-first-user-turn are settled (ticket-55 contract placement); ADR-0003 defers multi-level nesting, which constrains any auto-continue loop's stop conditions.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S if left as a decision record; M if continuation-via-wake were ever approved (liveness/loop risk — an auto-resume nudge can spin a worker that keeps ending on assistant turns).
- **Key reference anchors:** the reference tree's `source/packages/chat-inference/base.ts` (the base middleware decorator), the reference tree's `source/packages/chat-inference/middleware/continuation-injector-middleware.ts`, `.../image-resizing-middleware.ts`, `.../tracing-middleware.ts`, `.../trailing-empty-assistant-removal-middleware.ts`, `.../effort-level-middleware.ts`, `.../noop-middleware.ts`, the reference tree's `source/host/extensions/inference/sand-labeling.ts`.

## Evidence
- Reference: `source/packages/chat-inference/base.ts`, `source/packages/chat-inference/middleware/` (five stage files verified present), `source/packages/chat-inference/index.ts`, `source/host/extensions/inference/sand-labeling.ts` (paths under `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`)
- Build: `src/adapter/cordis-dsh-host.ts` (spawn boundary ~628-673; `sendMessage` :704-714; `agent.followup` :744), `src/adapter/parent-agent.ts:63-76`, `src/core/wake-copy.ts`, `src/core/tools.ts:727` (only "middleware" mention; no decorator layer exists)
