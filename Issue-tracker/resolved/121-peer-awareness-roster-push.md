# 121 — Peer awareness: tail-pushed roster with liveness

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (independent of the 0.2.1 port)
**Related:** ADR-0027 (§Settled identity and dispatch), ADR-0025 (mitosis creates the peers the roster lists), ADR-0026 (rooms are a separate channel), ADR-0010 (presence-as-projection precedent), ADR-0018 C13 (no identity roster)

## Problem

An agent learns who exists only by already knowing a tool exists. `send_peer` needs a session id the dispatcher cannot get on its own, `fromName` is just the session id, and nothing in the prompt lists peers or their state. ADR-0027 rules discovery in, pushed at the prompt tail.

## What to do

- [x] Build a peer roster projection from live state: one row per eligible session, with **session id as the key**, `subagent.label` as the label, and a status shape.
- [x] **Identity rules, as settled in ADR-0027:** session id is the only identity; `subagent.label` is the only durable label; read it through `projectionValues.subagent.label` (per-session snapshot). Display fallback: label → session title → session id. Do not add a user-assigned name field.
- [x] **Kind rules, as settled:** a worker is `origin === "subagent"`; a dispatcher is `agentPreset === "multitask-dispatcher"` **only after this ticket verifies that such a preset exists and lands on live dispatcher sessions**. Until verified, do not claim the kind; list the row and record the reduced shape honestly.
- [x] Inject the roster at the **prompt tail**, after the stable prefix, so the cached prefix survives. Pin with a test that the roster text rides only in the tail and that the prefix stays byte-stable across turns.
- [x] Include liveness and current activity, targeting the `statusOf` shape: **working / waiting / approval / idle**, plus current tool and current target. Ship only the statuses that are actually observable on dsh 0.2.1; a test should pin the observable set and the text must not invent a status it cannot see.
- [x] Fail closed and cheap: if peer state cannot be read, the tail says less or nothing. The turn and the prefix must never fail because the tail could not be built.
- [x] Decide and record whether workers appear in the roster (ADR-0027 open question 2). Whatever is chosen must respect that workers are leaves.
- [x] Refresh point: per-turn prompt assembly. Bound the cost of assembling and diffing the roster; record the bound.

## Open questions this ticket must answer (ADR-0027's list)

1. Where in the tail the roster sits relative to standing rules and reminders.
2. Whether workers are listed, and how a summoned dispatcher appears.
3. The refresh point's cost bound.
4. Which of working / waiting / approval / idle are actually observable on the installed host.
5. Whether a dispatcher preset exists to carry the kind (shared with ticket 118).

## Constraints

- Injected text, not a tool call. No directory tool (C13).
- No saved identities; the roster is derived from live state every turn.
- No local store, no search index (ADR-0018 U-H).
- The status vocabulary becomes shared text; product copy is this ticket's.
- Offline tests only; the prompt-assembly path is unit-testable with the existing harness.

## Comments

### 2026-10-18 — filing

Filed for ADR-0027's human ruling, whose identity, label, and dispatch questions were settled on 2026-10-18 (`.scratch/repo-analysis/2026-10-18-open-questions-resolved.md` §Q2/§Q4). No source was edited in this records pass.

The `agentPreset` kind check is written as a verification because the working tree currently has no dispatcher preset row and workers inherit the parent's preset — the mechanism is sound, the precondition is not yet true.

## Answer

Resolved 2026-10-21 — audited against the shipped tree; every claim below was spot-checked at the cited line.

**Shipped.** The roster projection, renderer, and tail append live in `src/core/policy/assembler.ts`: the four-state liveness vocabulary `working / waiting / approval / idle` (`PeerLiveness` :98-106) with derivation precedence approval > working > waiting > idle (`derivePeerLiveness` :137-142); `PeerRosterEntry` (:155-163) keyed by session id, with `label` (= `subagent.label`), `title`, liveness, and the activity / currentTool / currentTarget facts; `buildPeerRosterSnapshot` (:251-269); the deterministic renderer (:299-351 — sort by session id, dedupe, self-exclusion, hard 20-row cap reusing the check-roster constant `TOOL_RESULT_SUMMARY_MAX_ROWS` = 20 at `src/core/report-clamp.ts:35`, overflow stated as an explicit count line :345-349, never a truncated row); and `appendPeerRosterTail` (:278-284), which returns the input byte-identical when there is no roster. Display fallback is label → title → session id (:192-195, :333-337).

**Tail placement and prefix stability.** Inside the per-turn reminder the roster is the last section, after the ledger and standing rules (`assembler.ts:80-88`); on wake turns `appendPeerRosterTail` puts it at the true tail, after reminder + wake + inbox (:271-284). The adapter feeds it once per turn on the running flip (`src/adapter/parent-agent.ts:282-294`), from live facts only — `wakeBus.isBusy`, `listPendingAccess`, `wakeBus.peek` (:243-253). Byte-stability of the cached prefix is pinned by tests: the text before the roster is identical with 0 and with 20 peers (`test/policy-peer-roster.test.ts:229-249`), an empty roster leaves the reminder byte-identical (:74-77), and consecutive renders of the same state are byte-identical (:176-195).

**Answers to ADR-0027's open questions this ticket owned:**

1. **Placement** — the roster is the LAST section of the prompt: after standing rules inside the turn reminder, and after the wake/inbox blocks on wake turns (citations above). Nothing rides below it.
2. **Workers are NOT listed.** Recorded choice: eligible peers are the OTHER activated dispatcher sessions only — workers are leaves (ADR-0003) already visible through the ledger and `check_workers`, and listing them would invite peer sends to sessions that never drain a peer inbox (`assembler.ts:245-249`, `parent-agent.ts:234-242`). A summoned dispatcher appears by activation: rows come from the activated-session map, self excluded.
3. **Refresh point and cost bound** — once per turn start (the `agent/status` → running flip), not per request (`parent-agent.ts:282-294`). The bound: a pure synchronous render — no I/O, no clock, no async (`assembler.ts:166-175`, :289-294) — one sort over the activated sessions, capped at 20 rows. No diffing is needed: unchanged state renders byte-identical text (test-pinned, above).
4. **Observable statuses** — exactly three observable facts exist on this host (`busy`, `pendingApproval`, `queuedWake`; `assembler.ts:110-124`), and all four vocabulary states derive from them, so the full set ships. `waiting` honestly means "a wake is ready and no turn is running", not a model-level wait (`assembler.ts:122-124`); any foreign value renders `unknown`, never a coerced state (:197-204; test :369-380).
5. **Dispatcher kind — answered by a DIFFERENT mechanism than this ticket assumed.** The assumed `agentPreset === "multitask-dispatcher"` preset does not exist and cannot carry the kind: `src/client/index.ts:300-305` records that "`agentPreset` is unusable here (every durable header reads \"standard\")". The dispatcher identity instead rides the durable sessionKind projection (`src/adapter/session-kind-projection.ts`), which folds the `command/run` + `command/done` pair the host's `/dispatcher-start` command already appends to the invoking session's own log (:16-44; pure fold `applySessionKindProjection` :179-238), publishes the wire value `"dispatcher"` under `projectionValues.sessionKind` (:241-245), survives restart via the projection-cache persistence (:55-64), and marks only on a success settlement — fail closed (:42-44). The roster itself needs no per-row kind: eligibility (activated dispatcher sessions only) already decides what appears.

**Fail-closed and cheap.** The renderer returns `null` on empty/junk input and `appendPeerRosterTail` leaves the text unchanged (`assembler.ts:302-320`, :278-284); malformed rows are skipped and unknown statuses degrade honestly; the no-throw posture is pinned by tests (`test/policy-peer-roster.test.ts:369-380`, :407-411). The injected copy is provenance-honest: "Other agents — not the user" (`src/core/policy/prompts.ts:76`).

Tests: `test/policy-peer-roster.test.ts` — tail placement + prefix byte-stability, the cap-20 convention (:197-199) with the overflow line (:202-217), honest `unknown`, the fallback chain, determinism.
