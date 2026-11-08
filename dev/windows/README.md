# Windows launcher

`dsh-bot.bat` here is the tracked source of truth. The Desktop
`dsh-bot.bat` is a small forwarder that calls this file, so editing this
copy changes what the Desktop shortcut runs.

It builds `lib` and `client` when they are stale (the same freshness probe
`-NoBuild` uses decides that), then boots the `multitask` profile by
default. The `web` route, `-NoBuild`, `-SkipCheck`, `-Restart`, `-Port`,
`-DryRun` and `-NoOpen` are documented in the file header. There is no
racoons switch: that feature is off by default and is not production-ready;
use its patch file only for isolated testing.

`-SkipCheck` is the quick relaunch: it runs no TypeScript build and no
freshness probe, so it serves whatever is already in `lib/` and `client/`.
`port-guard.ps1` keeps exactly one dsh: by default a running dsh is
replaced, and the launcher window that owned it is closed with it, so a
relaunch never leaves a paused window beside a live one. `-Keep` leaves the
running dsh alone and closes the new launch instead. A port held by
something that is not dsh is refused, never killed.
