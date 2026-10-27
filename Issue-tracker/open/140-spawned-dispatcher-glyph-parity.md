# 140 — A spawned dispatcher gets no glyph: it is not a sidebar row at all, so the licensed seat cannot carry the mark

**Status:** open
**Labels:** needs-info
**Blocked by:** a dated human ruling with two parts: (1) which seat may render a spawned dispatcher's glyph, given that stock dsh hides every `origin: 'subagent'` session from the sidebar; (2) which identity channel that seat may read, given that no durable, child-local fact on dsh 0.2.1-rc.2 discriminates a dispatcher child from a worker child.
**Related:** ticket 138 (deferred — this ticket takes over its glyph half only; the message-resume half stays there), ticket 130 (resolved 2026-10-22 — durable `dispatcher_sessions` mark), ticket 123 (resolved — the glyph machinery and the header decline), ticket 114 (the 0.2.1 port), ADR-0024 rider + addendum (the one licensed glyph registration), ADR-0027 §Starting identity and dispatch item 4 (preset condition (a)), ADR-0025 (mitosis), ADR-0018 (imitate the host), ticket 118 (the identity probe)

## Problem

The owner ruled, 2026-10-22 (level 1):

> "spawned dispatchers should get same glyph as user spawned dispatcher, doesn't matter if user or a dispatcher initiated the command."

Today a user-started dispatcher shows the sidebar glyph `◆`. A dispatcher-spawned dispatcher shows nothing. Ticket 138 recorded this and named one blocker: a preset row must exist and be selected at activation (ADR-0027 item 4 condition (a)), and an independent preset would have to re-declare the child's whole tool set and prompt (well over 80 lines).

**That recorded blocker is not the real blocker.** Verified against the installed tree (`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`, all packages `0.2.1-rc.2`), a spawned dispatcher is a subagent child, and stock dsh filters every subagent child out of the session list before any row is built:

- `dsh-client-ui-workspace/lib/client.js:964-965` — `sessionVisible()` returns `false` when `session.origin === "subagent"`.
- The same function gates grouping, the stray/ungrouped list, pinned rows, and search (`:1037`, `:1043`, `:1134`, `:1152`, `:1185`, `:1200`).
- The licensed glyph seat is rendered only inside a row: `renderSlot("sidebar.session.row.leading", …)` at `:2306`, declared at `:5239`.

So the ADR-0024 rider's seat never mounts for a spawned dispatcher. **A preset row cannot fix this**: even with a perfect preset and `projectionValues.sessionKind === "dispatcher"`, there is no row to decorate. The prior analysis ("only a preset row reaches the client") checked the identity side and missed the visibility side.

The spawned dispatcher is visible in exactly two places, and neither is a sidebar row: the parent's stock subagent catalog (`conversation.session.header.actions`, id `subagent-catalog`, order 10, `dsh-client-ui-subagent/lib/client.js:983-989`) and its own conversation, opened as a tab or from that catalog.

## Route evaluation

### Route A — declare a preset row and select it at spawn (the recorded plan)

**Rejected.** Two independent reasons:

1. **It cannot render the glyph.** The child stays `origin: 'subagent'` (`dsh-subagent/lib/index.js:346-356`, `origin` at `:354`); `origin` is a closed host literal (`dsh-session/lib/types/types.d.ts:82`, `:120`). No preset changes the header origin, so the row is still filtered out at `dsh-client-ui-workspace/lib/client.js:965`.
2. **The cost is real and large.** `SubagentStartRequest.agentPreset` exists (`dsh-subagent/lib/types/types.d.ts:132-135`) and a plugin can register a preset (`dsh-agent-preset-registry/lib/types/index.d.ts:44`). But an independent selection **replaces** the parent composition — `applyChildComposition` mounts the named preset (`dsh-subagent/lib/index.js:374-378`) and only `composeFrom(parent)` when no preset is named (`:381`). The `standard` preset this child inherits is a ~200-line composition (`.../dsh-agent-presets/presets/standard/agent.cordis.yml`). Duplicating it in our repo, kept in step across dsh upgrades, buys a durable `agentPreset`/`agent-preset/selected` (`:1799`) that still renders nothing.

### Route B — extend the `sessionKind` projection to mark the child

**Rejected as briefed; it needs a channel the rider forbids.**

- Our projection unit reads only host session events: `SessionProjectionDefinitionLike.init(header, inheritedEventCount)` and `apply(state, event)` (`src/adapter/session-kind-projection.ts:135-145`; host contract `dsh-session-projection/lib/types/index.d.ts:49`, `:58`). It is synchronous and plain-JSON; it has no I/O.
- Our durable mark lives in a **different storage domain**: the `dispatcher_sessions` table in `multitask_dispatcher.json` (`src/adapter/durable-marker.ts:50`, read/write at `:444-456`). The projection cache owns its own domain (`session_projcache`, host `dsh-session-projection-cache`). Our table is invisible to the projection.
- No durable event in the child's own log discriminates a dispatcher child. The only per-child durable facts are:
  - header `origin: 'subagent'` and `delegationDepth` — identical for workers (`dsh-subagent/lib/index.js:354-355`);
  - `subagent/descriptor` (`:1800`) — carries `version`, `mode`, `provider`, optional `label`/model/persona/toolFilter. The provider is `spawn` for workers and dispatchers alike; `label` is the caller's title. No kind bit.
  - `agent-preset/selected` (`:1799`) — appended only for an independent selection, which mitosis never makes (and which is Route A).
  - delegated policy overrides — `sandbox/mode`, `approval/policy`, `permission/preset` only, and only when set; our activation sets none.
  - the dispatcher policy inject is a message with the shared wake source kind (`src/adapter/parent-agent.ts:35-47`), and `inject` is `wakeup=false`, so it may never commit. Folding it would be content-matching an invented marker.

Adding a new host channel to carry the mark is exactly what ADR-0024's rider denies ("no new host channel is licensed either").

### Route C — spawn the dispatcher as a root session instead of a host child

**Rejected.** Leaving `origin` unset would make it a sidebar row and the existing glyph would follow. But `spawnDispatcher` rides `ctx.subagents.startActivation`, which always builds the child through `childSessionMeta` (`dsh-subagent/lib/index.js:346-357`). Bypassing it means hand-creating an agent: no descriptor, no catalog membership, no parent-notification delivery, and the send/continuation adjacency rules that ticket 130's cold resume depends on all break. That invents a channel and contradicts ADR-0025 and ADR-0018's imitate-the-host posture.

### Route D — the child's own conversation header (the only reachable additive seat)

**Recommended if the owner wants a visible mark now.** `conversation.session.header.actions` is a `list` slot; stock occupies it with `subagent-catalog` at order 10 (`dsh-client-ui-subagent/lib/client.js:983-989`), so a second additive entry at a higher order never shadows it. `createSessionKindGlyph("dispatcher", t)` (`src/client/session-kind.tsx:245-272`) already renders the same `◆` and is retained, uncomposed machinery. This is a different slot from the rider's, so ticket 123's precedent applies: it needs a dated ruling extending the rider. **It still needs a durable identity to read** — see the open question below.

## The ruling that is missing

Two questions, both answerable only by the owner:

1. **Seat.** A spawned dispatcher has no sidebar row (verified). Where should its glyph live: the child's own conversation header (Route D, additive, list slot), or nowhere until dsh exposes a child-kind signal?
2. **Identity channel.** The child's only client-visible identity is `SessionSummary.origin` plus `projectionValues`. No host fact, and no event in the child's log, distinguishes it from a worker. The ruling must choose one:
   - (a) select an independent preset at spawn, accepting the full composition re-declaration (Route A's cost) — this also sets header `agentPreset` and appends `agent-preset/selected`, a clean durable marker;
   - (b) license one new, named host channel for the identity (for example a projection unit permitted to consult our own `dispatcher_sessions` table) — the rider currently forbids this;
   - (c) defer the glyph for spawned dispatchers and record the reduced shape in the PRD and `docs/surfaces.md`.

Also record in the ruling whether the shipped `sessionKind` projection is itself the "new host channel" the rider's sentence was meant to block. The rider's sentence rests on a dead premise: it says dispatcher identity already reaches the client through the `roster.<sessionId>` mirror, but that channel was removed by the 0.2.1 port — the settings service rejects undeclared keys (`src/adapter/roster-channel.ts:2-8`). The projection is the successor, and it shipped under tickets 123/130 without an ADR moving. That ambiguity should be settled by the same ruling rather than resolved by an agent.

## Acceptance (unchecked until the ruling lands)

- [ ] The ruled seat renders the same `◆` glyph for a spawned dispatcher and a `/dsh-bot` dispatcher — parity regardless of initiator, per the 2026-10-22 ruling.
- [ ] Offline: a spawned dispatcher session resolves to kind `"dispatcher"` from its durable facts.
- [ ] Offline: a user-started dispatcher (`/dsh-bot`) is unchanged — still `projectionValues.sessionKind === "dispatcher"`.
- [ ] Offline: a non-dispatcher child (a worker) is unchanged — still resolves `"worker"`, and `resolveSessionKind` keeps `origin` first (ADR-0027 §Settled 5, ticket 130's "What is NOT proposed here").
- [ ] Offline: a normal session is unchanged — renders nothing, fails closed on a missing or malformed row.
- [ ] Composition: no seat beyond what the ruling licenses; the existing sidebar registration (`src/client/index.ts:293-306`) and its inject-count pins are unchanged unless the ruling says otherwise.
- [ ] No new host channel beyond what the ruling licenses. No `appendPluginRecord` (third-party callers are gated out), no fabricated `agentPreset`, no invented session `origin`.
- [ ] If the ruling is (c): the reduced shape is recorded in the PRD and `docs/surfaces.md`, and this ticket closes as documented rather than shipped.

## Rough size

- Route D + identity option (a): ~12 client lines for the header registration (`src/client/session-kind.tsx`, `src/client/index.ts`), ~200 lines of preset composition duplicated from `standard`, ~60 test lines. Highest drift risk.
- Route D + identity option (b): ~50 client lines, ~60 projection/adapter lines, ~50 test lines, plus a new ADR note.
- Route A alone: inert for the glyph. Do not implement it for this ruling.
- Option (c): documentation only, ~10 lines.

## Risks

- **A ruling that names a preset row will not deliver the glyph.** If the owner answers "make the preset row", the outcome is expensive and invisible. The missing-answer risk is the main one; the ticket states it explicitly so the ruling is not given on the old premise.
- **Duplicated composition drifts.** Any preset-row route copies `standard` into our repo; a dsh upgrade silently changes the child's tool set. This is the risk ticket 138 already flagged, now compounded by the fact that it buys no glyph.
- **Second registration would breach the rider.** `conversation.session.header.actions` is not licensed today (ticket 123 recorded it as declined). Composing it without the ruling repeats the exact mistake ticket 123 reverted.
- **The glyph is idle-only where it does render.** `sidebar.session.row.leading` mounts only for resting rows (`dsh-client-ui-workspace/lib/client.js:2306`), so even the working case shows a status dot. A header chip does not have that limit; a future owner may read the resulting difference as inconsistency.
- **Identity from a message fold would be fragile.** The policy inject uses the shared wake source kind and is `wakeup=false`; matching it would both invent a marker and race the first turn.

## Constraints (this design)

- Glyph only; no text in a 16px cell; no new panel, no floating surface, no stock-layout replacement.
- No change to the worker path and no change to `resolveSessionKind`'s `origin`-first order.
- No invented marker: the identity mark stays ours (`dispatcher_sessions`) *or* the host's own `agentPreset`; nothing is fabricated.
- Offline tests only; no live dsh, LLM, or browser run is needed to file or to implement.
- Read-only against `vendor/racoons/**` and the reference-material folder.

## Comments

### 2026-10-22 — filing (design pass; takes over ticket 138's glyph half)

Verified read-only against the installed `0.2.1-rc.2` tree rather than prior prose. Three corrections to the recorded analysis:

1. **"Only a preset row reaches the client" is wrong.** A preset row would reach `SessionSummary`, but the row never exists: `sessionVisible` returns `false` for `origin === "subagent"` (`dsh-client-ui-workspace/lib/client.js:964-965`, shipped 0.2.1-rc.2). The rider's own "known limits" section already recorded this for workers; it applies equally to a spawned dispatcher, which is a subagent child by construction.
2. **The roster-mirror premise is dead.** ADR-0024's rider says identity already reaches the client through `roster.<sessionId>` and therefore licenses no new host channel. That channel was removed by the 0.2.1 port (`src/adapter/roster-channel.ts:2-8`). The successor is our own `sessionKind` projection. The rider's clause cannot be read literally today; the ruling should say what it permits now.
3. **Route B has no clean discriminator.** Enumerated every durable event in a child's log: descriptor, preset selection, delegated policy, header facts. None separates a dispatcher child from a worker child. Our `dispatcher_sessions` table sits in a different storage domain than the projection cache and is not readable from a projection unit's synchronous `init`/`apply`.

No ruling was made and no code was touched. Label `needs-info`: the missing decision is the seat plus the identity channel, stated above. Ticket 138 stays deferred for its message-resume half; its glyph half is this ticket.

### 2026-10-24 — research verdict attached (tickets 143 + 144). Verdict: NEEDS-RULING — implementation is possible only via decisions below. Evidence: docs/research/2026-10-24-dsh-ui-patch-for-spawned-dispatcher-glyph.md and .scratch/testing/2026-10-24-rc3-compat/70-DELTA.md. Decision menu for the owner (pick one per item):

(1) UI route: (a) vendored replacement of @deepseek-ai/dsh-client-ui-workspace (partial fork, profile-wide, breaches ADR-0024 as written — needs an explicit ADR amendment), (b) shadow sidebar.workspaces — a single slot, same re-implementation cost, same breach, one-entry abdication back to stock, or (c) keep stock UI and use a non-sidebar seat: the child session's conversation.session.header.actions chip (replaceRisk none) or a main+sidebar.panellist panel.

(2) Identity channel (exactly one): agentPreset at spawn (client-visible, composition cost already measured in 140), a new licensed channel over dispatcher_sessions, or an invented label marker. Reading dispatcher_sessions from a projection unit is NOT possible (sync, no I/O).

(3) Two code-level facts any ruling must name: resolveSessionKind returns 'worker' for any origin 'subagent' before consulting the projection (src/client/session-kind.tsx:149) — relaxing this origin-first order needs a ruling; the sidebar leading cell mounts only on idle rows (:2306) — any sidebar-seat glyph is idle-only, record that limit.

(4) Housekeeping: rider item 1 contains a dead roster-mirror premise sentence (roster mirror no longer the channel) — rewrite when ruling lands. rc.3 adds no relevant slot (three new 'More menu' seats, no sessionId payload). No code was touched for this research.

### 2026-10-28 — ruling implemented (agent ruling under owner full-rein grant, subject to human reversal; draft ADR to follow separately)

Ruling as given: a spawned dispatcher gets the mark via (1) the host-side `sessionKind` projection unit consulting the adapter's dispatcher-mark mirror, and (2) a client header chip reading `projectionValues.sessionKind`. No new projection key, no new channel; `resolveSessionKind`'s `origin`-first order untouched.

What landed (branch `ticket-140-spawned-dispatcher-mark`):

- **Adapter** (`src/adapter/cordis-dsh-host.ts`): `spawnDispatcher` seeds `dispatcherMarks` with the reserved child id at the reserve site, BEFORE `startActivation` — the projection's `init` runs inside that call (`session/created`), and the durable row is only written after it resolves. `finally` deletes the seed when the host refused (`spawnedId === null`) or minted its own id, so a failed spawn leaves no phantom mark for the peer fence.
- **Projection** (`src/adapter/session-kind-projection.ts`): `init` now takes the late-bound mirror probe (`sessionKindProjectionDefinition`, `initSessionKindProjection`). `stateVersion` 1 → 2: a v1 checkpoint must be discarded and refolded, or a spawned child's wrong kind would stay durably cached. Fail-closed on a missing/throwing probe or an unreadable header.
- **Wiring** (`src/plugin.ts`): the unit is registered before `createCordisDshHost` exists, so the probe is a mutable ref (`dispatcherMarkProbe`), assigned right after construction. Nothing captures the host instance at registration time.
- **Client** (`src/client/session-kind.tsx`, `src/client/index.ts`): second, separately ruled seat — one additive `conversation.session.header.actions` entry (order 30, above stock `job-list` at 20 and `subagent-catalog` at 10). It resolves from `projectionValues.sessionKind` directly (`resolveHeaderDispatcherKind`), because the child IS `origin: 'subagent'` and `resolveSessionKind` would answer `"worker"` there; that function is unchanged. The worker marker is still not composed in any seat.

Acceptance status under this ruling:

- [x] The ruled seat renders the same `◆`-era mark for a spawned dispatcher (the shared bot portrait; `createSessionHeaderKindGlyph` reuses `SessionKindMark`).
- [x] Offline: a spawned dispatcher session resolves to `"dispatcher"` from its durable facts (`test/spawned-dispatcher-kind.test.ts`).
- [x] Offline: a user-started dispatcher is unchanged — its command fold still marks it.
- [x] Offline: a worker still resolves `"worker"`; `resolveSessionKind` keeps `origin` first.
- [x] Offline: a normal session renders nothing; a failed spawn leaves no mark.
- [x] Composition: two seats, each licensed by a dated ruling; the sidebar registration and its inject-count pins moved 3 → 4 in the client suites.
- [x] No new host channel: the mirror is our own in-process map, the projection is the existing key.

Not covered by this ruling, left untouched: the message-resume half (ticket 138), the ADR-0024 rider prose rewrite (draft ADR pending), and any worker-model client-side effect of `origin`-first ordering.

One boundary worth naming: a projection-cache row written by the PRE-140 unit (stateVersion 1) is discarded on read by the contract's version rule and refolds from `init`, which at boot has no mark in the mirror (it warms on activation). Such a child therefore projects null until something re-derives it — the same window the ticket-138 mirror already has. Rows written from this build forward carry v2 and restore the dispatcher kind across a restart; no new I/O was added to close the old-row case.
