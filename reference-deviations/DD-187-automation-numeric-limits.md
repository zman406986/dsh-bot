# DD-187 — Automation numeric limits and clamps
- **Area:** A22 automation
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference's routines/automations subsystem carries a small block of numeric limits and clamps that bound the capability at every layer — the domain module, the durable store, the agent-facing session tools, and the wake path. The six values are declared together in the subsystem's domain module (`the reference tree's source/host/automations/automation.ts:8-13`). Described by role:

- **A name-length cap of 80 characters**, applied on the way in by a clamp helper that trims a routine's name to that length (`the reference tree's source/host/automations/automation.ts:91`).
- **A per-agent routine ceiling of 50** — the store's create-or-replace path refuses a new routine once the agent already holds that many (`the reference tree's source/host/automations/automation-store.ts:70`).
- **A listing cap of 100** — the per-agent listing accessors truncate the returned collection to that bound (`the reference tree's source/host/extensions/session/agent-session.ts:212-216`), the runtime's automation list responses apply the same truncation (`the reference tree's source/host/extensions/transcript/automation-runtime.ts:337`, `:353`, `:373`, `:395`, `:414`, `:436`), and the status reminder's definitions slice reuses it (`the reference tree's source/host/automations/automation-status-reminder.ts:35`).
- **A retained run-history depth of 20** — the store keeps at most that many run records per routine, enforced both when a new run is appended and when the history is read back (`the reference tree's source/host/automations/automation-store.ts:58`, `:76`).
- **A run-detail length cap of 300 characters**, applied by a clamp helper to the stored event/detail summary (`the reference tree's source/host/automations/automation-store.ts:48`).
- **A wake-event ceiling of 25** — a wake carries at most that many events, clamped by the wake-event helper (`the reference tree's source/host/automations/automation.ts:97`) and again by the coalesced-run-id clamp (`the reference tree's source/host/automations/automation-store.ts:49`).

The caps are of two kinds, and the distinction is worth noting: the free-text limits (name, detail) **truncate**, while the collection limits (per-agent count, listing, history depth, wake events) **cap** — the per-agent ceiling is the only one that refuses rather than trims, and it refuses at the write path.

## What the current build does
**Absent, and trivially so.** The build has no routines subsystem at all (DD-183), so none of these limits has a subject: no routine name to shorten, no per-agent routine collection to cap, no routine list to truncate for a view, no run history to keep, no run detail to shorten, and no routine wake to bound. The build's tree carries no routine, automation, schedule, or trigger vocabulary for them to attach to.

The build does carry numeric limits of its own, in unrelated places, and they show the same instinct to bound collections and text lengths that the build actually has:

- a peer message text ceiling of 8000 characters, enforced by **refusing** an over-long send and naming the bound rather than truncating it (`src/core/tools.ts:237`, enforcement at `:671-677`);
- a delivery-retry limit of two retries beyond the settle wake's own opportunity — three attempts in total — enforced in the todo reconciler and wired into the dispatcher as an option (`src/core/todo-reconciler.ts:51`, `:207`; `src/core/multitask.ts:465`, documented at `:110` and `:201`);
- a peer inbox depth cap of 64 (`src/core/peer-inbox.ts:19`), and a summary row bound of 20 on clamped tool-result reports (`src/core/report-clamp.ts:35`).

The last of those is the closest match to the reference's retained-history depth — the same "keep at most this many rows" pattern, independently chosen, for a different target.

## The deviation
The reference bounds its automation subsystem with a fixed numeric envelope at every layer: a name clamp, a per-agent ceiling, a listing cap, a history depth, a detail clamp, and a wake-event ceiling. The build ships none of them, because it ships no subsystem for them to bound.

The deviation is therefore **not a missing guard on an existing capability**. There is nothing in the build that these limits could protect, no unbounded collection they would bring under control, and no behavior that changes if they were adopted in isolation. It is a property of a capability the build does not have, and it falls with that capability rather than standing as a separate decision.

The only transferable content is the pattern — cap the collection, cap the history, shorten the free text — and the build already applies that pattern independently to its own collections and text, at its own targets and with its own values, as the peer text ceiling, the retry limit, the inbox cap, and the summary row bound above show. Nothing in the reference's specific numbers is a design conclusion the build is missing, and none of the six values is independently actionable.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's exception **C14** — part of the accepted, human-ruled master ADR at position 2 in the authority stack — rules out the routines/automations subsystem outright (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md:29`), and these limits are that subsystem's internal bookkeeping, so they fall with it exactly as its client panel does (DD-183; DD-186). The limits are not independently actionable: each one names a subject the build does not have, so there is no guard to add, no bug to fix, and no behavior that changes while C14 stands. The instinct to bound things is already present in the build's own collections and text fields, so nothing of design value is lost by declining them. This is a ruled exclusion, not an unruled gap — no new judgment is owed, and nothing in the recorded rulings reverses C14.

## Incorporation notes
- **Where it would live:** Nowhere under C14. If C14 were ever reversed, these bounds belong inside the subsystem's own domain module and store, declared together as a named constant block the way the reference declares them (`the reference tree's source/host/automations/automation.ts:8-13`), rather than scattered at the call sites that enforce them — the natural-home note DD-183 records for the subsystem as a whole.
- **Constraints:** C14 forbids the subsystem, so any work here needs a dated human reversal of C14 first, not an agent ruling. A reversal would also inherit the subsystem's own blockers: no clock, no firing loop, no durable per-agent store (DD-177), and no run records for a history depth to bound. Independently, if the build ever needs a bound on a collection it does have, the peer text ceiling records the house style as refuse-and-name-the-limit rather than silently truncate — worth matching deliberately rather than by accident.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — nothing is owed while C14 stands; the risk is mis-filing a subsystem's internal constants as an independent product decision, which would inflate the deviation inventory without changing any behavior.
- **Key reference anchors:**
  - `the reference tree's source/host/automations/automation.ts:8-13` — the six limits declared together: name length 80, per-agent 50, listing 100, run history 20, run detail 300, wake events 25.
  - `the reference tree's source/host/automations/automation.ts:91` — the name clamp helper.
  - `the reference tree's source/host/automations/automation.ts:97` — the wake-event clamp helper.
  - `the reference tree's source/host/automations/automation-store.ts:48` — the run-detail clamp helper.
  - `the reference tree's source/host/automations/automation-store.ts:49` — the coalesced-run-id clamp, bounded by the wake-event ceiling.
  - `the reference tree's source/host/automations/automation-store.ts:58`, `:76` — run history truncated to the retained depth on read and on append.
  - `the reference tree's source/host/automations/automation-store.ts:70` — the create-or-replace path refusing a new routine at the per-agent ceiling.
  - `the reference tree's source/host/extensions/session/agent-session.ts:212-216` — per-agent listing accessors truncated to the listing cap.
  - `the reference tree's source/host/extensions/transcript/automation-runtime.ts:337`, `:353`, `:373`, `:395`, `:414`, `:436` — runtime automation list responses truncated to the same cap.
  - `the reference tree's source/host/automations/automation-status-reminder.ts:35` — the reminder's definitions slice bounded by the same listing cap.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/automations/automation.ts:8-13`, `:91`, `:97` (the limits declared together; name and wake-event clamps); `.../source/host/automations/automation-store.ts:48`, `:49`, `:58`, `:70`, `:76` (run-detail and coalesced-id clamps, history depth on read and append, per-agent ceiling at the write path); `.../source/host/automations/automation-status-reminder.ts:35`; `.../source/host/extensions/session/agent-session.ts:212-216`; `.../source/host/extensions/transcript/automation-runtime.ts:337`, `:353`, `:373`, `:395`, `:414`, `:436`.
- Build: `src/core/tools.ts:237`, `:671-677` (peer text ceiling — refuse, name the bound, truncate nothing); `src/core/todo-reconciler.ts:51`, `:207` (delivery-retry limit); `src/core/multitask.ts:465` (bound wired in as an option), `:110`, `:201` (documented default); `src/core/peer-inbox.ts:19` (inbox depth cap); `src/core/report-clamp.ts:35` (summary row bound). Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md:29` (C14 — no org chart, no routines/automations subsystem, no per-agent memory, no group rooms). Related deviations: `reference-deviations/DD-183-routines-subsystem-absent.md` (the subsystem these limits bound — cross-referenced, not duplicated); `reference-deviations/DD-186-routines-ui-panel.md` (the client-side panel affected by the listing cap).
