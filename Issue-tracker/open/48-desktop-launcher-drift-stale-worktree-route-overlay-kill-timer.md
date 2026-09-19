# 48 — Desktop launcher drift: menu option [2] serves a 39-commit-stale worktree, the overlay is unreviewable (`%TEMP%`), and no kill timer is armed

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 43 (Requirement 1 — committed in-repo overlay + launcher pass-through — is implemented here; its live ACs stay there), 33 (close-out; the worktree merge it performed is what stranded the route), 34 (the stale tree predates `dsh.client.inject`, so the route's client half is dormant), 46 (this session's watch fix — also absent from the stale tree), 35 (epic whose ACs run through a launcher boot)

## Symptom (cited)

`dsh-bot.ps1` (Desktop, outside the repo) offers two targets:

| Key | Path | Branch |
|---|---|---|
| 1 | `C:\Users\TZhen\Desktop\dsh-bot` | `main` |
| 2 | `C:\Users\TZhen\Desktop\dsh-bot-always-on` | `clone/always-on-dispatcher` |

Option [2] is not a live route any more. Measured 2026-09-18:

```
$ git worktree list
C:/Users/TZhen/Desktop/dsh-bot           bbd946f [main]
C:/Users/TZhen/Desktop/dsh-bot-always-on 1e7c735 [clone/always-on-dispatcher]

$ git rev-list --count main..HEAD   # in the worktree
0
$ git rev-list --count HEAD..main
39
```

`git merge-base --is-ancestor 1e7c735 main` → **true**: the branch's whole batch
landed at `400450f` ("Merge clone/always-on-dispatcher: always-on dispatcher
17.27-17.33 + capsule UI 38-42 (ticket 33)", ticket 17's dated merge comment).
So option [2] builds and serves a tree that is **39 commits behind main with
nothing unique in it**. What that tree is missing is exactly the current
frontier work:

- **34** — no `dsh.client.inject` record (its `package.json` still carries only
  `platform` + `external`), i.e. the client half never materializes: a launcher
  boot from [2] shows **no capsule at all** (ADR-0014's dormant-module class).
- **43 / 44 / 45** — host-half apply, command registration by the generator-effect
  idiom, and the valid JSON-Schema fix for provider-rejected activated turns.
- **46** — this session's `settingsScope` watch fix.

A live pass launched from [2] therefore fails for reasons already fixed on main,
and the failure looks exactly like a product bug. That is the trap.

## Root cause

The target list and its copy were written at worktree-creation time
(`.scratch/clone-always-on/worktree-workflow.md` §1: "Clone worktree …
**ALL ticket-17 implementation**") and never reconciled with the merge that
ticket 33 performed two days later. Nothing in the launcher reads git
freshness, so a stale checkout is silent until a live pass misbehaves.

Three smaller gaps in the same script:

1. **Ticket 43 Requirement 1 is unimplemented.** It asks for a *committed*
   in-repo overlay (`dev/cordis.web.patch.yml`) passed with `--patch` in the
   same command that spawns dsh, so the overlay a pass used is reviewable
   in-tree. The launcher instead writes a transient `%TEMP%\dsh-bot-*.patch.yml`
   on every launch and never records it (ticket 43, "Also still open").
2. **No kill timer.** AGENTS.md makes a launch-time kill timer mandatory for
   every test process and browser instance (ADR-0015 §process hygiene repeats
   it); the launcher arms none — it starts a console window and hands cleanup to
   whoever remembers to close it.
3. **The exact invocation is only printed under `-DryRun`.** Ticket 43's note:
   a live pass "used port 8799 while plain `dsh web` defaults to 3080 — the
   invocation drifted from the probed one; capture the exact launcher command in
   the pass artifacts next time."

## Requirements (minimal)

1. **Freshness is visible and enforced.** The menu reports each target's
   ahead/behind against `main`; a target that is behind `main` **refuses to
   launch** by default, naming the count and the fix. `-Sync` fast-forwards a
   clean, 0-ahead checkout (`git merge --ff-only main`) before building;
   `-AllowStale` is the explicit escape hatch. A target with unique local
   commits is never fast-forwarded — it reports and stops.
2. **The overlay is the committed file** (`dev/cordis.web.patch.yml`), named
   relatively (`../lib/index.js`) so `anchorInsertedPluginNames`
   (`dsh-app-boot/lib/index.js:1170-1177`) anchors it beside the patch in
   whichever checkout ran it. The `%TEMP%` generator goes away; a missing
   overlay fails loud before boot rather than serving a rowless tree.
3. **Kill timer + invocation record.** `-KillAfterMinutes <n>` arms a detached
   force-kill of the server process tree at launch time (not clean-up-at-end);
   the exact command line is always printed so a pass can paste it into its
   artifacts.
4. **No product-code change.** The launcher lives outside the repo; the only
   repo change is the overlay file itself (Requirement 2), which is
   config-only — `src/`, `test/`, `lib/`, `client/` are untouched.

## Acceptance criteria

- [x] (offline) Menu/dry-run on both targets reports branch + dirty + ahead/behind vs `main`; the always-on entry shows its behind-count and its copy no longer claims to hold all ticket-17 work. — Menu output with the worktree provably behind: `[2]` renders `tmp-l48-behind, clean, 3 behind main` (see the comment's evidence table).
- [x] (offline) Launching a behind-`main` target without `-Sync`/`-AllowStale` refuses with a message naming the count and the remedy — verified against the worktree's real 0-ahead/39-behind state and again at 3-behind.
- [x] (offline) `-Sync` on a clean, 0-ahead, behind checkout fast-forwards it to `main` (`1e7c735..fc02eeb Fast-forward`, 76 files, then `now: clone/always-on-dispatcher, clean, = main`).
- [ ] (offline) `-Sync` refuses **without mutating anything** when the checkout carries unique commits. **Inspected, not exercised** — reaching it needs a synthetic commit on the guarded branch, which would be a real mutation of the worktree. Code path: `Resolve-StaleTarget` throws on `Ahead > 0` before any git write.
- [x] (offline) `dev/cordis.web.patch.yml` composes through the real boot layer: `dsh --profile web --dump-config --patch <file>` shows the row, and the row's `name` is the `file:///…/<checkout>/lib/index.js` URL — proven for **both** checkouts, each anchoring to itself.
- [x] (offline) `-KillAfterMinutes` arms a killer that force-kills the spawned server tree at launch time, and the exact launch command is printed on every launch, not only `-DryRun`. — Timer mechanism timed against a dummy (alive at +35 s, dead by +80 s against a 60 s arm); the armed killer was observed as a live process in a process audit.
- [x] (offline) Repo gates after the overlay file lands: `npm test` 711 pass / 0 fail / 186 suites (unchanged), `npm run typecheck` clean (both configs), `npm run build` + `build:client` OK.
- [x] (live, ZERO LLM calls — ticket 33's browser pass) a launcher boot from the synced worktree serves the same boot graph as main. — Both routes booted detached and served the identical client-bundle entry `{"id":"dsh-multitask-dispatcher", …, "inject":[renderer, locale]}` with byte-identical 65,320-byte bundles.
- [ ] (live, ticket 33's browser pass) the **capsule renders** on that boot (dormant chip → `data-composition="dormant"`) and flips on `/dispatcher-start`. Needs a real browser and an activated session; both are already ticket 33's standing browser-pass steps.

## Comments

### 2026-09-18 — implemented and verified offline; the worktree is un-stranded; two live routes now boot the same graph

Launcher `dsh-bot.ps1` (Desktop, outside the repo) rewritten around Requirements 1–3;
`dev/cordis.web.patch.yml` added in-repo (`fc02eeb`). Evidence, all zero LLM calls:

| Check | Result |
|---|---|
| Menu, worktree behind | `[2] tmp-l48-behind, clean, 3 behind main` (temp branch, restored after) |
| Refuse stale, no flags | `STALE: … 3 commit(s) behind main (0 ahead of it)` → `refusing to serve a stale checkout. Re-run with -Sync … or -AllowStale` |
| Real 0-ahead/39-behind state | refused, naming 39 — and the count read 40 an hour later, i.e. it tracks main live |
| `-Sync` | `Updating 1e7c735..fc02eeb` / `Fast-forward` / `now: clone/always-on-dispatcher, clean, = main` |
| `-AllowStale` | `serving the old tree on purpose (3 behind main)`, then the overlay guard fails loud — a checkout old enough to be stale predates `dev/cordis.web.patch.yml`, so the two guards reinforce |
| Overlay composition (main) | `--dump-config --patch dev\cordis.web.patch.yml` → `:540 # == C:\Users\TZhen\Desktop\dsh-bot\dev\cordis.web.patch.yml`, `:542 name: file:///C:/Users/TZhen/Desktop/dsh-bot/lib/index.js` |
| Overlay composition (worktree) | same file → `#{…}dsh-bot-always-on\dev\cordis.web.patch.yml`, `name: file:///C:/Users/TZhen/Desktop/dsh-bot-always-on/lib/index.js` |
| Kill timer | dummy survived +35 s and was gone by +80 s against a 60 s arm; the armed killer visible in a process audit as `ping -n 241 … & taskkill /PID … /T /F` |
| Gates | `npm test` 711/0/186 (unchanged), typecheck both configs clean, `build` + `build:client` OK |
| Live boot, main route | served page's boot graph: `{"id":"dsh-multitask-dispatcher","url":"/plugins/??dsh-multitask-dispatcher/client.js&rev=…","inject":["…dsh-client-ui-renderer","…dsh-client-locale"],"external":["react","react/jsx-runtime"]}` |
| Live boot, worktree route | identical row, `rev` differs, bundle byte-identical at 65,320 bytes; both bundles carry `settingsScope` ×2 and no `"settings"` (ticket 46's fix ships), `shell.overlay` ×1, and `settings.plugin.item` ×0 (ticket 47's gap, confirmed in the live bundle) |

**Two behavioural findings worth carrying:**

1. **A launcher window launched from inside an agent tool session dies with that
   session.** Every launch through the Desktop script while its parent PowerShell
   was itself a child of the agent's shell came up dead (connection refused
   forever), while the *same* command line started detached via
   `([wmiclass]'Win32_Process').Create(...)` served in under 5 s. The launcher's
   own `Start-Process` is correct — the parent's process tree is reaped when the
   tool call returns. So agent-run live passes must detach the server (WMI create,
   or a scheduled task) or they will chase a phantom product bug. Recorded here
   because ticket 33's pass is agent-run and this ticket's first three live
   attempts were exactly that mistake.
2. **The stale tree is worse than "old copy".** Pre-sync, `package.json` carried
   no `dsh.client.inject` at all (ticket 34 landed after `400450f`), so the
   module would not merely be old — it would never appear in the served boot
   graph and the capsule could never render. Route [2] was therefore a
   guaranteed-fail live pass, not a stale-but-working one.

**Cleanup:** all five test boots (8811/8823/8834/8845/8867) are down, the temp
branch `tmp-l48-behind` is deleted, both checkouts are clean, and the launcher
has a backup at `dsh-bot.ps1.bak-2026-09-18` (the script is outside git, so it
has no history of its own).

**Residual:** the two unchecked ACs — the `Ahead > 0` refusal (needs a synthetic
commit to exercise) and the browser-level capsule assertion (ticket 33's pass).

### 2026-09-19 — live pass 2 observation (not this ticket's route; no AC ticked)

Pass 2 booted the `multitask` profile route, not the synced-worktree launcher route, so the
last open AC stays with ticket 33's browser pass. Two signals relevant to it: (1) the
dormant capsule chip + card render fine on a real profile boot (`shots/01/04/07/08`); (2)
`/dispatcher-start` flipped the capsule FOOTER FLAG to `data-flag="on"` but the expanded
card composition stayed the dormant pitch — whoever ticks the "flips on /dispatcher-start"
clause should decide whether the flag flip satisfies it or the roster-keyed card behavior
(ticket 44's pass-2 comment) is the honest reading. Also confirmed again this pass: WMI
`powershell -Command "& timer.ps1"` processes never execute; all kill timers were node-internal
(verified in tasklist at launch).

### 2026-09-19 — one-line note

Mooted by 78 cutover (a44084a): capsule retired.
