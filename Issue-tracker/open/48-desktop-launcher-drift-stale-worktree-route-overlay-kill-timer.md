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

- [ ] (offline) Menu/dry-run on both targets reports branch + dirty + ahead/behind vs `main`; the always-on entry shows its behind-count and its copy no longer claims to hold all ticket-17 work.
- [ ] (offline) Launching a behind-`main` target without `-Sync`/`-AllowStale` refuses with a message naming the count and the remedy — verified against the worktree's real 0-ahead/39-behind state.
- [ ] (offline) `-Sync` on a clean, 0-ahead, behind checkout fast-forwards it to `main`; on a checkout with unique commits it refuses without mutating anything.
- [ ] (offline) `dev/cordis.web.patch.yml` composes through the real boot layer: `dsh --profile web --dump-config --patch <file>` shows the row, and the row's `name` is the `file:///…/<checkout>/lib/index.js` URL — proving the relative anchor resolves to the right checkout for both targets.
- [ ] (offline) `-KillAfterMinutes` arms a killer that force-kills the spawned server tree at launch time (observable by a short timer against a dummy), and the exact launch command is printed on every launch, not only `-DryRun`.
- [ ] (offline) Repo gates after the overlay file lands: `npm test` 0 fail, `npm run typecheck` clean (both configs), `npm run build` + `build:client` OK.
- [ ] (live, ZERO LLM calls — ticket 33's browser pass) a launcher boot from the synced worktree serves the same boot graph as main (row + client bundle + capsule), i.e. route [2] is trustworthy again or is retired.

## Comments

_(none yet)_
