# Windows launcher

`dsh-bot.bat` here is the tracked source of truth: a Windows-only,
machine-bound **dev** launcher for this checkout, not the install path for a
new machine. For installation, see the root [README.md](../../README.md).

On the dev machine an untracked Desktop `dsh-bot.bat` forwarder calls this
file, so editing this copy changes what the Desktop shortcut runs. That
forwarder is machine-local, not part of the repo — a fresh clone has no
Desktop shortcut.

It builds `lib` and `client` when they are stale (the same freshness probe
`-NoBuild` uses decides that), then boots the `multitask` profile by
default. The `web` route, `-NoBuild`, `-SkipCheck`, `-Restart`, `-Port`,
`-DryRun` and `-NoOpen` are documented in the file header.

`-SkipCheck` is the quick relaunch: it runs no TypeScript build and no
freshness probe, so it serves whatever is already in `lib/` and `client/`.
`port-guard.ps1` keeps exactly one dsh: by default a running dsh is
replaced, and the launcher window that owned it is closed with it, so a
relaunch never leaves a paused window beside a live one. `-Keep` leaves the
running dsh alone and closes the new launch instead. A port held by
something that is not dsh is refused, never killed.

Dev note: a `pnpm file:` install hardlinks the checkout into the profile, so
after a rebuild replaced output files can leave the installed view stale —
re-run `dsh plugin add` to refresh it. The `multitask` route sidesteps this by re-pointing a junction to this
checkout before each boot.
