# 297 — The e2e harness parses a spawn_dispatcher ack shape the product no longer emits

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Severity:** P2 / medium — no product behaviour is wrong; the e2e gate is red on a clean HEAD.
**Ship blocker:** yes — `npm run e2e` fails deterministically on an unmodified HEAD. Pre-existing and environment-independent: it is an in-repo harness/ copy mismatch, not a host, machine, or setup problem.
**Blocked by:** nothing.
**Origin:** 2026-11-10, delegated triage of a known-red e2e run; reproduces on HEAD `d4a3460` with a clean checkout.
**Related:** 118 (spawn_dispatcher mitosis: where the ack copy and this assertion both came from), 120 (the s1..s4 e2e scenarios), ADR-0032 (a summoned dispatcher is a parallel session).

## Problem

The s3 scenario never sees a child dispatcher id, and six of its assertions fail in a cascade, because `dev/e2e-mock.mjs` still parses the ack shape from before commit `afe9846`.

- **The harness** (`dev/e2e-mock.mjs:1376`, `:1379`, unchanged since HEAD `d4a3460`) reads the id out of `(session <id>)`:
  - `:1376` — `assert('s3', 'spawn_dispatcher returned a peer dispatcher id', /as a peer dispatcher \(session [^)]+\)/.test(summonAck), …)`
  - `:1379` — `const childId = /as a peer dispatcher \(session ([^)\s]+)\)/.exec(summonAck)?.[1] ?? null;`
- **The shipped copy** (`src/core/tool-results.ts:307-309`, `formatSpawnDispatcherNote`) no longer contains `(session <id>)`. `afe9846` rewrote it to a prose note that names the id at the end of the second sentence: `Message it with message_agent addressed to ${input.dispatcherId}; its answer arrives later …`. `afe9846` also touched `dev/e2e-mock.mjs` (205 lines) but never updated these two regexes, so the harness was left pinned to the retired shape.
- **Consequence:** `childId` is `null`, so `assert('the returned child id is a session id')` (`:1381`) fails, `childRequest` is never looked up (`:1383-1390`), and the assertions that depend on it — the child's dispatcher surface (`:1392-1399`), its brief (`:1400-1404`), the worker turn it spawns (`:1409-1419`), the child's peer message (`:1333-1342`), and the creator's receipt of the report (`:1348`) — all report fail. The scenario's first assertion, the ack phrase test at `:1376`, fails for the same reason.
- **Also fixed (2026-11-10):** the ack regex was necessary but not sufficient — a second, independent stale expectation (the child's tool surface) kept s3 red. Both were aligned to ticket 176 and s3 is now green; see the final comment below.
- **Reach:** `npm run e2e` (`package.json` `scripts.e2e` = `check:build && check:client && node dev/e2e-mock.mjs`) exited non-zero on a clean HEAD, so the ticket-120 harness could not gate a release. Nothing in `src/` was wrong: the product emitted the current copy correctly and withheld `spawn_dispatcher` by design (ticket 176); the harness was stale on both counts.

## Acceptance criteria

- [x] `dev/e2e-mock.mjs` extracts the child id from the CURRENT shipped ack (`message_agent addressed to <id>`) and still accepts the retired `(session <id>)` form, so the harness tolerates either copy.
- [x] The ack/id assertions keep their strength: the result must still contain the `as a peer dispatcher` phrase and still yield a non-null id. No assertion is deleted, relaxed, or skipped.
- [x] `src/core/tool-results.ts` is not edited; no test file is edited; `src/` is not rebuilt.
- [x] `npm run e2e` on this tree ends with s1, s2, s3 and s4 all passing and exits 0.

## Comments

2026-11-10: Filed from the harness side only. The evidence is two unchanged files at HEAD `d4a3460` — the regex literal in `dev/e2e-mock.mjs:1379` and the copy in `src/core/tool-results.ts:309` — plus `git show afe9846 -- src/core/tool-results.ts`, which shows the `(session ${input.dispatcherId})` sentence being replaced by the `addressed to` sentence. The failure is deterministic and needs no host, network, or model: the mock serves scripted replies, so the ack text is always the shipped one.

2026-11-10 (fix applied, verification run, ticket NOT resolved): the regex half is done and proven; s3 is still red for a second, independent reason.

**Change** (only `dev/e2e-mock.mjs`): the id is now parsed by `CHILD_ID_PATTERNS` + `spawnAckChildId(ack)` (`:1283-1301`), which tries `/as a peer dispatcher \(session ([^)\s]+)\)/` (retired form) then `/message_agent addressed to ([^\s;,.)]+)/` (current form). The ack assertion (`:1396-1404`) now requires the `as a peer dispatcher` phrase AND a non-null extracted id — same strength, no assertion removed.

**Command:** `npm run e2e` (full). `check:build` → "build fresh"; `check:client` → "client bundle fresh (215436 bytes, sha256 d6146671…)"; mock / boot / dispatch pass; cleanup passes. **Final lines:** `scenarios: s1=pass s2=pass s3=fail s4=pass` then `EXITCODE=1`. Evidence: `.scratch/testing/2026-10-18-mock-llm/2026-11-10-160101/result.json`.

**Now passing (were the regex failures):** `PASS [s3] spawn_dispatcher returned a peer dispatcher id` and `PASS [s3] the returned child id is a session id — {"childId":"6e34bd7d-4dde-41b1-866d-e98727652f1e"}`. The ack text is the current copy, and the `addressed to` branch is what produced that id.

**Still failing, verbatim (three lines; they are a second defect, not this regex):**
- `FAIL [s3] the child is a dispatcher (its own surface offers spawn_dispatcher and await_agent) — {"toolCount":36}`
- `FAIL [s3] the child spawned a worker and it ran`
- `FAIL [s3] the child addressed its creator by the roster session id and the send was accepted — {"returned":""}`

**Why:** the child's request carries 36 tools with `await_agent` present and `spawn_dispatcher` absent (`s3-mock.jsonl` seq 4; the creator's is seq 1 with 37 tools and both). That is ticket 176's deliberate design — "spawn_dispatcher is withheld from its surface" (`src/core/tool-results.ts:294-295`, `src/core/tools.ts:1884`) — so the surface assertion at `:1392-1399` and the script's child-turn matcher `{ anyUserIncludes: 's3-child-brief', toolNames: ['spawn_dispatcher'] }` (`:1319-1325`) are stale against ticket 176 for the same reason the ack regex was stale against afe9846. With that matcher unmet the child never runs its scripted `spawn_worker`, which fails the next two assertions and burns the s3 kill timer (180 s).

**Not fixed here on purpose:** making s3 green needs a decision this ticket does not own — does s3 still promise a child that can summon (and ticket 176 regressed), or does the harness follow ticket 176 (`spawn_worker` + `await_agent`, no `spawn_dispatcher`, matcher included)? Either answer edits assertions or product, which this ticket's scope forbids. Criterion 4 stays unticked and the ticket stays open; the follow-up ticket should name that decision.

2026-11-10 (second half done — s3 aligned with ticket 176; `npm run e2e` green; resolved)

**The decision the open question above asked for: the harness follows ticket 176.** The product is right and the scenario's premise was stale, exactly as with the ack regex — `spawn_dispatcher` is withheld from a summoned dispatcher's surface on purpose (`src/core/tools.ts:1884-1895`, note at `src/core/tool-results.ts:288-300`), and the shipped ack says so in words ("It cannot summon further dispatchers"). So s3 no longer promises a child that can summon; it promises a child that IS a dispatcher and cannot summon.

**Change** (only `dev/e2e-mock.mjs`; `src/` and `test/` untouched):
- Child-turn script matcher (`:1338-1344`): `{ anyUserIncludes: 's3-child-brief', toolNames: ['spawn_dispatcher'] }` → `{ anyUserIncludes: 's3-child-brief', toolNames: ['spawn_worker', 'await_agent'] }`. The old gate asked for a tool the child never receives, so it never matched, the child never ran its scripted `spawn_worker`, and the worker/timers behind it starved.
- Surface assertion (`:1430-1437`) keeps its dispatcher half and states it against the shipped class: `spawn_worker` AND `await_agent` present, label now "…offers spawn_worker and await_agent".
- **New** assertion (`:1438-1443`): "the child cannot summon further dispatchers — its surface has no spawn_dispatcher (ticket 176)", evidence `{hasSpawnDispatcher, toolCount}`. The absence is asserted, not deleted — the check got stronger, not weaker.
- s3 header comment (`:1312-1314`) records the same rule so the next reader does not "fix" it back.

**Command:** `npm run e2e` (full). `check:build` → build fresh; `check:client` → client bundle fresh; mock / boot / dispatch pass; s1..s4 all pass; cleanup passes. **Final lines:** `scenarios: s1=pass s2=pass s3=pass s4=pass` then `EXITCODE=0`. Evidence: `.scratch/testing/2026-10-18-mock-llm/2026-11-10-160726/result.json` — `ok: true`, phases `mock=pass boot=pass dispatch=pass s1=pass s2=pass s3=pass s4=pass`, 39 assertions, 0 failed.

**The three formerly-red lines, now green (verbatim names):**
- `PASS [s3] the child is a dispatcher (its own surface offers spawn_worker and await_agent) — {"toolCount":36}`
- `PASS [s3] the child cannot summon further dispatchers — its surface has no spawn_dispatcher (ticket 176) — {"hasSpawnDispatcher":false,"toolCount":36}`
- `PASS [s3] the child spawned a worker and it ran`
- and the dependent pair they unblocked: `PASS [s3] the child addressed its creator by the roster session id and the send was accepted — {"returned":"Accepted for peer session session-d51b7e41-…"}` and `PASS [s3] the child's report arrived on a LATER turn as a peer message (not as the user) — {"summonSeq":3,"peerSeq":9}`.

**Nothing else weakened:** every prior s3 assertion still runs, the ack/id checks keep both their phrase test and their non-null id (`:1399-1414`), the child-brief isolation check is untouched, and the s3 kill timer is no longer burned (the run finished well inside it).
