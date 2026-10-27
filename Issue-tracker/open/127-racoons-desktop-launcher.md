# 127 — Add the RACOONS desktop launcher

**Status:** open
**Labels:** ready-for-human
**Related:** 114; owner request, 2026-10-20

## What to do

Create `dsh-bot-RACOONS.bat` on the owner's Desktop. Use the exact spelling.
Launch the main checkout with the README's transient web patch command.
RACOONS has no on/off switch any more: it mounts whenever the plugin is enabled
(ticket 145). The launcher pins `racoonsRecordOnly`,
`racoonsStorageRoot`, and `racoonsContextWindowTokens` in
`dev/cordis.racoons.patch.yml`.

Desktop roots are `C:\Users\TZhen\Desktop\` and `C:\Users\TZ\Desktop\`.
The launcher must select the adjacent `dsh-bot` directory on either device.
Its branch is `main`.

## Constraints

- Never write to the owner's `dsh-bot` checkout.
- Commit nothing. Do not start dsh, use keys, contact a model, or open a browser.
- Missing worktree, dependencies, or build output must print a clear error and pause.
- The session's developer instructions prohibit report/research Markdown files.
  Return the requested research note's facts in the final response instead.

## DoD

- [x] Create the exact desktop filename and a worktree-only patch.
- [x] Confirm the documented command and source/build config path by inspection.
- [x] Prepare the existing source and client builds offline if needed.
- [x] Check paths and batch syntax without starting dsh.
- [ ] Human launch check; live startup is intentionally unverified in this session.

## Comments

2026-10-20: Renumbered from ticket 115 at the racoons-integration lane merge — the main lane had already claimed tickets 114-125. Same ticket, new number.
2026-10-20: Filed before implementation. Initial integration worktree status was clean.
The committed `dev/dsh-bot-launcher.ps1` targets the owner's main checkout; this
launcher will use the integration worktree directly. Existing `lib/plugin.js`
still contains the unsupported `.volatile()` call removed from `src/plugin.ts`.
The client build entry `client/index.js` is absent. Rebuild these outputs offline.

2026-10-20: Created the batch launcher and `dev/cordis.racoons.patch.yml`.
`npm run build` and `npm run build:client` both exited 0. The new build no longer
contains `.volatile()`. Required output paths and `dsh.cmd` on PATH exist.
Static batch checks passed: ASCII, CRLF, resolved labels, balanced blocks, and
correct command. Source default stays false; the patch sets true at line 10.
README lines 44–51 document the launch command; the committed PowerShell
launcher constructs the same command at lines 242–245. No dsh boot, browser,
API key, model contact, or commit. No owner working-tree file was written.

2026-10-28: Launcher re-pointed (agent-run, subject to owner reversal). The
`dsh-bot-racoons` worktree and `racoons-integration` branch no longer exist;
racoons now lives on `main` in the main checkout, so the Desktop
`dsh-bot-RACOONS.bat` targets `%~dp0dsh-bot` on branch `main`. Its comment block
was rewritten from the deleted `racoonsEnabled` switch to the current options
(`racoonsRecordOnly`, `racoonsStorageRoot`, `racoonsContextWindowTokens`,
confirmed in `src/plugin.ts`). The required build output check moved from
`lib/adapter/racoons.js` to `lib/adapter/racoons-mount.js`; all listed paths
exist in the main checkout. Syntax checked with a neutered copy
(`.scratch/testing/2026-10-28-t127-launcher/`); no dsh start, no live test.
The bat is outside git; only this ticket file is committed. Human launch check
still open, so status stays open.
