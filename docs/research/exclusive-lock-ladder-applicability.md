# Exclusive lock ladder: applicability to our core

**Question:** the upstream dsh-grokbot plugin serializes every turn through an exclusive-lock ladder — task lock → bot lock → workspace write-queue (`runExclusively`, its `src/exec.mjs`). Does that pattern belong in our core?

**Verdict: NOT APPLICABLE as a ladder; one narrow in-flight guard is warranted (duplicate-concurrent-spawn window, below).** Every concurrency hazard the ladder exists to prevent already has an existing, verified guard in our core, and the hazard the guards do miss is a single check-then-set window, not a missing lock hierarchy.

**Status:** decision input only — this note takes no side for the authority stack (`docs/agents-rulebook.md`, level 8). It is not a ruling and creates no exception-list item.

---

## The upstream pattern, and why fidelity does not force it

The ladder is described in the 2026-10-02 upstream comparison, §3 (turn execution) and §10 (differences that matter): `.scratch/testing/2026-10-02-grokbot-upstream-compare/upstream-findings.md` — a git-ignored scratch artifact, so the load-bearing facts are restated here: upstream "workers" are **persistent named bot sessions** that keep living between turns and contend for shared per-project git workspaces (`upstream-findings.md` §4: no spawned worker processes; concurrency limited by `maxConcurrentJobs` and the exclusive-lock ladder). The ladder orders mutually exclusive access so a bot is not mid-turn in two conversations at once and two bots do not write one workspace concurrently.

That premise has **no analog here**. Our workers are spawn-per-task leaves with no shared session and no shared workspace: only the dispatcher spawns and workers are leaves (`docs/adr/0003-dispatcher-only-spawning.md`), each worker is its own host child session (`src/adapter/cordis-dsh-host.ts:674-681`), and no two workers share mutable state by design. Note also that dsh-grokbot is **not** the reference tree — it is an independent pattern-clone of a different product (`upstream-findings.md` §9), so ADR-0018's imitation bar does not reach it. Adopting or rejecting the ladder is a free design decision, not a fidelity obligation — which is exactly why it must be decided on hazard analysis, below.

## Hazard-by-hazard: the ladder's protections vs our existing guards

**1. Illegal lifecycle transitions (double settle, post-abort revival, steer of a done worker).** Status changes flow through a pure FSM where terminal states accept nothing and `applyEvent` returns null for any illegal event (`src/core/worker-fsm.ts:30-44`, `src/core/worker-fsm.ts:50-54`); the core applies events only when legal and ignores the rest (`src/core/multitask.ts:406-425`). A second settle for an already-terminal worker is dropped before it can re-wake anyone (`src/core/multitask.ts:486-491`). No lock is needed: the state machine itself refuses the race.

**2. Spawn/restart race (crash between spawn start and record keeping).** The spawn path writes its durable marker **and awaits it** before the spawn resolves (`src/core/multitask.ts:611-616`), so any crash after the caller sees success leaves a marker behind. On restart the rebuild restores terminal rows and converts live-at-crash markers into unknown-state holds (`src/core/multitask.ts:877-900`); a held stream key refuses re-spawn with a distinct, resolvable reason (`src/core/multitask.ts:568-577`; the refusal's documented intent, `src/core/types.ts:99-110`). Settle snapshots the terminal status, and abort deletes the marker (`src/core/multitask.ts:502-506`, `src/core/multitask.ts:652`) — mark-before-await closes the window where a worker exists but no record does.

**3. Steer races (two steers mid-flight, steer vs settle).** Steer delivery is serialized by a single-slot last-wins queue — one parked message per worker, a new park replaces the undelivered one (`src/core/steer-queue.ts:1-15`, `src/core/steer-queue.ts:21-23`) — plus park-then-interrupt with a post-interrupt check that drops the steer if the worker stopped steering meanwhile (`src/core/multitask.ts:678-689`), and a boundary pop that only fires while the FSM says `steering` (`src/core/multitask.ts:521-529`). Upstream solves the same contention with a bot-level mutex; ours is narrower because last-wins makes ordering irrelevant: only the newest steer can ever be delivered.

**4. Stop vs settle race.** The stop path transitions to `aborted` **first** and only then interrupts, so a late host settle lands on a terminal state and cannot revive the worker (`src/core/multitask.ts:636`, then `src/core/multitask.ts:653-655`; the guard is the FSM rule from hazard 1). The mirror refusal also holds: stopping an already-settled worker refuses without interrupting, so a delivered completion is never undone (`src/core/multitask.ts:626-644`).

**5. Settle vs pending access asks.** The settle handler clears the worker's access tickets **before** the FSM transition, so a settled worker cannot leave a parked ask behind (`src/core/multitask.ts:483-489` — clear at :485 precedes the transition); the stop path clears the same tickets too (`src/core/multitask.ts:648`).

**6. Unknown-worker writes (steer/stop of a foreign or dead id).** The steer path refuses an unknown id without side effects (`src/core/multitask.ts:660-676`) and only a live mid-work worker accepts a steer at all; the adapter's interrupt authority likewise resolves only through the worker's recorded parent entry, which exists only for workers this process spawned (`src/adapter/cordis-dsh-host.ts:690-702`).

## The one real window: duplicate concurrent spawns on one stream key

Stream-key uniqueness is check-then-set: `spawnWorker` reads the live map at `src/core/multitask.ts:553`, then **awaits the host spawn** (`src/core/multitask.ts:578`) before registering the worker on the map at `src/core/multitask.ts:600-601`. The await between check and set yields the event loop, so two concurrent `spawnWorker` calls with the same `(parentSessionId, streamKey)` can both pass the check and both spawn — the one-worker-per-stream invariant is violated for the pair.

This is the ladder-shaped hazard that is real here. The fix is small and local — a synchronous in-flight reservation of the stream key before the await (released on refusal/terminal) — not a lock ladder. The companion ticket for that fix is filed this session; per repo rule it is its own ticket, so this note records the hazard and the shape of the fix only.

## Governance notes

- **Per-stream exclusivity is already a settled ruling.** The one-stream-one-worker rule and its refusal-without-host-call semantics were specified and resolved in `Issue-tracker/resolved/05-worker-registry-and-stream-uniqueness.md`. The uniqueness **domain** is `(parentSessionId, streamKey)` — a model-authored key scoped to the dispatcher session — recorded in `docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md:33` (context: `:23`). Any NEW cross-session or process-global lock would change that recorded domain and is therefore an unrecorded decision: it would require its own draft ADR before implementation, not a code-first change.
- **Why the ladder's upstream purpose does not transfer.** Upstream needs the ladder because persistent bot sessions are long-lived shared resources contending across conversations and workspaces (`upstream-findings.md` §3–§4). Our workers have no between-turn life to contend over — a worker is one task, one child session, one settle — and the dispatcher (the only persistent session) is already serialized by the host's turn model plus the wake bus's queue-don't-flush behavior (`src/core/multitask.ts:238-243`).
