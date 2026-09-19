# 90 — Restart-honesty carried verifier findings (ticket 31's activation guard and rebuild ordering)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 31 (the ticket whose verifier raised these; implemented `818d03c`, re-based 2026-09-19), 17 (carried them forward, line 91), 33 (the close-out that owed either a follow-up ticket or a fold-in — this is that ticket), 57/58 (the wake primitive and the bounded redrive the guard chain now drives), 12/ADR-0012 (restart replays durability, never work)

## Problem

Ticket 31's independent verification passed, but its verifier recorded three
findings that no ticket ever picked up. Ticket 17 carried them explicitly
(`Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md:91`):
"Ticket 33 should either file them as a follow-up ticket or fold them into a
later fix." Ticket 33's close-out has now filed them here. All three live in
the activation-time rebuild chain — `rebuildAndNotice` in `src/plugin.ts`
(`:519-555`) — which is the code that makes restart honesty work: it rebuilds
the roster from durable markers BEFORE the first publish, wakes the one-time
notice, and redrives undelivered results.

## The carried findings, verbatim

> Ticket 31's verifier noted: the activation guard's false branch is untested;
> the guard compares session ids rather than an activation generation counter
> (narrow stale-chain window on same-session re-activation); under a concurrent
> roster event during the marker read the gated observer can publish before the
> rebuild lands.

— `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md:91`

## Re-verification against today's tree (2026-09-19, before filing)

Each finding was checked against the current code rather than copied forward.
**All three are still live** — none is stale.

**F1 — the guard's false branch is untested. STILL LIVE.**
The guard is `if (!lifecycle.isDispatcherSession(sessionId)) return;`
(`src/plugin.ts:533`). Its comment says the activation "may have ended while
markers were being read — never publish or inject for a session that is no
longer an activated dispatcher". No test exercises that path: the
restart-honesty suite covers the happy path (`test/restart-honesty.test.ts:296`),
notice-once (`:388`), no-durable-state (`:425`), and the degraded read (`:448`) —
all of them keep the session activated throughout. `test/activation-lifecycle.test.ts`
covers deactivation generally (`:414`) but never deactivates *during* the marker
read. So a regression that deletes the guard would not fail the suite.

**F2 — session-id comparison instead of an activation generation counter. STILL LIVE.**
`isDispatcherSession` is set membership: `return sessions.has(sessionId);`
(`src/adapter/parent-agent.ts:306-307`). No generation/epoch/sequence concept
exists anywhere in `src/` (grep for `generation|epoch|activationSeq|activationId`
finds only an unrelated "ms since epoch" comment in `src/core/access-types.ts:44`).
Consequence: a chain started by activation #1 that resumes after a
deactivate → re-activate of the SAME session id passes the guard and acts for the
new activation. Harm is narrower than it sounds, and worth stating precisely so a
fix is not over-scoped: `rebuildFromDurability` never overwrites in-memory
entries and does not delete markers (`src/core/multitask.ts:866-880`), so the
second chain's rebuild returns empty and stays silent — the duplicate-notice
symptom is already prevented. What remains is ordering and double-execution:
a stale chain can publish the roster and call `pumpFor(sessionId).sync()` and
`multitask.redriveUndelivered(sessionId)` (`src/plugin.ts:534,537,554`) for the
*new* activation's session, so the redrive pass can run twice for one activation
(the D-5 budget is persisted, so a double pass can spend two attempts).

**F3 — a concurrent roster event can publish before the rebuild lands. STILL LIVE.**
`onRosterChanged` (`src/plugin.ts:268-272`) publishes whenever the session is an
activated dispatcher, with no "rebuild in flight" gate; no such flag exists
(grep for `rebuilding` in `src/` finds nothing). The rebuild awaits the marker
store (`src/core/multitask.ts:874-876`), so any roster-affecting transition in
that window (worker status change, access-ask park/resolve, todo delivery)
publishes a PRE-rebuild snapshot. That is exactly the ordering ticket 31's own
acceptance rule forbids: "`rebuildFromDurability` runs BEFORE the first
`publishRosterSnapshot`, so restored terminal rows are in the very first
snapshot the panel sees" (`src/plugin.ts:514-518`). The happy-path test cannot
see it because nothing else touches the roster while the read is in flight.

## What to do

All three are offline-testable (S8): the seams are the plugin's own activation
lifecycle, the durability store, and the fake host — no network, no LLM, no
running dsh, no browser.

- [ ] **AC1 — pin the guard's false branch (F1).** Add an offline test that
      deactivates the session while `rebuildFromDurability` is pending (a
      controlled durability fake that resolves on demand), then lets the chain
      resume; assert nothing is published for that session after the
      deactivation, no notice is woken, and `redriveUndelivered` is not called.
      RED-verify it first: with the guard removed, the test must fail.
- [ ] **AC2 — decide and record the guard's basis (F2).** Either (a) add an
      activation generation counter (bumped per activation, captured by the
      chain, compared in the guard) with a test that a stale chain from a
      previous activation of the same session id is refused, or (b) record, in
      the `rebuildAndNotice` comment, why the session-id check is sufficient —
      naming the `rebuildFromDurability` no-overwrite/no-delete property
      (`src/core/multitask.ts:866-880`) that already prevents the duplicate
      notice, and stating the accepted residual (double publish / double
      redrive pass). Do not leave the choice implicit.
- [ ] **AC3 — make the rebuild-before-publish ordering hold under concurrency (F3).**
      Gate the roster observer (or the publish path) while a rebuild for that
      session is in flight, so a concurrent transition cannot publish a
      pre-rebuild snapshot; the first publish after activation must still carry
      the restored rows. Test: fire a roster-affecting transition during the
      pending marker read and assert the first mirrored snapshot already
      contains the restored rows. If gating is rejected as a design change,
      record the ordering guarantee's exact limit in the ticket and in the code
      comment instead of leaving the stronger claim standing.
- [ ] **AC4 — gates + honest record.** `npm test` 0 fail and `npm run typecheck`
      clean on both configs (record the exact counts); append a dated comment
      with the commits; if any AC is dispositioned rather than implemented,
      say so explicitly with the reason.

## Constraints

- Offline tests only (S8). No live pass is required by this ticket — it is
  lifecycle-ordering work, not a browser-visible surface.
- Core semantics frozen: `rebuildFromDurability`'s no-overwrite/no-delete
  behavior and ADR-0006's durability split are not in scope to change. If a fix
  seems to need a core change, stop and raise it rather than making one.
- No new user-visible copy; nothing here changes what the user reads.
- Never `git add -A`; explicit paths only.

## Comments

### 2026-09-19 — filed (overnight session; no ruling needed, no blocking question)

Filed because ticket 17's handover explicitly required it ("either file them as a
follow-up ticket or fold them into a later fix") and no such ticket existed; the
three findings were re-verified against the current tree first, per that
instruction, and all three are still live (evidence above). No judgement call was
needed to file it, so nothing here is an overnight-dispatched ruling — the AC2
(a)-vs-(b) choice is left to the implementing agent, with the evidence it needs to
make it. `Labels: ready-for-agent`, `Blocked by: none`.
