# Windows launcher

`dsh-bot.bat` here is the tracked source of truth. The Desktop
`dsh-bot.bat` is a small forwarder that calls this file, so editing this
copy changes what the Desktop shortcut runs.

It builds `lib` and `client`, then boots the `multitask` profile by
default. The `web` route, `-NoBuild`, `-DryRun` and `-NoOpen` are
documented in the file header. There is no racoons switch: that feature is
off by default and is not production-ready; use its patch file only for
isolated testing.
