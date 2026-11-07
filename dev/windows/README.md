# Windows launcher

`dsh-bot.bat` here is the tracked source of truth. The Desktop
`dsh-bot.bat` is a small forwarder that calls this file, so editing this
copy changes what the Desktop shortcut runs.

It builds `lib` and `client`, then boots the `multitask` profile by
default. `web` and `racoons` routes, `-NoBuild`, `-DryRun` and `-NoOpen`
are documented in the file header. The RACOONS launcher was retired;
`dsh-bot.bat racoons` is the remaining switch.
