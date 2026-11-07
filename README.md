# dsh-multitask-dispatcher

A plugin for DeepSeek Harness (`dsh`). It turns one dsh chat into a dispatcher.

## What this is

In dsh, one agent turn does the work, so a long job blocks the chat. This plugin adds a dispatcher: a chat agent that stays free to talk to you and hands long jobs to background workers. A worker starts blank. It sees only the prompt the dispatcher writes for it, never your chat. When a worker finishes, it wakes the dispatcher, and the dispatcher tells you the result in the chat.

The dispatcher has eight tools: `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `message_agent`, `await_agent`, and `spawn_dispatcher`.

Workers are leaves. They never talk to you. A worker returns a final answer and can send the dispatcher a note with `reply_to_dispatcher`. When a worker needs access it does not have, it says so in its final answer and stops; there is no ask channel.

Status: version 0.1.0. It is not published to npm. Install it from a checkout.

## What you need

- Node.js 22.15 or newer. This is the `engines` floor in `package.json`; the e2e harness needs 22.15 for `zstdDecompressSync`.
- A local dsh install that can load plugins. The plugin targets the dsh 0.2.x plugin API and was last run against dsh 0.2.2-rc.1.
- npm. This repo uses npm workspaces, not pnpm.
- The cordis framework is a peer dependency. `npm install` fetches it.

## Install

```bash
git clone https://github.com/zman406986/dsh-bot.git
cd dsh-bot
npm install
npm run build:client
```

`npm install` runs `prepare`, which runs the main build. Then add the local package to a dsh profile:

```bash
dsh plugin --profile <profile> add file:<path-to-this-checkout>
```

Select the bundle `dsh-multitask-dispatcher` in that profile's bundle list. Do not also add an insert row by hand: two rows with the same id make the plugin's settings form disappear.

## Build

- `npm run build` compiles the vendored libraries and then the plugin, into `lib/`. It runs `build:vendor` first.
- `npm run build:vendor` compiles only `vendor/racoons/core` and `vendor/racoons/adapter`.
- `npm run build:client` bundles the browser module into the `client/` folder with esbuild. dsh serves that bundle to its web UI.
- `npm run typecheck` runs `build:vendor`, which emits the vendored libraries, then three no-emit passes: the plugin, the browser module, and the test tree.

`lib/` and `client/` are build output. They are git-ignored.

## Test

```bash
npm test
```

This runs the offline suite. It needs no network and no model. `pretest` compiles the vendored libraries first.

The offline suite is the default lane. A second harness, `npm run e2e`, drives a real local dsh process against a scripted model. It needs a dsh install, so it is optional.

## Use it

1. Open a normal dsh chat.
2. Type `/dsh-bot`. That chat becomes the dispatcher.
3. Ask for work. The dispatcher keeps answering and gives long jobs to workers.

One more command:

- `/dispatcher-steer <worker id> <instruction>` corrects a worker that is still running.

To stop, close the chat or unload the plugin. There is no stop command.

### Summoning a second dispatcher

The dispatcher can call `spawn_dispatcher` to summon another dispatcher.

- The new one is a new top-level session. It runs beside the first one, not under it.
- It has its own sidebar row, its own chat, and its own state.
- It does not see the first chat. The prompt it was given is its first message.
- The two talk with `message_agent`. Neither can wait on the other.
- The sidebar glyph is the only mark on a dispatcher session. There is no header chip.
- Only the user-started dispatcher class may summon. A summoned dispatcher is a team leader: it is not given `spawn_dispatcher` at all (ticket 176), so there is no second level of dispatchers.
- On the user-started class, the plugin sets no depth or count bound of its own. Because the new dispatcher is a top-level session, dsh's subagent depth limit and its live-child pool do not apply to it either. That is observed behaviour, not a promise.

## Configuration

Every field is a setting on the plugin's card on dsh's Plugins page. A saved change is not applied live. It takes effect in the next chat.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turns the plugin on. Off registers nothing. |
| `wakeCoalesceWindowMs` | `0` | Batches background wakes into one dispatcher turn per window. `0` wakes at once. |
| `inboxEnabled` | `false` | Optional file inbox. Off starts nothing. |
| `inboxDir` | `""` | Inbox folder. Empty disables intake even when enabled. |
| `inboxRescanIntervalMs` | `5000` | Fallback rescan interval. Clamped to a 1000 ms floor. |
| `racoonsEnabled` | `false` | Optional test feature. Off means racoons is not mounted at all. |
| `racoonsRecordOnly` | `false` | Only used while racoons is enabled. Records context cleanup without applying the bulk prune. |
| `racoonsStorageRoot` | `""` | Only used while racoons is enabled. Where the cleanup ledger is stored. Empty uses `<DSH_HOME>/storages/racoons`. |
| `racoonsContextWindowTokens` | `0` | Only used while racoons is enabled. Context window for the automatic prune. `0` leaves it off. |
| `microcompactEnabled` | `false` | Clears old tool results on dispatcher sessions. Off, and not yet checked live. |

The context-cleanup library (racoons) is an optional test feature and is **off by default**. When it is on, it covers every session in the dsh process; removed content can be restored by its recall id, and originals are stored per session under the storage root. Turn it on with `racoonsEnabled: true` — the `dev/windows/dsh-bot.bat racoons` route and `dev/cordis.racoons.patch.yml` are the supported ways.

## Project layout

| Path | What is in it |
|---|---|
| `src/` | Plugin source: the policy core, the dsh adapter, worker prompts, and the browser module. |
| `test/` | Offline tests. |
| `vendor/racoons/` | A vendored context-cleanup library. Apache License 2.0; see `vendor/racoons/LICENSE` and `vendor/racoons/PROVENANCE.md`. |
| `dev/` | The scripted model and the end-to-end harness. |
| `docs/` | Decisions, research notes, and notes on what the UI shows. |
| `Issue-tracker/` | Tickets, sorted by status. |
| `scripts/` | The browser bundle build. |
| `tools/` | Documentation checks and index generators. |

## Docs

- `docs/adr/README.md` — the decision index.
- `docs/surfaces.md` — what the plugin adds to dsh's screen, and what it does not.
- `docs/agents-rulebook.md` — working rules for this repo.

## Licence

MIT. See [LICENSE](LICENSE).

The vendored library under `vendor/racoons/` is under the Apache License 2.0. See `vendor/racoons/LICENSE`.

## Problems

There is no CONTRIBUTING file and no SECURITY file yet. To report a problem, open an issue at https://github.com/zman406986/dsh-bot/issues.
