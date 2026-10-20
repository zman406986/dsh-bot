# Chief-of-Staff dispatcher with mitosis: a dispatcher hands off problem and outcome, and may summon another dispatcher

**Status:** agent-drafted 2026-10-18 from the owner's decision 1 (see `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"); **owner-reviewed and corrected 2026-10-19** — this ADR records what we adopt first, not a ban on anything else. It supersedes ADR-0003's flat-topology spawning clause for the dispatcher→dispatcher edge only and amends ADR-0018 exception U-G for that edge only; ADR-0003's worker-leaf, single-parent, and no-worker-to-worker rules stay in force. The bounds in §Starting bounds are a first-implementation proposal, not an owner ruling.

**Numbering:** 0025, the first free number at filing (2026-10-18; highest in use was 0024). Filed by the records pass from the owner's 2026-10-18 decision, recorded in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 1. The human ruled the direction; the text below is the agent's draft of it. Implementation is ticketed separately per repo rule; no source was edited in this pass.

## Supersession of ADR-0003 (dispatcher→dispatcher edge only)

ADR-0003's body is left untouched (the recorded 2026-09-19/09-20 convention: dated notes on the Status line and the index, never body edits). The clauses superseded **for the dispatcher→dispatcher edge only**, quoted exactly from `docs/adr/0003-dispatcher-only-spawning.md`:

1. Decision, line 5, first sentence: "The team topology is **flat: only the dispatcher spawns agents**." — a dispatcher may now also summon another dispatcher, so the topology is no longer flat above the worker level.
2. Decision, line 5, third sentence: "Nested spawning is out (deferred, behind a future ADR if ever needed)." — this is that ADR, for the dispatcher→dispatcher edge only.
3. Consequences: "Peers (ADR-0002) remain dispatcher-level identities; this ADR grants them no spawn authority." — a dispatcher summoned by a dispatcher carries the dispatcher's spawn surface; whether it may itself summon a dispatcher is TBD (below).
4. Consequences: "Revisiting nested spawning requires a new ADR." — this is that ADR, for the dispatcher→dispatcher edge only.

Note on scope: the clause superseded is ADR-0003's *spawning* clause — the sentences that say only the dispatcher spawns agents and that nested spawning is out. The worker-leaf sentence in the same Decision line ("Workers are leaves — they never spawn sub-workers.") and the undecided worker-messaging sentence ("Worker-to-worker messaging topology is not decided here.") are **not** superseded.

**Retained verbatim from ADR-0003:**

- "Workers are leaves — they never spawn sub-workers."
- "S4/S6 stay single-parent: exactly one dispatcher owns each worker's settle wake and todo reconciliation."
- "Worker-to-worker messaging is resolved by reference observation, not by asking the human: no direct worker-to-worker messaging."

ADR-0018's conformance "workers are leaves — the reference's worker runs exclude the spawn, management, user-message, and peer-message tools" stands unchanged. ADR-0003 binds: a worker spawns no agent, dispatcher or worker.

## Amendment of ADR-0018 exception U-G (dispatcher→dispatcher edge only)

U-G currently reads, exactly:

> **U-G** — No runtime agent management: dispatchers are not created/cloned/kickstarted by agents at runtime; no agent create/update tools or profiles.

The owner's decision authorizes a dispatcher to summon another dispatcher at runtime. U-G is therefore **amended for the dispatcher→dispatcher edge only**: a dispatcher may create a dispatcher peer. U-G otherwise stands as accepted — its other exclusions are ADR-0018's, not repeated or extended here. The amendment is recorded as a dated note on ADR-0018's Status line and the ADR index row, the same pattern ADR-0024 used to record its supersession of ADR-0021/0022; ADR-0018's accepted body is not rewritten.

C13 (no agent-identity roster), C14 (no org chart / routines / per-agent memory; its room exclusion is addressed separately by ADR-0026), and C15 (single wake kind) are not touched: a summoned dispatcher is a session, not a saved identity, and its wake is not a new wake kind.

## Context

The 2026-10-18 study found our dispatcher prompt is stricter than the reference's: ours requires goal, constraints, context, success criteria, and report format in every spawn prompt, while the reference's coordinator says "Don't root-cause it yourself first" and "Hand off the problem and the outcome, not a prescription" (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"What each source offers" → Corrections item 3). The owner ruled the Chief-of-Staff role and mitosis in one dated decision. Mitosis itself has no reference precedent — Grok Bot has no dispatcher-spawns-dispatcher path — so this is a deliberate product addition, not an imitation.

The design note `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` (untracked) carries a ready ADR wording and a concrete mechanism proposal. It is input to the implementation ticket, not authority: where it sets numeric bounds, those numbers are proposals for the implementing ticket to weigh.

## Decision

1. **The dispatcher prompt becomes the Chief-of-Staff role.** The dispatcher decides whether the work needs a team or a single worker, then hands off the **problem and the intended outcome** rather than a prescription of method. Exact prompt wording is the implementation ticket's; the PRD's current five-part spawn-prompt bullet (§6.1: goal, constraints, relevant context, success criteria, report format) is to be amended by that ticket, not by this records pass.
2. **A dispatcher may summon another dispatcher — mitosis.** The summoned dispatcher carries the **full dispatcher tool surface** and the **dispatcher policy**. It is a **peer of its creator, not a rank below it**: the structural parent/child relation the host imposes (one session spawns another) does not make it a subordinate, and no control authority over its creator is created.
3. **Workers stay leaves (ADR-0003 binds).** ADR-0003's worker-leaf and single-parent rules are unchanged: a worker spawns no agent, and exactly one dispatcher owns each worker's settle wake and todo reconciliation. ADR-0028's worker mid-task reply goes to that owning dispatcher.
4. **A summoned dispatcher's state is its own.** ADR-0019's per-dispatcher tool scoping is the design we build to: a dispatched peer registers its own scoped tool surface and its own keyed state — its own ledger, steer queue, inbox, and wake state. Sharing the creator's state is not part of this decision.
5. **First implementation uses the host's existing bounds.** See §Starting bounds below. The host already refuses work past `maxDepth` and past the live-subagent pool; we start there and add no cap of our own. Other bounds (a spawn budget, a per-tree dispatcher cap, a reservation scheme) remain open; adopting one needs a ticket that states the tradeoff, not a fresh ruling.
6. **A summoned dispatcher's channel to the user is an open question.** The first implementation routes a child dispatcher's work through its creator, because the host gives a subagent child no chat surface of its own and hides it from the sidebar. Whether a child may eventually address the user directly is left open (see Open questions); the ticket that changes it states the tradeoff.

## Starting bounds (first implementation, from host evidence)

The first implementation adds no cap of its own and leans on what the host already enforces. These are starting values derived from the installed host, not owner rulings; a later ticket may add a cap if observation justifies one. The evidence is in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q6.

| Bound | Value | Where it comes from |
|---|---|---|
| **Depth** | host `maxDepth`, default **1** | `dsh-subagent/lib/types/index.d.ts:99-104` — "Default delegation depth for tools without an explicit limit; defaults to 1". `resolveChildDepth` throws `SubagentDepthError` when `parentDepth + 1 > maxDepth`; the persisted header's `delegationDepth` is the monotone floor. |
| **Live children in a tree** | host `maxActiveSubagents`, default **8 per root tree** | `dsh-subagent/lib/types/index.d.ts` (same block) declares the default; enforcement is a hard reservation at `dsh-subagent/lib/index.js:1046-1052` (`ACTIVATION_LIMIT_REACHED`), called at `:1676`. The pool resolves as `resident.get(parent.id)?.pool ?? rootPool(parent)` (`:1676`), and `rootPool` is one pool per root identity (`:1754-1762`), so descendants draw from the creator's pool. |
| **A cap of our own** | **none in the first implementation** | `src/core/multitask.ts` has no live-worker count, no per-session spawn budget, and no total cap; the only spawn-side refusals are stream-key uniqueness and the in-flight reservation. This ADR adds nothing on top. |

**Required consequence — the depth budget must be raised per spawn.** Because `maxDepth` is the *child's absolute ceiling* (not a count of levels below the child), a depth-1 child dispatcher that could still spawn workers needs a ceiling that admits its own next hop. The dispatcher-spawn path must therefore pass **`maxDepth = parentDepth + 2`**: one hop for the child dispatcher itself, one hop for the workers it will spawn. Shipping `parentDepth + 1` would accept the child and then refuse every worker the child tries to create. This is a required implementation detail, not a bound of ours. (The existing worker spawn already derives its own ceiling this way — `workerSpawnMaxDepth` in `src/worker/agent-def.ts`, live-pass ticket 83.)

**A known risk, observed rather than pre-empted.** The 8-active-subagent root pool is a hard wall shared by every dispatcher and worker in the tree, so a child dispatcher spawning workers can exhaust capacity its creator's workers also draw from. The first implementation accepts that as a **worker-starvation risk to watch**. If starvation is observed, the fix is a ticket (a quota, a reservation, or something else) that states the tradeoff; this ADR does not pre-empt it.

**Alternatives left open.** The design note's proposals — generation 1 only, 4 live spawned dispatchers, `recursion-limit` and `dispatcher-cap` refusals, a durable spawn counter — are recorded there as proposals only. They remain available as future options; adopting one needs its own ticket stating the tradeoff, not a fresh ruling. A child dispatcher may itself summon another dispatcher; the host's depth and pool values are what stop it in the first implementation.

## Consequences

- The dispatcher topology is no longer flat: it becomes dispatcher trees. ADR-0003's flat-team intent survives in the worker rule.
- **The first implementation adds no bound of ours.** A dispatcher tree may deepen and widen until the host refuses: `maxDepth` per spawn, and 8 live children in the root pool. Exhausting the pool is a worker-starvation risk to watch.
- **Spawn capacity is shared, not partitioned** in the first implementation. A child dispatcher and its creator's workers draw on one pool. A future ticket may add a reservation or quota if observation justifies it.
- The dispatcher prompt is rewritten to the Chief-of-Staff role; the stricter spawn-prompt requirement is relaxed by the implementing ticket.
- Peer messaging now has a producer: a dispatcher can create a peer to talk to. The 1:1 path is unchanged, discovery is pushed at the prompt tail (ADR-0027), and the worker mid-task reply is separate (ADR-0028).
- No exception-list item beyond U-G is created. ADR-0018 C13/C14 still bind: no saved agent identities, no per-agent memory, no agent profiles.
- This ADR does not choose tool names or mechanisms. The design note's `spawn_dispatcher` proposal illustrates one shape; the implementation ticket owns the surface.
- **PRD sections needing amendment (ticket-owned, not amended here):** §4 (S9), §5 (Dispatcher/Worker/Peer definitions and the roles diagram), §6.1 (dispatcher policy), §6.2 (Spawning row), §6.3 (tool table), §7.6 (Phase 2 peers), §16 (glossary).

## Open questions

Questions 1 and 2 have first-implementation answers recorded above; they stay listed so the change is visible. The remaining items are the implementation ticket's:

1. **What bounds mitosis — recursion depth, spawn budget, live-dispatcher cap, or none?** First implementation: no cap of our own; host `maxDepth` (default 1) and the 8-live-child root pool are the bounds. A different bound remains open (see §Starting bounds, "Alternatives left open").
2. **Does a summoned dispatcher speak to the user, its creator, or both?** First implementation: only its creator, because the host gives a subagent child no chat surface. A direct child→user channel remains open.
3. How is a summoned dispatcher addressed and discovered? (The 1:1 peer path and the tail-pushed roster are ADR-0026/0027; identity and addressing remain theirs.)
4. What is the tool surface and its name?

## Traceability

- Ruling: `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 1 (level-1 dated human ruling; the ADR text is the agent's draft of it).
- Bounds evidence: `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q6 (`dsh-subagent/lib/types/index.d.ts:99-104`, `dsh-subagent/lib/index.js:1046-1052`, `:1676`, `:1754-1762`). The values are host facts; the ADR's "no cap of our own" is a first-implementation choice, not a ruling.
- Design input: `.scratch/adr-drafts/2026-10-18-messaging-await-mitosis-design.md` (untracked, disposable; §2 proposes the wording, §8 the mechanism). Its numeric bounds are proposals the implementing ticket weighs.
- ADRs: 0003 (three clauses superseded for the dispatcher→dispatcher edge; worker-leaf, single-parent, no-worker-to-worker retained), 0018 (U-G amended for the dispatcher→dispatcher edge only; C13/C14/C15 untouched), 0019 (per-dispatcher scoped tools bind), 0002 (peers in scope), 0026/0027/0028 (room broadcasting, discovery push, worker mid-task reply).
