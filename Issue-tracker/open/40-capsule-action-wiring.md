# 40 — Wire capsule intents to the verified seams: start, per-row steer, conversational stop (epic 35 §2)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 36 (the seam verdicts), 39 (the intent callbacks exist).

## Context

Epic 35: the activation button "calls the same command path, it must not
invent a second activation channel" (ADR-0009); the roster's per-row steer
affordance opens the steer input (transport stays the shipped
`/dispatcher-steer` host command → core last-wins queue, `src/adapter/steer-command.ts`).
The client composes user-visible command text and submits it through the
**user's own send path** — it never calls core/adapter internals directly
(design-16 §3.4: the panel stays presentation-only).

If ticket 36's verdict for a seam is "degraded" (no verified path), this
ticket shrinks honestly: implement the degrade UX (copy + command hint, e.g.
"type /dispatcher-start in this chat") and record the gap in the epic comment
— the ticket is still resolvable.

**Tree rule:** same as ticket 38 (worktree branch until 33 merges).

## Requirements

- Define the transport seam ticket 36 verified (e.g. a narrow
  `CommandTransport` interface: `send(sessionRef, text): Promise<result>`),
  bound at module composition time (`src/client/index.ts`), injectable for
  tests.
- **Start intent** (39's `onActivationIntent("start")`) → submits
  `/dispatcher-start` verbatim through the user send path — identical to the
  user typing it; the host command registry does the rest.
- **Per-row steer affordance** → opens the steer input prefilled with
  `/dispatcher-steer <workerId> ` (exact-target power path, never required by
  copy); via composer focus/prefill if verified, else copy-into-composer hint.
- **Stop intent** (`onActivationIntent("stop")`) → submits the conversational
  stop phrasing (design-17 §7 copy, new locale keys) through the same path —
  never a direct core stop call.
- Failure handling: a failed send renders honest error copy; no optimistic
  fake success, no retry loop, no invented queue (host owns the composer
  journal — design-17 conflict 9).
- All affordance copy through locale, both faces; validator green.

## Acceptance criteria

- [ ] New `test/client-capsule-actions.test.ts` with a fake transport: start
      submits the exact `/dispatcher-start` text; steer prefills
      `/dispatcher-steer <workerId> `; stop submits the conversational phrasing
      (asserted via locale keys, not literals); failure path renders error copy
      and flips no state to "success".
- [ ] Guard: no client code path calls core/adapter internals — the transport
      is the only egress, and its test double proves the client works with a
      fake (offline, S8).
- [ ] Degrade branch tested for any seam ticket 36 marked unverified.
- [ ] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green; host face untouched.

## Verification

Named method: `npm test` (new actions suite + `steer-command`,
`stop-semantics`, capsule regressions), `npm run typecheck`,
`npm run build:client`. End-to-end send-path truth is asserted live in ticket
33's browser pass.
