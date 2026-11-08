# Critic review — optional spawn model choice (ticket 285 / ADR-0035)

**Reviewed:** main at cc69118. Feature commits: 739b49c (tools, resolver, host) and 2e2e551 (durable worker default, docs). Forty commits have landed after 2e2e551; I checked their diff and they do not change the model path (model-option.ts, tools.ts and tool-results.ts are untouched; the host hunks around the model code are only comment/title changes).

**Mode:** read-only. No source or test edits, no commit, nothing restarted. I did not rerun the suite; the night handoff reports 1294 tests / 367 suites, 1294 pass, 0 fail at this commit.

**Verdict:** No unconditional break found. The normal string-input fallback is implemented and well tested. The fallback contract is not total at the tool/host boundary, and the durable worker default bypasses the catalog. The worst finding is the stored default (finding 1); it becomes a break as soon as the catalog removes or renames the stored model.

**Counts:** 0 unconditional breaks, 6 risky, 7 cosmetic (13 findings). Process notes are separate and not counted.

## Step back: what I checked, and what I did not find

The common path is sound. I could not make a normal *string* value refuse a spawn: unknown provider, unknown model, ambiguous bare id, missing catalog, and catalog throw each becomes a fallback, one warning, and a tool-result note, and the tests cover those cases; one provider throwing while another resolves still resolves, with no warning. Empty and whitespace-only values are omitted silently, and a non-empty value with no wired resolver throws by documented wiring intent (test/dispatcher-tools.test.ts, "a non-empty model with no resolver throws before creating a todo"). Explicit routes win in the host request: spawn_worker.model beats the stored worker_model, and spawn_dispatcher.model beats the inherited route; the host tests assert both. The durable worker default is keyed by the actual leader id (including a host-assigned id), written before the first turn, and restored from the mark; the round-trip, legacy-row, and restore tests are present.

I am not calling the fallback broken. The real risks are at three seams: the tool layer trusts the resolver's result shape, the host trusts a stored route without the catalog, and the restore is asynchronous.

**Direct answer to "does every invalid input fall back or can any shape crash or refuse":**

- For a normal string value: yes, it falls back; no spawn is refused.
- For a non-string value: no, it throws. optionalString (src/core/tools.ts:267-277) throws for a number/object before the resolver; the plan calls this a programming error (§3.3), but the README's unqualified "an unknown or invalid value does not refuse the spawn" (README.md:96) is broader than the code. A conforming tool caller sends a string, so this is a docs caveat, not a live bug.
- For a catalog that violates the declared shape: no, it can refuse; finding 2.
- For a stored worker_model that is no longer in the catalog: no, it is applied without a catalog check; finding 1.

## Findings at a glance

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | risky (worst) | src/adapter/cordis-dsh-host.ts:3699-3703, 3988-3995 | Stored worker_model is never revalidated; a removed model is applied to every later worker |
| 2 | risky | src/core/tools.ts:904, 915; src/adapter/model-option.ts:262-272 | A rejected resolver or unexpected catalog shape still refuses the spawn; an unexpected absent is silently dropped |
| 3 | risky | src/adapter/model-option.ts:155-162, 193-200, 262-272 | Catalog reads have no timeout or abort; a hung provider blocks the spawn |
| 4 | risky | src/plugin.ts:1586; src/adapter/cordis-dsh-host.ts:3676-3705 | Restore is fire-and-forget; a first-turn worker spawn can miss the durable default |
| 5 | risky (low) | src/adapter/durable-marker.ts:421-439, 501 | A malformed workerModel discards the whole dispatcher mark for that leader, not just the default |
| 6 | risky (conditional) | src/adapter/cordis-dsh-host.ts:2960-2969, 3539-3590, 4703-4715 | The in-process default can outlive its leader and apply to a reused id |
| 7 | cosmetic | src/adapter/model-option.ts:229-232 | A partial catalog failure is reported as "unknown model" |
| 8 | cosmetic | src/core/tools.ts:908-912; src/core/tool-results.ts:715, 317-318 | The tool-result note/ack embeds the untruncated, unsanitized value |
| 9 | cosmetic | src/adapter/cordis-dsh-host.ts:4163-4164; src/core/tool-results.ts:715 | Fallback copy says "team leader" to a user dispatcher and "inherited route" when a stored default may apply |
| 10 | cosmetic | README.md:94; docs/adr/0035-spawn-model-option.md:17 | Docs say a bare id must be unique; the code accepts a shared id via the spawning session's provider |
| 11 | cosmetic | docs/adr/0035-spawn-model-option.md:25; src/adapter/cordis-dsh-host.ts:4314-4324 | ADR says a route change does not change maxTokens; the leader path drops it |
| 12 | cosmetic | src/adapter/cordis-dsh-host.ts:2970-2971, 2988-2997; src/core/tools.ts:1839-1852 | A non-durable worker default still reads as fully accepted; an absent store is not even logged |
| 13 | cosmetic | .scratch/night/handoff.md:39 | The morning handoff tells the human an invalid model should be refused |

## Risky findings

### 1. The durable worker default is never revalidated; a removed or renamed model is applied to every later worker

**Where:** src/adapter/cordis-dsh-host.ts:3699-3703 (refresh restore, only usableRoute), 3988-3995 (spawnWorker applies explicitWorker ?? storedDefault; the comment at 3988-3990 says "Catalog validation already happened in the tool path; this is the last guard, not a second resolver"), 2966-2968 (write only shape-checks).

**What:** The leader's worker_model is resolved against the catalog once, at summon time. The resolved route is stored in the mark and the in-memory map. On restore and on every later worker spawn, the host only checks that provider/model are non-empty strings. It never asks the live catalog whether the route still exists, and the tool path never sees the stored default (an omitted spawn_worker.model does not call the resolver).

**Why it matters:** If a provider removes or renames a model, or the user disables that provider, after the leader was summoned, every subsequent worker is started with agentOptions for a dead route. Depending on the subagent provider, the activation either throws (the tool call fails, not a fallback) or the worker starts and dies on its first request; either way there is no model_fallbacks note, no warning, and no fallback to the leader's route. This contradicts ticket 285's fallback rule (lines 59-65: invalid or unknown values are ignored, not refused) and ADR-0035's "the catalog is advisory: a model the catalog does not list is treated as unknown and falls back" (line 21). This is the one I would fix first.

**What I would do instead:** Revalidate the restored/stored default once per leader activation (or on the first worker spawn) against readLlmCatalog; if it no longer resolves, delete it from the map, warn once with the worker_model wording, and let the worker inherit the leader's route.

### 2. The fallback seam is not total: a rejected resolver or an unexpected catalog shape still refuses the spawn

**Where:** src/core/tools.ts:904 (await resolve(trimmed, purpose) with no catch), 915 (an unexpected absent result returns {} silently); src/adapter/model-option.ts:262-272 (no guard for a non-iterable listProviders return, a non-array listModels return, or a non-string id); src/adapter/cordis-dsh-host.ts:4146-4148 (the wrapper comment says "Never throws for a bad value").

**What:** The resolver catches throws from the catalog methods, but not a catalog that returns the wrong shape: [...providers] in resolveExplicitRoute, models.find in findModel, and .toLowerCase() on an id can all throw. The host wrapper does not catch, and resolveModelArg does not catch a rejected resolve; the tool handler throws before the spawn. The handler also treats an unexpected absent result for a non-empty value as "not provided" and returns {}, silently dropping the model choice without a warning or note; the resolver contract only defines absent for an empty or omitted value, so this is a contract violation, not a legitimate omission.

**Why it matters:** The feature's central promise is that a bad value never refuses the spawn. A host/catalog contract violation, or a future resolver implementation that rejects, turns a spawn into a harness error; the caller cannot tell it was the model option. The silent absent branch is the same failure in the other direction: a model choice disappears with no signal.

**What I would do instead:** Make the seam total: catch a rejected resolve in resolveModelArg and any unexpected catalog shape in resolveModelOption, convert it to a catalog-error fallback with one warning, and treat an absent result for a non-empty value as a fallback or wiring error rather than {}.

### 3. Catalog reads have no timeout or abort; a hung provider blocks the spawn

**Where:** src/adapter/model-option.ts:155-162, 193-200, 262-272; src/core/tools.ts:904.

**What:** listProviders and every listModels call are awaited with no bound and no signal. The tool call's exec signal is read only later (spawn_dispatcher) or not at all on the worker host path. If a provider's catalog call hangs, the spawn tool call stays open, no worker is created, and the fallback never runs.

**Why it matters:** The ADR says the catalog may be slow (line 30), but there is no ceiling. A flaky provider can stall a spawn for the rest of the turn; the user sees no spawn and no explanation.

**What I would do instead:** Bound the catalog read with a short timeout combined with the tool's abort signal, and map a timeout to catalog-error/catalog-unavailable so the spawn falls back.

### 4. The restore is fire-and-forget; a first-turn worker spawn can miss the durable default

**Where:** src/plugin.ts:1586 (void host.refreshDispatcherMarks()); src/adapter/cordis-dsh-host.ts:3676-3705 (the restore awaits store.listDispatcherMarks()).

**What:** onActivated starts the restore without awaiting it. The activation fence comment (plugin.ts:1580-1585) reasons about a send, which can only exist after a dispatcher turn is open, not about the leader's first-turn spawn_worker call. If the store read is slow, the leader's first turn can call spawn_worker before the map is populated; the worker silently loses the stored default and inherits the leader's route, with no warning or note.

**Why it matters:** This is the restart path the feature explicitly promises (ticket 285 acceptance criterion, line 104). The window is small on a healthy store, but the failure is silent and only appears after a restart, which makes it hard to diagnose.

**What I would do instead:** Await the mark restore before the first turn, or make spawnWorker read/peek the leader's mark row when the in-memory map misses, so the default is available at the first spawn.

### 5. A malformed workerModel discards the whole dispatcher mark for that leader, not just the default

**Where:** src/adapter/durable-marker.ts:421-439 (parseDispatcherMark throws for a non-object or empty provider/model); the domain spec at src/adapter/durable-marker.ts:501 sets invalidRecords: "backup-and-skip".

**What:** A present workerModel must be a plain object with non-empty string provider and model; otherwise parseDispatcherMark throws. The storage domain's backup-and-skip policy catches the schema failure, moves the whole row aside as a .bak file, and treats the dispatcher mark as absent. The optional field's malformedness therefore discards the rest of the row too — the required sessionId and any parentSessionId/generation the host wrote — so after a restart this leader may not be recognised as a spawned dispatcher at all, and its worker default is lost.

**Why it matters:** The code comment only weighs "a half-filled route would restore a default the host cannot apply" against "reading the row as no default"; it does not consider that rejecting the row also drops the leader's durable identity. The blast radius is one leader, not the whole table (backup-and-skip prevents that), but it is still more than the default. The test asserts the whole row throws (test/adapter-durable-marker.test.ts:630-716), so this is deliberate strictness with an unintended scope.

**What I would do instead:** Parse workerModel leniently: if it is present but malformed, drop only that field (log once) and keep the row's required identity fields, so a bad optional value cannot erase a good dispatcher mark.

### 6. The in-process default can outlive its leader and apply to a reused id

**Where:** src/adapter/cordis-dsh-host.ts:2960-2969 (writeDispatcherMark sets the map when a default is present, never deletes it when absent), 3539-3590 (agent/disposed does not clear workerModelDefaults), 4703-4715 (phantom cleanup only clears ids that never became live).

**What:** workerModelDefaults is a process-global map keyed by session id. A live leader's entry is never removed on disposal. If the host later reuses that session id for a different leader spawned without worker_model, the new leader's workers inherit the old default. The durable row is replaced without the field, so the in-memory and durable states diverge. The comment at 2963-2965 promises a malformed route "stores nothing, so a later worker keeps today's inherited route"; that is false when an earlier entry for the same id survives. The phantom cleanup already guards the "create produced no session" case, which shows id reuse is considered possible; the disposed-live case is not guarded.

**Why it matters:** A model choice silently leaks to the wrong dispatcher. It is conditional on id reuse (normally UUIDs), hence risky rather than a break, but it is the leak the durability question asks about.

**What I would do instead:** Clear the map entry when a dispatcher mark is written without a worker default, and/or on disposal when the durable row no longer carries one, so the durable row is the only source of a legitimate default.

## Cosmetic findings

### 7. A partial catalog failure is reported as "unknown model"

**Where:** src/adapter/model-option.ts:229-232.

**What:** In the bare-id pass, if some providers' listModels threw and none of the readable providers matched, the result is unknown-model ("not in the model catalog"), even though part of the catalog was unreadable. The catch blocks (155-162, 195-200) also discard which provider or error failed.

**Why it matters:** The note is confidently wrong: a user with a broken provider is told the model does not exist. It is cosmetic because the spawn still falls back.

**What I would do instead:** If failedProviders > 0 and no match, return catalog-error (or a distinct "catalog incomplete" reason) and mention the failed provider count; keep unknown-model only when every provider was readable.

### 8. The tool-result note and ack embed the untruncated, unsanitized value

**Where:** src/core/tools.ts:908-912 (requested: trimmed); src/core/tool-results.ts:715 (spawn ack) and 317-318 (dispatcher note); the warning path truncates and sanitizes at src/adapter/model-option.ts:87-90.

**What:** The model_fallbacks field, the ack line and the dispatcher note use the full trimmed value, not the 120-character sanitized form used in the log. A very long value, a newline or a quote can bloat the tool result or forge lines in the ack/note.

**Why it matters:** The feature's own "truncate and sanitize" rule applies only to the process log; the model-facing surface is the one that affects context size. It is cosmetic for normal model ids.

**What I would do instead:** Use the same sanitized/truncated display value for ModelFallbackNotice.requested and both note builders.

### 9. Fallback copy assumes a team leader and is vague about the stored default

**Where:** src/adapter/cordis-dsh-host.ts:4163-4164 (worker fallback description: "the team leader's default worker route or its own route"); src/core/tool-results.ts:715 (ack: "this worker uses the inherited route").

**What:** spawn_worker is on the user-started dispatcher too, so a user dispatcher's worker fallback warning calls it "the team leader." The ack says "inherited route" even when the leader's stored worker_model is what applies; the ticket's destination is "the stored default, else the leader's route."

**Why it matters:** Log and tool-result wording; the user dispatcher is not a team leader and the ack does not say which route was used. Cosmetic.

**What I would do instead:** Use class-neutral wording ("your default worker route or your own route") and say "the leader's worker default, else its route" in the ack/note.

### 10. Docs say a bare id must be unique; the code accepts a shared id via the spawning session's provider

**Where:** README.md:94 ("A bare model id works only when it names exactly one catalog model"); docs/adr/0035-spawn-model-option.md:17 (says exactly one, then adds the preferred-provider tie-break); code src/adapter/model-option.ts:214-225; test test/model-option.test.ts:210-228.

**What:** The code deliberately resolves a bare id shared across providers to the spawning session's provider. The README says it works only when unique; the ADR contradicts itself in the same paragraph; the tool description (src/core/tools.ts:328-329) also says "accepted when unique."

**Why it matters:** A caller who reads the docs will not try a shared id; one who tries it gets a success the docs say is impossible. Cosmetic, but it is exactly a value that looks rejected by the docs yet is accepted.

**What I would do instead:** Document the tie-break in one sentence: a bare id is accepted when it is unique, or when one of its providers is the spawning session's provider; otherwise it is ambiguous and falls back.

### 11. ADR says a route change does not change maxTokens; the leader path drops it

**Where:** docs/adr/0035-spawn-model-option.md:25 ("A route change clears the inherited reasoning effort; it does not change the parent's maxTokens"); code src/adapter/cordis-dsh-host.ts:4314-4324; test test/spawn-dispatcher-host.test.ts:2330-2350.

**What:** An explicit leader route builds a bare provider/model and drops the inherited reasoningEffort and maxTokens. The test explicitly asserts the drop; the plan's risk table acknowledges it (PLAN.md:1059); the ADR says maxTokens is not changed. The ADR's Consequences line 32 correctly describes the worker merge keeping maxTokens, so the contradiction is only in the leader sentence.

**Why it matters:** A reader relying on the ADR for the leader path gets the wrong behavior. Cosmetic docs, not a code bug.

**What I would do instead:** Say "an explicit leader route replaces the inherited route and drops its reasoning effort and maxTokens; a worker route change clears effort but the subagent merge keeps the parent's maxTokens," or change the code if the ADR's intent was to keep it.

### 12. A non-durable worker default still reads as fully accepted

**Where:** src/adapter/cordis-dsh-host.ts:2970-2971 (no store returns silently), 2988-2997 (write failure logs only); src/core/tools.ts:1839-1852 (success note has no durability signal).

**What:** If the marker store is absent or the write fails, the worker_model is in the in-process map but not durable. The spawn result still reads as fully accepted. The ADR/ticket say the loss is logged (ticket 285 line 69), but an absent store logs nothing; a write failure logs to the process log, which the calling model does not see.

**Why it matters:** A worker_model that looks accepted but will not survive a restart. It is cosmetic in production (the store is wired), but the tool result gives no signal.

**What I would do instead:** Surface the mark-write result to the caller as a note/flag when the store is absent or the write fails, and at minimum log the absent-store case once.

### 13. The morning handoff tells the human an invalid model should be refused

**Where:** .scratch/night/handoff.md:39.

**What:** The "What to click" instruction says "A model name that does not exist should be refused at spawn with a clear error, not start and fail later." That is the opposite of ADR-0035 line 21, ticket 285 line 61, README.md:96, and the code (fallback, one warning, model_fallbacks note). A human verifying from the handoff will see the worker start and mark the feature broken.

**Why it matters:** This is the most likely source of a false "it is broken" report tomorrow morning. It is not a code defect, but it is the highest-value docs fix after finding 1.

**What I would do instead:** Change the handoff line to expect a fallback: "an invalid model starts the worker on the inherited route, writes one [multitask-dispatcher] warning, and the tool result carries model_fallbacks."

## Process notes (not counted as findings)

- ADR-0035 is still "draft (non-human-approved)" and says every answer is agent-drafted; ticket 285 is "resolved" but its acceptance boxes at lines 100-105 are unchecked. The code is on main. This is a governance gap, not a code defect: the owner's ruling is still pending, and the handoff's refusal expectation suggests the team has already diverged on what was decided.
- Commit 739b49c bundles an unrelated ticket-194 change (await_agent now refuses timeout_ms: null, src/core/tools.ts:1685-1695) with the model feature. It makes the feature diff noisier and the ticket-285 review harder; no behavior bug in the model path.

## What I did not verify

- No live model call; the catalog contents, entitlement, and a real worker's first request are untested here. The ADR already accepts that a catalog hit does not prove entitlement and that there is no mid-run fallback.
- No live restart; the restore is covered by test/spawn-dispatcher-host.test.ts with a listable fake store, not by a real dsh restart.
- The tests assert the activation request carries agentOptions; they do not prove the subagent provider honors it end to end. The ADR says the in-process provider advertises the capability.
- The full suite was not rerun; the handoff reports 1294/1294 at cc69118. The leader's own model before its first turn can revert on a cold resume (PLAN.md:449, stated as a narrow edge, not solved).

## Suggested order

1. Finding 1: revalidate the stored default; this is the one that silently starts workers on a dead route.
2. Finding 2: make the resolver/tool seam total; this is the one that can still refuse a spawn.
3. Finding 3 and 4: bound the catalog read and await the restore; both are availability/durability edges.
4. Finding 5: keep the required dispatcher mark when only the optional workerModel is malformed; finding 6: clear the default when a mark is written without one.
5. Findings 7-13: one-line docs/copy/UX fixes; finding 13 before the human verification.
