# 295 — The activation confirmation is invisible: one clipped command line, never the full text

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Severity:** P2 / medium — activation works, but the user cannot read what it told them.
**Ship blocker:** no — activation itself is correct; the confirmation is unreadable.
**Blocked by:** nothing.
**Origin:** 2026-11-10 verification pass against the installed host's command and chat code plus a reproduction against our own adapter.
**Related:** 44 (host-half commands unregistered by inverted `ctx.effect` usage), 134 (activation copy: the workers panel does not exist), 170 (prompt-pass dead-end reporting and start ack), ADR-0009 (activation is an explicit command), ADR-0032 (a summoned dispatcher is a parallel session — appendix on what a bare `user/message` append does and does not do).

## Problem

`/dsh-bot` announces success with a 208-character sentence and no newline, so the chat draws it as one collapsed line with an ellipsis and gives the user no way to read the rest.

- The copy is `DISPATCHER_START_SUCCESS` (`src/adapter/activation-command.ts:51-54`): the activation sentence, the `/dispatcher-steer` hint, and `ACTIVATION_PRESENCE_HINT` (`:46-48`). 208 characters, one line, no `\n`.
- It reaches the chat only as a **command result**. The host persists `command/run` and `command/done` (`dsh-commands/lib/index.js:334-351`, installed package), and the chat renders that as `GenericCommandCard` (`dsh-client-ui-chat/lib/client.js:8482-8545`, installed package). Its collapsed row is `summary = outcome.text` (`:8485`, `:8494-8506`) with nowrap + ellipsis, and `body` exists only when `text.includes("\n")` (`:8489`). Our text has no newline, so `body` is `null` and `open` is always false (`:8490`): the row can never expand.
- Activation's only other write is a **model-facing** context inject — `tryInject` (`src/adapter/parent-agent.ts:59-72`) from the `policyEnabled` block in `bindActivation`. That message is the policy; it is not a confirmation, and it is deliberately not user copy.
- Reproduction: `.scratch/testing/2026-11-10-activation-feedback/repro-activation-feedback.ts` exits 1 with `chat-message writes carrying the activation confirmation: 0` — every surface write during a successful activation was inspected; none carries the confirmation text.

Result: after `/dsh-bot` the user sees one line ending in an ellipsis, cannot expand it, and so never learns where results arrive or that `/dispatcher-steer` exists — the two facts `ACTIVATION_PRESENCE_HINT` was added (ticket 32/134) to deliver.

## Why the obvious routes are wrong

- **`agent.followup`** is the next-turn inbox plus `wakeDriver` (`dsh-agent-loop/lib/index.js:570-572`, `:564-569`, `:618-632`, installed package): it starts an LLM turn. Spending a model call to print a confirmation is not acceptable, and the turn would then have to be answered.
- **Adding a newline to `DISPATCHER_START_SUCCESS`** would let the card expand, but it changes the returned `CommandResultLike`, which `test/composition-polish.test.ts` pins byte-for-byte (`:375`, `:517`), and the collapsed row would still be a truncated first Line.
- **Client-side rendering** (a bespoke card, or locale strings) is out of scope: the client is another worker's lane and the copy is server-side.

## Decision: a model-free surface append, next to the command result

`session.append("user/message", data, { surfaceOp: "append" })` is the host primitive that adds a **visible, model-readable** message without touching the inbox and without waking the driver (`dsh-session/lib/index.js:1524-1535` and the surface planner at `:442-445`, installed package; the property is stated in `docs/adr/0032-summoned-dispatcher-is-a-parallel-session.md:56` and this repo already uses the port at `src/adapter/microcompact.ts:502-509`). ADR-0032 rejected that call as a **delivery** route because "it renders and nothing runs"; here rendering is exactly what is wanted, so the rejection does not apply.

- **Payload form:** `form: "notice"` with a `summary` string renders as a compact one-line context row whose summary is always readable and whose body is the full text (`dsh-client-ui-chat/lib/client.js:5690-5696`, `:5652-5655`, installed package). That is the shape the host itself uses for `model-selection` and `action-cards` notices.
- **Where it fires:** the binding path only — `bindActivation` in `src/adapter/parent-agent.ts`. That function is reached only after the top-level gate and the per-session idempotency check succeed, so an already-active, not-top-level, or unbound outcome appends nothing, and a worker session never reaches it.
- **The command result is untouched.** `activationResultCopy` (`src/adapter/activation-command.ts:99-115`) still returns exactly `{ kind: "success", text: DISPATCHER_START_SUCCESS }`.

## Acceptance criteria

- [x] A fresh (dormant) activation appends **exactly one** `user/message` with `{ surfaceOp: "append" }`, role `user`, `source.kind === "plugin:multitask-dispatcher"`, `source.form === "notice"`, a non-empty `source.summary`, and content text containing all of `DISPATCHER_START_SUCCESS`.
- [x] That activation calls `followup` **zero** times: no turn is opened, no inbox entry is created, no wake driver runs.
- [x] Re-activating an already-active session, activating in a child chat, and activating through an unbound lifecycle each append **zero** messages.
- [x] The returned `CommandResultLike` is byte-identical to `{ kind: "success", text: DISPATCHER_START_SUCCESS }` (proved through the command handler). This change edits no test; its activation-copy pins pass. (Annotation, 2026-11-10 close-out: `test/composition-polish.test.ts` was later edited by ticket 296 to move the dormant listener pin 6 → 7, and that file now passes 8/8 — the "not edited" half of this line described the tree before that fix.)
- [x] The notice text is built in one place: the message builder lives beside `wakeUserMessage` in `src/adapter/wake-copy.ts`, the copy stays in `src/adapter/activation-command.ts`.
- [x] Worker sessions receive no activation notice (they never pass through `bindActivation`). (Annotation, 2026-11-10 close-out: proved structurally, not by a worker-specific test — `tryActivationNotice` has exactly one call site, `src/adapter/parent-agent.ts:1057`, inside `bindActivation`, which only `activateSession` reaches.)

## Constraints

- No host edit, patch, or vendored change; no client edit and no locale-string change.
- Best-effort: a host whose session has no `append` seam must activate exactly as before (the append is skipped, never faked with `followup`).
- The append is a surface write on the session being activated, never on another session's log.

## Implementation (2026-11-10)

- **Builder:** `activationNoticeMessage(text, summary)` in `src/adapter/wake-copy.ts:142`, beside `wakeUserMessage`, plus `summary?` on `WakeUserMessage.source` (`src/adapter/wake-copy.ts:115`) — the field the `notice` row reads. One id per message (`multitask-activation-notice-…`), role `user`, `source: { kind: WAKE_SOURCE_KIND, form: "notice", summary }`.
- **Copy:** `ACTIVATION_NOTICE_SUMMARY` in `src/adapter/activation-command.ts:62` ("Dispatcher active in this chat."), next to `DISPATCHER_START_SUCCESS` (`:51-54`), which is reused verbatim as the notice body. Both stay in the copy module; the builder only assembles the message.
- **Port:** optional `session.append?` on `AgentLike.session` (`src/adapter/cordis-dsh-host.ts:89-102`), documenting the installed signature and that it is the inbox-free surface write.
- **Wiring:** `tryActivationNotice` (`src/adapter/parent-agent.ts:450-468`), called from `bindActivation` (`src/adapter/parent-agent.ts:1057`) — the one place every successful activation passes through, after the top-level gate and the per-session idempotency check. Best-effort: no seam means no notice, never a `followup` substitute.
- **Untouched:** `activationResultCopy` and the command handler still return exactly `{ kind: "success", text: DISPATCHER_START_SUCCESS }`; no client code, no locale string changed.
- **One consequence worth knowing:** `bindActivation` is shared by every activation entry point — `/dsh-bot` (`src/plugin.ts:2135`, `:2137`), a summoned dispatcher (`src/plugin.ts:1189`), and a cold resume of a marked dispatcher (`src/plugin.ts:1243`) — so each of those appends one notice to that session's surface. That is a true statement in every one of them, it costs no turn, and it is why no origin check was added. Worker sessions never reach this function.

## Comments

2026-11-10: Filed with two independent readings behind it — our adapter (`src/adapter/activation-command.ts`, `src/adapter/parent-agent.ts`) and the installed host's command persistence and chat rendering (`dsh-commands/lib/index.js`, `dsh-client-ui-chat/lib/client.js`). The reproduction script is the check, not a research note: it inspects every write a successful activation performs and finds zero carrying the confirmation. Rendering of the `notice` form is read from the installed client code and is therefore inferred, not observed in a browser in this pass.

2026-11-10: Implemented and proven by tests. `test/adapter-cordis-dsh-host.test.ts` — 97 tests, 97 pass, 0 fail (5 new in `describe("ticket 295: activation confirmation is visible and turn-free")`, `test/adapter-cordis-dsh-host.test.ts:3534`): a dormant activation appends exactly one `user/message` with `{ surfaceOp: "append" }`, role `user`, `kind: "plugin:multitask-dispatcher"`, `form: "notice"`, a non-empty summary and the full `DISPATCHER_START_SUCCESS` body, with `followupCalls.length === 0`; the command path returns the byte-identical result and the one notice; an already-active session adds none; a child chat and an unbound lifecycle add none; a host without the `append` seam still activates and does not fake a wake. `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit` are clean. No build, no client build, no full suite, no e2e.

2026-11-10 (honest status of the two neighbouring files): `test/activation-lifecycle.test.ts` is 9 pass / 1 fail and `test/composition-polish.test.ts` is 7 pass / 1 fail. Both failures are the same assertion and neither involves this ticket: the dormant listener-count pin (`test/activation-lifecycle.test.ts:290`, `test/composition-polish.test.ts:442`) now reads 7 against a pinned 6, because ticket 296's in-flight change added a `ctx.on("session/event")` listener in `src/adapter/parent-agent.ts` (the working tree has three `ctx.on` calls, `HEAD` has two). This change adds no listener. The pins need 6 → 7 by whoever owns ticket 296; they were left untouched here rather than edited across another worker's live change. Everything else in both files passes, including every activation-copy assertion.

2026-11-10 (residual display risk): the command card is still written (`command/run` + `command/done`), so an activated chat now shows BOTH the clipped command row AND the notice row carrying the same sentence in full. That is the intended trade — the card is what the composition-polish tests pin, and removing it would change the command contract — but a later ticket may want to shorten the card text or drop it once the notice is live. The notice's summary is server-side and English only: there is no settled-language helper for command copy (the client locale dictionary carries the card's faces), so a zh user sees an English one-line summary above the same English body.

### 2026-11-10 — resolved

`/dsh-bot` now writes ONE extra message — a model-free, inbox-free surface notice carrying the same confirmation in full — next to the command result it always wrote.

**What changed**

- Builder `activationNoticeMessage(text, summary)` in `src/adapter/wake-copy.ts:142`, beside `wakeUserMessage`, plus the optional `summary?` field on the wake `source` shape (`src/adapter/wake-copy.ts:115`). One id per message, role `user`, `source: { kind: plugin:multitask-dispatcher, form: "notice", summary }`.
- Copy `ACTIVATION_NOTICE_SUMMARY = "Dispatcher active in this chat."` at `src/adapter/activation-command.ts:62`; the body is `DISPATCHER_START_SUCCESS` (`src/adapter/activation-command.ts:51-54`) verbatim, so the sentence is written once.
- Optional port `session.append?(type, data, { surfaceOp: "append" })` on `AgentLike.session` (`src/adapter/cordis-dsh-host.ts:98-102`), documented as the surface write that touches neither the inbox nor the wake driver.
- Wiring `tryActivationNotice(agent)` (`src/adapter/parent-agent.ts:450-468`), called from `bindActivation` (`src/adapter/parent-agent.ts:1057`). Every refusal returns before that line, so an already-active, child-chat, or unbound activation appends nothing; a host without the seam returns early and never fakes a `followup`.
- Untouched: `activationResultCopy` still returns `{ kind: "success", text: DISPATCHER_START_SUCCESS }` (`src/adapter/activation-command.ts:99-115`); no host edit, no client edit, no locale string.

**Commands and exact results (run in this close-out pass)**

- `npx tsx --tsconfig tsconfig.client.json --test test/adapter-cordis-dsh-host.test.ts test/adapter-policy-inject.test.ts test/activation-lifecycle.test.ts test/composition-polish.test.ts` → tests 135, pass 135, fail 0 (97 + 20 + 10 + 8).
- `npm run build` → exit 0. `npm run build:client` → exit 0 (`client/index.js`, 213450 bytes).
- `npm test` → tests 1325, pass 1325, fail 0, 370 suites. `npm run lint:docs` → clean, exit 0.
- The five ticket-295 tests (`test/adapter-cordis-dsh-host.test.ts:3534-3662`) carry each acceptance box: one append with `{ surfaceOp: "append" }`, role, producer kind, `form: "notice"`, non-empty summary and the full body; `followupCalls.length === 0`; the byte-identical command result through the real command handler; zero appends for re-activation, child chat, and unbound; a seam-less host still activates with no invented wake.
- `npm run e2e` (reported by the team lead, not re-run here): s1/s2/s4 pass; s3 fails on a pre-existing stale harness regex, now tracked as ticket 297. Nothing in this diff reaches an e2e scenario.

**Verified vs inferred**

- Verified: the append's type, shape, count and turn-freeness; the unchanged command result; build, client build, full suite, doc lint.
- Inferred: that a `form: "notice"` row renders the one-line summary and can expose the full body. That is read from the installed client (`dsh-client-ui-chat/lib/client.js:5690-5696`, `:5652-5655`) — no browser was opened for this pass, so nothing here claims the row was watched on screen.

**Residual risks**

- Double surface: an activated chat shows the clipped command card AND the notice. The card is what `test/composition-polish.test.ts` pins, so it stays; a later ticket may shorten or drop it.
- The summary is server-side English only (no settled-language helper for command copy), so a zh user gets an English summary above the same English body.
- The notice also fires on spawned-dispatcher activation and on cold resume of a marked dispatcher — all three share `bindActivation`. The sentence is true in each, but a summoned child now shows it too.
- Best-effort by design: a rejected or throwing append is swallowed, so a broken seam degrades silently to the pre-295 behavior (card only).