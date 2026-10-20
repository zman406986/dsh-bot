# dsh-multitask-dispatcher

Always-on multitask dispatcher plugin for DeepSeek Harness (`dsh`). A primary chat agent that stays responsive by delegating non-trivial work to background workers that start with empty context.

## Status

Implemented and offline-tested: the dispatcher plugin (`src/core` multitask surface behind the `DshHost` boundary, `src/adapter` Cordis/dsh glue, `src/worker` workers that start with empty context) and its web client surface (`client/`, the wrapper shell with the worker list, approval cards, and composer send). `npm test` runs the suite with no network and no LLM; the project's decision history is recorded in the repo's local `Issue-tracker/`. Remaining work is tracked in `Issue-tracker/open/`.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Install into a dsh profile

The plugin reaches a profile through that profile's `cordis.patch.yml` (`insert` row), never by editing `cordis.yml`.

**Persistent install** (recommended for the multitask profile):

```bash
# Build first so lib/ exists
npm run build

# Install the local package into the profile's package tree
dsh plugin --profile multitask add file:C:/path/to/dsh-bot

# Then add an insert row to ~/.dsh/profiles/multitask/cordis.patch.yml
```

Example `cordis.patch.yml` insert:

```yaml
- insert:
    - id: multitask-dispatcher
      name: dsh-multitask-dispatcher
      config:
        enabled: true
```

**Transient overlay** (dev, no persistent install):

```bash
npm run build
dsh --profile web --patch dev/cordis.web.patch.yml
```

Where `dev/cordis.web.patch.yml` holds the same insert row.

## Layout

| Path | Role |
|---|---|
| `src/plugin.ts` | Cordis plugin entry (`name` / `inject` / `Config` / `apply`) |
| `src/core/dsh-host.ts` | `DshHost` — the only host boundary the core depends on |
| `src/core/fake-host.ts` | Hand-written fake for tests (no mocking framework) |
| `src/core/multitask.ts` | Public core surface (`createMultitask`) |
| `src/core/types.ts` | Worker / settle / spawn types |
| `test/host-seam.test.ts` | Boundary tests: no network, no LLM, no live dsh |
