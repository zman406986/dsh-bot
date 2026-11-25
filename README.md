# dsh-multitask-dispatcher

A plugin for DeepSeek Harness (`dsh`). It turns one dsh chat into a dispatcher.

## What this is

In dsh, one agent turn does the work, so a long job blocks the chat. This plugin adds a dispatcher: a chat agent that stays free to talk to you and hands long jobs to background workers. A worker starts blank. It sees only the prompt the dispatcher writes for it, never your chat. When a worker finishes, it wakes the dispatcher, and the dispatcher tells you the result in the chat.

The dispatcher has three tools of its own: `deliver_result`, `message_agent`, and `spawn_dispatcher`. Workers, status, steering, and stopping use dsh's own tools: `subagent`, `list_agents`, `send_message`, and `interrupt_agent`.

Workers are leaves. They never talk to you. A worker returns a final answer, which arrives in dsh's completion notice, and can send the dispatcher an interim note with `send_message`. When a worker needs access it does not have, it says so in its final answer and stops; there is no ask channel.

Status: version 0.1.0. It is not published to npm. Install it from a checkout.

## What you need

- Node.js 22.15 or newer. This is the `engines` floor in `package.json`; the e2e harness needs 22.15 for `zstdDecompressSync`. The fresh-install path was verified with Node 24 and npm 11.
- A local dsh install that can load plugins. It must be exactly dsh 0.2.2-rc.1: the plugin pins its dsh peer dependency to that version, and dsh enforces exact peer matches, so other 0.2.x versions will not do.
- npm, for building this repo. The build uses npm workspaces.
- pnpm, on PATH. `dsh plugin add` forwards to pnpm, and dsh does not bundle it; without pnpm the add fails (exit 127).
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

A CLI add activates the bundle for you: `dsh plugin add` registers and activates bundles that declare `dsh.bundle*`, so after the command above there is nothing to select. Installing through the web UI is different: that path sets `activateNewBundles: false`, so there you must activate the bundle `dsh-multitask-dispatcher` in the profile's bundle list yourself. Do not also add an insert row by hand: two rows with the same id make the plugin's settings form disappear.

The add hardlinks the checkout into the profile (`pnpm file:`). After you rebuild the checkout, replaced output files can leave the installed view stale; re-run the `dsh plugin add` command above to refresh it.

## Build

- `npm run build` compiles the plugin into `lib/`.
- `npm run build:client` bundles the browser module into the `client/` folder with esbuild. dsh serves that bundle to its web UI.
- `npm run typecheck` runs three no-emit passes: the plugin, the browser module, and the test tree.

`lib/` and `client/` are build output. They are git-ignored.

## Test

```bash
npm test
```

This runs the offline suite. It needs no network and no model. One test, `test/stock-worker-model-default.test.ts`, resolves the installed dsh host dynamically (a `DSH_HOST_DIR` environment override, then module resolution) and skips gracefully when no host is present; the rest of the suite stays offline.

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

### Choosing models

The summon tool and dsh's worker spawn both take an optional model.

- `spawn_dispatcher` takes `model` for the summoned team leader and `worker_model` for the default model of the workers that leader later spawns.
- A worker's `model` argument on dsh's `subagent` call chooses that one worker's route where the host offers the slot. An explicit value wins; the leader's stored `worker_model` applies when the argument is omitted.
- Write the value as provider/model-id. For example:

  ```text
  deepseek/deepseek-reasoner
  ```

  A bare model id works when it names exactly one catalog model, or when one of its providers is the spawning session's provider; otherwise it is ambiguous and falls back.
- Omit the argument to keep today's behavior: a leader inherits the summoning dispatcher's live route, and a worker inherits its leader's default or route.
- An unknown or invalid value does not refuse the spawn. The spawn falls back to the inherited route, writes one `[multitask-dispatcher]` warning to the dsh process log, and adds a short note to the tool result.

## Configuration

Every field is a setting on the plugin's card on dsh's Plugins page. A saved change is not applied live. It takes effect in the next chat.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turns the plugin on. Off registers nothing. |
| `wakeCoalesceWindowMs` | `0` | Batches background wakes into one dispatcher turn per window. `0` wakes at once. |
| `inboxEnabled` | `false` | Optional file inbox. Off starts nothing. |
| `inboxDir` | `""` | Inbox folder. Empty disables intake even when enabled. |
| `inboxRescanIntervalMs` | `5000` | Fallback rescan interval. Clamped to a 1000 ms floor. |
| `microcompactEnabled` | `false` | Clears old tool results on dispatcher sessions. Off, and not yet checked live. |

## Project layout

| Path | What is in it |
|---|---|
| `src/` | Plugin source: the policy core, the dsh adapter, worker prompts, and the browser module. |
| `test/` | Offline tests. |
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

## Problems

There is no CONTRIBUTING file and no SECURITY file yet. To report a problem, open an issue at https://github.com/zman406986/dsh-bot/issues.
