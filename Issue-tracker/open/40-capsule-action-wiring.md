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

- [x] New `test/client-capsule-actions.test.ts` with a fake transport: start
      submits the exact `/dispatcher-start` text; steer prefills
      `/dispatcher-steer <workerId> `; stop submits the conversational phrasing
      (asserted via locale keys, not literals); failure path renders error copy
      and flips no state to "success".
- [x] Guard: no client code path calls core/adapter internals — the transport
      is the only egress, and its test double proves the client works with a
      fake (offline, S8).
- [x] Degrade branch tested for any seam ticket 36 marked unverified.
- [x] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green; host face untouched.

## Verification

Named method: `npm test` (new actions suite + `steer-command`,
`stop-semantics`, capsule regressions), `npm run typecheck`,
`npm run build:client`. End-to-end send-path truth is asserted live in ticket
33's browser pass.

## Comments

### 2026-09-18 — agent team (implementation, worktree `clone/always-on-dispatcher` @ `98991a8`)

All ACs checked. Worktree commit `98991a8` ("Ticket 40: wire capsule intents
to verified seams"), 8 files (2 new). **Gates** (worktree, all green):
`npm test` **668 pass / 0 fail / 176 suites** (delta over the ticket-39
baseline 645/0/170 is exactly the 23 new tests in 6 new suites; all
regressions — `steer-command`, `stop-semantics`, `activation-lifecycle`,
capsule/roster suites — pass untouched), `npm run typecheck` clean on both
configs, `npm run build:client` green (55909-byte bundle vs 46451 at 39).
Host face untouched (`git status`: only `src/client/**` + tests). Legal QA
grep over every changed file for the reconstruction identifiers: clean.

What landed:

- **`src/client/actions.ts` (new)** — the ONE egress: `CommandTransport`
  (two verbs, see deviation 1), `bindCommandTransport` over lazy service
  sources, `sendActivationIntent(transport, currentSessionId, intent,
  stopMessage)`, `tryPrefillSteer`, `steerCommandPrefill` (exact
  `/dispatcher-steer <workerId> ` with trailing space),
  `activationOutcomeCopyKey` (`sent` → **null** — no fake success), the
  `CapsuleActionStatus` notice store (carries only a copy key or null — no
  success state exists), and the ticket-40 locale key consts.
- **`src/client/index.ts`** — binds the transport + both seats at module
  composition time inside the existing `shell.overlay` inject; entry id and
  Cordis-level `inject` list unchanged.
- **`src/client/capsule.tsx`** — `createDispatcherCapsule` gains the 5th/6th
  factory params (`actionStatus?`, `onRowSteer?`); renders the honest
  failure line under the activation row; ticket-39 defaults preserved.
- **`src/client/panel.tsx`** — `createRosterPanel(t, store, onSteer?)`; each
  non-finished row gets a Steer affordance (prefill seat, never a sender)
  that pairs a successful prefill with the review-and-send hint, or the
  copy-only fallback when the draft is unreachable.
- **`src/client/overlay.ts`** — 7 new keys, both faces, validator green
  (scaffold key-set pin extended): `capsule.stop.message` (SUBMITTED
  conversational ask, matching ticket 31's stop/course-change policy rule,
  design-17 §7), `capsule.action.send-failed` / `.not-available` /
  `.no-channel` (the only notices the capsule renders), `roster.steer.button`
  / `.hint` / `.copy-fallback`.
- **`src/client/context.ts`** — optional structural faces for
  `remote` / `sessions` / `conversation` (+ scoped conversation sink).
- **`test/client-capsule-actions.test.ts` (new, 23 cases / 6 suites)** —
  exact payloads, degrade matrix, no-success-state guards, and a source-scan
  egress guard (wiring modules import no `../core`/`../adapter`; no
  host-side `subagents`/`sendMessage`/`steerWorker`/`stopWorker`/
  `interruptWorker` references — the steer transport stays host-side).

Exactly which transport each intent uses (verified against the installed
0.1.5-rc.1 tree, ticket 36's method):

- **start** → `ctx.remote.commands.execute(sessionId, "/dispatcher-start",
  [])` — the composer's exact command transaction, current session resolved
  at click time via `ctx.sessions.list.getSnapshot().current` (shipped read
  idiom, ui-conversation `lib/client.js:16562`). ADR-0009 holds: no second
  activation channel.
- **stop** → the scope-addressed plain-prompt sink
  `ctx.sessions.scope(currentSessionId).conversation.send(<locale-keyed
  phrasing>)`. This addressing is the HOST's own documented pattern for
  root-scope plugins — the host throws
  "conversation.send requires a session scope — address one via
  ctx.sessions.scope(id).conversation" (ui-conversation `lib/client.js:
  3170-3182`), the same scope mechanism seam 3 verified.
- **steer** → prefill only: `ctx.conversation.input.for(actx).setDraft()`;
  focus not exposed (seam 3 verdict), so prefill + hint; the actual steer
  transport is unchanged and host-side (`/dispatcher-steer` → core
  last-wins queue).

Deviations / recorded decisions (honest, per ticket):

1. **The ticket's single `send(sessionRef, text)` example did not survive
   verification — the transport is ONE interface with TWO verbs.** Verified
   fact: the command endpoint returns `undefined` for a line that parses to
   no command ("returns `undefined` when syntax or name does not resolve",
   dsh-commands `lib/index.js:205-231`) — routing the conversational stop
   phrasing through it would silently do nothing. Conversely the prompt sink
   does not execute commands (seam note §2 caveat b). So start MUST ride
   `commands.execute` and stop MUST ride the prompt sink. Both are shipped
   product faces — nothing was invented; the deviation is interface shape
   only, and the AC's intent (a narrow injectable transport, the only
   egress, fake-proven offline) is met.
2. **Boot-time inject lists unchanged** (Cordis `["slots", "locale"]`;
   package.json `dsh.client.inject` untouched). `remote`/`sessions`/
   `conversation` are read lazily at send/click time via optional structural
   faces — the settings-watch runtime-dynamic idiom. ADR-0014's smallest-set
   rule: these are core services that materialize with the shipped web
   composition regardless (connection/composer), and declaring them would
   add arrival coupling; a runtime without them degrades to honest
   `no-channel` / copy-fallback instead of a dead seat.
3. **Steer affordance renders on non-finished rows only** — steering a
   settled worker is refused host-side (`not-running` copy exists), so
   offering the button on finished rows would be dishonest. Ticket did not
   specify row eligibility.
4. **Hint renders after a SUCCESSFUL prefill too** (not only as fallback) —
   seam 3's verdict: "prefill + a locale hint is the honest composition"
   because focus is not exposed; the user must review and send.
5. **Stop still carries no kill authority** — the submitted text is an ask
   resolved from `capsule.stop.message`; capsule view models and ticket
   31/39's no-stop guard are untouched (all guards re-ran green). A `sent`
   outcome renders nothing: the roster feed is the only activation success
   truth, and the dispatcher's conversational confirm is the stop's.
6. **Degraded seams note:** ticket 36's degraded verdicts (Settings
   deep-link, profile identity) belong to ticket 42's footer, which does not
   exist yet; ticket 40's own seams (2 and 3) are verified, and every
   unreachable-face edge (no session, no scope, no service, throwing write)
   has a tested degrade branch.

Ticket 41/42 notes: the notice line and per-row affordance are in place;
footer/deliverables still absent; the action-status store is reusable for
any future send UX. End-to-end send-path truth remains ticket 33's browser
pass (offline here per its FORBIDDEN-live rule).
