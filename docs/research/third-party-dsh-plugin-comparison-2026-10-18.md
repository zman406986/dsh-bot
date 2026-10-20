# Third-party dsh plugin comparison: Fei2411/DeepSeek-Bot and its fork QingJ01/DS-Bot-App

- Question: Do either of these public third-party dsh plugins substitute for this project, and if not, which of their design ideas are worth adapting into `src/`?
- Scope: the two GitHub repos only, read against this repo (`dsh-multitask-dispatcher`, MIT, TypeScript Cordis plugin). No dependencies installed; no source from either repo modified or copied.
- Method: read-only shallow clones at `C:\Users\TZhen\AppData\Local\Temp\gh-analysis\DS-Bot-App` and `C:\Users\TZhen\AppData\Local\Temp\gh-analysis\DeepSeek-Bot`, plus `gh` repo metadata and direct reads of the files cited below, on 2026-10-18. Upstream paths below are repo-relative (inside those clones), not paths in this repo.
- Date: 2026-10-18

**Status:** evidence only — never a ruling. This note takes no side for the authority stack (`docs/agents-rulebook.md`, level 8) and creates no exception-list item. Adopting any item below needs its own ticket, and an ADR where it changes a recorded decision.

## Verdict

**Do not fork either repo.** Both implement a different product unit (long-lived named Bots), in untyped JavaScript, under an Apache-2.0 + `NOTICE` regime our copy policy does not accept for vendoring. What transfers is **design knowledge**: eight mechanisms worth re-deriving behind our own seams, listed with their upstream paths below.

## Fei2411/DeepSeek-Bot (upstream)

- **What it is:** a dsh plugin that turns a dsh install into a team of long-lived, named Bots — a Main Bot, bot-to-bot hand-offs up a work tree, and group chats where members speak in turn. It targets the same host as us (DSH `0.2.0-rc.2` baseline) through the same Cordis mechanism (`cordis.patch.yml` insert row, `@deepseek-ai/*` peers).
- **Stack:** plain JavaScript ESM, no TypeScript anywhere. React 19 client bundled by esbuild into a committed `client.js` registered through `window.__ModuleLoader__.load`; `node:sqlite` FTS5 for history search; npm; Node 22.19+; **no runtime dependencies** (esbuild is the only devDependency; the fork later adds `ws` and `qrcode`).
- **License:** Apache-2.0 with a `NOTICE` file (records DSH MIT lines reused in a dev-only launcher; everything else is credited as ideas, not code). This repo is MIT.
- **Maturity:** created 2026-10-07, so 11 days old at review; 419 commits, 2,442 stars, 235 forks, 8 releases (`v0.1.0`–`v0.1.7`), 47–52 open issues. Effectively a single-maintainer project (342/419 commits by one person under three name spellings).
- **Architecture:** one plugin (`name = 'ds-bot'`) that wraps no inference loop — every Bot is an ordinary DSH root session, driven with `agent.followup` / `agent.steer`. Roster, rooms, open works, and prefs live in one whole-file `state.json` guarded by a one-writer file lock; `inflight.json` notes the single in-flight turn for restart resume; a context steward decides checkpoint-in-place vs a fresh session part; chat history is indexed in SQLite FTS5.
- **Tests:** 71 test files (~13.5k LOC) with a hand-written fake Cordis context and a scripted mock model; CI matrix Linux/Windows × Node 22/24 × two DSH versions, plus a leak scan and a Docker boot+migration job.

## QingJ01/DS-Bot-App (7-day fork)

- **What it is:** a fork of the repo above that adds a React Native / Expo mobile app and a phone-to-host bridge ("Your Bot team, on your phone"). It keeps upstream's long-lived-Bot model; it is not a dispatcher either.
- **Stack:** the same JavaScript ESM host half (no TypeScript), plus an Expo 54 / React Native 0.81 app in TypeScript, a dependency-free mobile SDK, and a separate HTTP+WebSocket bridge at `/mobile/v1`. Three independent npm projects; no root package.json.
- **License:** Apache-2.0, same `NOTICE` shape (DSH MIT lines plus idea-only credits).
- **Maturity:** created 2026-10-11, 63 commits, 112 stars, 8 forks, 3 releases with Android APKs. Issues are disabled; two external PRs open. Heavy CI for its age: plugin tests on two OSes × Node 22/24 × two DSH versions, a client-bundle staleness check, lint, and a Docker startup+migration job.
- **Architecture:** upstream's host modules plus mobile bridge code; 85 test files (~16.6k LOC). Same `state.json` + `home-lock.js`, same `inflight.json` resume, same steward/`parts.js` compaction, same FTS5 `chat-index.js`. No dispatcher, no worker pool, no todo ledger, no blank workers — confirmed by grep.

## Adopted-candidate ideas (re-derive; never paste)

1. **Context steward: condense-in-place vs move-to-a-new-part.** Upstream `ds-bot/src/host/steward.js` and `ds-bot/src/host/parts.js` (the fork carries the same pair). A cheap model call at a check line (default 0.8 of the usable window) answers `{"action":"switch"|"compact"}`; `compact` condenses older messages in place keeping user messages verbatim, `switch` writes a handoff note and opens a fresh session part. **Ours:** no equivalent — long worker tool loops rely on dsh defaults plus our own report clamping (`src/core/report-clamp.ts`). If adopted, the worker FSM gains a `compacting` event and the steward call goes through `DshHost`, never a second LLM client.
2. **Restart resume of the single in-flight turn.** Upstream `ds-bot/src/host/resume.js` (252 lines: `inflight.json`, re-deliver once after a 3 s delay, explicit "approvals are gone" text, `agent/inbox/discarded` listener). **Ours:** `src/adapter/restart-notice.ts` plus durable markers (`src/core/durability.ts`, ADR-0006) already report unknown-state honestly but never resume, because ADR-0012 rules that restart replays durability, never work. Their file is the smallest honest shape if that ruling ever changes; today it is a reference, not a change.
3. **Single-writer home lock across two dsh hosts.** Upstream `ds-bot/src/host/home-lock.js` (97 lines: pid + hostname + random token, mtime heartbeat, stale detection, second host goes read-only, token-not-pid ownership). **Ours:** markers live in `ctx.storageDomain` via `src/adapter/durable-marker.ts`, so there is no shared file to clobber today. Relevant only if we ever persist outside dsh storage; `docs/research/exclusive-lock-ladder-applicability.md` already records that our core needs no lock chain, and ticket 109 covers the one real in-process window (per-stream spawn).
4. **FTS5 transcript search with part anchors.** Upstream `ds-bot/src/host/chat-index.js` (293 lines; trigram tokenizer, BM25 ranking, derived index rebuilt by deleting the file). **Ours:** `check_workers` shows recent activity, but a settled worker's transcript is reachable only through dsh; the dispatcher cannot answer "what did worker B find?" without asking the user to open dsh. A derived index is compatible with ADR-0006/A5 ("no second transcript DB") precisely because it stores no truth — deleting it costs only a rebuild.
5. **Scripted mock LLM for end-to-end runs.** Upstream `ds-bot/dev/mock-llm.mjs` (686 lines; Anthropic-Messages-compatible, scripted commands, estimated usage, system-prompt hashes) plus `dev/bench.sh` and `dev/check.sh` (per-test data dirs, port slots, process-group cleanup). **Ours:** `src/core/fake-host.ts` is unit-level only; there is no real-host end-to-end path. This would let S1–S5 run against a live dsh with zero tokens, and the grouped-run shape matches our "smallest test set, one run" rule. Any use must stay inside `read-before-running-live-and-browser-tests.md` (kill timers, trivial tasks, no key export).
6. **Redacted diagnostics for public reports.** Upstream `ds-bot/src/host/diagnostics.js` (257 lines; credential pattern table, home-path scrubbing, JSONL log, in-app report flow). **Ours:** no diagnostics subsystem; the client has only console-only diagnostic lines (`src/client/index.ts`). A redacted local log the user can paste into a report is a maturity feature we lack, and it pairs with the existing live-test evidence layout.
7. **Client-bundle staleness check.** Upstream `ds-bot/scripts/build-client.mjs --check` plus `ds-bot/test/client-bundle.test.js` (fails when the committed bundle differs from a fresh build). **Ours:** `scripts/build-client.ts` writes `client/index.js`, but `client/` is git-ignored and rebuilt at `prepack`, so there is no committed-bundle drift to catch. A `--check` mode still guards a stale local or packaged artifact and is cheap; `test/client-face-scaffold.test.ts` builds the bundle in-memory and checks its shape, but never compares it against the file on disk.
8. **CI matrix.** Upstream `.github/workflows/test.yml` and `build.yml`: OS × Node × DSH version, plus bundle check, lint, leak scan, and a Docker boot job. **Ours:** there is no `.github/` directory and no CI at all. Our suite is already offline and key-free, which is exactly what makes a matrix runnable; even one OS × one Node leg would catch Windows-only breakage, and the owner works on two Windows machines.

Not on the adoption list, but noted: their byte-stable prompt-prefix discipline (`ds-bot/src/host/prompt.js`) and their work-tree result forwarding (`ds-bot/src/host/handoffs.js`), a possible shape for our Phase-2 peer inbox.

## No-fork rationale

1. **Different product unit.** Their agent is a persistent Bot carrying its own memory and session; ours is a blank worker spawned per stream and steered by a dispatcher. The PRD's core contract (blank prompts, workers are leaves, todo ledger, completion wakes) has no counterpart there — forking would mean deleting their core model and writing ours on an untyped base.
2. **Language and seam mismatch.** Their host half is ~11k LOC of untyped JavaScript (~25k across the plugin, client included) with no `DshHost`-style boundary; every module reaches `ctx` through a shared runtime object. Our ADRs assume TypeScript `strict` and one host boundary (ADR-0001). Porting our core into their tree is a rewrite, not a fork.
3. **License and copy policy.** Apache-2.0 is compatible with distributing MIT code, but our rulebook is stricter than copyright: ADR-0018 B9 bans verbatim copying and permits only adapted, independently named work. A fork would drag their `NOTICE`, identifiers, prompts, and file layout through our tree and create an audit burden with no product upside.
4. **Scope drag.** The fork carries an Expo/React Native app, an Android APK pipeline, a phone bridge, Docker packaging, group chats, per-bot memory, usage ledgers, and a self-update system. None of that is in our PRD: §2 rules out rebuilding dsh's inference/transcript/tool runtime, remote desktop parity, and UI or binary parity, and ADR-0018's exception list already places an agent-identity roster, per-agent memory, and group rooms outside our product (C13/C14). That is a large surface to own for zero dispatcher value.
5. **Maturity is shallow as a fork.** Upstream is 11 days old and single-maintainer; the fork is 7 days old with issues disabled and external PRs pending. Even as a base it is a fast-moving target we cannot follow into our profile model.

What it is good for instead: a **reference implementation of the dsh seams we share** — Cordis services used, client-bundle technique, `agent.steer`/`followup`/`inbox`, approval interception, restart resume, FTS5 history, and a proven CI matrix. Take the ideas, restructured and independently named; leave the code.

## Shared dsh seams (why their code reads as familiar)

Both repos run on the same host surface our adapter uses, which is why their host modules are readable without translation:

| Seam | Their use | Our equivalent |
|---|---|---|
| Cordis `apply(ctx)` + `inject` | one plugin, `inject` on `llm`/`tools`/`sessions`/`sessionController`/`systemPrompt` | `src/plugin.ts`, `src/adapter/cordis-dsh-host.ts` |
| `agent.followup` / `agent.steer` | delivery layer chooses steer vs queued followup | `src/core/steer-queue.ts` (single-slot, last-wins) |
| `agent.inbox` | remove queued messages without opening a turn | steer-queue park/interrupt path |
| `ctx.on('approval/request')` | answer approvals inside hidden sessions | `src/adapter/dispatch-approval.ts`, `src/core/access-relay.ts` |
| `ctx.storageDomain` | not used — they keep a whole-file `state.json` | `src/adapter/durable-marker.ts` (the accepted approach per ADR-0006/A5) |
| Client `window.__ModuleLoader__.load` bundle | esbuild → committed `client.js` | `scripts/build-client.ts` → `client/index.js` (ADR-0014) |

Two consequences follow. First, differences between us and them are **product-model** differences, not host-API differences — which is exactly why the no-fork verdict rests on the product unit rather than on technical incompatibility. Second, API-version drift is the practical risk if any idea is adopted: their baseline is newer than our pinned research host.

## Caveats before adopting anything

- Their baseline is DSH `0.2.0-rc.2` / `0.2.1-alpha.1`; our live-test research is pinned to `0.1.5-rc.1/rc.2` and our peer dependency is `*`. Re-verify any API usage (`agent.steer`, `agent.inbox.remove`, `agent/inbox/discarded`) against our installed host before relying on it.
- Their smoke bench needs a DSH checkout plus the mock model; our live-test guide already forbids unaccompanied live LLM runs. Any adoption must start in the offline suite.
- Their `state.json` pattern conflicts with ADR-0006/A5 (no second DB); the lock pattern may be adapted, the state file may not, unless an ADR says otherwise.
- Maturity numbers are point-in-time (2026-10-18) and will drift; re-check with `gh` before citing them.

## Sources

- `C:\Users\TZhen\Desktop\dsh-bot\.scratch\repo-analysis\2026-10-18-ds-bot-app.md` — local-only analysis of the fork. **Untracked scratch; not committed; disposable evidence.**
- `C:\Users\TZhen\Desktop\dsh-bot\.scratch\repo-analysis\2026-10-18-deepseek-bot.md` — local-only analysis of the upstream repo. **Same status.**
- Files cited under "Adopted-candidate ideas" were read directly in the two clones named under Method; repo metadata came from `gh` on 2026-10-18.
