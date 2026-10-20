# DD-123 — Router-owned routed-transcript store vs transcriptRef pointers
- **Area:** inference routing & streaming (A15)
- **Type:** deliberate-divergence (ruled)
- **Date:** 2026-09-23

## What the reference does
Because the reference's router executes dispatched turns itself rather than letting a native session run them (see DD-122), those routed turns would otherwise leave no durable trace — so the router keeps its own per-agent transcript store. The reference tree's `source/node-agent-coordinator/inference-router.ts` appends every routed user and assistant entry to a JSON file under the coordinator's data directory, keyed by agent id. The store is a versioned document (version 2, with a per-agent entry map) parsed validation-first: anything that fails the shape check degrades to an empty store rather than throwing. Writes are whole-document: a temp file written with a restrictive mode, then renamed over the target. Each agent's array is trimmed to the most recent 200 entries on every append, and per-agent serialized promise queues order turns so one agent's appends and reads cannot interleave.

## What the current build does
The build has no transcript store and is forbidden one. `src/core/durability.ts` states the constraint in its own comments: durable markers are "never a second transcript DB" and "Core must not invent its own transcript database" — they carry only the minimum a post-restart roster rebuild needs, per ADR-0006. What persists is a pointer, not content: `WorkerRecord.transcriptRef` and the durable marker hold a reference (falling back to the worker/child-session id) that lets the dispatcher point the user at where the report lives, while the settle report itself stays in the host transcript (`src/core/types.ts` `WorkerRecord`/`SettledEvent`; settle flow threading `transcriptRef` through `src/core/multitask.ts`). ADR-0012's restart model rebuilds roster state from these pointers and replays nothing of the work.

## The deviation
The reference solves a real problem its architecture creates: routed turns bypass the native session, so the router must persist their content or it is lost. The build has no such gap — every worker turn runs inside a host-owned child session whose transcript the host already persists durably, so a second store would duplicate history the host owns. The only functional echo in the build is the durable marker's redrive bookkeeping: `transcriptRef` (with worker-id fallback) so a restart can still find the transcript — pointers instead of the store's capped content arrays.

## Verdict: DO-NOT-INCORPORATE
ADR-0006, as implemented in `src/core/durability.ts`, fixes the durability contract at "minimum-to-reconstruct" markers and explicitly forbids a second transcript database; the host owns durable transcript history by the PRD's division of labor, and ADR-0012's rebuild-from-persisted-state-only model is built on that. The reference's store exists only to compensate for turns its router runs outside any host transcript — a compensation the build must never need, since no build path bypasses the host loop (DD-122). Incorporating it would reverse settled ADRs and duplicate the host's own persistence, so the divergence is deliberate and stands.

## Incorporation notes
- **Where it would live:** nowhere in the build. Hypothetically per-agent history would belong behind the `DurabilityPort` in `src/core/durability.ts`, which is exactly the surface the ADR-0006 contract rules out extending with content.
- **Constraints:** durable markers carry pointers only (`transcriptRef: string | null`, worker-id fallback); settle reports stay in the host transcript; rebuild reads persisted state, never work content (ADR-0006/ADR-0012); any change needs a new human-ruled ADR.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S if ever wanted (the pattern is small), but the risk is architectural, not effort: it would put a second copy of durable history inside the plugin and break the boundary that the host owns transcripts.
- **Key reference anchors:**
  - the reference tree's `source/node-agent-coordinator/inference-router.ts` — store type and its schema-version constant (line 20); validation-first parse degrading to an empty store (line 30); 200-entry per-agent cap (lines 41, 75); store path under the data directory (line 59); temp-write with restrictive mode plus rename (lines 70-71); per-agent promise queues for turn ordering (lines 215-227).
  - the reference tree's `tests/inference-router-transcript.test.mjs` — reference-side behavior spec for the store.

## Evidence
- Reference: the reference tree's `source/node-agent-coordinator/inference-router.ts`; the reference tree's `tests/inference-router-transcript.test.mjs`
- Build: `src/core/durability.ts` (lines 4-7, 34: never a second transcript DB; `transcriptRef` fields); `src/core/types.ts` (`WorkerRecord.transcriptRef`, `SettledEvent.transcriptRef`); `src/core/multitask.ts` (settle path threading `transcriptRef`, worker-id fallback at restore)
