# 106 — Dispatcher rows offer no direct right-click close — the human wants right-click on a session to close its dispatcher, leaving a normal session

**Status:** open
**Labels:** ready-for-agent
**Related:** 101 (resolved — add/delete dispatcher sessions; the delete seat this rides), 104 (open — stale-mirror honesty; right-clicking a stale row may hit a host refusal), 102 (resolved — row-actions discoverability), ADR-0021 decision 3 (add/delete = deactivate the binding), ADR-0010 (mirror honesty)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"dispatcher bots session should be close-able in the window by rightclicking session, once closed, they become normal sessions"*.

Today the only close affordance is the hover/focus-revealed delete button in the row-actions block (`src/client/shell.tsx:373-401`, `data-delete-id`, labels `shell.row.delete` / `shell.row.delete-confirm`), with two-press arming via `shellDeletePress` (`src/client/shell-store.ts:381-404`, confirm window `SHELL_DELETE_CONFIRM_MS = 4_000` at `:363`).

**What "delete" already does (verified in code at filing):** the delete host seat (`src/client/index.ts:896-905`) sends `DISPATCHER_STOP_LINE = "/dispatcher-stop"` (`src/client/actions.ts:105`) through the ONE command transport (`bindCommandTransport`, `src/client/actions.ts:232-273`; `sendCommand` executes `remote.commands.execute(sessionId, line, [])` at `:253`). Host-side, the stop command (`src/adapter/stop-command.ts:97-109`) gates on the live activation set and then only deactivates the binding — registry drop, parent unbind, per-dispatcher tools unregistered — and the roster mirror clear writes `null` for the session (`src/adapter/roster-channel.ts:200-204`), which the store classifies as `cleared` (`src/client/shell-store.ts:592-596`), flipping the row to `data-dispatcher="false"`. **The "once closed, they become normal sessions" end state already exists host-side.** The ask is therefore about the AFFORDANCE — right-click on the row itself, not hunting a hover-revealed button.

## What to do

- [x] Add a right-click (contextmenu) affordance on dispatcher rows (`ShellRow`, `src/client/shell.tsx:272-404`; rows carry `data-session-id` and `data-dispatcher`) opening a minimal in-window context menu whose action sends the same `/dispatcher-stop` through the existing ONE transport — the new host seat composes exactly like `onDeleteDispatcherSession` (`src/client/index.ts:896-905`), reusing the `reportCommandFailure` tripwire (`src/client/index.ts:825-839`) so failures are not silent.
- [x] Reuse the existing two-press arming pattern (`shellDeletePress`, `src/client/shell-store.ts:381-404`) inside the menu for parity with the delete affordance: first press arms, second press within `SHELL_DELETE_CONFIRM_MS` confirms; the menu item shows the armed (`shell.row.delete-confirm`) state the same way the row button does.
- [x] Name the new host-seat key so it does NOT match /stop|cancel|kill|abort|deactivate|terminate|destroy/i — a pinned constraint at `test/client-session-management.test.ts:314-322` (e.g. `onCloseDispatcherSession` is fine; a `stop`/`kill`-style key is not).
- [x] Do not touch the transport's two-method surface (`sendCommand` / `sendPrompt`, `src/client/actions.ts:140-145`) — the menu rides `sendCommand` like both existing seats.
- [x] en+zh lockstep for all new copy; reuse the existing `shell.row.delete` / `shell.row.delete-confirm` / `shell.row.delete-title` keys where the meaning is identical so no new keys are needed (`validateLocaleDictionary`, `src/client/overlay.ts:507-540`, enforces identical key sets).
- [x] Offline pins in `test/client-session-management.test.ts` (the new seat: present under the sanctioned key, sends `/dispatcher-stop` through the fake transport, two-press arming, failure tripped) plus `test/client-floating-window.test.ts` for the rendered context-menu behaviour as appropriate.
- [x] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes. (`client/` is git-ignored; bundle regenerated locally, nothing bundle-shaped to commit.)

## Constraints

- ONE command transport; no new host seams; no invented push channels.
- No mirror-authority changes — ticket 104 (open) owns stale-mirror honesty. Right-clicking a stale row may get a host refusal ("not an activated dispatcher session"); surfacing refusals is 104's family of concern and out of scope here — this ticket only keeps the existing console tripwire on the new seat.
- Token-only CSS; `multitask-dispatcher-` class discipline; no animation.
- The U-G boundary stands: no worker management affordances — the menu acts on the SESSION's dispatcher binding only, never on workers or turns.
- en+zh locale lockstep for every new user-visible string.

## Comments

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem; the avoid-word "bots" appears only inside the quote). The scribe pass verified the cited facts by code reading only (no implementation): the delete seat already deactivates the dispatcher binding through the ONE command transport, the host's stop command never disposes the chat, and the mirror clear's `null` write is what turns the row back into a normal session — so no transport or host work is needed, only the affordance. The pattern to extend is ticket 101's seat + ticket 102's discoverability discipline: gate the affordance on `row.dispatcher`, arm before firing, and never flip a flag optimistically (ADR-0010 — the mirrors are the truth). Labelled ready-for-agent: the behavior is fully specified by the request plus the existing patterns.

### 2026-09-22 — implementation session

Implemented offline only (no live dsh/LLM/browser work; no push).

**What changed**

- `src/client/shell.tsx` — the affordance. Right-click (`onContextMenu`) on a row button opens the close menu only when the row is a dispatcher (`row.dispatcher`) AND the close seat exists; normal sessions ignore right-click entirely (no `preventDefault`). The menu is part of the shell component tree — a `position:fixed` `multitask-dispatcher-shell__row-menu` div rendered inside the shell root (no portal, no new host seam), positioned at the cursor through the new pure `clampRowMenuPosition` (keeps it on-screen near viewport edges; `SHELL_ROW_MENU_BOX` estimates the one-item menu's size). Menu classes/data hooks: `multitask-dispatcher-shell__row-menu(-item)`, `data-row-menu=<sessionId>`, `data-row-menu-close=<sessionId>`, `data-armed`. CSS is token-only (`var(--dsw-alias-*)`, one `color-mix` of two tokens), no animation, `multitask-dispatcher-` discipline. Hygiene: the menu dismisses on outside pointer-down (capture-phase; a pointer-down inside the menu never dismisses), Escape, any scroll (capture — scroll does not bubble), and its own row ceasing to be a dispatcher row (mirror clear / feed removal) — the menu never outlives its row's dispatcher state; no liveness is guessed (ADR-0010).
- `src/client/index.ts` — new host seat `onCloseDispatcherSession`, declared on `ShellHosts` next to the delete seat and built in `mountShellPage`: identical transport usage to the delete seat (`sendTransport.sendCommand(sessionId, DISPATCHER_STOP_LINE)` → `remote.commands.execute(sessionId, "/dispatcher-stop", [])`), identical `reportCommandFailure` console tripwire, no second transport, no host-side change. No optimistic flip: the row re-renders as a normal session only when the host's mirror clear (`null` write) arrives.
- `src/client/overlay.ts` — three new keys in en+zh lockstep: `shell.row.close` ("Close dispatcher" / “关闭调度会话”), `shell.row.close-confirm` ("Confirm close" / “确认关闭”), `shell.row.close-title` (the honest deactivation semantics: the chat itself stays). The ticket's "reuse `shell.row.delete*` where the meaning is identical" resolved to new keys because the human's ask names the verb "close" — the delete keys say "delete", and one vocabulary means the menu copy says what the affordance does.
- `src/client/floating-window.tsx` / `floating-window-store.ts` / `createLauncherChip` untouched (tickets 105/107 areas).

**Arming decision — REUSED, not a sibling.** The menu item reuses the existing pure `shellDeletePress` reducer (`src/client/shell-store.ts`), unchanged; the menu holds its OWN `ShellDeleteArmState` slot (separate from each row button's), so the single-slot collision the ticket worried about never arises — the shared part is the pure rule, not the state. Opening a menu always starts idle (never born pre-armed); the armed label carries the same revert-timer discipline as the row's delete button, and the press decision re-checks the clock regardless.

**Pins added/updated**

- `test/client-session-management.test.ts`: new seat-wiring pin (executed command is exactly `{sessionId: "s-target", line: "/dispatcher-stop", attachments: []}`); absent-remote and transport-rejection containment extended to the close seat; sanctioned-key assert extended (`onCloseDispatcherSession` present; the banned-verbs regex pin now scans it too and stays green); new describes for the menu's arming (reused reducer, menu-owned slot, cross-surface isolation) and the position clamp (through-pass, edge clamp, negative-point pin).
- `test/client-floating-window.test.ts` (§6, the rendered suite where the ticket-102 affordance pins live): real shell in the real window over the real mount hosts with a spy `remote.commands.execute` — contextmenu opens only on dispatcher rows; menu inside the window's tree; positioned (inline left/top); click #1 arms only (`data-armed="true"`, "Confirm close" label, no send); click #2 inside the window sends `/dispatcher-stop` exactly once and closes; outside pointer-down, Escape, scroll, and the row's own mirror-clear deactivation all dismiss; the dethroned row (`data-dispatcher="false"`) no longer opens the menu. Stale-mirror liveness NOT pinned (ticket 104's).
- `test/client-face-scaffold.test.ts`: the exact-locale-key-list pin extended with the three new keys (lockstep itself enforced by `validateLocaleDictionary`).

**Gates (before → after)**: `npm run typecheck` green → green; `npm test` **1194/290/0 → 1199/293/0**; `npm run lint:docs` green → green; `npm run build:client` green (`client/` git-ignored, nothing bundle-shaped to commit). Evidence: `.scratch/testing/2026-09-22-live-105-106-107/offline-106/` (README with the artifact→claim map, baseline/after gate outputs). Ticket left in `open/`.
