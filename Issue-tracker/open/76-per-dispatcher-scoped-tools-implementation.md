# 76 — Implement ADR-0019: per-dispatcher scoped tool registration + session-keyed state

**Status:** open
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

- [ ] Scoped registration: at activation the five dispatcher tools register through the
      activated agent's scoped tools surface (structural `AgentLike` extension, no cordis type
      import); disposers are held per session and tolerate host-side auto-unregister;
      `request_access` stays a global registration.
- [ ] Singleton retirement: `activationTools` one-slot, single `dispatcherSessionId`, single
      host parent, and `gatedExecute`'s single-session compare are replaced by per-session
      registries; `DISPATCHER_TOOL_GATE_REFUSAL` and the `already-active-elsewhere` copy are
      retired (host `UNKNOWN_TOOL` covers out-of-scope callers); `already-active-here` and
      `not-top-level` stay.
- [ ] Session-keyed state per ADR-0019's table: host parent map (interrupt/send resolve
      authority from the worker's recorded `parentSessionId`), `(parentSessionId, streamKey)`
      uniqueness domain, access-policy session rows attributed per session with per-session
      clear on deactivate/unload, per-session access prompt pump, per-session roster publish
      (no single-active gate), per-session restart rebuild gating.
- [ ] Single-dispatcher behavior is a strict superset check: all existing suites pass
      unchanged except where the retired refusal copy is asserted; a "map of one" behaves as
      shipped.
- [ ] Offline multi-session tests (S8, FakeHost, no network/LLM) pin: a second dispatcher
      session's tools never appear in the first's surface; handlers route to their own
      session's state; same `stream_key` in two sessions does not collide, same key within one
      session still refuses; deactivating session A clears only A's policy rows and prompts;
      roster publishes carry the changed session's id.
- [ ] `npm test` and `npm run typecheck` green; ADR-0019 moved to accepted only by human
      sign-off (not by this ticket).

## Constraints

- No new host seams and no host API changes — the same `ctx.tools.register` addressed through
  the host's own per-agent scope (verified usage, `dsh-tools/lib/index.js:2792` error copy).
- ADR-0018 exception list is the fidelity bar: no new deviations (tool names, schemas, copy,
  and semantics unchanged; workers stay leaves; workers never see dispatcher tools).
- Live two-dispatcher verification is out of scope here — it rides the live lane
  (tickets 45/33 chain).
