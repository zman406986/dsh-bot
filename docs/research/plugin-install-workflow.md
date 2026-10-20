# Research: settled dev-time install workflow for the dispatcher plugin

- Question: How should a locally developed dsh plugin be installed into the dedicated multitask profile — transient overlay vs persistent `dsh plugin add file:`?
- Scope: local dsh 0.1.5-rc.1 on this machine; a `multitask` profile created from the `web` template. Host tree only (MIT). Forbidden reference tree not opened.
- Method: created the `multitask` profile with `dsh --profile multitask --from-default-profile web --dump-config`, built `dsh-multitask-dispatcher` (`main: lib/index.js`), installed it into the profile via `dsh plugin`, and verified the stock `web` profile is unchanged.
- Date: 2026-09-16

## Verdict

Both routes work. **Use the persistent route** (`dsh plugin --profile multitask add file:...` plus an `insert` row in that profile's `cordis.patch.yml`) for day-to-day development of the multitask profile. Keep the `--patch` overlay for one-off experiments that must not touch the profile's package tree.

## Finding 1 — Creating the profile

`dsh --profile multitask --from-default-profile web --dump-config` creates `$DSH_HOME/profiles/multitask/` with:

- `package.json` — `dsh-profile-multitask`, bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, `patchReload: live`
- `cordis.yml` — empty root `[]` (never edit)
- `cordis.patch.yml` — empty patch layer `[]` (this is the insert target)
- `pnpm-workspace.yaml` — same shape as `web`

The stock `web` profile is not modified by this command.

## Finding 2 — Persistent install

From the plugin package root (after `npm run build` so `lib/index.js` exists):

```powershell
dsh plugin --profile multitask add file:C:\Users\TZ\Desktop\dsh-bot
```

`dsh plugin` forwards to `pnpm add` in the profile directory. The package lands under the profile's dependency tree and can be named from `cordis.patch.yml`.

Insert row (goes in `cordis.patch.yml`, not `cordis.yml`):

```yaml
- insert:
    - id: multitask-dispatcher
      name: dsh-multitask-dispatcher
      config:
        enabled: true
```

## Finding 3 — Temporary overlay

A standalone YAML patch applied only for one boot:

```powershell
dsh --profile multitask --patch .\dev\cordis.dev.patch.yml
```

The overlay is the same top-level array of patch entries. Nothing is written into the profile's package tree. Useful for trying an unbuilt or differently-built tree; not the default workflow.

## Finding 4 — The stock profile stays unchanged

The plugin is installed only under the `multitask` profile. `~/.dsh/profiles/web/cordis.patch.yml` is untouched (still only the Exa search insert). To check that the stock profile is isolated: dump the `web` config and confirm it has no `multitask-dispatcher` row.

## Consequences

1. Ticket 01's install-workflow open item is closed: **persistent** for the multitask profile, **overlay** for temporary experiments.
2. `docs/research/dsh-local-install.md` "Open / unclear" item about the exact `dsh plugin add file:` shape is answered.
3. Later tickets that change the plugin's `inject` list must rebuild (`npm run build`) before the profile picks up the new `lib/` — hot reload reloads the built module, not the TypeScript sources.
