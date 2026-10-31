# 168 — Installed dsh is 0.2.1-rc.2 while the repo, README and launchers name 0.2.1-rc.3

**Status:** open
**Labels:** needs-owner-decision
**Related:** 144 (the dsh 0.2.1-rc.3 baseline ruling this contradicts); 167 (the Desktop launchers, whose missing-dsh error text names rc.3); `README.md` §What you need; owner request, 2026-10-30 ("stop, wrap up, file what is left").

## Problem

Observed on the owner's machine on 2026-10-30:

- `npm ls -g @deepseek-ai/dsh` → `@deepseek-ai/dsh@0.2.1-rc.2`
- the harness the Web GUI runs from
  (`…\node-v24.19.0-win-x64\node_modules\@deepseek-ai\dsh\package.json`) →
  `"version": "0.2.1-rc.2"`
- `README.md:18` → "last run against dsh 0.2.1-rc.3"
- `dsh-bot.bat` missing-dsh error → "install …@0.2.1-rc.3"
- `dsh-bot-RACOONS.bat` names no version at all; it only says to install dsh.

So the documented baseline and the version actually running disagree by one
release candidate. Nothing was observed to break: the ADR-0032 summon fix
needs `ctx.agents.create` plus `ctx.sessionController.resolveAgent`, and
both exist in rc.2 (`dsh-api-session-controller/lib/index.js` exposes
`agents.create`; the `origin === 'subagent'` ownership guard at
`:1693` and the `session/agent-busy` error are present). Ticket 144's
baseline was therefore never enforced by a check — only by prose.

## Why it is not a quick edit

Two coherent resolutions, and only the owner can pick:

1. **Correct the text down to rc.2** — change `README.md:18` and the
   launcher error to name the version that is actually installed and
   actually tested against. Cost: the rc.3 baseline ruling in ticket 144 is
   walked back, and any rc.3-only behaviour the repo relies on must be
   re-audited against rc.2.
2. **Upgrade the install to rc.3** — `npm install -g
   @deepseek-ai/dsh@0.2.1-rc.3`, then re-verify the plugin loads. Cost:
   network + a global install on the owner's machine, and a re-run of
   whatever live checks ticket 158 still owns, because the baseline moves.

Doing both (upgrade *and* reword) or reword-then-upgrade later are also
fine — the point is that one of them must be chosen, because today a reader
of the README is told to install a version that is not the one in use.

## Constraints

- One line of prose and possibly one global install. Do not change source
  code to chase the version.
- If resolving by upgrade: no live dsh run, no model contact, no key export,
  and read `read-before-running-live-and-browser-tests.md` before any live
  launch that follows.
- If resolving by reword: check whether any code comment or test pins rc.3
  and decide case by case; do not silently leave contradictory references.
- Either way, the launcher error text and `README.md` must end up saying the
  same thing, and `dsh-bot-RACOONS.bat`'s dsh-not-found error should name the
  version too if the others do.

## DoD

- [ ] Owner picks: reword to rc.2, or upgrade to rc.3.
- [ ] `README.md`, `dsh-bot.bat` and `dsh-bot-RACOONS.bat` all name the same,
      actually-installed version.
- [ ] If the baseline moved, ticket 158 records that its live checks were run
      against the new baseline.
