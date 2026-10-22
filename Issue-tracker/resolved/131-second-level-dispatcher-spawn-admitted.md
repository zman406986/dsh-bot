# 131 — Second-level dispatcher spawn is admitted: the host depth ceiling never refuses a mitosis hop

**Status:** resolved
**Labels:** needs-info
**Deferred:** 2026-10-22 — blocked on a human decision: current behavior is ADR-0025-ruled (no mitosis bound of ours); see the 2026-10-22 comment for citations and both unblock options.
**Blocked by:** nothing
**Related:** ticket 118 (verification pass, 2026-10-22 — Finding 1; its test list expects a refusal that does not happen), ADR-0025 (§Starting bounds and §Alternatives left open — "the host's depth and pool values are what stop it"; no recursion gate of ours), ADR-0003 (the worker-leaf rule, untouched), ticket 130 (the related but separate identity gap)

## Contradiction

Ticket 118's test list expects "a second-level dispatcher spawn is refused by the **host depth ceiling**, not by a gate of ours". The shipped code does no such thing. The spawn is admitted at every generation.

**Why.** `dispatcherSpawnMaxDepth(parentDelegationDepth)` returns `parentDepth + 2` (`src/worker/agent-def.ts:105-107`) and is recomputed from the parent's own depth on **every hop**. The host's rule (`resolveChildDepth`, extracted 0.2.1 tree `deepseek-ai-dsh-subagent-0.2.1-rc.2/lib/index.js:279-284`) computes `childDepth = parent's delegationDepth + 1` and refuses only when `childDepth > maxDepth`. Because the caller raises the ceiling in lockstep with the tree, the inequality never becomes true on a dispatcher hop.

**Measured, from the shipped derivation:**

| Parent depth | Ceiling requested | Dispatcher child lands at | Its workers land at |
|---|---|---|---|
| 0 | 2 | 1 (admitted) | 2 (admitted) |
| 1 | 3 | 2 (admitted) | 3 (admitted) |
| 2 | 4 | 3 (admitted) | 4 (admitted) |
| 3 | 5 | 4 (admitted) | 5 (admitted) |
| 4 | 6 | 5 (admitted) | 6 (admitted) |

The pattern continues without a ceiling. **The only remaining bound on mitosis depth as shipped is the host's 8-slot live-child root pool.**

The depth wall that does exist is a different one, and ticket 118 already records it: a hop sent a ceiling that was **not** raised is refused (parent depth 2 with `maxDepth: 2` → `subagent depth 3 exceeds maxDepth 2`, `subagent depth 2 exceeds maxDepth 1` in the other measured case). Our spawn path always raises it, so that wall is never hit by us.

## Why this is not a code bug

ADR-0025 §Starting bounds says the host's `maxDepth` and the 8-active-subagent root pool are the **only** bounds, and that we add no cap of our own. §Alternatives left open adds that "a child dispatcher may itself summon another dispatcher; the host's depth and pool values are what stop it" — and that adopting a generation limit "needs its own ticket stating the tradeoff, not a fresh ruling". Ticket 118's "What to do" carries the same prohibition in stronger words: no `recursion-limit`, no `dispatcher-cap`, no generation counter, no durable spawn budget.

So the code matches ADR-0025 on the "no gate of ours" half and contradicts the ADR's other half only in the sense that the depth value does not stop a dispatcher hop either. The ADR text and the shipped derivation cannot both be right about depth being a bound on mitosis.

**If the owner wants a generation limit, it needs an ADR amendment, not a code patch.** Adding a gate without amending ADR-0025 would break a recorded decision.

## Options (this ticket picks none)

1. **Leave as shipped.** Mitosis runs until the 8-slot pool refuses. Record that depth is not a mitosis bound in ADR-0025's §Starting bounds, so the text stops implying it. No code moves.
2. **Amend ADR-0025 with a generation bound.** Decide a maximum generation (1, 2, …) and how it is enforced — a `recursion-limit`-class refusal, a durable counter, or something else. This is the option ADR-0025 explicitly reserved a ticket for. It requires the ADR to change first, then the code.
3. **Adjust ticket 118's text if the expectation was simply wrong.** If the original intent never was "the host stops it at generation 1", correct the test clause to say what the code does and close the contradiction as a documentation error. Cheapest, but only honest if the owner agrees the expectation was mistaken.

Options 1 and 3 overlap; 2 is the only one that changes behaviour.

## Evidence

- Derivation: `src/worker/agent-def.ts:105-107`; comment above it (`:88-98`) states the `parentDepth + 2` idiom and cites ADR-0025.
- Host rule: extracted 0.2.1 tree `deepseek-ai-dsh-subagent-0.2.1-rc.2/lib/index.js:279-284` (cited from ticket 118's verification pass; the tree is not vendored in this repo).
- Call site: `src/adapter/cordis-dsh-host.ts:1084-1089` reads the parent's `delegationDepth` (`?? 0`) and passes the derived ceiling.
- Test that records the truth: `test/spawn-dispatcher-activation.test.ts:606` — title says "admitted", body asserts `second.ok === true` with `maxDepth: 3`; the same test shows the host refusing an unraised ceiling. So the repository already pins the real behaviour while ticket 118's header pins the opposite expectation.
- Pool: 8-live-child root pool, `ACTIVATION_LIMIT_REACHED`; ADR-0025 §Starting bounds cites `dsh-subagent/lib/index.js:1046-1052`, `:1676`.

## Constraints

- **No gate may be added under this ticket.** ADR-0025 forbids `recursion-limit`, `dispatcher-cap`, generation counters, and durable spawn budgets. Option 2 requires an ADR amendment first.
- No change to the worker path, no change to ADR-0003's worker-leaf rule.
- No source edit is needed for options 1 or 3; option 2 is a records change followed by a ticket.

## Comments

### 2026-10-22 — filing

Filed from ticket 118's verification pass (its 2026-10-22 comment, "Finding 1"). Chunk 3 had already measured it and recorded it as a finding without adding a gate; the verifier confirmed it against the shipped derivation and the host's `resolveChildDepth`. Ticket 118's own test list still expects a refusal, and its test file records the truth, so the contradiction sits inside that ticket. It is filed separately because the resolution is an owner ruling, not a chunk of implementation work. Labelled `needs-triage` for that reason.

Ticket 118 was not edited. Its `Status: claimed` and test list are left as they are.

### 2026-10-22 — dispatched as an implementation task; stopped before any code change

An overnight dispatch framed this as a code bug: replace the per-hop `parentDepth + 2` with an absolute module constant so that a depth-2 dispatcher cannot spawn a depth-3 dispatcher. **Not implemented.** The dispatch itself said the ADR and this ticket are the source of truth; both refuse the change:

- ADR-0025 §Starting bounds (line 61) **requires** `maxDepth = parentDepth + 2` per hop and calls it "a required implementation detail, not a bound of ours". §Alternatives left open (line 65) keeps "generation 1 only … a `recursion-limit`" as a proposal only: "adopting one needs its own ticket stating the tradeoff". §Consequences (line 70): "The first implementation adds no bound of ours."
- This ticket's Constraints (line 54): "**No gate may be added under this ticket.** ADR-0025 forbids `recursion-limit`, `dispatcher-cap`, generation counters, and durable spawn budgets." Option 2 (the only behaviour-changing option) "requires an ADR amendment first" (lines 39, 34). No ADR-0025 amendment exists in the tree; the ADR index's last note (2026-10-21) says "mitosis proceeds under ADR-0025 unchanged".
- Accepted ADRs outrank ticket rulings in the authority stack, so this ticket cannot authorise the gate even if it wanted to. It has no acceptance checkboxes; it is a decision ticket that "picks none".

**The requested semantics cannot be delivered through the host's ceiling anyway.** The host's only test is `parentDepth + 1 > maxDepth`, applied to every child kind. ADR-0025 line 61 also requires that a spawned child dispatcher keep its worker hop. So a dispatcher at header depth 1 must be admitted to spawn a worker at depth 2 (`maxDepth >= 2`), while the same parent's dispatcher child also lands at depth 2. The host cannot tell a worker child from a dispatcher child, so no value of `maxDepth` admits the worker hop and refuses the dispatcher hop. Any "depth 2 may not spawn depth 3" rule is a check in `spawnDispatcher` — a gate of ours.

The only gate-free cap is `maxDepth = min(parentDepth + 2, MAX)`, and it does not give the requested shape either: with `MAX = 2` a depth-1 dispatcher is admitted at depth 2 but its workers at depth 3 are refused, i.e. the second-level dispatcher becomes a worker-less leaf, contradicting line 61.

Code unchanged: `src/worker/agent-def.ts:105-107` still returns `parentDepth + 2`; the call site is `src/adapter/cordis-dsh-host.ts:1245-1246`. Baseline re-run green: `test/spawn-dispatcher-host.test.ts` 9/9, `test/spawn-dispatcher-tool.test.ts` 22/22. The behaviour pinning the current truth stands at `test/spawn-dispatcher-activation.test.ts:606`.

**To unblock**, the owner or a records pass must do one of: (a) amend ADR-0025 with a chosen generation bound and its tradeoff, then file the code ticket — this ticket's option 2; or (b) record that depth is not a mitosis bound and trim ADR-0025 §Starting bounds and the PRD's "host's depth ceiling and live-child pool" wording — options 1/3. Either way the records move first. Ticket stays open.

### 2026-10-22 — deferred by agent ruling (subject to human reversal)

Deferred 2026-10-22 by agent ruling (subject to human reversal), which supersedes the "ticket stays open" line above. This is not a defect: admitting a second-level dispatcher spawn is ruled intended by accepted ADR-0025, which mandates `maxDepth = parentDepth + 2` per hop and forbids any gate of ours, and `test/spawn-dispatcher-activation.test.ts:606` already pins the behaviour. Unblocking needs a dated human ruling on file, either (A) an ADR-0025 amendment choosing a generation bound and stating its tradeoff, which then needs a code ticket, or (B) a dated ruling that depth is not a mitosis bound, plus trimming the stale "host depth ceiling" wording in ADR-0025 §Starting bounds and PRD lines 136, 150, and 434. The 2026-10-22 comment above carries the full citations for both paths; this comment records only the parking decision. Move back to `open/` when that ruling lands.

### 2026-10-22 — resolved by owner ruling

The owner ruled on 2026-10-22 (spoken, this date): the unbounded mitosis hop is **not a problem** — no depth cap is wanted. This is the dated human ruling the deferral was waiting for, and it picks neither unblock option because neither change is wanted: ADR-0025 stays as accepted (no bound of ours), no ADR amendment, no PRD trim. The behaviour pinned at `test/spawn-dispatcher-activation.test.ts:606` stands as intended. A matching dated note was appended to ADR-0025 §Alternatives left open. Ticket closed; nothing to implement.
