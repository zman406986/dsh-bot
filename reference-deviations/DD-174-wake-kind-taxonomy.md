# DD-174 — Wake taxonomy: six durable wake kinds vs the build's single wake family
- **Area:** A20 session & durability
- **Type:** deliberate-divergence
- **Date:** 2026-09-23

## What the reference does
The reference's transcript extension carries a background-wakes module and a small family of wake-support modules that together recognise **six distinct wake kinds** — six separate kinds, not one wake path. The kinds are not merely labels on an in-process notification: pending wakes are **durable**, written to a pending-wake store with a settled/cleared lifecycle, and scheduled again at the next opportunity after a restart. Durability is bounded by a recorded retention horizon of **48 hours**: a pending wake older than that is treated as stale and is not scheduled again.

Concretely, the modules split the work: the store module owns the list of accepted wake kinds and the durable marker record, the rescheduling module owns the staleness horizon and the settled-wake clearing path, and the background-wakes module owns the live wake paths for inbound message traffic and for externally-originated events. A further module owns completion revivals, which is where a command-driven wake kind appears. The durable pending-wake subset enumerates three roles — cloud-hosted background agent work, nested delegated sub-agent work, and shell command work — and the remaining kinds cover message, event and revival-shaped wakes. A wake in the reference can therefore originate from work that this build has no concept of at all.

## What the current build does
The build has **one kind of wake**. Wakes flow through one wake-bus module under `src/core/` (`src/core/wake-bus.ts`), which defines a flat list of sources rather than a set of wake kinds: the sources that actually produce wakes at this stage are the user, a settled worker, a worker access request, and a peer; a redelivery-timer source exists and is used only for redelivery (see DD-172); and one further source for externally-originated events is declared and accepted by the bus but is **currently unused** anywhere in `src/` or `client/`. The bus's own doc comment states that the not-yet-producing sources are accepted so later tickets can add them without changing the list.

The build covers only one kind of wake: the dispatched-worker wake. `src/core/multitask.ts` owns the wake bus, enqueues settles through it, and takes the ready wake per session to update the ledger. There is no durable pending-wake store, no set of wake kinds, and no staleness horizon — persistence of worker records follows ADR-0006's rule that only what is needed to rebuild is stored instead.

## The deviation
The reference models wakes as six durable kinds with a 48-hour retention horizon and a path that schedules them again across restarts; the build models wakes as a single kind carried by one bus, with a flat list of sources rather than separate kinds, and with no durable pending-wake store or retention horizon at all. The build's timer source is a redelivery mechanism, not a wake kind in the reference's sense, and the unused external-event source is a declared-but-unpopulated extension point rather than a second kind.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 exception C15 is decisive and covers this case explicitly: it rules a **single wake kind**, with only dispatched workers flowing through the wake bus, the ledger, and the running-tasks surface, and it names background one-shot commands and remote/cloud jobs as wake kinds the build does not adopt. The reference's six kinds are exactly the surface C15 forecloses, so the six kinds are not a gap but a ruled-out design. This is a ruled divergence, not an oversight — C15 sits in ADR-0018's exhaustive exception list (which states that anything not on the list is imitated), so the six kinds are on the deliberate-divergence side of the line by recorded decision. C19 is the adjacent durability ruling: the build persists *more* than the reference (durable minimum-to-reconstruct worker records per ADR-0006, against the reference's start-marker-only ledger), which means the durability half of this deviation is also already ruled and in the build's favour rather than the reference's.

## Incorporation notes
- **Where it would live:** `src/core/wake-bus.ts` (the flat source list would become a set of wake kinds) and `src/core/multitask.ts` (the enqueue/drain path), plus a new durable pending-wake store that does not exist today.
- **Constraints:** ADR-0018 C15 forbids the six wake kinds outright; adopting them would require a human reversal of C15 rather than an implementation ticket. The unused externally-originated-event source in `src/core/wake-bus.ts` is the one dormant extension point worth recording — it is declared and accepted but never used to produce a wake, so a future ticket could populate it without changing the bus's list. Any durability work here must stay consistent with ADR-0006 and C19 rather than importing the reference's pending-wake store shape.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — six durable wake kinds with a rescheduling path is a new subsystem, and it is blocked at the ruling level by C15 rather than at the engineering level.
- **Key reference anchors:**
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/background-wakes.ts` — 487 lines; live wake paths for inbound message traffic (~L175, ~L288) and for externally-originated events (~L373, ~L405)
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/async-task-union.ts:2` — durable pending-wake kind union
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/sand-pending-wake-store.ts:11` — the accepted-kind list; :15 durable pending-wake marker record; :40–46 kind validation on read; :90, :127, :132 store operations keyed by agent, kind and work id
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/pending-wake-rearm.ts:6` — the 48-hour staleness horizon; :7 the local kind union; :56–88 settled-pending-wake clearing and roster emission
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/completion-revivals.ts:253` — a command-driven wake kind on the revival path

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/background-wakes.ts`; `.../transcript/async-task-union.ts`; `.../transcript/sand-pending-wake-store.ts`; `.../transcript/pending-wake-rearm.ts`; `.../transcript/completion-revivals.ts`
- Build: `src/core/wake-bus.ts` (source list at L14–30; unused externally-originated-event source at L20, L29); `src/core/multitask.ts` (wake bus import L28, drain/enqueue path L320–509); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` L30 (C15), L31 (C19), L21 (exhaustive-list statement); ADR-0006 for the minimum-to-reconstruct persistence rule cited by C19; DD-172 for the redelivery-timer usage
