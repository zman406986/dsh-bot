# 83 — Worker spawn refused live: the spawn request's `maxDepth` slot carries the worker's leaf budget (0), but the host reads it as the depth ceiling for THIS spawn (needs ≥ 1) — `SubagentDepthError: subagent depth 1 exceeds maxDepth 0`, so no worker can ever start

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (discovered by the ticket-45 live pass, 2026-09-19 — the provider-schema gate it was behind is fixed; this is the next layer down)
**Related:** 45 (live pass evidence; its AC 2/3 "worker appears" clause is blocked here), 10 (where the maxDepth slot was chosen), 09/11 (spawn path / dispatcher tools), 33 (live close-out)

## Symptom (live, cited)

Ticket-45 live pass 2026-09-19 (`C:\Users\TZhen\Desktop\dsh-live-ticket45-2026-09-19\`, outside
the repo): throwaway `multitask` profile, activation via `commands/execute /dispatcher-start`
(MATCHED), then ONE plain-text spawn ask. THE PROVIDER ACCEPTED THE TURN — all five dispatcher
tool schemas passed validation (ticket 45's defect is gone): the trajectory shows `todo_write`
(in_progress) → `spawn_worker` → `todo_write` (back to pending), 3 tool calls, turn completed,
no INVALID_REQUEST. But the spawn itself was refused by the host runtime:

```
spawn_worker{...} → error
SubagentDepthError: subagent depth 1 exceeds maxDepth 0
```

The dispatcher model then did the right thing (reconciled the todo honestly, reported plainly,
offered inline help — `shots/05-spawn-refused-maxdepth.png`,
`rpc-trajectory-spawn-error.json`):

> "I couldn't start it — background task delegation is disabled in this session. The runtime
> rejects any spawn at depth 1 ("maxDepth 0"), so there's no level at which I can hand work
> off right now."

Consequence: the dispatcher activates, converses, and reconciles, but `spawn_worker` can never
succeed live — the product's core loop (spawn → steer → deliver) is still unreachable one
layer below the provider.

## Root cause (cited)

`CordisDshHost.spawnWorker` (`src/adapter/cordis-dsh-host.ts:628,634`) builds the
`startContinuable` request with `maxDepth = workerAgentDef?.maxDepth ?? 0` — the WORKER's leaf
budget (`WORKER_MAX_DEPTH = 0`, `src/worker/agent-def.ts:31`, ticket 10's design: "workers
never spawn descendants"). The host reads that field differently:
`resolveChildDepth(parent, request.maxDepth)` (`dsh-subagent/lib/index.js:432-437`) computes
`childDepth = parent.delegationDepth + 1` and throws `SubagentDepthError` when
`childDepth > request.maxDepth` — i.e. **`request.maxDepth` is the absolute delegation-depth
ceiling for spawns through this request, and a child of a depth-0 session needs `maxDepth ≥ 1`**.
`maxDepth: 0` therefore refuses every spawn ("subagent depth 1 exceeds maxDepth 0",
`dsh-subagent/lib/index.js:412-420`).

The two "leaf worker" guarantees we actually want are (a) the worker session lands at depth 1,
and (b) the worker itself cannot spawn descendants. (b) is already enforced INDEPENDENTLY of
this slot: the worker's tool barrier denies the host `subagent` tool
(`workerAgentDef.resolveToolFilter`, `src/worker/tool-barrier.ts`). The offline tests pin the
wrong semantics: `test/adapter-cordis-dsh-host.test.ts:199,246` assert
`spec.request.maxDepth === 0`.

## Requirements (direction; final call belongs to the implementer)

1. Pass a request `maxDepth` the host can accept — ≥ 1 for the dispatcher→worker hop (e.g.
   `1`, so a child may exist at depth 1 and depth 2 is refused even before the tool barrier
   is consulted) — while keeping the worker's own leaf guarantees where they belong (tool
   barrier; and, if the host surfaces a child-side delegation budget via child agent options,
   pin that separately). Preserve ADR-0003 (dispatcher-only spawning) with a test that walks
   the real semantics: depth-1 child allowed, depth-2 refused.
2. Update the two offline pins to the corrected slot meaning; add a pin that the request
   budget is derived from ONE named constant with the leaf rationale in its comment (so the
   "0 = leaf" confusion cannot silently return).
3. No prompt/copy changes, no tool-name or result-shape changes.

## Acceptance criteria

- [x] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client` green with the
      corrected request budget and updated pins. (2026-09-19, see closing comment.)
- [ ] (live) the ticket-45 AC 3 flow (start → one trivial worker → one mid-run steer → stop)
      executes against the real host: worker spawns (roster row + `subagents/list`), steer
      queued, stop honored, delivered to user — no `SubagentDepthError`. (Owned by the
      separate live re-pass; unblocked by commit `1f04727`.)

## Notes

- Discovered live 2026-09-19 in the ticket-45 pass; the one spawn attempt was refused by the
  host BEFORE any worker session existed, so no worker tokens were spent. LLM traffic for the
  whole pass: exactly ONE dispatcher round (3 tool calls; ~50.7K tok context, 69% cache hit).
- Ticket 45's own defect (invalid tool JSON Schema → provider INVALID_REQUEST) is confirmed
  FIXED by this same pass: the provider validated and executed all five dispatcher tools.
- Host evidence: `dsh-subagent/lib/index.js:432-437` (`resolveChildDepth`), `:144-147`
  (`delegationDepthOf` — persisted parent header is the monotone floor), `:412-420`
  (`SubagentDepthError` copy).

## Comments

### 2026-09-19 — closed (offline gate green, commit `1f04727`); live AC unblocked for the re-pass

Semantics confirmed against the installed host lib (READ-ONLY) before implementing — the
ticket's reading was exactly right, no divergence: `resolveChildDepth`
(`dsh-subagent/lib/index.js:432-437`) computes `childDepth = delegationDepthOf(parent) + 1`
and throws `SubagentDepthError` (`:412-420`) when `childDepth > request.maxDepth` — the
request slot is the CHILD'S ABSOLUTE ceiling; the host does not clamp and does not
auto-derive. `delegationDepthOf` (`:144-147`) floors the parent depth at
`Math.max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)`; `startContinuable`
(`:1647-1651`) validates then enforces it. The seam (`AgentLike.session.header`,
`cordis-dsh-host.ts`) exposes the header side, so the fix uses the REAL parent depth — no
hardcoded depth-1 parents.

Fix (commit `1f04727`):

- `src/worker/agent-def.ts`: `WORKER_MAX_DEPTH = 0` is now documented as the worker's OWN
  delegation BUDGET below itself (leaf per ADR-0003), never the request slot; new pure
  `workerSpawnMaxDepth(parentDelegationDepth, budget = WORKER_MAX_DEPTH)` derives the
  request ceiling as `parentDepth + 1 hop + budget` (one named constant drives it — the
  "+1" is the parent→worker hop, not a second budget). Leaf enforcement stays independent
  of the number: the tool barrier denies the host `subagent` tool.
- `src/adapter/cordis-dsh-host.ts` (`spawnWorker`): request `maxDepth` is now
  `workerSpawnMaxDepth(parent.session.header?.delegationDepth ?? 0, workerAgentDef?.maxDepth
  ?? WORKER_MAX_DEPTH)`. The `?? 0` fallback (header unreadable) assumes a top-level
  dispatcher — true today because activation is `isTopLevel`-gated
  (`src/adapter/parent-agent.ts:271`, which itself fails open on an unreadable header);
  DATED NOTE 2026-09-19: multi-level nesting is deferred by ADR-0003 and never used; if a
  deeper parent is ever bound, this derivation already tracks it (see test), so only the
  fallback needs revisit. `ContinuableStartSpecLike.request.maxDepth` doc updated.
- Exports: `workerSpawnMaxDepth` through `src/worker/index.ts` + `src/index.ts`.

Tests — both wrong pins corrected, not deleted: `test/adapter-cordis-dsh-host.test.ts:199→207`
and `:246→253` now assert `spec.request.maxDepth === 1` for a depth-0 parent. New
`ticket 83 regression` describe walks the host rule replicated from the cited lib lines
(`hostResolveChildDepth`): (1) depth-0 dispatcher → depth-1 child ACCEPTED (the exact live
2026-09-19 failure shape, previously "subagent depth 1 exceeds maxDepth 0"); (2) a
hypothetical depth-2 grandchild REFUSED through the same ceiling (leaf at the host layer,
defense in depth behind the tool barrier); (3) a depth-2 parent yields ceiling 3 — derived
from the seam, not hardcoded 1; (4) unreadable header → ceiling 1 (documented fallback).
`test/worker-agent-type.test.ts` pins `def.maxDepth === WORKER_MAX_DEPTH === 0` (budget
meaning) and `workerSpawnMaxDepth(d) === d + 1 + WORKER_MAX_DEPTH` for several depths.

Gates: `npm test` 945/946 across 236 suites — the ONE failure is
`test/client-face-scaffold.test.ts` (en/zh onboarding-face parity), a CONCURRENT agent's
in-flight ticket-68 work in the shared tree, untouched by this diff and failing
independently of it; every suite touched by this ticket is green. `npm run typecheck` clean
(both tsconfigs), `npm run build:client` clean (141,609 bytes). Red→green was demonstrated
mid-flight (first run: both new derivation tests + corrected pins failed on the old
arithmetic; after fix, green).

Live AC left UNCHECKED on purpose — it belongs to the separate live re-pass, which this
commit unblocks: see the ticket-45 comment of 2026-09-19 (the pass that discovered this
defect: one dispatcher round, `spawn_worker` refused before any worker session existed, no
worker tokens spent). That pass's next attempt should now show the roster row appear where
`SubagentDepthError` stood. No prompt/copy, tool-name, or result-shape changes (req 3).
Note for future readers: `docs/research/dsh-loop-capability-map.md:48,134` still describe
the pre-83 "leaf enforced by maxDepth: 0" shape — dated research observations, superseded
by this ticket. ADR-0018's exception list untouched (D21 wake-report clamps and C15 wake
kinds are unrelated; this change restores host fidelity rather than deviating).
