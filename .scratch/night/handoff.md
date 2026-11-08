# Morning handoff — night of 2026-11-07/08

Written by the summoned team leader. Nothing was restarted or installed.
Last commit: `cc69118`. Working tree: source, tests, vendor and docs are clean; only the regenerated open index and this `.scratch` folder are uncommitted.

## What landed

Two planned features, merged before this shift:

- Optional `model` argument on `spawn_worker` and `spawn_dispatcher` (ticket 285, merge `2e2e551`). Validated at spawn; omitting it behaves exactly as before.
- Real sidebar titles for summoned team leaders (ticket 159 / plan 2, merge `8828a01`). The dispatcher's team title is written to the session through the host title service, before the first turn.

Then five defect batches from `.scratch\night\triage.md`, one ticket at a time, each with an offline test:

- Batch 1: 180, 182, 191, 193, 220, 236
- Batch 2: 186, 195, 196, 199, 205, 206, 235, 238
- Batch 3: 188, 189, 190, 198, 221, 237
- Batch 4: 187, 197, 200, 265
- Batch 5: 280, 281, 282, 283, 284, 192, 185
- Plus ticket 183: a bounded adapted-copy review recorded in `docs/research/no-verbatim-copy-review-2026-11-08.md` (PASS, no verbatim violation, eight wording follow-ups tracked in 287).

33 tickets closed tonight. Full gate after the critic follow-up: **1311 tests / 368 suites, 1311 pass, 0 fail**; typecheck clean; docs gate clean at 5 open rows.

## To activate it

The plugin and the web client both changed, so both need a build and a restart:

```
cd C:\Users\TZ\Desktop\dsh-bot
npm run build
npm run build:client
```

Then stop the running dsh web process and start it again the same way as before, and refresh http://127.0.0.1:3080. No reinstall, no new dependency.

## What to click

1. **Title.** Ask the current dispatcher to summon a team leader with a title (spawn_dispatcher). The new row in the left sidebar should read that exact title, not "Untitled". Restart dsh once more and check it is still there; the title is stored, not just the roster label. If the row still says Untitled, the host's title service is missing and the code deliberately stays silent — check that the installed dsh is the same one that was running tonight.
2. **Model argument.** Spawn a worker with the optional `model` set to a model you have enabled. It should start normally on that model; omitting the argument should look exactly like before. A model name that does not exist should not refuse the spawn: the worker starts on the inherited route, one `[multitask-dispatcher]` warning is logged, and the tool result carries `model_fallbacks`.
3. **Settings refresh (192).** Open the Plugins page, change a setting, then let the page re-render while the save is in flight. The saved/refused result should still appear and the draft should stay. This one is unit-tested only; the live page is the open check.
4. **Empty conversation page (280)** and **copy button (281)** are client-only fixes; both are offline-tested and are exercised naturally when the shell is used.

## Deliberately left for a human

- **158 / 167** — the verification sweep and the desktop launcher sync; both need your machine or your judgement.
- **160** — tracked diagram files name the reference reconstruction. This needs your attribution decision before publication; no code change is pending.
- **286** — the live title check above (ready-for-human).
- **287** — the eight copy follow-ups from the 183 review need your wording approval before anyone edits owner-supplied prompt or UI copy. F1 is the one that matters: the team-leader wake still says "user-facing send" although the shipped plugin wires no such channel.
- **192 live Plugins-page check** — staged above; unit tests are green.

## Notes

- The client bundle rebuild (`npm run build:client`) is required for 192/280/281 and the copy fixes to show in the GUI.
- `npm test` rebuilds the vendor libs every run; nothing extra is needed.
- Do not run `npm install`; the tree is as it was.
