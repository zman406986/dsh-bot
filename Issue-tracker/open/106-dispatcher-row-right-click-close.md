# 106 — Dispatcher rows offer no direct right-click close — the human wants right-click on a session to close its dispatcher, leaving a normal session

**Status:** open
**Labels:** ready-for-agent
**Related:** 101 (resolved — add/delete dispatcher sessions; the delete seat this rides), 104 (open — stale-mirror honesty; right-clicking a stale row may hit a host refusal), 102 (resolved — row-actions discoverability), ADR-0021 decision 3 (add/delete = deactivate the binding), ADR-0010 (mirror honesty)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"dispatcher bots session should be close-able in the window by rightclicking session, once closed, they become normal sessions"*.

Today the only close affordance is the hover/focus-revealed delete button in the row-actions block (`src/client/shell.tsx:373-401`, `data-delete-id`, labels `shell.row.delete` / `shell.row.delete-confirm`), with two-press arming via `shellDeletePress` (`src/client/shell-store.ts:381-404`, confirm window `SHELL_DELETE_CONFIRM_MS = 4_000` at `:363`).

**What "delete" already does (verified in code at filing):** the delete host seat (`src/client/index.ts:896-905`) sends `DISPATCHER_STOP_LINE = "/dispatcher-stop"` (`src/client/actions.ts:105`) through the ONE command transport (`bindCommandTransport`, `src/client/actions.ts:232-273`; `sendCommand` executes `remote.commands.execute(sessionId, line, [])` at `:253`). Host-side, the stop command (`src/adapter/stop-command.ts:97-109`) gates on the live activation set and then only deactivates the binding — registry drop, parent unbind, per-dispatcher tools unregistered — and the roster mirror clear writes `null` for the session (`src/adapter/roster-channel.ts:200-204`), which the store classifies as `cleared` (`src/client/shell-store.ts:592-596`), flipping the row to `data-dispatcher="false"`. **The "once closed, they become normal sessions" end state already exists host-side.** The ask is therefore about the AFFORDANCE — right-click on the row itself, not hunting a hover-revealed button.

## What to do

- [ ] Add a right-click (contextmenu) affordance on dispatcher rows (`ShellRow`, `src/client/shell.tsx:272-404`; rows carry `data-session-id` and `data-dispatcher`) opening a minimal in-window context menu whose action sends the same `/dispatcher-stop` through the existing ONE transport — the new host seat composes exactly like `onDeleteDispatcherSession` (`src/client/index.ts:896-905`), reusing the `reportCommandFailure` tripwire (`src/client/index.ts:825-839`) so failures are not silent.
- [ ] Reuse the existing two-press arming pattern (`shellDeletePress`, `src/client/shell-store.ts:381-404`) inside the menu for parity with the delete affordance: first press arms, second press within `SHELL_DELETE_CONFIRM_MS` confirms; the menu item shows the armed (`shell.row.delete-confirm`) state the same way the row button does.
- [ ] Name the new host-seat key so it does NOT match /stop|cancel|kill|abort|deactivate|terminate|destroy/i — a pinned constraint at `test/client-session-management.test.ts:314-322` (e.g. `onCloseDispatcherSession` is fine; a `stop`/`kill`-style key is not).
- [ ] Do not touch the transport's two-method surface (`sendCommand` / `sendPrompt`, `src/client/actions.ts:140-145`) — the menu rides `sendCommand` like both existing seats.
- [ ] en+zh lockstep for all new copy; reuse the existing `shell.row.delete` / `shell.row.delete-confirm` / `shell.row.delete-title` keys where the meaning is identical so no new keys are needed (`validateLocaleDictionary`, `src/client/overlay.ts:507-540`, enforces identical key sets).
- [ ] Offline pins in `test/client-session-management.test.ts` (the new seat: present under the sanctioned key, sends `/dispatcher-stop` through the fake transport, two-press arming, failure tripped) plus `test/client-floating-window.test.ts` for the rendered context-menu behaviour as appropriate.
- [ ] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes.

## Constraints

- ONE command transport; no new host seams; no invented push channels.
- No mirror-authority changes — ticket 104 (open) owns stale-mirror honesty. Right-clicking a stale row may get a host refusal ("not an activated dispatcher session"); surfacing refusals is 104's family of concern and out of scope here — this ticket only keeps the existing console tripwire on the new seat.
- Token-only CSS; `multitask-dispatcher-` class discipline; no animation.
- The U-G boundary stands: no worker management affordances — the menu acts on the SESSION's dispatcher binding only, never on workers or turns.
- en+zh locale lockstep for every new user-visible string.

## Comments

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem; the avoid-word "bots" appears only inside the quote). The scribe pass verified the cited facts by code reading only (no implementation): the delete seat already deactivates the dispatcher binding through the ONE command transport, the host's stop command never disposes the chat, and the mirror clear's `null` write is what turns the row back into a normal session — so no transport or host work is needed, only the affordance. The pattern to extend is ticket 101's seat + ticket 102's discoverability discipline: gate the affordance on `row.dispatcher`, arm before firing, and never flip a flag optimistically (ADR-0010 — the mirrors are the truth). Labelled ready-for-agent: the behavior is fully specified by the request plus the existing patterns.
