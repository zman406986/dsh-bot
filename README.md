# dsh-multitask-dispatcher

An always-on multitask dispatcher plugin for DeepSeek Harness (`dsh`).

## What it is

In dsh, one agent turn does the work, so a long task blocks the chat. This plugin adds a mode where the chat becomes a dispatcher: it stays responsive and hands non-trivial work to background workers. A worker starts blank — it sees only the prompt the dispatcher writes for it, never the dispatcher's conversation — and reports back when it finishes.

The dispatcher drives workers through eight tools: `spawn_worker`, `check_workers`, `steer_worker`, `stop_worker`, `deliver_result`, `message_agent`, `await_agent`, and `spawn_dispatcher`. Workers are leaves: they never address the user. They return a final answer, can send the dispatcher a mid-task note with `reply_to_dispatcher`, and can ask for a gated action or a named credential with `request_access`. That ask reaches the user as a prompt with Allow, Always allow (this session), or Deny; an unanswered ask is denied after a timeout.

Workers wake the dispatcher when they settle or ask for access; a peer dispatcher can message it; the optional file inbox can deliver a job. The dispatcher then answers the user in an ordinary chat turn. Results arrive as normal messages, not notifications.

## Status

Working plugin, version 0.1.0. Offline-tested: `npm test` runs the suite with no network and no LLM. A mock-LLM end-to-end harness (`npm run e2e`) drives a real local dsh process against a scripted model. Not published to npm yet; install it from a checkout. Open work is tracked in `Issue-tracker/open/`.

## Requirements

- Node.js 22 or newer (`engines` in `package.json`).
- A local dsh installation whose profile can load plugins. The plugin targets the 0.2.x plugin API; the code was verified against dsh 0.2.1-rc.3 (ticket 144, 2026-10-24; rc.2 was the previous baseline, ticket 114).
- npm. The repo uses npm workspaces, not pnpm.

## Build and test

```bash
npm install          # installs dependencies; `prepare` runs the build
npm run typecheck    # vendor build, then tsc --noEmit for plugin and client
npm test             # offline suite: no network, no LLM
npm run build        # compile the plugin to lib/
npm run build:client # bundle the browser module to client/index.js
npm run e2e          # mock-LLM end-to-end harness (needs a local dsh install)
```

`lib/` and `client/index.js` are build output and are git-ignored.

## Install into a dsh profile

Build first, including the browser bundle (the host serves `client/index.js`), then add the local package to the profile:

```bash
npm run build && npm run build:client
dsh plugin --profile <profile> add file:<path-to-this-checkout>
```

The package ships a bundle patch (`cordis.patch.yml`, selected through the "dsh.bundle.patch" key in `package.json`). Select the bundle in the profile's "dsh.profile.bundles" list and do not also add an insert row by hand: two rows with the same id make the plugin's settings form disappear. `docs/research/plugin-install-workflow.md` records the install workflow in more detail.

For development, the committed overlay boots the built tree into the stock web profile without touching that profile:

```bash
dsh --profile web --patch dev/cordis.web.patch.yml
```

`dev/cordis.src.patch.yml` is the same row pointed at `src/index.ts`; the e2e harness uses it.

## Usage

1. Open a top-level chat in dsh.
2. Type `/dsh-bot`. That chat becomes the dispatcher for the session. Activation is refused in a child chat.
3. Ask for work. The dispatcher decides what to delegate, spawns workers, and reports results back in the chat.
4. To leave the mode, dispose the chat or unload the plugin. There is no stop command.

Related commands:

- `/dispatcher-steer <worker id> <instruction>` sends a mid-run correction.
- `/dispatcher-resolve <worker id> <allow|always-allow|deny>` answers a pending access ask.

## Configuration

Every field is a volatile setting of the plugin's `Config`, editable in dsh's Plugins page card for **Multitask Dispatcher**. A saved change applies to new chats; the chat you are in keeps the values it started with.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Feature flag for the plugin. When off, the plugin registers nothing. Read once at plugin apply. |
| `accessRequestTimeoutMs` | `120000` | How long an unanswered access ask waits before it is denied. |
| `wakeCoalesceWindowMs` | `0` | Batch idle background wakes into one dispatcher turn per window. `0` wakes immediately. |
| `inboxEnabled` | `false` | Opt-in file inbox. Off starts nothing at all. |
| `racoonsRecordOnly` | `false` | Racoons record-only mode. Off means racoons applies context cleanup; on means everything is still recorded but the automatic prune and manual forget are held back (a result's entry checkpoint answer can still apply). |
| `racoonsStorageRoot` | `""` | Racoons storage root. Empty uses `<DSH_HOME>/storages/racoons`. |
| `racoonsContextWindowTokens` | `0` | Racoons context window in tokens; `0` leaves the half-window auto prune off. |
| `inboxDir` | `""` | Inbox root. Empty disables intake even when enabled. |
| `inboxRescanIntervalMs` | `5000` | Fallback rescan interval; clamped to a 1000 ms floor. |
| `microcompactEnabled` | `false` | Clears the content of old tool results on dispatcher sessions at a fixed usage ratio. Off pending live verification. |

Racoons is always on while the multitask plugin is enabled, and it covers the dispatcher session and every worker session, not just one of them. Removed content is restorable by its recall id, and the originals are stored durably per session under `<DSH_HOME>/storages/racoons` (one ledger file plus its blobs directory per session).

## Architecture

| Path | Role |
|---|---|
| `src/index.ts` | Public barrel: plugin entry plus the exported core surface. |
| `src/plugin.ts` | Cordis entry (`name` / `inject` / `Config` / `apply`); wires adapter to core. |
| `src/core/` | Host-agnostic dispatcher behind the `DshHost` boundary: worker state machine, wake bus, access relay, steer queue, todo ledger, roster snapshot, prompt assembly. |
| `src/adapter/` | dsh/Cordis side: host implementation, slash commands, dispatcher tools, access prompts, settings identity, inbox watcher, restart notice. |
| `src/worker/` | Worker side: contract prompt, tool barrier, agent definition. |
| `src/client/` | Browser module: locale dictionaries, per-tool call views, settings card, sidebar session-kind glyph. Shell components are retained but not mounted (ADR-0024). |
| `test/` | Offline tests. Hand-written fakes (`FakeDshHost`), no mocking framework. |
| `dev/` | Mock LLM and the end-to-end harness. |
| `docs/adr/` | Every recorded decision, with an index in `docs/adr/README.md`. |
| `Issue-tracker/` | Tickets: `open/`, `resolved/`, `deferred/`, `cancelled/`. |

The plugin registers into stock dsh only: three slash commands, eight per-session tools, tool-call views, one settings card, and one additive sidebar glyph that marks dispatcher sessions. There is no separate window, launcher, or capsule.

## Docs

- `docs/adr/README.md` — decision index; read the ones touching your area first.
- `docs/agents-rulebook.md` — process rules, authority stack, environment notes.
- `CONTEXT.md` — shared vocabulary.
- `PRD-dsh-multitask-dispatcher.md` — product behavior, scope, success criteria.
- `docs/surfaces.md` — what UI ships and what is deliberately absent.
- `Issue-tracker/issue-tracker.md` — ticket conventions.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 TZ.
