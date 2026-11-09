# 292 — The isolated proof that the approval seam exists but is pinned shut

**Status:** open
**Type:** research
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no — this is evidence for a seam nobody is changing any more; the product does not depend on it.
**Blocked by:** nothing. The probe writes its own explicit approval policy at `agent/created`, so it needs neither 289 nor 290 (both cancelled); it is a standalone observation.
**Origin:** 2026-11-09 design lane. `docs/research/child-ask-seams.md` settles the seams by reading; its finding 9 records what reading could not settle. The probe plugin and launch patch already exist at `.scratch/night/live/asks/`.
**Related:** 293 (the honest limit that stays), 294 (the option for the owner — a host change); ADR-0033 (the ask feature was removed), ADR-0036 (recorded by 289/290/291's cancellation); `read-before-running-live-and-browser-tests.md`.

## What this ticket is

This is a **record of a probe run**, not a build task. Nothing here changes `src/`, and no behaviour is proposed. It exists because one claim about the host has only ever been read from source and never observed:

> the `approval/request` waterfall is a real, working answering seam — but on the delegated path the host pin closes it before any listener is consulted.

One live instance, isolated on port 3099, settled it: the observed results are pasted below.

## What the probe does

Boot dsh on port 3099 with `DSH_HOME` under `.scratch/night/live/asks/` and a loader patch that inserts `probe-plugin.mjs`. Under one root agent the probe sets up three cases and drives `ctx.approval.request(...)` directly (no model turn, no credentials):

- **direct** — a child created with `ctx.agents.create({ parentAgent })`, which the host does not pin.
- **control** — a child spawned through the subagent path with the host pin left alone.
- **treated** — a child spawned through the subagent path that receives an **explicit** `approval/policy: 'ask'` append in an `agent/created` listener. The policy is set outright by the probe; it is **not** inherited from the parent, and it is **not** a copy of the parent's policy. This is the point of the probe: it isolates the seam from the inheritance question (which is what 289 got wrong).

## The three things to observe

Each blank is filled from the probe's own log (`.scratch/night/live/asks/probe-out/probe.jsonl`), pasted as a line, not summarised.

- [x] **(i) The listener fires when the policy is `ask`.** The plugin's `approval/request` listener receives the request for an agent whose effective policy is `ask`, and its answer is the outcome the caller sees.
      Observed — the listener's own line, then the ask that returned its answer (`t` = ms since probe start):

      ```json
      {"t":2348,"event":"approval-request-fired","agent":"probe-cdf694-treated","toolName":"probe-tool"}
      {"t":2349,"event":"approval-ask","tag":"delegated-child-explicit-ask","agentId":"probe-cdf694-treated","policyOverride":"ask","openedOwnTurn":true,"outcome":"allowed-once","error":null,"appendError":null,"askMs":1,"hung":false,"listenerFired":true,"firedCount":2,"firedForAgents":["probe-cdf694-direct","probe-cdf694-treated"]}
      ```

      The directly-created child, also with policy `ask`, fired too (`{"t":2281,"event":"approval-ask","tag":"direct-child","agentId":"probe-cdf694-direct","policyOverride":"ask","outcome":"allowed-once","askMs":2,"hung":false,"listenerFired":true}`).
- [x] **(ii) With the host pin the listener does not fire, and the child gets an immediate rejection.** For a delegated child whose policy is still `never`, no listener is consulted and `ctx.approval.request` returns `rejected` at once — it does not hang and does not wait.
      Observed:

      ```json
      {"t":2334,"event":"approval-ask","tag":"delegated-child-host-pin","agentId":"probe-cdf694-control","policyOverride":"never","openedOwnTurn":true,"outcome":"rejected","error":null,"appendError":null,"askMs":1,"hung":false,"listenerFired":false,"firedCount":1,"firedForAgents":["probe-cdf694-direct"]}
      ```

      `firedCount` is still `1` and `firedForAgents` still names only `probe-cdf694-direct`: the control ask reached no listener.
- [x] **(iii) The append at `agent/created` lands before the first turn.** The policy record written in the `agent/created` listener is in the child's log before any turn runs on that child, so a later record wins over the delegation seed.
      Observed — the append record and its sequence numbers, then the child's creation log:

      ```json
      {"t":2344,"event":"agent-created-override","agentId":"probe-cdf694-treated","source":"startup","policyBefore":"never","policyAfter":"ask","turnAlreadyOpenAtHook":false,"seqBefore":3,"seqAfter":4}
      {"t":2347,"event":"treated-child-created","childId":"probe-cdf694-treated","liveAgent":true,"policyOverride":"ask","hookRan":1,"turnAlreadyOpenAtHook":false}
      ```

      The hook read the policy as `never`, appended `ask`, and the next read saw `ask` (`seqBefore` 3 → `seqAfter` 4); no turn was open at either check.

## What the probe did not show

What the child received in (i) was the listener's own fixed outcome string (`allowed-once`), returned in-process by the probe — not a value round-tripped from a parent agent: no request id was minted, nothing was persisted, and no parent turn ran. A genuinely parent-answered ask would need a request id, a store, a parent-facing answer tool and a later parent turn; none of those exists, and the probe does not stand in for them.

## Acceptance criteria

- [ ] The three observations above are filled in from a real run, each with its log line pasted, or the ticket states plainly which one the probe could not produce.
- [ ] The run is recorded as having used an **explicit** `'ask'` policy on the treated child, written by the probe — not an inherited policy, not the parent's.
- [ ] Teardown confirmed: the 3099 process is gone, the port is free, and a listening-socket check is recorded.
- [ ] `.scratch/night/live/` is confirmed gitignored (`git check-ignore -v`) and the git status after the run is unchanged apart from this ticket and the generated index.
- [ ] 3080 is untouched: no request was sent to it, and the owner's instance is still serving afterwards.
- [ ] If an observation contradicts the reading in `docs/research/child-ask-seams.md`, that is written down here; the probe is not adjusted until it agrees.

## Constraints

- Never bind, probe, restart, or stop 3080. Port 3099 only, and refuse to start if 3099 is busy.
- Kill timer set at launch, not at teardown, per `read-before-running-live-and-browser-tests.md`. Trivial task only; never burn the human's tokens.
- Throwaway home under `.scratch/night/live/asks/`. Do not copy the human's dsh key anywhere; use the installed host as-is.
- No source change in this ticket and no commit of any artifact: the probe lives in `.scratch`, and this ticket records what was seen.
- This ticket does not reinstate 289, 290 or 291. It observes a seam; it does not propose using it. Any use is 294's question and the owner's decision.

## Comments

2026-11-09: Filed from the design lane as a build task, then rewritten the same day into the record of the probe. The un-pin approach it was originally blocked on is dead (see 289 and 290), but the seam question itself is worth an honest observation, and the probe already exists at `.scratch/night/live/asks/`. The result blanks were deliberately empty at filing.
2026-11-09: The three observations are now filled from `.scratch/night/live/asks/probe-out/probe.jsonl` (17 lines), pasted as log lines; the constraints above are unchanged, and the "What the probe did not show" section states the one thing the run cannot support.
