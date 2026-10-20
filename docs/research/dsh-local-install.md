# Research: dsh installed on this machine — profiles, how plugins load, and the lesson about trusted paths

- Question: dsh is installed on the user's device after all (`docs/research/dsh-extension-surface.md` recorded it as absent). Where is it, how is it configured, how are plugins actually loaded, and does the installed code confirm the extension surface the earlier note asserted from public docs?
- Scope: the local **dsh** installation only. The forbidden reference tree was not opened. dsh's own `node_modules` was read freely — dsh is MIT-licensed and is the product we build on, not the reference we must not copy.
- Method: located the global install, read its `package.json` and bundled `@deepseek-ai/*` packages, read the user's `$DSH_HOME` (`~/.dsh`) profile layout, and read a real third-party plugin end-to-end.
- Date: 2026-09-16

## ⚠️ Correction (2026-09-18) — read before using the paths or version below

This note's **environment facts are out of date**, though its structural findings (profile layout, plugin composition, the worked third-party plugin example) still hold. Two wrong facts were proven on 2026-09-18 by two independent passes, both of which were briefly derailed by them:

1. **Wrong user profile in every path.** The paths below say `C:\Users\TZ\...`; this machine is `C:\Users\TZhen`. `C:\Users\TZ` does not exist.
2. **The npm-global install path does not exist.** `C:\Users\TZhen\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` is **absent**. Searching there — or in the repo's own `node_modules`, which holds only `cordis`, `cosmokit`, and `schemastery` — is what made one agent wrongly conclude the host was not installed at all.

**Where the host actually is (verified 2026-09-18):**

- `$DSH_HOME` = `C:\Users\TZhen\.dsh` — contains `profiles/`, `sessions/`, `storages/`, `settings.yaml`.
- **The bundled packages live at `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`** — roughly 230 packages including `dsh/` itself, plus `dsh-system-prompt/`, `dsh-persona/`, `dsh-agent-instructions/`, `dsh-agent-presets/`, `dsh-subagent*/`, `dsh-tool-subagent-control/`, `dsh-session-checkpoint-policy/`, `dsh-compaction/`, and the rest of what a plugin can extend. This is the code to read when a host behaviour needs checking against the real implementation.
- **Version is `0.1.5-rc.2`**, not the `0.1.5-rc.1` stated below.

**Lesson, recorded because it has now cost two passes:** a path or version in a research note is an *unverified claim* until something re-reads it. When a question depends on the host's behaviour, locate the host afresh rather than trusting a path from a note — the notes describe a code tree that can move.

## Verdict

dsh **0.1.5-rc.1** is installed globally and is **working, configured, and in use** — it has a live web profile with a custom third-party plugin (`@deepseek-ai/dsh-web-search-exa`) already added and selected. This **replaces** `dsh-extension-surface.md`'s "host was NOT found on the local machine" finding: that absence is out of date, and every adapter ability the dispatcher needs is therefore verifiable by reading real installed code rather than public docs. The single most useful find is a **complete worked example of a custom dsh plugin** — package layout, `apply(ctx)`, config schema, service registration, settings section, credential lookup — sitting in the user's own profile directory. That is the template the dispatcher plugin should follow, and it is dsh's own MIT code, so unlike the reference tree it is entirely safe to read and imitate.

## Finding 1 — the installation

- Executable: `C:\Users\TZ\AppData\Roaming\npm\dsh.ps1` (plus `dsh.cmd`, `dsh`).
- Package: `@deepseek-ai/dsh@0.1.5-rc.1`, installed globally via npm.
- Installed at: `C:\Users\TZ\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`.
- `dsh --version` → `0.1.5-rc.1`. `dsh --help` reports: boot a profile — "an ordered stack of plugin-bundle patch layers under your own overrides."
- Version matches the registry version cited in `dsh-extension-surface.md`, so the earlier note's public-docs research is still accurate for this build.
- Toolchains available for building the plugin: **`pnpm`** (v? — present at `C:\Users\TZ\AppData\Roaming\npm\pnpm.ps1`), **`bun`**, and `npm`. `pnpm` is the one dsh's own docs and profile layout use.

## Finding 2 — what `$DSH_HOME` contains (`C:\Users\TZ\.dsh`)

```text
~/.dsh/
├── profiles/
│   ├── node_modules/          # shared install tree for profile plugins
│   ├── web/                   # the active profile
│   │   ├── package.json       # declares dsh.profile.bundles
│   │   ├── cordis.yml         # profile root — deliberately `[]`
│   │   ├── cordis.patch.yml   # the user's own overlay layer
│   │   └── pnpm-workspace.yaml
│   └── (only `web` exists)
├── sessions/                  # session store
├── storages/                  # storage backends
├── .credentials.yaml          # credentials
└── settings.yaml              # settings
```

- **Only one profile exists: `web`.** There is no `tui`, `headless`, or custom profile yet. The dispatcher's "dedicated multitask profile" (ADR-0005) does not exist and must be created — `dsh --profile <name> --from-default-profile web` is the documented way to start one from a shipped template.
- `settings.yaml` holds the user's LLM setup: provider `opencode-go` with models `deepseek-v4-flash` (default), `deepseek-v4-pro`, `kimi-k3`, `mimo-v2.5`; `agent-presets.default: cordis`.

## Finding 3 — how profiles and plugins actually compose

- `profiles/web/package.json` declares the bundle stack:

  ```json
  { "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }
  ```

- `cordis.yml` is the profile root and is **empty by design**: `[]`, with a comment saying "The tree is composed as patches: each bundle in `package.json`'s `dsh.profile.bundles`, then `cordis.patch.yml`, then any `--patch` overlays. **Edit `cordis.patch.yml`, not this file.**"
- So the composition order is: **bundle layers → `cordis.patch.yml` → extra `--patch` overlays**. This is the "ordered stack of plugin-bundle patch layers" from `--help`, and it is how our plugin gets into the app.
- `cordis.patch.yml` is a top-level YAML array of loader patch entries. The user's own file proves both entry kinds:

  ```yaml
  - insert:
      - id: web-search-exa
        name: '@deepseek-ai/dsh-web-search-exa'
        config:
          apiKeyEnv: EXA_API_KEY

  - id: web
    config:
      searchProvider: exa-official
  ```

  `insert` adds a plugin; `id` + `config` overrides an existing row. `!!js` expressions are allowed.
- **Conflict note for our spec:** `dsh-extension-surface.md` described loading via `pnpm dsh web --patch ./cordis.yml` / `dsh plugin --profile <name> add file:/path/to/bundle`. Both are real mechanisms, but the installed reality shows the **persistent** route is a profile-level `cordis.patch.yml` plus `dsh plugin` (which forwards to pnpm in the profile directory). A `--patch` overlay is the *temporary* route. The dispatcher should ship as an installable bundle for the multitask profile, with a `--patch` overlay used only during development.

## Finding 4 — a real third-party plugin, end to end (the template)

`profiles/node_modules/@deepseek-ai/dsh-web-search-exa` is a small, self-contained plugin that has **exactly the shape our dispatcher plugin should take**. Its `package.json`:

```json
{
  "name": "@deepseek-ai/dsh-web-search-exa",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/dsh-credentials": "*",
    "@deepseek-ai/dsh-launch-environment": "*",
    "@deepseek-ai/dsh-settings": "*",
    "@deepseek-ai/dsh-web": "*",
    "@deepseek-ai/cordis": "*"
  },
  "dependencies": { "@deepseek-ai/schemastery": "*" }
}
```

Parts worth imitating (all confirmed in its `lib/index.js`):

- **A module-level contract:** `const name = "web-search-exa"; const inject = ["web"];` — exports `name`, `inject`, `Config`, `apply`. Declares the services it needs, and nothing else.
- **`apply(ctx, config)` is the whole entry point**, and it only *registers* things — it does not run work.
- **Config is a schemastery object** (`z.object({...})` from `@deepseek-ai/schemastery`), with `.role("secret")` and `.role("credential-ref")` on credential fields and `.default(...)` on the rest.
- **Settings section:** `installSettingsSection(ctx, settingsNamespace("web-search-exa"), Config, config, { setSource, onChange })` — gives the plugin a live, user-editable settings section.
- **Service registration:** `ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(ctx, current())))` — publishing a typed capability onto an existing interface (`ctx.web`).
- **Credential lookup:** try `ctx.get("credentials")` → `credentials.resolve(credentialRef(apiKeyEnv))`, fall back to the launch environment. Never read a secret from a plain config field.
- **Config is read lazily** through a `current()` indirection, so a settings change is picked up without re-registering.
- **Cleanup is automatic:** registers through `ctx`, so Cordis unloads them with the plugin ("anything registered through ctx ... is cleaned up when the plugin unloads" — matches `dsh-extension-surface.md`).

This is ~180 lines including comments and error mapping. A dispatcher plugin is bigger, but this confirms the shape and the size of the interfaces.

## Finding 5 — the bundled `@deepseek-ai/*` package list confirms the adapter surface

The install ships **~190 `@deepseek-ai/*` packages**, and the names line up with `dsh-extension-surface.md`'s claims, often in more detail. Ones that matter to the dispatcher:

- **Subagents / spawn:** `dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`, `dsh-subagent-in-process-driver`, `dsh-tool-subagent`, `dsh-tool-subagent-control`.
- **Jobs / wake:** `dsh-jobs`, `dsh-jobs-local`, `dsh-tool-jobs`, `dsh-session-telemetry`, `dsh-session-projection`.
- **Steering / agent control:** `dsh-agent`, `dsh-agent-loop`, `dsh-tool-subagent-control`.
- **Todos:** `dsh-tool-todo`.
- **Storage / durability:** `dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`, `dsh-storage-sqlite`.
- **Session store / persistence:** `dsh-session`, `dsh-session-persistence`, `dsh-session-persistence-jsonl`, `dsh-session-format`, `dsh-session-format-v0-to-v1/v1-to-v2/v2-to-v3`, `dsh-session-query`, `dsh-session-query-sqlite`.
- **Tool registration:** `dsh-tools`, `dsh-tool-*` (bash, pwsh, fs, fs-search, web, present, ask-user, skill, goal, workflow, ralph, cordis), `dsh-tool-call-timeout-policy`.
- **Permissions / approvals / secrets:** `dsh-permission-presets`, `dsh-user-approval`, `dsh-authorization`, `dsh-credentials`, `dsh-credentials-local`, `dsh-client-ui-approval`, `dsh-client-ui-permission-presets`. **This is direct evidence for the spec's permission/secret relay (Gap 2) — dsh ships the approval and credential interfaces, so our relay is a small layer of code, not new machinery.**
- **User questions / delivery:** `dsh-user-questions`, `dsh-tool-ask-user`, `dsh-tool-present`, `dsh-attachment`, `dsh-attachment-local`, `dsh-client-ui-deliverables`.
- **Timers / scheduling (for the wake-source enum):** `cordis-plugin-timer`, `dsh-schedule`, `dsh-timeout`, `dsh-time-context`, `dsh-client-ui-schedule`.
- **External wake sources:** `dsh-webhook`, `dsh-webhook-github`.
- **Sandbox (host facility, not our concern):** `dsh-sandbox`, `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-sandbox-windows-acl`, `dsh-bash-sandbox`, `dsh-pwsh-sandbox`.
- **Plugin tooling / HMR:** `cordis-plugin-hmr`, `cordis-plugin-loader`, `cordis-plugin-include`, `cordis-plugin-group`, `dsh-tool-cordis`, `dsh-host-plugin-inventory`, `dsh-client-ui-settings-plugins`.
- **Model and provider interface:** `dsh-llm`, `dsh-llm-deepseek`, `dsh-llm-pi-ai`, `dsh-llm-retry`, `dsh-agent-default-model`.
- **Agent presets / personas:** `dsh-agent-presets`, `dsh-client-ui-agent-preset`, `dsh-persona`, `dsh-workflow`, `dsh-tool-workflow`, `dsh-plan-mode`, `dsh-goal`, `dsh-command-goal`.
- **Memory:** still **absent** — no `dsh-memory*` package. Confirms `dsh-extension-surface.md` Finding 4(a) and the spec's deferral of per-agent memory.

Two experimental-looking packages are worth flagging but not relied on: `dsh-tool-ralph` (unknown purpose from the name alone) and `dsh-tool-workflow`.

## Finding 6 — Clean-room lesson: which tree is safe to read

The two trees now sit side by side on this machine, and they have **opposite** rules:

| Tree | Licence | Read | Imitate |
|---|---|---|---|
| `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` | Uncertain; unofficial reconstruction of proprietary code | Yes, for behavior only | **Never** — no code, prompts, identifiers, or literals |
| `node_modules/@deepseek-ai/*` (dsh itself) | **MIT**, by DeepSeek | Yes | **Yes** — this is the platform we build on |

So `dsh-web-search-exa` is a legitimate template: reading it and following its plugin shape is exactly what building a dsh plugin means. The forbidden tree remains forbidden. This does not relax anything — it just makes the safe side concrete and separable, and gives implementers a real example to copy *structure* from without any risk (structure and API usage, still not our prompt copy, which stays new per PRD §10).

## Consequences for the spec and tickets

1. **`dsh-extension-surface.md`'s "host not installed" finding is out of date.** Should be corrected in place or superseded by a pointer to this note. The spec's blocker (the point where ticket 09 could not be verified) is **cleared** — ticket 09 can be built and verified against a real host.
2. **Ticket 01 has a concrete target now:** the plugin follows the `web-search-exa` shape — `name`/`inject`/`Config`/`apply(ctx)` exports, ESL module, schemastery config, `peerDependencies` on the dsh services it touches, registers only through `ctx`.
3. **ADR-0005's multitask profile must be created** — only `web` exists. `dsh --profile <name> --from-default-profile web` creates one from the shipped template; the dispatcher then installs as a bundle in that profile with an `insert` row in its `cordis.patch.yml`.
4. **The permission/secret relay (ticket 13) has real interfaces to build on** — `dsh-user-approval`, `dsh-credentials`, `dsh-permission-presets` exist. The relay should use them rather than inventing a flow.
5. **Timer/external wake sources (ticket 06) have real interfaces too** — `cordis-plugin-timer`, `dsh-schedule`, `dsh-webhook`.
6. **No memory package exists** — the spec's memory deferral stands unchanged.

## Open / unclear

- Whether `dsh-tool-ralph` and `dsh-tool-workflow` overlap with the dispatcher's job; not investigated.
- The exact install command shape for a **locally developed** plugin bundle (`dsh plugin --profile <name> add file:...`) was not executed; only the profile-level patch mechanism was read. Verify before writing install docs.
- `pnpm-workspace.yaml` in the profile directory was not read; the workspace's dependency-hoisting rules may matter for a plugin with peer dependencies.
- Whether the profile's `node_modules` is safe to develop inside directly, or whether a separate dev workspace plus `dsh plugin add file:` is the intended workflow — not established. Ticket 01 should settle this by doing it.