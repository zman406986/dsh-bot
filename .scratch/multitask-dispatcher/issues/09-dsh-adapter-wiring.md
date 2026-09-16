# 09 — dsh adapter wiring

**What to build:** The core stops being a simulation and starts driving the real harness. This ticket replaces the fake host with dsh's actual services, so a worker spawned by the dispatcher is a real background agent.

**Blocked by:** 08 — Durable roster marker + restart behavior.

**Status:** ready-for-agent

Note: dsh **is** installed on this machine (`@deepseek-ai/dsh@0.1.5-rc.1`, global npm, live `web` profile) — see `docs/research/dsh-local-install.md`. This ticket is verifiable against a real host, not just the fake.

- [ ] Spawning a worker through the real adapter starts a real background agent in dsh and returns its worker id without blocking the dispatcher's turn.
- [ ] The adapter uses dsh's real seams as verified in the installed tree: subagent spawn, the interrupt path, the job registry for live status, the session/storage facilities for the durable marker, and the completion → wake path.
- [ ] Interrupting a worker calls dsh's real interrupt path and the agent stops its current turn.
- [ ] Worker settlement is observed from dsh and reaches the wake bus exactly once per worker.
- [ ] Requesting a dispatcher wakeup reaches the real dispatcher session and opens a turn.
- [ ] The durable marker reads and writes through dsh's session/storage facilities.
- [ ] Live job status is read from dsh's job registry for the check surface; job records are not treated as durable.
- [ ] The core is unchanged by this ticket — only the adapter implementation behind the host interface is new. The existing core tests still pass against the fake.