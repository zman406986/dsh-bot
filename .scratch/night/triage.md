# Open-ticket triage — 2026-11-08 (read-only)

**Scope:** all 36 tickets in `Issue-tracker/open/` (plus `.gitkeep`), read in full.
**Method:** each claim was checked against the current tree by reading the cited file and line range; no git commands, no edits to source, no test runs. Line numbers below are from the working tree as it stands.
**Freshness probe:** every source file is dated on or before 2026-11-07 19:47 and the newest ticket is 2026-11-07 22:12, so nothing in `src/`, `vendor/`, `test/` or `docs/` changed after the tickets were filed. "Still real" therefore means "the cited code still does what the ticket says".
**Night plans:** `.scratch/model-arg/PLAN.md` (spawn model + worker_model args) and `.scratch/auto-title/PLAN.md` (session title via sessionTitle.rename). Both were written 2026-11-07 22:09-22:12, after the last source edit, so their line references are current.

## Counts

| Verdict | Count | Tickets |
|---|---|---|
| Real, agent-actionable | 28 | 182, 183*, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 205, 206, 220, 221, 235, 236, 237, 238, 265, 180 |
| Stale / already satisfied | 2 | 158 (body only), 167 (work landed; human check left) |
| Duplicate of each other | 1 pair (both inside the 28) | 180 + 193 — same root (ADR-0033 residue); one commit fixes both |
| Blocked on a human/owner decision | 1 | 160 (owner ruling on diagram attribution) |
| Dormant / speculative trigger | 5 | 280, 281, 282, 283, 284 |
| Too vague to act on | 0 | — (221's acceptance criterion is the only unmeasurable one) |
| **Total** | **36** | 28 + 2 + 1 + 5 |

\* 183 is real but needs git history to bound its window, which this lane forbids; see its row.

## Table

Legend — **Effort:** S = under ~1 h, M = a half day, L = a day or more. **Overlap:** with the model-arg (MA) / auto-title (AT) night plans.

| # | What it asks | Still real? (evidence checked) | Effort | Overlap | Flags |
|---|---|---|---|---|---|
| 158 | Post-157 verification lane: full-suite sweep, by-eye client-bundle check, one live restart probe | **Partly stale.** §1/§2 are closed and §3 (full suite) is recorded green in the ticket's own 2026-11-07 comment: 1116 tests, 0 fail. §4 by-eye and §5 live restart remain unrun | S (but needs a running GUI and a restart) | None; would be the natural gate for both plans' new tests | Body contradicts its own comment; remainder is human/live-only |
| 160 | Two tracked diagram files embed the reconstruction repo URL; needs owner ruling before publication | **Real.** `docs/diagrams/reference-agent-runtime.architecture.json:9-11` and `…reference-agent-runtime.html:4963` still carry the URL | S (two deletions) | None | **Blocked:** owner decision; owner is away |
| 167 | Desktop launchers re-sync to the vendored repo | **Stale.** Consolidated 2026-11-07: Desktop `dsh-bot.bat` is a 490-byte forwarder to `dev/windows/dsh-bot.bat`; `dev/dsh-baseline.txt` reads 0.2.2-rc.1; the RACOONS launcher is gone | Human-only (launch check) | None | All agent work landed; only the manual launch check is open — move to `ready-for-human` or close |
| 180 | `docs/surfaces.md` still lists `/dispatcher-resolve` and access prompts as **Live** | **Real.** `docs/surfaces.md:291,292,300` still say Live; `grep dispatcher-resolve src/` → 0 hits | S | None | Duplicate root with 193 — one commit fixes both |
| 182 | The inherited `workflow` tool (script `agent()`) bypasses the worker leaf barrier | **Real.** `src/worker/tool-barrier.ts:16-73` denies spawn/await verbs but not `workflow`; `HOST_SPAWN_TOOL_CANDIDATES` (`src/core/tools.ts:694-698`) has no workflow entry; installed `dsh-tool-workflow/lib/index.js:67` defaults the exposed name to `workflow`; `grep workflow src/worker` → 0 | S | None | Ship blocker claimed; best value-per-line in the set |
| 183 | Bounded adapted-copy review for `5dbf04c..3d08313` | **Unsure by construction.** The cited copy exists (`src/worker/prompt.ts:129-137`, `src/core/policy/prompts.ts:333-339`), but bounding the window needs `git diff`/`blame`, which this lane forbids; and MA adds new model-facing copy in the same file | M | **MA** (adds copy to `src/core/policy/prompts.ts`) | Do it **after** the night plans, or the window re-opens |
| 185 | A `tool-calls` finish is accepted as an entry answer | **Real.** `vendor/racoons/adapter/llm-ask.ts:280-300` records the finish kind but only refuses error/aborted, max-tokens and empty text | S-M | None | Sibling of 186/189 |
| 186 | Ask leaves the stream iterator open after a finish chunk | **Real.** `llm-ask.ts:263-284` breaks on finish with no `finally`/`return()` | S-M | None | Land with 189 |
| 187 | A preflight-rejected edit falsely invalidates read coverage | **Real.** `vendor/racoons/adapter/evidence.ts:110-113` exempts every write from the `failed !== true` filter and leaves the outcome unknown | M | None | Needs a "proven no-mutation" producer signal — a small design decision |
| 188 | Entry partial retention drops image blocks from mixed results | **Real.** `vendor/racoons/adapter/port.ts:484-486` rewrites content as `[{type:"text"}]` | M | None | |
| 189 | Entry asks drop the caller's abort signal | **Real.** `vendor/racoons/adapter/plugin.ts:2657-2666` never reads `payload.signal`; `runStep`/`askEntry` take no signal | M | None | Land with 186 |
| 190 | Cold resume drops the worker's running edge | **Real.** `src/core/multitask.ts:1950-1964` rebuilds an adopted worker as `status:"spawned"`; there is no running-edge buffer to replay | M | `multitask.ts` (MA edits spawnWorker) — minor | Same adopt-before-rebuild window as 191 |
| 191 | A parent rebuild deletes another parent's buffered settle | **Real.** `src/core/multitask.ts:2075-2077` sweeps `pendingSettles` for every id absent from the shared `workers` map, with no parent check | S-M | `multitask.ts` — minor | P1 ship blocker (silent worker-result loss); pair with 190 |
| 192 | A settings refresh discards a pending save result | **Real.** `src/client/settings-card-store.ts:696` only preserves the generation when the wrapper object is identical | M | None | |
| 193 | Settings description still advertises the removed permission timeout | **Real.** `src/client/overlay.ts:276-277` (EN) and `:587-588` (ZH) | S (two strings) | None | Duplicate root with 180 |
| 194 | `await_agent` accepts `timeout_ms: null` as "omitted" | **Real.** `src/core/tools.ts:1579-1583` exempts null; `:1594` maps it to undefined | S | `src/core/tools.ts` (MA) — different function | Land before MA touches that file |
| 195 | A newer accepted steer is stranded when idle arrives during the older send | **Real.** `src/core/multitask.ts:1152` returns without recording a pending boundary; `:1183-1191` leaves the newer slot parked with no drain | M-L | `multitask.ts` — minor | S3 claim |
| 196 | Pending worker activation survives plugin unload/HMR | **Real.** `src/adapter/cordis-dsh-host.ts:3729` awaits `startActivation` before `:3783-3784` registers the controller/activation the disposer visits | M | **MA** edits the same `spawnWorker` block | Same "pending work survives unload" class as 265 |
| 197 | A redrive wake spends the retry budget twice | **Real.** `src/core/todo-reconciler.ts:320-346` exempts only the settle notice, so a delivery-redrive wake increments again | M-L | None | P1 ship blocker; pair with 198 |
| 198 | Lazy recovery reuses an unopened session's todo id | **Real.** `todo-reconciler.ts:545,584` keeps a per-ledger counter advanced only by loaded rows; `multitask.ts:897` returns on any existing id without an owner check | M | `multitask.ts` — minor | P1 ship blocker; pair with 197 |
| 199 | A priority peer drops inbox intake from a dormant dispatcher's mixed wake | **Real.** `src/core/wake-bus.ts:719-748` branches on `ready.source`; a mixed wake is sourced `worker-settled`, so `:742-744` re-queues only `settledWorkers` and discards `externalJobs` | S-M | None | |
| 200 | A composition failure keeps an unrestricted worker live | **Real.** `cordis-dsh-host.ts:3224-3233` (fresh) and `:2847-2861` (reattach) both warn and continue | L | **MA** conflicts in the same host file and its tests | High severity |
| 205 | Fork `role-conflict` says "assistant" for a tool/tool pair | **Real.** `vendor/racoons/core/judge/fork.ts:120-122` message vs. `:228` predicate (any equal role except user) | S (wording + comment) | None | |
| 206 | The usage reader can emit an unsafe aggregate from safe buckets | **Real.** `vendor/racoons/adapter/usage.ts:103,107` add without a safe-integer check | S | None | |
| 220 | Entry guard accepts an empty keeplines selection | **Real.** `core/verdicts/entry-wire.ts:67-79` allows an empty range list; `core/guard/checks-entry-shape.ts:239-252` returns true for an empty list | S-M | None | P2: can blank the whole landed result in active context |
| 221 | Blank anchor bands are rescanned quadratically | **Real.** `core/rules/anchors.ts:169-175` (one candidate per 100 lines) × `:244-249` (full-band walk per candidate) | S | None | Acceptance "bounded" is not measurable — pick a concrete bound |
| 235 | A measured zero cache share is reported as unknown | **Real.** `core/meter/meter.ts:57-60` folds `cachedInputTokens === 0` into the null branch | S (one condition) | None | |
| 236 | The canonical encoder drops an own `__proto__` JSON member | **Real.** `core/util/bytes.ts:82-85` copies through `output[key] = …`, which hits the inherited setter | S | None | P2: two distinct JSON objects hash identically |
| 237 | Entry answers double-count one captured refetch | **Real.** `core/engine/engine.ts:352-367` dedupes by `eventId` only; the answer path re-sends the same node under a new id | M | None | |
| 238 | The first forced-loss token count is lost when no usage row exists | **Real.** `core/engine/telemetry.ts:49` requires `latestUsage !== null` before recording it | S | None | |
| 265 | A pending microcompact pass survives unload and appends after store disposal | **Real.** `src/adapter/microcompact.ts:431` awaits the boundary read, `:451-527` appends and writes with no lifetime recheck; `:588-591` only unregisters the listener | M | None | Same class as 196 |
| 280 | A ready-but-empty conversation page hides load-older | **Real in code**, `src/client/conversation.tsx:399-416`; the trigger needs a page the current host never emits | S | None | Dormant/unmounted surface (ADR-0024) |
| 281 | A rejected clipboard write is unobserved | **Real.** `src/client/shell.tsx:216-222` calls `void navigator.clipboard?.writeText()` inside a synchronous try | S | None | Dormant |
| 282 | The mirror store accepts another session's snapshot | **Real.** `src/client/shell-store.ts:497-509` never compares `snapshot.dispatcherSessionId` with `sessionId` | S | None | Dormant |
| 283 | A reentrant clear is overwritten by stale mirror fanout | **Real.** `src/client/shell-mirror-feed.ts:112-121` sets `lastMirrors` then iterates with no generation guard | S | None | Dormant; needs a reentrant subscriber |
| 284 | Conversation reentry loses the current unsubscribe handle | **Real.** `src/client/conversation-feed.ts:220-235` syncs before subscribing, then assigns one shared handle | S | None | Dormant. **Number collision:** the auto-title plan proposes filing its ticket as 284 — that number is now taken; use 286 (285 is still free for model-arg) |

## Flagged groups

**Duplicates.** 180 + 193 are one fix: both are residue from the ADR-0033 / ticket 174 removal of the worker access-ask feature, in different surfaces (docs vs. live settings copy). Nothing else is a true duplicate. Same-class siblings that should be scheduled together but are *not* duplicates: 186+189 (ask lifecycle), 190+191 (adopt-before-rebuild), 196+265 (pending work survives unload), 197+198 (durable delivery recovery), 205+220 (entry answer acceptance), 206+235+238 (usage/telemetry arithmetic).

**Already fixed / stale.** 167 — every agent-side item landed on 2026-11-07 (forwarder, baseline file, RACOONS launcher retired); only the human launch check remains. 158 — its own 2026-11-07 comment records the full-suite run that its body still lists as owed; the remaining §4/§5 items need a human at the GUI and a live restart. No ticket was found to be fixed by code it does not know about.

**Too vague.** None is unreadable, but 221's acceptance ("bounded rather than rescanning") cannot be verified without a chosen bound — decide the bound before starting. 280-284 are not vague, they are **unreachable**: each needs a consumer that the current composition does not create (the shell is unmounted and the mirror feed unfed per ADR-0024). Fixing them fixes nothing a user can hit today.

**Needs a human.** 160 (owner ruling on attribution), 167 (launch check), 158 §4/§5 (by-eye + live restart).

## Do first — 5 smallest high-value fixes

1. **182 — deny `workflow` to worker scopes.** One name added to `WORKER_DENIED_TOOL_CANDIDATES` plus one regression asserting a worker cannot reach script-level `agent()`. Closes a claimed ship blocker for almost no code. Watch: the deny list is intersected with live names, so add `workflow` and, if the host exposes it, `workflow_ptc`.
2. **191 — parent-scope the buffered-settle sweep.** Carry `parentSessionId` on each buffered settle and sweep only this parent's entries (`src/core/multitask.ts:1073-1083`, `:2075-2077`). ~40 lines including the two-parent interleaving test; removes a P1 silent result loss.
3. **220 — refuse an empty keeplines answer.** Reject before planning and bind the guard's kept selection to the answer kind. Small, and it prevents one malformed answer from blanking the whole landed result in active context.
4. **236 — preserve an own `__proto__` member in the canonical encoder.** Build the copy without an inherited setter (define the property or copy into a null-prototype object) and regenerate the shipped JS. Three lines; removes a hash collision on public API.
5. **194 — refuse `timeout_ms: null`.** Delete the null exemption at `src/core/tools.ts:1581` and keep `:1594`; two lines and a test. Do it before the model-arg plan edits that same file.

Next five, all single-line-to-single-string commits that can go in one batch: **193 + 180** (one commit, ADR-0033 residue), **235**, **206**, **238**, **205**.

## Sequencing against the night plans

- Run 182, 191, 220, 236, 194 outside both plans. Only 194 touches a file model-arg edits (`src/core/tools.ts`), and it touches a different function — land it first.
- **Do not start 196, 200 or 183 while the plans run.** 196 and 200 conflict with model-arg in `src/adapter/cordis-dsh-host.ts` and its tests; 183's review window would be invalidated by model-arg's new prompt copy.
- 158's full-suite half is the cheapest gate after either plan lands, but it needs a live restart to close.

## What this triage did not verify

- No tests, builds, typechecks or live runs. Every racoons ticket is checked at source and emitted-JS line level only; none of their probes were re-run.
- 183 cannot be bounded without git history, which this lane forbids; its verdict is inherited from its own citations.
- 158's "1116 pass" figure is quoted from its comment, not observed here.
- 280-284 were verified line-by-line for the defect but their triggers (a mounted pane, a reentrant subscriber, a mismatched producer) were not exercised.
