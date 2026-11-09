# 295 — Approve a worker's asks by un-pinning the child's approval policy

**Status:** cancelled
**Type:** task
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no — today a worker that needs an approval gets a hard error; this removes that dead end.
**Blocked by:** nothing.
**Origin:** `docs/research/child-ask-seams.md` (findings 1–3, 6) and the 2026-11-09 lane decision: answer child asks through the parent instead of accepting the host pin.
**Related:** 296 (answers the request this ticket makes possible), 292 (live proof), 293 (the asks that stay unreachable); ADR-0033 (removed the old access-ask relay), ADR-0011 (the approval policy seam).

## Problem

A delegated child is pinned to approval policy `never`: the capture returns `"never"` at `dsh-subagent/lib/index.js:414`, the child's log gets an `approval/policy` event at `:431-434`, and it is applied from the child's setup at `:1807`, before the first turn. The approval service then returns `"rejected"` before its waterfall whenever the policy is `never` (`dsh-user-approval/lib/index.js:197-201`), so a would-prompt action becomes a hard error and no approval request is ever created.

Sandbox is not the gap. It is already inherited from the parent (`dsh-subagent/lib/index.js:413` with `dsh-sandbox-policy/lib/index.js:180-182`); the pin is the only thing missing.

The pin is overridable without host changes. The session store is a public service (`dsh-session/lib/types/index.d.ts:28`) and it appends (`:286`); approval policy is a last-write-wins fold read per ask (`dsh-user-approval/lib/index.js:58-63`, `:177-179`); and `agent/created` is awaited before the first turn (`dsh-agent/lib/types/runtime-types.d.ts:242-254`). So at `agent/created`, for a session this plugin spawned as a worker, append the parent session's effective approval policy onto the child. The later record wins and the child stops being pinned. No host change, no new config.

## Acceptance criteria

- [ ] At `agent/created`, a child this plugin spawned as a worker receives the parent session's effective approval policy as an appended `approval/policy` record.
- [ ] Unit test with the fake host: the append happens for our worker session, and the child's effective policy afterwards is the parent's, not `never`.
- [ ] Unit test: no append for the owner's own session, and none for a child this plugin did not spawn (a summoned dispatcher, or a child created by someone else).
- [ ] Unit test: when the parent's policy cannot be read, nothing is appended and the host pin stands — fail closed, never guess.
- [ ] No new config, flag, or setting: the behaviour is the product.
- [ ] `npm run typecheck` and `npm test` pass.

## Constraints

- Write only through the public session store. Do not patch the host, the vendored tree, or `dsh-subagent`.
- Leave sandbox inheritance alone; it already works and is not part of this change.
- Extend the existing `agent/created` path in the adapter (`src/adapter/cordis-dsh-host.ts`); do not add a second listener that could double-append.
- Scope is our worker spawns only. Answering root asks here would preempt the browser UI (`child-ask-seams.md` finding 8).
- The append is a policy record, not a grant: no tool is allowed by this ticket, only the ask that 296 answers.

## Comments

2026-11-09: Filed from the design lane; no code written yet.
2026-11-09: Cancelled at the owner's channel — the un-pin is a no-op on this deployment: the parent's own effective approval policy is 'never' (preset danger-full-access → never, defaultPreset), so copying it onto a child writes 'never', which is the host pin. See `docs/adr/0036-delegated-child-ask-needs-host-change.md` (proposed, pending owner confirmation); the delegated-child pin itself is recorded in `docs/adr/0033-worker-access-ask-removed.md`.
