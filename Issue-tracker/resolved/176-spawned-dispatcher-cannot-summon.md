# 176 — A summoned dispatcher cannot summon another dispatcher

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** nothing hard. `src/core/policy/prompts.ts` is being edited by ticket 174 (access removal) and ticket 175 (class-split of the remaining blocks) — keep this ticket's prompt edit to one narrow insertion and re-read the file immediately before editing.
**Origin:** owner-directed, 2026-11-03. *A dispatcher that another dispatcher summoned (the "spawned" / team-leader class) must NOT be able to summon more dispatchers.*
**Related:** ADR-0032 (a summoned dispatcher is a top-level session — untouched), ADR-0025 / decision 2 (the summoned peer carries the dispatcher surface), ADR-0034 (the two policy classes), ticket 173 (the two classes), ticket 175 (class-split of the remaining prompt blocks), ticket 118 (mitosis), ticket 131 (the 2026-10-22 "no cap of ours" ruling), ticket 141 (generation), ticket 130 (durable dispatcher mark).

## Problem

Today a summoned dispatcher carries the full dispatcher tool surface, `spawn_dispatcher` included. It can therefore summon another dispatcher, which can summon another, with no bound of ours (ticket 131, ADR-0032 decision 5). The owner has now ruled the spawned class may not summon at all.

This is a **class rule, not a depth cap**. It does not reverse ticket 131 or ADR-0032 decision 5's "no cap of ours": the tree still has no count or depth bound — it simply has no second level, because the only node that can summon is the user-started one.

## Decision — three layers, all required

### 1. Tool surface: the spawned class never sees the tool

`registerDispatcherTools` gains the class (`origin`, the existing `DispatcherOrigin` vocabulary from `src/core/policy/prompts.ts`) and omits the `spawn_dispatcher` definition when `origin === "spawned"`. The tool is not registered at all, so a team leader gets host `UNKNOWN_TOOL`, not a refusal copy — ADR-0019's "visibility is the fence" holds.

`src/plugin.ts`'s `activateToolSurface` needs the class of the session it is registering for. It gets it from a plugin-local set populated in `onDispatcherSpawned` (the only caller of `lifecycle.activate` that passes `origin: "spawned"`) and cleared in `onDeactivated`. Ticket 175 adds a fuller per-session origin record inside the lifecycle; this ticket does not wait for it and does not edit `parent-agent.ts` (ticket 175's file). When 175 lands, the plugin-local set becomes redundant and can be retired against `lifecycle.dispatcherOrigin`.

### 2. Host refusal: the backstop, loud

`spawnDispatcher` in `src/adapter/cordis-dsh-host.ts` refuses when the CALLING session is spawned-class. The refusal is a thrown `Error` with the `CordisDshHost:` prefix the file already uses, and it names the rule and the remedy (report to the summoner; the summoner spawns). It is not a silent no-op and not a fabricated host error class.

The class is resolved from facts the host already owns, in this order:

1. the in-process class mirror, written by `activateSpawnedDispatcher` (`"spawned"`) and `resumeUserStartedDispatcher` (`"user"`) — covers every session this process activated;
2. the spawn-generation mirror: `dispatcherGenerations.get(id) >= 2` means spawned (the spawn path writes `spawner + 1`, so 1 never appears there);
3. the durable mark answer: `"dispatcher"` means spawned, `"not-dispatcher"` means user-started.

### 3. Prompt rule: the team leader is told why

`buildSpawnedDispatcherSectionEn` / `_Zh` gain one rule bullet. EN and ZH stay line-for-line equal (one line each) — `test/policy-assembler.test.ts` pins the line count and the bullet count, which moves from 6 to 7 for the spawned class.

## Cold resume: what class does a resumed spawned dispatcher read as?

Decided: **`spawned`** — it keeps the refusal — and this is the safe direction on both of its two failure modes.

The durable record that makes this answerable already exists. `dispatcher_sessions` rows are written only by the spawn path; `parseDispatcherMark` rejects generation 1, and a user-started dispatcher never carries a row. So *a mark row's presence means "another dispatcher summoned this session"*, which is exactly the class. No schema change and no new field is needed (the same reading ticket 175 records as ADR-0034 decision 4).

The four resume cases:

| Case | Class | Why |
|---|---|---|
| Cold-resumed summoned dispatcher, mark row present | `spawned` — refused | `resumeMarkedDispatcher` reads the mark and writes `dispatcherGenerations` before activation; the durable answer is also there for a store that has not opened yet |
| Resumed user-started dispatcher, no mark row | `user` — allowed | `resumeUserStartedDispatcher` records `"user"` from the `sessionKind` projection; the mark table answers `"not-dispatcher"` |
| In-process spawn of a dispatcher (either class) | known exactly | the mirror is written before the child can call any tool |
| Mark table not yet open AND nothing mirrored | **`spawned` — refused** (fail closed) | see below |
| No durable store at all (or one with no sync peek) AND nothing mirrored | `user` — allowed | nothing can ever be proven on that shape; the spawn path's own in-memory records above already covered every real spawned session |

**Why fail closed on "unknown".** The owner set this constraint explicitly. A wrong allow creates a second dispatcher level the owner ruled out, and nothing else would catch it. A wrong deny is visible immediately (the summon is refused with a clear message) and self-heals the moment the store opens. So an unanswerable class is treated as `spawned`.

**What that window actually costs.** It is not the normal user-dispatcher path: a `/dsh-bot` chat and a resumed user dispatcher both reach the host with a live mirror entry or an open store by the time any model tool call lands. The residual case is a boot where the mark store has not opened and the plugin's `refreshDispatcherMarks` (fired at activation, async) has not returned — the store opens inside `rebuildFromDurability`, which runs at activation, so `"unknown"` is a start-of-session transient rather than a steady state.

**The one case this cannot catch, stated.** A spawned dispatcher whose mark write failed (the accepted ticket-130 crash window between the create and the row write) is not durable at all: after a restart it does not even come back as a dispatcher (ticket 130's own limitation), so it is not a live team leader that could summon. Nothing new is lost here.

## Files

| File | Change |
|---|---|
| `src/core/tools.ts` | `DispatcherToolDeps.origin`; `createDispatcherTools` omits `spawn_dispatcher` for `"spawned"` |
| `src/adapter/dispatcher-tools.ts` | pass `origin` through to `createDispatcherTools` |
| `src/adapter/cordis-dsh-host.ts` | per-session class mirror, `spawnedDispatcherClass` resolution, refusal in `spawnDispatcher`; class recorded in `activateSpawnedDispatcher` / `resumeUserStartedDispatcher` |
| `src/plugin.ts` | plugin-local spawned-class set; `activateToolSurface` passes `origin` |
| `src/core/policy/prompts.ts` | one rule bullet in each face of the team-leader section |
| `test/spawn-dispatcher-activation.test.ts` | tool-set assertions for the spawned class; grandchild tests rewritten |
| `test/spawn-dispatcher-host.test.ts` | host refusal, both directions (6 new cases) |
| `test/adapter-dispatcher-tools.test.ts` | registration with `origin: "spawned"` and `"user"` |
| `test/policy-assembler.test.ts` | spawned bullet count 6 → 7, plus a text pin |
| `test/plugin-scaffold.test.ts` | the summoned child's `setup` no longer includes `spawn_dispatcher` |

## Assertions that previously encoded the now-reversed behaviour

1. `test/spawn-dispatcher-activation.test.ts` — *"Both surfaces carry the same eight dispatcher tools"* asserted `creator.scopedTools.names()` and `child.agent.scopedTools.names()` were equal. They are not any more: the user dispatcher has `spawn_dispatcher`, the summoned one does not. Rewritten to assert the difference (and to keep asserting that nothing else differs).
2. `test/spawn-dispatcher-activation.test.ts` — the ticket-141 grandchild tests (`"the generation rides the mark row"`, `"a cold-resumed grandchild is re-activated …"`) spawned a dispatcher from a dispatcher. That path is now refused by design. The first keeps its first hop and asserts the refusal; the second becomes the cold-resume class test.
3. `test/policy-assembler.test.ts` — the spawned-class bullet count pin (6) moves to 7.
4. `test/plugin-scaffold.test.ts` — `assert.ok(ctx.createdToolNames.includes("spawn_dispatcher"))` on the summoned child's composed `setup` surface. Inverted: the child's surface is composed WITHOUT it.
5. `test/spawn-dispatcher-activation.test.ts` — two bare `scopedTools.names().length === 9` / `=== 8` counts on a summoned child, now 8; and the ticket-130 cold-resume surface pin, now the spawned-class set.

## Constraints

- ADR-0032 stands. A summoned dispatcher stays a top-level session; nothing here turns it back into a subagent child to get a depth limit.
- The owner's text in `buildSpawnedDispatcherSectionEn` begins "Lead a team to tackle a massive job" and is preserved verbatim; only one bullet is appended.
- Both language faces move together.
- No cap of ours, no budget, no counter: this is a class rule.
- `FakeDshHost.spawnDispatcher` (the core test double) is not given a class model. The real host is the backstop; the fake is only used by core tests that do not model sessions.
- Offline tests only. No network, no LLM, no live dsh.

## Acceptance

- [x] A summoned dispatcher's scoped surface has no `spawn_dispatcher`.
- [x] A user-started dispatcher's surface still has all eight dispatcher tools.
- [x] `host.spawnDispatcher` throws a loud, named refusal when the caller is spawned-class.
- [x] A cold-resumed summoned dispatcher is still refused; a resumed user-started dispatcher still spawns.
- [x] Both prompt faces carry the new rule, line-for-line equal.
- [x] `npm run typecheck` clean (both configs). `npm test`: 741/743 pass; the 2 failures are ticket 174's `request_access` sweep and ticket 162's known inbox flake, neither in a file this ticket changed.

## Comments

**2026-11-03 — implemented. What actually shipped, and two course corrections.**

*Ticket 175 landed while this ticket was being implemented.* It added a `dispatcherClassOf` read on the `sessionKind` projection, a `DispatcherOrigin` parameter on `onUserDispatcherResumed`, and a `dispatcherClass` field that is set to `"spawned"` whenever the dispatcher-mark probe answers `"dispatcher"`. That is the same durable fact this ticket's cold-resume decision rests on, reached independently — good, and it means the reading in "Cold resume" above is now the tree's own rule rather than a proposal. It also means ticket 173's "Known limitation" is already closed for the PROMPT class; this ticket closes it for the TOOL SURFACE and the host refusal.

*Correction 1 — "unknown" means deny only when a store exists.* The first draft of `dispatcherClassForSummon` returned `"spawned"` for every unanswerable case. That would have broken every install with NO `storageDomain` at all (`markers === undefined`), where nothing can ever be proven and the pre-176 behaviour is the only honest answer. The rule as shipped is:

- recorded class → that class;
- recorded generation → `>= 2` is spawned (the spawn path writes spawner + 1, so 1 never appears);
- the mark mirror has the id → spawned;
- no store, or a store without `peekDispatcherMark` → `user` (unchanged legacy behaviour);
- a store that exists but answers `"unknown"` → **spawned** (fail closed);
- `"not-dispatcher"` → `user`.

*Correction 2 — the host needed a write seam for the user class.* Inference alone cannot distinguish "the human's `/dsh-bot` chat" from "a session the plugin never classified", and the fallback would have read the human's own dispatcher as `spawned` on any host where the store answered `"unknown"` at boot. So `CordisDshHost.recordDispatcherClass(sessionId, origin)` was added: the plugin records `"user"` at the three activation entry points (the `/dsh-bot` command, the resumed-user path) and `"spawned"` at the spawn hook. `recordDispatcherClass` never downgrades a known `"spawned"` to `"user"` — the class of a session id cannot change (ADR-0034 decision 1).

*Assertion count.* Four assertions pinned the reversed behaviour and were changed, listed in §Assertions above. A fifth was found in `test/plugin-scaffold.test.ts` (`createdToolNames.includes("spawn_dispatcher")` on a summoned child) and is listed there too.

*Test status at implementation time.* `npm run typecheck` exits 0 (both configs). `npm test` ran 743 tests with 2 failures, and neither is this change:

1. `test/adapter-racoons-mount.test.ts` — one assertion still lists `request_access` in the expected tool set. Ticket 174 deleted that feature; the test file is theirs and is being swept.
2. `test/inbox-end-to-end.test.ts` — a known full-suite flake, already ticketed as 162. It passes 5/5 in isolation.

Both files pass in isolation (or are mid-sweep by ticket 174), and neither imports anything this ticket changed. Every test file this ticket does touch passes in full: `spawn-dispatcher-activation` (18/18), `spawn-dispatcher-host` (14/14), `spawn-dispatcher-tool` (11/11), `adapter-dispatcher-tools` + `dispatcher-tools` (33/33), `policy-assembler` + `policy-zh-assets` (24/24), `plugin-scaffold` (16/16), `activation-lifecycle` (10/10).


### 2026-11-04 — PM closure

Shipped in commit `643a801` on `main`. Full suite green at closure (754 tests, 0 fail),
both tsconfigs clean, `npm run lint:docs` clean.
