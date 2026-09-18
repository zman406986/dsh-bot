# 76 — Implement ADR-0019: per-dispatcher scoped tool registration + session-keyed state

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** 72 (design — resolved), human sign-off of ADR-0019 (`docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md`) before any live-lane work
**Related:** ADR-0018 (multiple dispatchers are real), research note `docs/research/dsh-tool-scoping-seam.md` (update 2026-09-19: host seam verified on installed 0.1.5-rc.2), 19 (the single-session activation this generalizes), 30 (session-scope access rows), 59 (stream-key uniqueness)

## Problem

Ticket 72's survey verified the host's per-agent tool-scope seam and ADR-0019 (draft) designed
the generalization: dispatcher tools register through each activated Agent's scoped context,
the plugin-level singleton (one `activationTools` slot, one `dispatcherSessionId`, one host
parent, single-session `gatedExecute`, `already-active-elsewhere`) retires, and every
single-session state assumption becomes session-keyed. This ticket is that implementation —
ticket 72 was design-only by its own AC.

## Acceptance criteria

- [x] Scoped registration: at activation the five dispatcher tools register through the
      activated agent's scoped tools surface (structural `AgentLike` extension, no cordis type
      import); disposers are held per session and tolerate host-side auto-unregister;
      `request_access` stays a global registration.
      Evidence: `src/adapter/cordis-dsh-host.ts` (`AgentLike.ctx?`, structural view of the
      host's per-agent scope; seam per `docs/research/dsh-tool-scoping-seam.md`,
      `dsh-tools/lib/index.js:2781`); `src/plugin.ts` `activateToolSurface` registers through
      `agent.ctx.tools`, disposers per session in `sessionToolDisposers`; `request_access`
      is a plugin-level global registration reference-counted over active dispatcher sessions.
- [x] Singleton retirement: `activationTools` one-slot, single `dispatcherSessionId`, single
      host parent, and `gatedExecute`'s single-session compare are replaced by per-session
      registries; `DISPATCHER_TOOL_GATE_REFUSAL` and the `already-active-elsewhere` copy are
      retired (host `UNKNOWN_TOOL` covers out-of-scope callers); `already-active-here` and
      `not-top-level` stay.
      Evidence: `src/adapter/dispatcher-tools.ts` (gate + refusal removed; handlers close over
      their own session id), `src/adapter/parent-agent.ts` (per-session `Map`, outcome union
      loses `already-active-elsewhere`), `src/adapter/activation-command.ts` (both copies
      retired with dated comments), `src/adapter/cordis-dsh-host.ts` (parent map;
      `parentAgentOf(sessionId)` replaces the `parentAgent` slot).
- [x] Session-keyed state per ADR-0019's table: host parent map (interrupt/send resolve
      authority from the worker's recorded `parentSessionId`), `(parentSessionId, streamKey)`
      uniqueness domain, access-policy session rows attributed per session with per-session
      clear on deactivate/unload, per-session access prompt pump, per-session roster publish
      (no single-active gate), per-session restart rebuild gating.
      Evidence: `cordis-dsh-host.ts` (`parents` map; spawn/interrupt/send resolve the worker's
      recorded parent), `src/core/multitask.ts` (`liveStreamKeyId` composite key; hold lookup
      session-scoped), `src/core/access-relay.ts` + `src/core/access-types.ts` (attributed
      session rows, `clearSession(sessionId?)`), `src/plugin.ts` (`pumpFor(sessionId)`,
      `onRosterChanged` → `isDispatcherSession`, `rebuildAndNotice` per-session liveness).
- [x] Single-dispatcher behavior is a strict superset check: all existing suites pass
      unchanged except where the retired refusal copy is asserted; a "map of one" behaves as
      shipped.
      Evidence: full suite green; only the retired-copy/construction assertions were rewritten
      (activation-lifecycle, adapter-dispatcher-tools, adapter-policy-inject, coexistence,
      plugin-scaffold); dormant matrix, coexistence, restart-honesty, composition-polish,
      access-prompt suites pass unchanged on their original assertions.
- [x] Offline multi-session tests (S8, FakeHost, no network/LLM) pin: a second dispatcher
      session's tools never appear in the first's surface; handlers route to their own
      session's state; same `stream_key` in two sessions does not collide, same key within one
      session still refuses; deactivating session A clears only A's policy rows and prompts;
      roster publishes carry the changed session's id.
      Evidence: `test/multi-dispatcher.test.ts` (new, 6 tests: scoped surfaces, per-session
      routing, stream-key domains, per-session publish ids, prompt abandonment isolation,
      always-allow row isolation) + `test/host-seam.test.ts` (3 new core-level keying tests).
- [x] `npm test` and `npm run typecheck` green; ADR-0019 moved to accepted only by human
      sign-off (not by this ticket).
      Evidence: 841 tests pass / 0 fail; `tsc -p tsconfig.json` and `tsc -p
      tsconfig.client.json` clean. The ADR file's status line is untouched by this ticket.

## Constraints

- No new host seams and no host API changes — the same `ctx.tools.register` addressed through
  the host's own per-agent scope (verified usage, `dsh-tools/lib/index.js:2792` error copy).
- ADR-0018 exception list is the fidelity bar: no new deviations (tool names, schemas, copy,
  and semantics unchanged; workers stay leaves; workers never see dispatcher tools).
- Live two-dispatcher verification is out of scope here — it rides the live lane
  (tickets 45/33 chain).

## Comments

### 2026-09-19 — agent (ticket 76 implementation)

Landed in three commits, in the ticket's prescribed order:

1. `a41d0e4` — stream keys keyed `(parentSessionId, streamKey)` (`src/core/multitask.ts`):
   the global `liveByStreamKey` map becomes composite-keyed, and the ticket-59 unknown-state
   hold lookup is session-scoped too (same collision shape: one dispatcher's unresolved hold
   must not block a sibling's identically-named stream). Pinning tests in
   `test/host-seam.test.ts`.
2. `865ea68` — access-policy session rows gain an owning session (`PolicyEntry.session?`);
   lookup answers only the owning session (un-owned legacy rows behave as shipped);
   `clearSession(sessionId?)` clears only that session's rows (plus un-owned legacy rows) and
   the no-arg form clears all (plugin unload); `Multitask.clearSessionAccessPolicy(sessionId?)`;
   the plugin's always-allow sink attributes the row to the asking ticket's `parentSessionId`.
   Pinning tests in `test/access-relay.test.ts`.
3. `492e37c` — scoped registration + singleton retirement (files listed in the ACs) + new
   `test/multi-dispatcher.test.ts` (6 end-to-end offline tests over scoped agent surfaces, a
   fake prompt seam, and settings-capture).

Design decisions worth the human's eyes (all within ADR-0019's scope):

- **Fallback for ctx-less agents.** When an activated agent carries no `agent.ctx.tools`
  (stub hosts, or host drift — dsh is a developer preview with explicit breaking-change risk),
  the plugin registers the five tools on the plugin-level global surface as before. That keeps
  the shipped single-dispatcher shape byte-for-byte on old/stub hosts; the per-agent visibility
  fence is simply absent there (documented weaker path — the retired execute-time gate is not
  reinstated). Existing suites that use ctx-less agents pass on their original structural
  assertions because of this fallback.
- **Roster settings key stays the single `roster` key.** The ADR's keying table sketches
  per-session keys under the plugin namespace, but the client read-side belongs to the
  wrapper-UI epic (tickets 27/28/65/66 → 78–81), so this ticket fixed the data path only:
  publishes fire per changed session with no single-active gate, and every snapshot carries
  its `dispatcherSessionId`. Re-keying the mirror rides the wrapper epic with the client work.
- **`dispatcherSessionId()` kept as a compatibility slot** ("most recently activated active
  session"), with new `isDispatcherSession(id)` / `dispatcherSessionIds()` as the authority
  accessors; the steer command now gates on the invoking chat's own activation
  (`activeSessionIds()`), fixing what would have been a false refusal with two dispatchers.
- **`host.parentAgent` replaced by `parentAgentOf(sessionId)`** — the only production consumer
  (the access prompt pump) is per-session now; `hasParent()` means "any parent bound".
- **`sendMessage` authority change (honest note):** delivery now resolves the parent from the
  worker's recorded parent session; a message to an UNKNOWN worker id (no recorded parent)
  throws the same "no parent agent bound; cannot send" error it always did. Core only ever
  sends to known workers, so no shipped path changes.

ADR-0019 remains draft (non-human-approved) — untouched by this ticket per AC 6; its sign-off
gates only live-lane work. Live two-dispatcher verification stays with the 45/33 live lane.
