# 43 — Host-half apply never ran live: plugin row absent from the RUNNING boot tree on both routes (config dump misread as running state)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 09 (deferred smoke — this ticket unblocks it), 33 (live pass), 34 (client half — its remaining ACs share the same re-pass)

## Context (symptom + evidence)

Live pass 2026-09-18 (`C:\Users\TZhen\Desktop\dsh-live-pass-2026-09-18\`): the client half
worked on both routes (boot-graph row in `served-page.html`, combo route served our module,
dormant capsule rendered), but the host half never ran on EITHER route:

- web profile + transient `--patch` route: no settings section, footer stuck
  `data-flag="unknown"`, `/dispatcher-start` typed in the composer reached the LLM as plain text.
- persistent `multitask` profile route: same dead host half.
- Seemingly contradicting that: the insert row IS in the composed root config
  (`web-patched-config-dump.yml:539-543`) and the host plugin inventory showed the plugin
  enabled.

## Root cause (diagnosed + reproduced green today)

**The plugin is fine. The row was never in the running tree on either route. Two separate
config-delivery failures, plus one verification trap:**

1. **Web + `--patch` route — the overlay was not part of the boot that served the page.**
   The Temp patch file `C:\Users\TZhen\AppData\Local\Temp\dsh-bot-main.patch.yml` (mtime
   05:35, same minute as `dsh-server.log`) contains the insert row, and `--dump-config`
   composes it — but the dump is produced OFFLINE by a separate CLI run
   (`dump-config-lFgMwK8i.js:49` → `renderConfigDump` over `loadOptionalPatches` layers); it
   is NOT evidence of what a running server loaded. Decisive proof the row could not have
   been live in a healthy server: any entry that fails to import, throws in apply, or stays
   pending on inject FAILS THE BOOT LOUDLY (`assertEntriesActivated`,
   `dsh-app-boot/lib/index.js:1461-1497`, FIBER_PENDING=0/ACTIVE=2/FAILED=3 at :1446-1448;
   pending entries are named with their missing services). The live-pass server served pages
   for ~15 min with no settings section — so the running tree had no row. Missing-file
   behavior makes the omission silent: `loadOptionalPatches`
   (`dsh-app-boot/lib/index.js:1141-1155`) returns `undefined` on ENOENT ("a missing file
   means no layer") — a `--patch` path that does not exist yet at spawn time boots stock
   with no error.

2. **Multitask profile route — the persistent insert row never existed.**
   `multitask-config-dump.yml` (the profile's full composed tree, taken 05:49) contains NO
   `multitask-dispatcher` row anywhere (grep: zero hits), while all seven injected services
   are present (`:38/40/49/78/184/258/357`). The package WAS installed in the profile tree —
   which is why the client half still worked: the client boot graph and the "plugin
   inventory" are driven by the package inventory (`package.json` `dsh.client` /
   `dsh` manifest fields, `dsh-plugin-package-inventory-deepseek`), which lists INSTALLED
   PACKAGES, not loader rows. Inventory-enabled ≠ instantiated. Per the repo's own workflow
   (`docs/research/plugin-install-workflow.md` Findings 1–2), installation must be paired
   with an `insert:` row in the profile's `cordis.patch.yml` — that row was absent (or in a
   shape `applyEntryPatches` skips with a warn, `dsh-app-boot/lib/index.js:70-106`; warns go
   to the loader logger, invisible with `enableLogs` off). The profile dir was deleted after
   the pass (`~/.dsh/profiles/` mtime 05:56), so the exact bad shape is unrecoverable — the
   dump proves the outcome either way.

3. **The executor hypothesis is REFUTED** — "declared inject set never resolves at plugin
   scope on 0.1.5-rc.1" is false. Live boot probe today (web + `--patch`, host 0.1.5-rc.1,
   plugin loaded via a file-URL row exactly like the dump's): apply executes with validated
   config `{"enabled":true,"accessRequestTimeoutMs":120000}`, returns cleanly,
   `ctx.commands.register` is a function, and `ctx.inject(["settings"], cb)` FIRES with
   `installSection=function` — settings section and commands register. All seven inject
   names exist as shipped services (`super(ctx, "<name>")` in `dsh-subagent`/`dsh-agent`/
   `dsh-jobs` `lib/index.js:61`/`dsh-storage-domain`/`dsh-commands`/`dsh-tools`/
   `dsh-user-questions`). Offline, on the host's own `@deepseek-ai/cordis` copy, apply stays
   deferred until the last of the seven services is implemented, then runs — confirming the
   gating model (cordis `lib/index.js:1316-1331,1349-1399`).

## Requirements (minimal fix — NO product code change)

The plugin and both delivery mechanisms work; what failed is invocation/coverage discipline.

1. Web route: keep a committed dev overlay in-repo (e.g. `dev/cordis.web.patch.yml`) with
   the insert row — `name:` as the absolute path or `file:///...lib/index.js` URL (overlay
   loader anchors absolute/relative inserted paths to file URLs automatically,
   `anchorInsertedPluginNames`, `dsh-app-boot/lib/index.js:1169-1177`; verified live today).
   The launcher must pass `--patch <that file>` in the SAME command that spawns `dsh web`,
   and the pass script must assert the row is live (see ACs), never trust `--dump-config`
   alone.
2. Multitask route: recreate the profile
   (`dsh --profile multitask --from-default-profile web`), `dsh plugin --profile multitask
   add file:C:\Users\TZhen\Desktop\dsh-bot` (build first so `lib/index.js` exists), then
   write the insert row into `C:\Users\TZhen\.dsh\profiles\multitask\cordis.patch.yml`
   exactly per `docs/research/plugin-install-workflow.md` Finding 2
   (`- insert: [- id: multitask-dispatcher, name: dsh-multitask-dispatcher, config: { enabled: true }]`).
   `cordis.yml` stays `[]` (root list; its header says edit the patch file).
3. Do not "fix" the plugin's inject list, entry shape, or packaging — all verified correct
   (`package.json` `main`/`exports`; `src/plugin.ts:59-81` `name`/`inject`; entry imports
   cleanly from the exact row URL).

## Acceptance criteria

- [ ] (offline, gate) `npm test`, `npm run typecheck`, `npm run build` all green with zero
      product-code diff from `07155f6` for this fix (config/launcher-only).
- [ ] (live, ZERO LLM calls) `dsh --profile <p> --dump-config --patch <overlay>` shows the
      row AND a real boot with the same invocation shows host-apply evidence: the
      `multitask-dispatcher` settings section appears in the web UI Settings, and
      `/dispatcher-start` appears in the composer command menu. (Dump alone is explicitly
      NOT sufficient — that was this bug.)
- [ ] (live, ZERO LLM calls) `/dispatcher-start` typed in the composer is intercepted (no
      plain-text leak to the LLM) and activates the chat: dormant capsule flips to
      activated; no worker spawned yet.
- [ ] (live, BURNS tokens — last, single trivial task) one worker spawn → deliver →
      completed-means-delivered flow, minimal prompts per AGENTS.md kill/token rules. May be
      deferred to the full re-pass if the pass owner prefers.
- [ ] Server log of the passing boot attached to this ticket (or 33) as the recorded
      evidence; boot shows no "did not activate" error.

## Verification

- Diagnosis probes (today, token-free, all cleaned up): importing the exact row URL
  succeeds; host-loader rejects a raw `C:\...` name with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` — "Received protocol 'c:'" (so keep absolute-path or
  file:// names, never bare backslash paths outside an overlay); live `dsh web --patch`
  boot with a probe wrapper around `apply` printed: apply start → `real.apply RETURNED OK`
  → `SETTINGS INJECT FIRED settings=object installSection=function` → healthy serve
  (wrapper technique: ESM module re-exporting `name`/`inject`/`Config` from `lib/index.js`
  with an `apply` that logs then calls the real apply — stderr reaches the server log).
- Destructive control (same harness): an entry that throws inside apply, or whose Config
  schema is not a schemastery object, FAILS the boot loudly — proving the live-pass server
  (healthy boot, no section) cannot have had the row.

## Notes (secondary anomalies, no action here)

- `--dump-config` composes layers offline; it is a plausibility check only. The live pass
  treated `web-patched-config-dump.yml:541` as proof the row was running — that inference
  was the trap.
- Patch shapes that match nothing are warn+skip (`applyEntryPatches`,
  `dsh-app-boot/lib/index.js:70-106`); with `enableLogs` off these warns are invisible in
  the server log. Prefer `assertEntriesActivated`-visible failures: a row that is present
  but broken fails loud, a row that is absent fails silent.
- Live-pass launcher used port 8799 while plain `dsh web` defaults to 3080 — the invocation
  drifted from the probed one; capture the exact launcher command in the pass artifacts
  next time.
- The multitask profile directory was deleted after the pass; recreate it per Requirement 2.
