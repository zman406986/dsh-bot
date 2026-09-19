# 48 — Desktop launcher drift: menu option [2] serves a 39-commit-stale worktree, the overlay is unreviewable (`%TEMP%`), and no kill timer is armed

**Status:** resolved
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

- [x] (offline) Menu/dry-run on both targets reports branch + dirty + ahead/behind vs `main`; the always-on entry shows its behind-count and its copy no longer claims to hold all ticket-17 work. — Menu output with the worktree provably behind: `[2]` renders `tmp-l48-behind, clean, 3 behind main` (see the comment's evidence table). Closed out 2026-09-19 by removing the always-on entry itself: the worktree and branch `clone/always-on-dispatcher` no longer exist, so the report-and-refuse machinery now runs on the surviving target (see the closing comment).
- [x] (offline) Launching a behind-`main` target without `-Sync`/`-AllowStale` refuses with a message naming the count and the remedy — verified against the worktree's real 0-ahead/39-behind state and again at 3-behind.
- [x] (offline) `-Sync` on a clean, 0-ahead, behind checkout fast-forwards it to `main` (`1e7c735..fc02eeb Fast-forward`, 76 files, then `now: clone/always-on-dispatcher, clean, = main`).
- [x] (offline) `-Sync` refuses **without mutating anything** when the checkout carries unique commits. — **Exercised 2026-09-19 against a synthetic 2-behind/1-ahead checkout: exit 1, refusal at `Resolve-StaleTarget`'s `Ahead > 0` throw (line 185), and byte-identical `.git` before/after (checksum `5b2dfb84…`, HEAD `eda734c`, reflog 5 entries, both refs unmoved, the unique commit still unreachable from `main`).** See the closing comment for the full before/after fingerprint and the transcript.
- [x] (offline) `dev/cordis.web.patch.yml` composes through the real boot layer: `dsh --profile web --dump-config --patch <file>` shows the row, and the row's `name` is the `file:///…/<checkout>/lib/index.js` URL — proven for **both** checkouts, each anchoring to itself.
- [x] (offline) `-KillAfterMinutes` arms a killer that force-kills the spawned server tree at launch time, and the exact launch command is printed on every launch, not only `-DryRun`. — Timer mechanism timed against a dummy (alive at +35 s, dead by +80 s against a 60 s arm); the armed killer was observed as a live process in a process audit.
- [x] (offline) Repo gates after the overlay file lands: `npm test` 711 pass / 0 fail / 186 suites (unchanged), `npm run typecheck` clean (both configs), `npm run build` + `build:client` OK.
- [x] (live, ZERO LLM calls — ticket 33's browser pass) a launcher boot from the synced worktree serves the same boot graph as main. — Both routes booted detached and served the identical client-bundle entry `{"id":"dsh-multitask-dispatcher", …, "inject":[renderer, locale]}` with byte-identical 65,320-byte bundles.
- [x] (live, ticket 33's browser pass) the **capsule renders** on that boot (dormant chip → `data-composition="dormant"`) and flips on `/dispatcher-start`. Needs a real browser and an activated session; both are already ticket 33's standing browser-pass steps.
      — **2026-09-19 (this closeout): MOOT-VERIFIED — untestable by design, never green as written.** Its vehicle is retired: a44084a removed the capsule at the 78 cutover (94e6127 elected the wrapper shell as the root frame, c437ee8 recorded the cutover), and the always-on route it booted no longer exists. The literal assertion can never run, and its substance (a launcher boot from a second checkout serving the same graph as `main`) is already proven by the AC above. Disposition recorded per the resolved ticket 81/84 MOOT-VERIFIED pattern; no live pass is outstanding for this ticket.

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

### 2026-09-19 — live pass 4: the one live AC (capsule renders on that boot) is MOOT — the capsule was retired at the 78 cutover (a44084a); the elected root frame renders instead. Not exercised, not ticked; the launcher-script drift items remain this ticket's real scope. Stays open.

### 2026-09-19 — CLOSED (closeout): option [2] removed as a dead route; `-Sync` ahead-refusal exercised for real; live AC disposed MOOT-VERIFIED

Ticket 33's closeout verdict (line 274) put two things in scope here: the launcher-script
drift, and an explicit call on the moot capsule AC. Both are done; the two unchecked boxes
are now ticked with evidence (AC4) and MOOT-VERIFIED (AC9).

**1. Option [2] disposition — removed, not repointed.** Verified before deciding:

```
$ git worktree list                     # worktrees dsh-wt-48/69l1/86/89/docs are this session's agents
C:/Users/TZhen/Desktop/dsh-bot   3930e34 [main]        # no dsh-bot-always-on anywhere
$ git branch -a --list '*always-on*'    # (empty)
$ git merge-base --is-ancestor 1e7c735 main  → YES (its batch landed at 400450f, ticket 33)
```

The path and the branch are both gone, so option [2] could only die at the missing-path
throw (now line 279) — dead, not stale. Repointing was considered and rejected: the only
other checkouts on disk are per-ticket agent worktrees (`wt/48`, `wt/69l1`, …), which are
transient, many, and no more "useful second targets" than any other agent sandbox. So the
entry and its row are removed rather than left dying, and the header copy that still
described the ticket-17 continuation home is gone with it. The freshness machinery is kept
intact — `Get-GitState` / `Format-GitState` / `Resolve-StaleTarget` / `-Sync` / `-AllowStale`
— and a comment above `$targets` records the row shape and the two other spots to extend
when a real second checkout exists again.

Launcher `dsh-bot.ps1` (Desktop, outside git), 12,120 → 12,713 B, sha256
`e929c41da85345290f9805f50bb4785e17e4a6933659edba125cb34cb6d39006`; fresh backup
`dsh-bot.ps1.bak-2026-09-19-wt48` (pre-change sha256 `1cc0bcbb…`).

| Edit | Before | After |
|---|---|---|
| Target table (was 75-82) | two rows: `[1] main`, `[2] ticket-17 worktree` → `dsh-bot-always-on` | one row `[1] main` + a comment showing how to add another |
| `$Checkout` validation | `[ValidateSet('1','2')]` | `[ValidateSet('1')]` |
| Header copy (was 9-14) | `[2] … branch clone/always-on-dispatcher -- ticket-17 continuation home` | rationale note: removed at closeout, why not repointed, machinery kept |
| Menu valid list | `@('1','2','0')`, prompt `[1/2, 0=exit]` | `@('1','0')`, prompt `[1, 0=exit]` |
| Usage example | `-Checkout 2 -Sync` | `-Checkout 1 -Sync` |
| Menu answer plumbing | `$Checkout = Get-MenuAnswer …; if ($Checkout -eq '0') { return }` | answer lands in a local `$choice` first (see below) |

**2. A latent bug the edit surfaced (fixed).** Exercising the menu exposed that answering
`0` at the prompt threw `ValidateSetFailure` instead of exiting: the prompt's answer was
assigned straight into `$Checkout`, and a parameter attribute re-validates on every
assignment in the script scope, so `'0'` was rejected before the exit check could run. This
pre-dates the edit (`ValidateSet('1','2')` has the same flaw against the old `0` answer) but
it is in this ticket's blast radius, so the answer now goes to a local `$choice` and
`$Checkout` is only assigned once it is known valid. Procedurally this is the ticket's own
lesson repeating: nothing had ever exercised the exit path, so nobody saw it.

**3. AC4 exercised for real.** Reaching the `Ahead > 0` refusal needs a checkout that is
behind `main` *and* carries a unique commit, which the real routes can no longer provide. A
throwaway standalone repo was built at `C:\Users\TZhen\Desktop\tmp-l48-ahead` (deliberately
standalone, not a `git worktree` off `dsh-bot`: registering a worktree would write into the
main repo's `.git`, which another agent is using). Shape: `main` = base + 2 commits, `feature`
= base + 1 unique commit, checked out clean → `rev-list --left-right --count main...HEAD` =
`2  1`. A temporary target row `[2]` (plus `ValidateSet('1','2')`) was added to the real
script, the run made, and the file then restored to the shipped bytes (sha256 re-verified
`e929c41d…`); the shipped file has no `[2]` row and no temp path. The guard code executed is
the shipped file's own; only the target row and the ValidateSet differed.

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bot.ps1 -Checkout 2 -Sync -NoBuild -DryRun
   STALE: TEMP l48 synthetic ahead is 2 commit(s) behind main (1 ahead of it).
refusing to serve C:\Users\TZhen\Desktop\tmp-l48-ahead: it carries 1 commit(s) not in main,
so a fast-forward would drop work. Merge or rebase it deliberately, or pass -AllowStale to serve it as-is.
所在位置 C:\Users\TZhen\Desktop\dsh-bot.ps1:193 字符: 9     # = the Ahead>0 throw
exit=1
```

"Mutates nothing" is shown by a full fingerprint — not just HEAD — taken immediately before
and after that run:

| Probe | Before | After |
|---|---|---|
| `rev-parse HEAD` | `eda734cfefe6f45ac12f76cb33ddc65f33e0df03` | identical |
| `status --porcelain` | `` (clean) | `` (clean) |
| `reflog` entry count | 5 | 5 |
| `for-each-ref` | `feature=eda734c… main=c996f94…` | identical |
| `.git` tree checksum (`find .git -type f \| sha256sum \| sha256sum`) | `5b2dfb848cd31247b7bd3b95392a849a6524191b71426302897a51eba957c163` | identical |
| `rev-list --left-right --count main...HEAD` | `2  1` | `2  1` |
| unique commit D reachable from `main`? | no | no (`merge-base --is-ancestor` still exits non-zero) |

Identical `.git` checksums mean no git write of any kind occurred, `-Sync` included — the
refusal happens before `git merge --ff-only` is reached, and `-DryRun -NoBuild` also
guarantees no build or spawn ran. The run was made twice (once with an untracked file
present in the tree, once with it moved out so both states were clean); both refused
identically. Each launch ran under a `timeout -k 5 120` kill timer, armed at launch.

**4. Regression check on the surviving target** (final shipped bytes, no temp row):

```
$ printf '0\n' | powershell -NoProfile -ExecutionPolicy Bypass -File dsh-bot.ps1
  dsh-bot launcher
   [1] main                C:\Users\TZhen\Desktop\dsh-bot
        main, clean, = main
        branch main -- the whole product; tracker + research live here
   [0] exit
exit=0                          # previously threw ValidateSetFailure here

$ printf '1\n' | powershell … -File dsh-bot.ps1 -DryRun -NoBuild
   build skipped (-NoBuild)
   overlay: C:\Users\TZhen\Desktop\dsh-bot\dev\cordis.web.patch.yml
   command: dsh --profile web --patch "C:\Users\TZhen\Desktop\dsh-bot\dev\cordis.web.patch.yml"
   [dry-run] not spawning; overlay contents: … (the committed overlay)
exit=0                          # branch + dirty + ahead/behind reporting intact

$ powershell … -File dsh-bot.ps1 -Checkout 2 -DryRun -NoBuild
… 参数“2”不属于 ValidateSet 属性指定的集合“1” …      # exit=1: the dead route is now refused at binding
```

**5. Cleanup.** `tmp-l48-ahead` deleted, both temp launcher copies deleted, and no
`tmp-l48*` artifact remains on the Desktop; the repo's worktree list is back to its
pre-exercise set (main + the five agent worktrees). AC9's live pass is **not** carried to
anyone: the capsule vehicle is retired and the launcher route it needed is gone.

**6. Gates** (same day, worktree `wt/48`, no product code touched — the launcher is outside
the repo and the only previous repo change was the config-only overlay): `npm test`
**1044 pass / 0 fail / 256 suites**, `npm run typecheck` clean (both configs),
`npm run build:client` OK → `client\index.js`, 161,087 bytes reported (162,367 on disk).

**Disposition:** every AC ticked or MOOT-VERIFIED with the pattern cited; no live pass and no
LLM calls remain outstanding here. Status → resolved.
