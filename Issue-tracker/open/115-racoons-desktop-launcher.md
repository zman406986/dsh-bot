# 115 — Add the RACOONS desktop launcher

**Status:** open
**Labels:** ready-for-human
**Related:** 114; owner request, 2026-10-20

## What to do

Create `desh-bot-RACOON.bat` on the owner's Desktop. Use the exact spelling.
Launch the integration worktree with the README's transient web patch command.
Set `racoonsEnabled: true` in a new worktree patch; keep the plugin default false.

Desktop roots are `C:\Users\TZhen\Desktop\` and `C:\Users\TZ\Desktop\`.
The launcher must select the adjacent `dsh-bot-racoons` directory on either device.
Its branch is `racoons-integration`.

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
