# DD-170 — Conversation size limits and garbage collection
- **Area:** A20 session & durability
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference treats a conversation as bounded stored state with two byte-level ceilings. A
dedicated session-extension module (`the reference tree's source/host/extensions/session/conversation-size-limits.ts`)
defines a soft limit and a hard limit on a conversation's stored bytes, defaulting to 256 MB and
1 GB respectively, and lets both be overridden by an environment value or by a configured
megabyte field (`conversation-size-limits.ts:6-7`, `:24-25`, with the resolution order env →
configured → default and a minimum allowed value for positive inputs). Size is measured not as the file's logical
length alone but as the main database plus its write-ahead sidecar, so bytes staged but not yet
checkpointed still count (`:38`).

Two triggers act on those limits. A soft maintenance path is scheduled with a minimum interval
between runs and an in-flight guard, so repeated turns over a large conversation do not start
several collection passes at once (`:44-47`, with the interval and pending-write retention constants at `:8-9`). A
hard, turn-synchronous path runs before a turn: below the hard limit it either returns or defers
to the soft scheduler, and at or above the hard limit it runs a collection pass, re-measures, and
if the conversation is still over the cap raises a typed error carrying both the measured size and
the limit (`:48-51`; the error class at `:37`). Both paths are gated by an enable flag that may
come from the environment or from pinned state (`:26`, `:28`).

The collection itself is delegated to a worker-pool capability that takes the agent's identifier,
the blob database path, the retained root identifier, a retention window for in-flight writes, and
a legacy path, and returns a verdict distinguishing a collection that happened, one that was
skipped, and one that failed, with row and byte counts and whether vacuum ran (`:12`, `:15`, `:41`). Every verdict — including failures — is
reported through a diagnostics channel with a trigger label and agent id (`:30-36`, `:46`, `:50`).
Garbage is defined relative to a current root: with no root recorded, collection is a no-op rather
than a delete-everything (`:41`).

## What the current build does
The build does not have this feature. There is no conversation-size limit, no soft or hard byte
ceiling, no collection pass over stored conversation data, and no typed too-large error. A search
across `src/` and `client/` for conversation-size, garbage-collection, and too-large vocabulary
returns nothing; the only size bounds in the core are the report clamps and the structural limits
on delivery attempts.

What the build does have is a different kind of size bound. `src/core/report-clamp.ts` caps the
size of the strings the dispatcher sees at several defined thresholds — a completed report body,
an error body, a check-row activity line, and a roster snapshot's recent-result excerpt — with a
truncation marker and a transcript pointer appended on a hard cut (`src/core/report-clamp.ts:17`,
`:20`, `:23`, `:32`, `:48-54`, `:60-74`). The header records this as a deliberate protective
addition rather than an imitation, and notes that the reference has no equivalent bound at that
point (`report-clamp.ts:7-16`, cross-referenced as ADR-0018 D21).

The durability layer is bounded by structure rather than by a size ceiling: it persists a
minimum-to-reconstruct marker per worker — identifiers, status, a transcript pointer, a todo id,
a redrive count, and timestamps — and explicitly refuses to carry the report itself, which stays
in the host's transcript (`src/core/durability.ts:9-28`, `:30-45`). Markers are deleted once their
obligation closes (`:43-44`), and the whole structure is a single record per worker, so there is no
growing per-conversation blob stored by the build. The dispatcher's own state bounds
are of the same kind: a cap on delivery redrives, not on bytes (`src/core/multitask.ts:41`, `:110`,
`:201`).

## The deviation
The reference's limits are a maintenance layer over a storage shape the build does not have. Its
conversation is a durable per-agent database that grows without bound between the two ceilings;
the size limits exist to keep that file, and its collection pass exists to reclaim dead rows inside
it. The build's conversations are not its own — they live in the host, and the build's persistence
is a bounded marker snapshot that carries no transcript body at all. So the missing limit is a
consequence of where the conversation lives, not an independent oversight: there is no build-side
conversation file to measure, and no build-side garbage to collect against a retained root.

The nuance that keeps this from being a trivial "not applicable": the build does bound sizes, just
at a different point. The report clamps keep dispatcher-bound strings small, and the marker design
keeps the durable surface small, so both growth paths the build controls are already bounded by
construction. What the build does not have — and what the reference's feature addresses — is a
bound on the conversation transcript itself, which belongs to the host under the current ownership split.

## Verdict: DO-NOT-INCORPORATE
The limits are a property of the reference's storage design, and ADR-0018's A5 exception
(accepted ADR, rank 2 of the authority stack) keeps persistence in dsh's session/job store with no
second database — so the file these limits police does not exist on the build's side. No recorded
ruling names conversation size limits; the nearest recorded decision is A5's persistence rule and
the D21 clamp exception, neither of which is a ruling on this feature, so the settlement here is by
derivation from A5 rather than by a direct ruling. The build's own size bounds (report clamps at
`src/core/report-clamp.ts`, bounded markers at `src/core/durability.ts`) already cover the growth
paths the build controls, and the transcript-size path is host-owned territory. If the host ever
exposes a conversation-size signal to the plugin, or if the build ever gains a second store, this
should be re-opened as an ASK-HUMAN to the effect of A5's scope.

## Incorporation notes
- **Where it would live:** nowhere in the current shape. A faithful port would require a build-side
  conversation store to measure and collect against, which A5 forbids; the only plausible
  build-side site today is the durability snapshot in `src/core/durability.ts` if a future design
  ever lets it grow past one bounded marker per worker.
- **Constraints:** ADR-0018 A5 (persistence stays in the host's session/job store; no second
  database) is the controlling constraint and outranks any imitation pressure from the reference's
  parity goal. ADR-0018 D21 / U-F record that the build's chosen posture is inline clamping, not
  storage-side spilling with prompt-side references — a size ceiling with a collection pass is the
  storage-side pattern U-F declined. Any future bound on the build's own durable state must be
  re-derived for the host-backed `DurabilityPort` (`src/core/durability.ts:36-45`), not modeled on
  the reference's database-plus-sidecar byte measurement.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference
  tree.
- **Effort/risk:** S for the ruling (it is a derivation from A5, not a build task); L and
  architecture-changing if ever reversed, since it would first require overturning A5 or adding a
  host-side size signal the plugin can read.
- **Key reference anchors:** `the reference tree's source/host/extensions/session/conversation-size-limits.ts:6-7`
  (soft/hard defaults), `:24-25` (override resolution), `:38` (database + write-ahead measurement),
  `:44-47` (soft scheduler with interval and in-flight guard), `:48-51` (the per-turn path and typed
  too-large raise), `:37` (the error class), `:12`, `:15`, `:41` (delegated collection capability
  and verdict shape), `:30-36` (diagnostic reporting).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/session/conversation-size-limits.ts`
  (read in full, 53 lines).
- Build: `src/core/report-clamp.ts` (clamp thresholds and truncation behavior, especially `:17`,
  `:20`, `:23`, `:32`, `:60-74`); `src/core/durability.ts` (bounded marker design, `:9-45`);
  `src/core/multitask.ts` (delivery-redrive bound only, `:41`, `:110`, `:201`). Absence of any
  conversation-size, GC, or too-large vocabulary confirmed by a search over `src/` and `client/`.
- Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` item 3 (A5, persistence
  stays in the host store, no second database) and item 10 (D21, wake report body clamped) plus
  item 17 (U-F, inline clamping rather than storage spill); no recorded ruling names conversation
  size limits.
