# 134 — Activation copy tells the user progress shows in the Workers panel, which does not exist

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** nothing
**Related:** ADR-0024 (the floating window, launcher, and capsule are withdrawn; stock dsh is the only UI — nothing of ours is mounted), ticket 133 (the sibling dead claim in model-facing policy, resolved 2026-10-22 — it flagged this user-facing copy as the larger defect and left it), ticket 114 (the composition revert that left the panel retained-but-unmounted), ticket 32 (introduced the hint), `docs/surfaces.md:25-31` (the live progress routes in the native posture)

## Problem

The `/dsh-bot` success copy prints a claim about a surface that is not mounted. A successful activation returns `DISPATCHER_START_SUCCESS` (`src/adapter/activation-command.ts:49-52`, returned at `:93` and `:123`), which appends the presence hint at `src/adapter/activation-command.ts:44-46`:

> `export const ACTIVATION_PRESENCE_HINT =`
> `  "The Workers panel shows live progress; results arrive in this chat as " +`
> `  "they finish.";`

The rendered string is: "The Workers panel shows live progress; results arrive in this chat as they finish."

The English-locale twin of the same string is `src/client/overlay.ts:154-155` (`activation.presence-hint`, registered with the locale namespace at `src/client/index.ts:210-213`):

> `"activation.presence-hint":`
> `  "The Workers panel shows live progress; results arrive in this chat as they finish.",`

Its zh face at `src/client/overlay.ts:339-340` carries the same claim ("“工作者”面板会显示实时进度"). ADR-0024 says the module registers nothing into dsh's layout and the floating surface is withdrawn; `docs/surfaces.md:150` and `:250` list the roster ("Workers") panel as **Retained, unmounted**. The only live progress route in the native posture is the dispatcher's own chat narration (`docs/surfaces.md:29-31`). So the hint promises a surface the user will never see, at the moment they opt in.

The client face is shipped-but-unrendered today (the host command result is the surface — see the comment at `src/client/overlay.ts:148-153`), but ADR-0024 decision 4 keeps the machinery in the tree, and the string ships in the bundle. It is fixed in the same pass so the retained code cannot carry the dead claim if it is ever composed.

## Evidence

- `src/adapter/activation-command.ts:37` — JSDoc also names "the app-wide Workers panel".
- `src/adapter/activation-command.ts:45` — user-facing copy, live on every successful activation.
- `src/client/overlay.ts:155` — en locale copy, registered, unrendered.
- `src/client/overlay.ts:340` — zh twin with the same claim.
- Pins: `test/composition-polish.test.ts:326` (exact en literal), `:384` (`assert.match(ACTIVATION_PRESENCE_HINT, /Workers panel/)`), `:377` (exact zh literal), `:366-368` (host/client en parity).
- ADR-0024 decision 1–2 (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:13-14`); `docs/surfaces.md:25-31`, `:150`, `:250`.

## Acceptance

- [x] No user-facing string claims a Workers panel: grep `src/` for "Workers panel" (case-insensitive) returns zero hits.
- [x] Both constants rewritten to drop the panel claim while keeping the still-true part of the hint: progress is conveyed by the dispatcher's own narration in this chat, and results arrive in this chat as they finish. No new feature is named; the sidebar glyph is not mentioned (neither source string mentioned it).
- [x] zh face rewritten to match the en face (one localized unit); the en/zh and host/client parity pins updated.
- [x] `test/composition-polish.test.ts` updated and green.

## Constraints

- Copy only. No surface is restored and no composition changes; ADR-0024's posture stands.
- The push-absence rule survives: the hint keeps naming the pull surface and still promises no notification, toast, banner, badge, or email (design-17 §4.8; the existing forbidden-word pin stands).
- Does not reopen ticket 133's policy line.

## Comments

### 2026-10-22 — filing

Filed from ticket 133's resolution, which recorded the two user-facing copies plus the zh twin and left them unchanged because moving them means moving their pins. Re-verified before filing: the live grep for "Workers panel" over `src/` returns the JSDoc line and the two copy lines, and both pins are at the cited test lines. Labelled `needs-triage`.

## Resolution — 2026-10-22

Option taken: rewrite the copy to the live route (the dispatcher's own narration), drop the panel claim, and move the pins. No surface was restored; ADR-0024's native-dsh posture stands.

**Source changes.**

1. `src/adapter/activation-command.ts` — `ACTIVATION_PRESENCE_HINT` (and its JSDoc, which also named the panel):

   - Old (rendered): `The Workers panel shows live progress; results arrive in this chat as they finish.`
   - New (rendered): `The dispatcher reports progress as it works; results arrive in this chat as they finish.`

   `DISPATCHER_START_SUCCESS` is unchanged apart from inheriting the new hint; the "Dispatcher active in this chat. Workers spawned here report back here; use /dispatcher-steer to nudge a running worker. " prefix is untouched.

2. `src/client/overlay.ts:154-155` — the en locale twin now carries the identical new en string (parity pin holds).

3. `src/client/overlay.ts:339-340` — the zh face:

   - Old: `“工作者”面板会显示实时进度；结果完成后会直接送达本聊天。`
   - New: `调度器会在工作中随时汇报进度；结果完成后会直接送达本聊天。`

**Test pins moved (`test/composition-polish.test.ts`).**

- `:324-327` — the exact en literal assertion now pins the new string.
- `:375-378` — the exact zh literal assertion now pins the new translation.
- `:383-385` — the positive `/Workers panel/` assertion is replaced by the inverse guard `assert.doesNotMatch(ACTIVATION_PRESENCE_HINT, /panel/i)`, so a panel claim cannot come back. The `/this chat/` assertion and the forbidden-push-word loop are unchanged.

**Verification.**

- `grep -rni "workers panel" src/` — zero hits (was 3: the JSDoc at `:37`, the copy at `:45`, the locale face at `:155`).
- `grep -rni "workers panel" test/` — zero hits.
- `npx tsx --tsconfig tsconfig.client.json --test test/composition-polish.test.ts` — **14 tests, 14 pass, 0 fail** (5 suites). No other test file pinned the strings; `test/client-face-scaffold.test.ts` pins only that the locale key exists, which still holds.

**Sibling.** Ticket 133 fixed the model-facing policy line the same day; this is the user-facing half it flagged and left. The dead `shell.onboard.handoff.body` panel wording inside the retained-unmounted shell (`src/client/overlay.ts:276-277`, zh at `:443-444`) is still there and is out of this ticket's scope: the acceptance was the "Workers panel" claim, and that string words it differently ("shows in the panel beside it").

