# DD-167 — Per-agent durable session store vs the build's in-memory agent map
- **Area:** A20 session & durability
- **Type:** deliberate-divergence
- **Date:** 2026-09-23

## What the reference does
Every agent owns a durable session backed by its own SQLite database. The session layer
(`the reference tree's source/host/extensions/session/agent-session.ts`) is structured around a per-agent database
handle: a session-open helper constructs a database object bound to that agent's own file path
and returns it as an opened session record (`agent-session.ts:26-30`, `:112`). Sessions are not
held resident in a long-lived registry; helper paths run a unit of work against an agent and then
close the handle (`agent-session.ts:100`, the unit-of-work helper), and the database itself is
opened lazily. A dedicated agent-database module (`the reference tree's source/host/extensions/session/agent-db.ts`)
and its schema/serde/recovery companions (`agent-db-schema.ts`, `agent-db-serde.ts`,
`agent-db-recovery.ts`, `agent-db-transcript-pages.ts`) own the on-disk format, and
`the reference tree's source/host/storage/store-db.ts` plus `sqlite-recovery.ts` / `sqlite-busy.ts` sit underneath.

Resolution is lazy and failure is typed. The store's open path checks existence on disk first and,
when the agent's database is absent, raises a typed missing-agent error rather than returning an
empty session (`agent-session.ts:112`; the existence predicate at `:94`). Session lifecycle
positions — materialize, open, delete — are the store's own methods and delegate through a
materialization port when one is supplied (`agent-session.ts:36-43`, `:109-113`). Recovery from a
missing or corrupt database is a named, separate concern (`agent-db-recovery.ts`,
`session-mutations.ts`'s missing-db recovery), so durability is a first-class part of the session
abstraction rather than a bolt-on.

## What the current build does
The build keeps live dispatcher agents in an ordinary in-memory map. `src/adapter/parent-agent.ts`
declares `const sessions = new Map<string, AgentLike>();` (`:213`, documented at `:208-212` as the
insertion-ordered sessionId-to-live-agent registry), alongside a second map of activation
generations (`:221`). Membership in that map *is* liveness, and deactivation deletes the entry
(`:226-231`). Nothing about the map is persisted; when the process ends, it is gone.

There is no SQLite, no per-agent database file, and no session-store class. Durability is instead
carried by a separate, deliberately minimal layer: `src/core/durability.ts` defines a durable
marker record (`DurableWorkerMarker`, `:9-28`) and a `DurabilityPort` (`:36-45`) whose doc comment
states the marker is "never a second transcript DB" (`:6`) and that core "must not invent its own
transcript database" (`:34`). The host-backed implementation writes through dsh's own session/job
storage (`ctx.storageDomain`), and the adapter's `src/adapter/durable-marker.ts` supplies that
binding. After a restart, `src/core/multitask.ts` rebuilds the roster from those markers
(`rebuildFromDurability`, `:866`) rather than reopening a persisted session: terminal rows are
restored and a worker that was live at crash time becomes an explicit `unknownState` entry
(`:852-860`), with the comment explicitly recording that neither implementation resumes or replays
a worker and that the non-use of continuable-session cold-resume "is a core design decision, not an
oversight" (`:862-864`).

## The deviation
The reference treats the durable session as the unit of agent identity: an agent exists because its
database exists, and everything about reopening, resolving, or discovering an agent flows through
that store. The build inverts the ordering — the live agent is an in-memory registry entry, and
durability is a narrow record of outstanding work beside it that records only what a post-restart roster
rebuild reads (worker id, transcript pointer, todo link, status, delivery-redrive budget).

So the two differ in three linked ways: (1) storage medium — per-agent SQLite files compared to
in-memory maps plus markers in dsh's existing session/job store; (2) residency — reference sessions
open-and-close per unit of work while the build's map entries live for the activation's duration;
and (3) the meaning of a missing agent — the reference has a typed missing-session failure at
resolve time, whereas the build's absence-of-map-entry is simply a session that never activated or
has been deactivated, with restart-continuity handled by the roster rebuild instead.

This is a **recorded, deliberate architectural divergence with an explicit exception**, not a gap.
The build is not failing to imitate a durable per-agent store; it is substituting its own
durability mechanism by decision.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 exception **A5** is decisive and explicit: "Persistence stays in dsh's session/job store;
no second database" (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:25`). A5 is an
accepted, human-ruled exception, so the per-agent database is excluded from imitation by name and
the question is already ruled. ADR-0006 names the storage architecture the build does use — a
durable minimum-to-reconstruct worker record written through dsh's session/job store "rather than a
new store", and it says in terms that this "is a deliberate divergence from the reference, not an
imitation"
(`docs/adr/0006-worker-record-durability-split.md:5`, `:28`). ADR-0012 governs what survives a
restart: durability is replayed, work never is
(`docs/adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md`). No part of this
deviation is unruled, so there is nothing here for the human to decide — adopting the reference's
store would require reversing A5 first, which is a separate decision and not a fidelity fix.

## Incorporation notes
- **Where it would live:** If A5 were ever reversed, the change would centre on
  `src/core/durability.ts` (replacing `DurabilityPort` with a real session store) and
  `src/adapter/parent-agent.ts` (whose `sessions` map at `:213` would become a store-backed
  lookup). It would also reshape `src/core/multitask.ts`'s `rebuildFromDurability` (`:866`) and
  `src/adapter/durable-marker.ts`. None of this should be started under the current rulings.
- **Constraints:** ADR-0018 A5 forbids a second database outright. ADR-0006 requires the durable
  marker to ride dsh's session/job store (`ctx.sessions` / `ctx.storage`) and forbids inventing a
  second transcript DB; ADR-0012 forbids replaying work on restart. Any proposal to persist live
  agent sessions must clear those three before touching code.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L + high — this is not a bounded feature but a reversal of two accepted ADRs, and
  it would replace the mechanism that currently satisfies ADR-0012's restart contract; the risk is
  to the accuracy of the post-restart roster rather than to any single call site.
- **Key reference anchors:** `the reference tree's source/host/extensions/session/agent-session.ts` (session-open and
  existence check `:94`, `:112`; store options and lifecycle ports `:26-43`, `:109-113`; open/close
  helper `:100`); the agent-database module family `the reference tree's source/host/extensions/session/agent-db.ts`,
  `agent-db-schema.ts`, `agent-db-serde.ts`, `agent-db-recovery.ts`;
  `the reference tree's source/host/storage/store-db.ts`; `the reference tree's source/host/extensions/session/session-store-factories.ts`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/session/agent-session.ts` (per-agent DB open/close; typed missing-agent failure), `.../session/agent-db.ts` and its schema/serde/recovery companions, `.../session/session-store-factories.ts`, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/storage/store-db.ts`
- Build: `src/adapter/parent-agent.ts` (in-memory `sessions` map at `:213`), `src/core/durability.ts` (`DurableWorkerMarker` `:9-28`, `DurabilityPort` `:36-45`, no-second-DB note `:6`, `:34`), `src/adapter/durable-marker.ts`, `src/core/multitask.ts` (`rebuildFromDurability` `:866`, never-replay stance `:852-864`), `docs/adr/0006-worker-record-durability-split.md`, `docs/adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md`, `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:25`
