# 72 — Per-dispatcher tool scoping: verify host-side scopes, else generalize the single-session gate into session-keyed routing

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (finding recorded: `docs/research/dsh-tool-scoping-seam.md`)
**Related:** ADR-0018 (multiple dispatchers are real — this is its verification item), 64 (commissioned this), 19 (the single-session activation gate this generalizes), 30 (session-scoped always-allow rows — same keying), 27/29 (roster/activity projections keyed by one session)

## Problem

ADR-0018 rules multiple dispatchers real, each with its own dsh session. Today the dispatcher tool
surface is one process-wide registration on the plugin ctx with a single-session execute gate
(`lifecycle.dispatcherSessionId()`), pinned to one activation slot — a second dispatcher session
cannot exist. Finding and evidence: `docs/research/dsh-tool-scoping-seam.md`.

## Acceptance criteria

- [ ] One read-only observation pass against the installed `@deepseek-ai/*` packages (offline;
      same method as ticket 29's seam survey; never the reference tree): does the host offer a
      session-/agent-scoped tool registration seam a plugin can use (per-scope `tools` service,
      per-session register, or agent-filtered availability)? Verdict with file:line recorded as a
      dated comment and appended to the research note.
- [ ] If a host scope exists: design note (ADR draft) registering each dispatcher's tools in its
      own scope; the plugin-level singleton gate is retired.
- [ ] If not: design note (ADR draft) for **session-keyed gating** — registration stays global;
      `gatedExecute` routes `callerSessionId → dispatcher state` (per-session Multitask instance
      or keyed sub-registries — the note decides with evidence); unknown callers refuse with the
      existing structured copy; the worker-access tool gets the same keying.
- [ ] The design covers roster snapshot, wake bus, access relay, and recentActivity keying per
      dispatcher session (they all assume one session today).
- [ ] No implementation in this ticket — it ends at the signed-off design; implementation gets
      its own ticket (repo rule).

## Constraints

- Offline only (S8); the host survey is read-only on the INSTALLED dsh packages.
- Do not weaken the existing one-dispatcher behavior while designing; the generalized design must
  be a superset (single dispatcher = map of one).
- ADR-0018's exception list is the fidelity bar for any dispatcher-tool visibility question
  (workers stay leaves; workers never see dispatcher tools).
