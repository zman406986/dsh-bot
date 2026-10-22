# 131 — Second-level dispatcher spawn is admitted: the host depth ceiling never refuses a mitosis hop

**Status:** open
**Labels:** needs-triage
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
