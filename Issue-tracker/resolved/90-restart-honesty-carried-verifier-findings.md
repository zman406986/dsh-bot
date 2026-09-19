# 90 — Restart-honesty carried verifier findings (ticket 31's activation guard and rebuild ordering)

**Status:** resolved
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

- [x] **AC1 — pin the guard's false branch (F1). DONE — pin only, no behaviour
      change.** `test/restart-honesty.test.ts`, "a deactivation during the
      marker read ends the chain: nothing published, nothing woken, no redrive
      spent (ticket 90 F1)". The fake marker store gained a controllable table
      hold (`holdNextMarkerTable` / `releaseMarkerTableHold` — the durability
      adapter resolves the table per operation, so a hold parks exactly one
      read), which keeps the chain genuinely inside `rebuildFromDurability`
      when `agent/disposed` fires. **RED** (guard deleted at
      `src/plugin.ts:533`): `the dead chain publishes no roster snapshot:
      1 !== 0`; with the assertions reordered, the redrive assertion fails
      independently too (`redriveAttempts 1 !== 0` — the guardless chain spent
      a D-5 attempt and persisted it). **GREEN** with the guard in place.
      The guard was already correct, so the pin is the whole AC1 fix.
- [x] **AC2 — decide and record the guard's basis (F2). DECIDED (a): activation
      generation counter.** `bindDispatcherLifecycle` stamps a monotonic
      `activationGeneration` per activation (`src/adapter/parent-agent.ts`:
      interface + impl + `activate()`); `rebuildAndNotice` captures it before
      the first await and compares it after the marker read. Because the
      accessor returns `null` once the activation ends, that single comparison
      covers both the deactivation branch (F1) and the stale-chain window
      (F2), and the in-flight gate is keyed by the same generation so a stale
      chain's exit cannot reopen the publish window for a later activation.
      Test: "a stale chain from an earlier activation of the same session id
      is refused (ticket 90 F2)". **RED** (old session-id check):
      `the stale chain publishes nothing: 1 !== 0`; **RED** (unconditional
      gate clear in the `finally`): `the live rebuild is still in flight: the
      transition does not publish yet: 1 !== 0`. **GREEN**: exactly one
      publish for the new activation and `redriveAttempts === 1` (not 2) — the
      double publish / double redrive pass the finding named is closed, not
      merely recorded. The duplicate-notice half stays prevented by
      `rebuildFromDurability`'s no-overwrite/no-delete property
      (`src/core/multitask.ts:866-880`, untouched).
- [x] **AC3 — make the rebuild-before-publish ordering hold under concurrency
      (F3). IMPLEMENTED, not dispositioned.** `rebuildsInFlight`
      (sessionId → generation) suppresses `onRosterChanged`'s publish while
      that session's rebuild is in flight (`src/plugin.ts`); the chain's own
      post-rebuild publish projects the live roster, so a transition that
      landed in the window is carried by the FIRST snapshot, never dropped.
      Test: "a roster transition during the marker read cannot publish a
      pre-rebuild snapshot (ticket 90 F3)" — a real `spawn_worker` executes
      mid-read (its marker write is a later table resolution, so it
      completes). **RED**: `the first snapshot already carries the restored
      rows (rebuild before publish)` — the spawn's transition published first,
      pre-rebuild. **GREEN**: the first snapshot carries both the restored row
      and the raced spawn.
- [x] **AC4 — gates + honest record. DONE (2026-09-19).** `npm run typecheck`
      exit 0 (both configs, no output); `npm test` 1052 tests / 257 suites /
      1052 pass, **0 fail**; `npm run build:client` →
      `client/index.js` (161087 bytes). Commit `663c36f`.

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

### 2026-09-19 — resolved (commit `663c36f`; offline only, no browser, no live dsh)

Re-verified all three findings against the tree before touching anything; all
three were still live exactly as filed (guard untested at `src/plugin.ts:533`; no
generation concept anywhere in `src/`; no in-flight flag — the three greps in the
filing hold).

**Per-finding disposition:**

- **F1 — the guard's false branch is untested. PINNED-ONLY (no behaviour
  change).** The guard was already correct; what was missing was the test. New
  offline test parks the marker read on a controllable table hold and deactivates
  mid-read. RED with the guard deleted (`the dead chain publishes no roster
  snapshot: 1 !== 0`, and the redrive assertion fails independently at
  `redriveAttempts 1 !== 0`). The harness addition is
  `holdNextMarkerTable`/`releaseMarkerTableHold` in `test/restart-honesty.test.ts`
  — it exploits a real adapter property (the durability port resolves the table
  per operation, `src/adapter/durable-marker.ts:104-112`), so a held table parks
  exactly one read or write and later ones proceed.
- **F2 — session-id comparison instead of an activation generation. FIXED
  (option (a)).** Added a monotonic `activationGeneration(sessionId)` to the
  lifecycle (`src/adapter/parent-agent.ts`, stamped in `activate()` before
  `onActivated` fires, null once the activation ends) and made `rebuildAndNotice`
  capture-and-compare it instead of `isDispatcherSession`. Test RED against the
  old session-id check and GREEN after; it also pins the generation-keyed gate
  (a session-keyed clear reopens the pre-rebuild publish window and the test
  catches it). Residual accepted: the *duplicate-notice* symptom remains
  prevented by `rebuildFromDurability`'s no-overwrite/no-delete property
  (`src/core/multitask.ts:866-880`, frozen, untouched) — the generation closes
  the double publish / double redrive pass, which is what remained.
- **F3 — concurrent roster-event publish-before-rebuild. FIXED.** `rebuildsInFlight`
  (sessionId → generation) gates the roster observer for that session while its
  rebuild is in flight; the chain's post-rebuild publish carries any transition
  that landed in the window. Test fires a real `spawn_worker` mid-read: RED
  before the gate (`the first snapshot already carries the restored rows`),
  GREEN after — the first snapshot carries both the restored row and the raced
  spawn.

**Notes.** No core change (`rebuildFromDurability`, ADR-0006 split, and the
durability port are untouched — the adapter lifecycle/ordering only). No new
user-visible copy and no client source touched (`client/index.js` is a gitignored
build artifact; built green at 161087 bytes). ADR-0012's Context bullet that named
`isDispatcherSession` as the guard was amended in the same commit to name the
generation (and the F3 half), so the ADR no longer describes the pre-90 code.
Gates at `663c36f`:
typecheck exit 0 on both configs; `npm test` 1052 tests / 257 suites / 0 fail;
`npm run build:client` 161087 bytes. Nothing was dispositioned as unimplemented;
AC1 is deliberately test-only.
