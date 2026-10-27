# 151 — The dispatcher todo ledger is never written in live use, so the per-turn reminder is always empty

**Status:** resolved
**Labels:** needs-ruling
**Blocked by:** — the shape ruling was recorded 2026-10-28 (see `## Ruling`); research answered.
**Origin:** PRD gap scan 2026-10-28 — verified against the tree in a read-only pass; nothing implemented.
**Related:** PRD §6.1 (todo entry before spawn), §6.5 (todo queue semantics), §7.5 (data model), §13 M3 (S6 marked shipped), `docs/adr/README.md` ADR-0007 (the ledger belongs to the dispatcher alone), `reference-deviations/DD-164-todo-tool-vs-internal-ledger.md` (verdict DO-NOT-INCORPORATE for the reference's agent-authored tool), ticket 113 (file inbox, the only live creator).

## Problem

`spawn_worker` accepts an optional `todo_id` (`src/core/tools.ts:722`) and forwards it as `request.todoId` (`src/core/tools.ts:788`). At spawn the core calls `todoLedger.linkWorker(request.todoId, workerId, request.streamKey)` (`src/core/multitask.ts:1118`) — but `linkWorker` only edits an entry that already exists; it returns `false` when the id is unknown (`src/core/todo-reconciler.ts:602-609`) and the caller ignores the result.

So a spawn can never create a ledger entry. The only live creator is the opt-in file inbox (`Multitask.enqueueExternalJob`, `src/core/multitask.ts:1406`; `inboxEnabled` defaults to `false`, `src/plugin.ts:107`). The dispatcher surface has eight tools and none of them authors a todo (`DISPATCHER_TOOL_NAMES`, `src/core/policy/prompts.ts:65-74`).

Consequences, verified in the tree:

- The per-turn reminder renders `- (empty)` on every live turn: `assembleTurnReminder` maps an empty list to `EMPTY_LEDGER_LINE` (`src/core/policy/assembler.ts:85-88`; `src/core/policy/prompts.ts:141`).
- S6 ("Dispatcher todo list shows multiple `in_progress` streams and is reconciled on every wake", PRD:72) is inert in live use even though §13 M3 records it as shipped.
- The policy tells the dispatcher to write an entry before spawning (PRD:118) but ships no mechanism that can do it. Model-side workaround: reuse the todo id as `stream_key` (`src/core/tools.ts:287-292` tells it to) — that creates no entry either.
- Tests hide the gap: `test/dispatcher-tools.test.ts:136` (and many others) call `multitask.createTodo(...)` by hand before spawning, so the linked-row path is exercised while live creation is never exercised.

## Why this needs a ruling

The two obvious repairs contradict each other's recorded reasoning, and DD-164 rules out the third:

1. **Auto-create on spawn** — the tool call itself, or the spawn path, creates the entry from `stream_key`/`title` when `todo_id` names nothing. Keeps the ledger lifecycle-bound (ADR-0007) and fabricates no model-authored list. Downside: the dispatcher loses control of the entry text, and a typo in `todo_id` silently becomes a new entry instead of a no-op.
2. **A dispatcher todo tool** — a narrow create/update verb for ledger entries. Closest to what the policy prose already asks the model to do, but DD-164 rejects the reference's agent-authored todo list, and this could be read as its return under another name. Needs a ruling that states the distinction explicitly.
3. **Do nothing** — record S6 as file-inbox-only in the PRD and drop "todo entry before spawn" from §6.1. Lowest risk, but it deletes a success criterion.

## Ruling (2026-10-28, PM under owner full-rein grant, subject to reversal)

**Chosen shape: auto-create on spawn — option 1.**

- `spawn_worker` with **no** `todo_id` creates the linked ledger entry itself, between reading `todo_id` and building the spawn request (`src/core/tools.ts`, spawn handler). The entry is system-authored and lifecycle-bound: title and `stream_key` come from the call the model already makes; `in_progress` still comes from the existing `noteTurnStarted` path; retirement stays with delivery/reconcile.
- `spawn_worker` **with** a `todo_id` that names no entry **refuses** (`unknown-todo-id`, no spawn, ledger untouched). A typo must not silently become a new entry — the downside the ticket named in option 1 is closed by refusing.
- **No new create tool.** Option 2 is exactly what DD-164 rules out. The deviation record's own framing: *"The reference's is agent-authored, general-purpose, self-directed … The build's is dispatcher-owned and lifecycle-bound — entries are created by a spawn call and retired by delivery, and the model does not author or maintain them at all."* Verdict there: **DO-NOT-INCORPORATE**. A model-invoked create tool is the agent-authored list's first half under another name; auto-create keeps the model supplying only the title it already passes.
- Created in the tool handler, not inside `Multitask.spawnWorker`'s `register()`: the comment at `src/core/multitask.ts:1029-1030` requires a failed spawn to leave the ledger untouched, and reconcile prunes stale pending items, so an entry created before a spawn that then fails would be a phantom. The handler creates the entry, and prunes only the entry it created if the spawn fails.
- `linkWorker` silently returning `false` on an unknown id (`src/core/todo-reconciler.ts:602`) stops being reachable from the tool: the unknown case is refused before `multitask.spawnWorker` is called.
- Copy: the dispatcher prompt's "Write a todo entry first" line (`src/core/policy/prompts.ts:79`) now says the spawn records its own entry, so the model gives each spawn a clear title instead of trying to author a list.

**PRD §6.3 note:** the "Todos | existing todo tools" row was read as pointing at machinery that already exists (the ledger and its call sites), not as a requirement for a model-facing todo tool. Nothing in the PRD requires the reference's tool, and DD-164's verdict stands.

## Acceptance

- [ ] A live `spawn_worker` call produces a linked ledger entry with no file inbox enabled (test drives the tool, not `createTodo` by hand).
- [ ] The per-turn reminder can be non-empty without the file inbox; `reconcileTodos` sees the spawned stream.
- [ ] The chosen shape is recorded against DD-164: if a tool is added, the ticket comment states why it is not the reference's agent-authored list; if auto-create is chosen, the `todo_id` miss case is pinned (create vs ignore vs refuse).
- [ ] Existing tests that hand-create todos stay valid; the new test does not rely on any of them.
- [ ] No change to worker context (the ledger still never enters a worker, ADR-0007).

## Constraints

- Read-only against `vendor/racoons/**` and the reference-material folder.
- Offline tests only; no live dsh, LLM, or browser run needed to implement.
- No new storage: the ledger stays the existing core structure.

## Comments

2026-10-28: Filed from a read-only gap scan. Every cited line was re-read in the working tree (`d2fa388`), not taken from prior prose. The PRD/§13 "shipped" claim for S6 was not amended here — that amendment belongs to whichever shape the ruling picks.

The blocking research is running separately; this ticket stays unclaimed until its answer lands.

Label note: `needs-ruling` is not one of the five role strings listed in `agent.md`; it is used here because the filing instruction names it for this ticket. If the human prefers the canonical set, the nearest label is `needs-info` (the precedent on ticket 140).

2026-10-28 (implementation, ticket-151-auto-ledger): auto-create implemented in the `spawn_worker` handler; an unknown explicit `todo_id` now refuses with `unknown-todo-id` before any spawn; a failed spawn prunes only the entry that call created. `test/dispatcher-tools.test.ts` gained the three cases (auto-create/linked, unknown-id refusal with ledger untouched, failed-spawn no phantom); file plus typecheck green. The S6/§13 "shipped" wording still needs the recording amendment if review wants it — not touched here.

2026-10-28 (review round): blocker + four should-fixes landed on the same branch. (1) Ledger id sequence: `create()` with an explicit `todo-N` id now advances the generated counter past it (`src/core/todo-reconciler.ts`), so a restored `todo-1` no longer makes the next auto-created spawn throw — restart test added (`restored todo-1 → new spawn creates todo-2`). (2) EN policy copy at `prompts.ts:181-182` and the standing-rules line 218 reworded to "each spawn records its own todo entry"; ZH untouched. (3) Prune-on-failure is now conditional (`pruneIfUnlinked`): a throw from the durability marker write happens AFTER the worker was registered and the entry linked, so that entry is kept; test pins it. (4) The explicit-id refusal now also requires the entry to belong to the calling session and to have no linked worker (`todo-already-linked`); tests for both. (5) The duplicate-stream-key test now asserts the ledger (one entry, still linked to the first worker). Accepted reviewer notes 6-9 (result omits created id, wake-drain cosmetic reminder, mislabeled stream-key-held error, edited-case scope) are untouched. Tests: `dispatcher-tools` + `policy-assembler` + `todo-reconciler` + `durable-roster` = 87/87; adjacent `inbox-core`/`policy-peer-roster`/`adapter-policy-inject`/`delivery-obligation` = 62/62; typecheck core+client clean. The ticket-141 sha256 pin in `test/policy-assembler.test.ts` was re-pinned to the new intentional text, with the reason recorded beside it.

## Resolution — 2026-10-28

Landed via merge `a29bf71` ("Merge branch 'ticket-151-auto-ledger'"), carrying branch commits
`961aa3d` (auto-create) and `3a8a35e` (review fix batch: restart id-collision blocker plus the
should-fixes, with regression tests for restart `todo-2`, cross-session refusal, already-linked
refusal, and keep-entry-after-link-failure). 149 adjacent tests pass; typecheck clean.

PRD S6 ("Dispatcher todo list shows multiple `in_progress` streams and is reconciled on every wake")
is now reachable in live use without the file inbox.

Bookkeeping: `**Status:**` → `resolved`; moved
`Issue-tracker/open/151-dispatcher-todo-ledger-never-written.md` → `Issue-tracker/resolved/`.
