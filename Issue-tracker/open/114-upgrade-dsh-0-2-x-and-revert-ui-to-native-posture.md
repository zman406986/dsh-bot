# 114 — Upgrade dsh to 0.2.x and return the dispatcher UI to the e773ef8 native-dsh posture (keep later functional changes)

**Status:** open (execution in progress — the gates are filled in by the owner/implementer)
**Labels:** ready-for-agent
**Blocked by:** none for the version upgrade and the offline analysis. The client revert may not merge until the records step in §Conflicts surfaced is recorded (authority stack: only a human directive outranks an accepted ADR).
**Related:** ADR-0014 (client bundle materialization — pinned to 0.1.5-rc.1, carries the standing drift rule "re-verify on dsh upgrades"), ADR-0015 (browser-test route — pinned to 0.1.5-rc.1, same drift rule), ADR-0019 (**verified against 0.1.5-rc.2**), ADR-0021 + ADR-0022 (the floating window and capsule this ticket reverses — see §Conflicts surfaced), ticket 99 (commit `e773ef8` is its resolution), tickets 100, 102, 103, 105, 106, 107 (the UI work being reverted), tickets 101, 108, 113 (functional changes that must survive).

## Problem

Two separate pieces of work are underway.

**A. The harness is stale.** dsh is a globally installed CLI with no documented update procedure anywhere in this repo. The machine runs `@deepseek-ai/dsh@0.1.5-rc.1`. Registry latest is `0.2.0-rc.2`. A whole minor version of host API drift sits between the code and the current release. Every seam this plugin uses was read off the 0.1.5 tree and is recorded as such: the client bundle materialization contract (ADR-0014), the browser-test launcher route (ADR-0015), the per-dispatcher scoped-tools seam (ADR-0019), and dozens of `file:line` citations in `docs/research/`. Both ADRs say in writing to re-verify on a dsh upgrade.

**B. The UI posture is wrong for the target.** The human wants the dispatcher UI returned to the state at commit `e773ef8` — stock dsh is the primary UI, our module renders NOTHING into dsh's layout, and there is no floating window, launcher, or capsule. Everything after that commit re-hosted the shell into a floating window (ticket 100), added the launcher chip, drag/resize/maximize, right-click close, and the floating capsule with counts. That posture is accepted-ADR work (ADR-0021 decisions 2 and 4, ADR-0022), so the reversal has to be recorded, not slipped in — see §Conflicts surfaced.

The two goals are independent in code but share one verification lane: the post-upgrade smoke test must run against the reverted UI posture.

## Verified state at filing (2026-10-18)

- Global CLI: `dsh --version` → `0.1.5-rc.1`. `npm ls -g --depth=0 @deepseek-ai/dsh` → `@deepseek-ai/dsh@0.1.5-rc.1` under the WinGet Node prefix `C:\Users\TZhen\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64`.
- Registry: `npm view @deepseek-ai/dsh version` → `0.2.0-rc.2`.
- CLI has no self-update verb. `dsh --help` lists `--profile`, `--patch`, `web`, and `plugin` (which forwards to pnpm in the profile directory); there is no `update`/`upgrade` command. The repo documents no install or upgrade procedure beyond `dsh plugin --profile multitask add file:...` (`README.md` §Install into a dsh profile).
- **The profile's package tree is already mixed and is the tree that actually boots.** `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` holds `dsh` at `0.1.5-rc.1` while `dsh-client-ui-renderer`, `dsh-client-locale`, `dsh-client-modules`, `dsh-tools`, and `dsh-agent` are at `0.1.5-rc.2`. Profiles are pnpm workspaces (`pnpm-lock.yaml`, `pnpm-workspace.yaml` in both `web` and `multitask`), so upgrading the global npm package alone may leave the booted tree behind. Re-verification must name which tree it measured.
- Version citations that must be re-checked or re-stamped: `docs/research/dsh-local-install.md:19,30,32`, `docs/research/dsh-extension-surface.md:17,19`, `docs/research/dsh-adapter-api-notes.md:4,405`, `docs/research/dsh-capsule-seams.md:9,101`, `docs/research/dsh-plugin-ui-patterns.md:4,5,13,17,112`, `docs/research/always-on-dispatcher-behavior.md:80`, `docs/research/dsh-child-system-prompt-seam.md:10`, the `dsh-core-loop-*`, `dsh-loop-capability-map.md`, and `dsh-tool-scoping-seam.md` notes; ADR-0014 lines 13/28/36/44, ADR-0015 line 33, ADR-0019 lines 20/53; source comments `src/adapter/settings-section.ts:20`, `src/adapter/cordis-dsh-host.ts:44`, `src/client/actions.ts:17`, `src/client/context.ts:88`, `src/client/shell-mount.ts:132,162`, `src/client/toolviews.ts:10,59`, `test/client-face-scaffold.test.ts:61,366`.
- Client delta from `e773ef8` to HEAD (`1f5ae26`): 9 files, +2322/−100. New: `src/client/floating-window.tsx` (655 lines, includes `CAPSULE_CSS`), `src/client/floating-window-store.ts` (612 lines). Modified: `index.ts` (+326), `shell.tsx` (+390), `shell-store.ts` (+161), `overlay.ts` (+159), `settings-card-store.ts` (+66), `actions.ts` (+38), `settings-card.tsx` (+15). New test: `test/client-floating-window.test.ts` (2363 lines).
- At `e773ef8` the default composition registers exactly two things: the keyed `tool.call.toolview` entries and the keyed `settings.plugin.item` card; `mountShellPage` and the `shell-mount.ts` contracts stay in the tree as retained, unmounted machinery.
- The settings card currently exposes `wakeCoalesceWindowMs` (ticket 108, `src/plugin.ts:86`), `inboxEnabled` (`:97`), `inboxDir` (`:99`), and `inboxRescanIntervalMs` (`:104`) in `SETTINGS_CARD_FIELDS` (`src/client/settings-card-store.ts:237`), pinned by the schema↔card parity test (`test/client-settings-card.test.ts:477-481`).

## What to do

### Goal 1 — upgrade the global harness and re-verify the plugin

- [ ] Record the before state: global CLI version, profile-tree `@deepseek-ai/*` versions (the tree that boots), and the profile names in use (`web`, `multitask`).
- [ ] Upgrade the global package to the registry latest (currently `0.2.0-rc.2`). Do not invent an update procedure: document the command that worked in this ticket, because the repo has none today.
- [ ] Refresh/verify the profile package tree so the booted `@deepseek-ai/*` set is the same version as the CLI. Record which tree the smoke test measured.
- [ ] Re-verify every seam this plugin calls against the new tree, and record the verdict per seam:
  - client bundle materialization (`dsh.client` manifest, `inject` walking, `immediately` rules — ADR-0014);
  - client services: `ctx.slots` (list/keyed/single conflict rules), `ctx.locale`, `ctx.settingsScope`, `ctx.remote.commands`, `ctx.sessions`, `ctx.conversation`;
  - host services: `subagents.startContinuable` / `interrupt` / `sendMessage`, `agents.get`, `agent.followup` / `inject`, `tools.register` + `tools.restrict`, `storageDomain`, `commands.register`, `settings.installSection`, `webServer.register`, and the host events used by the adapter (`subagent/end`, `session/event`, `agent/status`, `agent/disposed`);
  - the launcher route used by browser tests (`dsh --profile web --patch ...`, port/served-page shape — ADR-0015).
- [ ] Fix fallout. Keep fixes minimal and cite the new `file:line` evidence in the code comment that made the old claim.
- [ ] Re-stamp version claims that moved. Research notes are evidence, never rulings: do not rewrite findings, add dated version stamps. ADR bodies stay untouched; the dated convention is a note on the ADR's status line or an entry in the ticket comment (see `docs/adr/README.md` precedent).
- [ ] Record the after state (same fields as the before state) in the table below.

### Goal 2 — return `src/client/` to the `e773ef8` posture, keeping later functional work

- [ ] Remove the floating-window and launcher posture from the default composition:
  - `src/client/index.ts`: drop the `SHELL_OVERLAY_SLOT` inject (`:528-538`), the `launcherOverlayRegistration` import (`:101`), the floating-window store/window composition (`:523`, imports `:168-172`), and the window-related comments/helpers. What remains must be exactly `e773ef8`'s shape: locale effect, toolview inject, settings-card inject.
  - `src/client/overlay.ts`: remove `LAUNCHER_ENTRY_ID` (`:52`), `LAUNCHER_OVERLAY_ORDER` (`:61`), `launcherOverlayRegistration` (`:105`), and every launcher/capsule/window copy key. Keep the settings-card field keys and the en+zh key-set lockstep.
  - Delete `src/client/floating-window.tsx` and `src/client/floating-window-store.ts`, and `test/client-floating-window.test.ts`.
  - Remove window/launcher/capsule references from `src/client/shell.tsx` and `src/client/shell-store.ts` that exist only to feed the window (the shell surfaces themselves stay — see next item).
- [ ] **Keep, do not revert, the functional changes from tickets 101, 108, and 113:**
  - 101: `DISPATCHER_START_LINE` / `DISPATCHER_STOP_LINE` (`src/client/actions.ts`), the add picker + delete arming in `shell-store.ts`, the add/delete seats in `shell.tsx` and `src/client/index.ts`. They stay in the tree as unmounted wiring, exactly as `mountShellPage` was at `e773ef8`.
  - 108: `wakeCoalesceWindowMs` in the settings card (schema is host-side, untouched).
  - 113: `inboxEnabled`, `inboxDir`, `inboxRescanIntervalMs` in the settings card, including the `string` field kind in `settings-card.tsx` and its `parseString`/`formatString` support in `settings-card-store.ts`.
- [ ] **Keep the ticket-102b fix.** Commit `fd6947d` added the nested `"remote.commands"` inject entry (`src/client/index.ts:222`), which the 101 seats' command transport needs. `e773ef8` predates it. A literal `git checkout e773ef8 -- src/client` re-breaks command delivery, so the revert must be selective.
- [ ] Re-base the tests that pin the retired posture. The pins that exist only to assert the window/launcher/capsule go with the code; the pins for preserved features stay and are re-based to the e773ef8 posture (the "renders NOTHING into dsh's layout" pin from ticket 99 is the template). Expected touch set: `client-face-scaffold`, `client-roster-panel`, `client-shell-mount`, `client-shell-seat-composition`, `client-toolviews`, `client-wrapper-shell`, `client-theme-tokens`, `composition-polish`, `coexistence`, `restart-honesty`, `approval-feed-composition`, `client-session-management`.
- [ ] Reconcile `docs/surfaces.md`. It already describes the retired capsule as live and cites files that no longer exist (`src/client/capsule.tsx`, `describeCapsuleFooter`, `test/client-capsule-composition.test.ts`). Make it state the current posture: stock dsh primary, no layout registration, shell surfaces retained as unmounted machinery.
- [ ] Record the disposition of ticket 106's right-click close menu (not in the preserve list). If it stays, it is unreachable without a mount; if it goes, say so. Do not leave it half-wired.

## Acceptance criteria

- [ ] `npm run typecheck` is green (both tsconfigs).
- [ ] `npm test` is green (offline, no dsh, no LLM). Record the before/after pass/suite counts; a count drop is expected where window tests are deleted and must be accounted for file by file.
- [ ] `npm run lint:docs` is green (doc-lint 0 findings; issue index and ADR index fresh).
- [ ] `npm run build` and `npm run build:client` succeed. Build artifacts (`lib/`, `client/`) are git-ignored and are not committed.
- [ ] `src/client/` contains no floating-window, launcher, or capsule code: no `floating-window*` files, no `launcherOverlayRegistration` / `LAUNCHER_ENTRY_ID` / `LAUNCHER_OVERLAY_ORDER`, no window CSS or window copy keys, no `SHELL_OVERLAY_SLOT` inject in the composition.
- [ ] The settings card still exposes the wake-coalescing field and all three file-inbox fields, and the schema↔card parity test passes.
- [ ] The ticket records the dsh version before and after, and which package tree (global or profile) each reading came from.

## Version record

Replace the `TBD` cells as the work lands. Do not delete the before row.

| What | Before (2026-10-18) | After |
|---|---|---|
| `dsh --version` (global CLI) | `0.1.5-rc.1` | TBD |
| Global `@deepseek-ai/dsh` package | `0.1.5-rc.1` | TBD |
| Profile tree `@deepseek-ai/dsh` (booted) | `0.1.5-rc.1` | TBD |
| Profile tree `@deepseek-ai/dsh-*` (renderer, locale, modules, tools, agent) | `0.1.5-rc.2` (mixed with the CLI above) | TBD |
| Registry latest at upgrade time | `0.2.0-rc.2` | TBD |

## Non-goals

- **Do not touch the reference tree.** The policy in `read-before-reference-tree-work.md` stands.
- **Do not commit build artifacts.** `lib/` and `client/` are git-ignored; the committer lane handles commits.
- **Do not revert functional adapter, core, or worker code.** Tickets 108, 109, 110, 112, and 113's host-side work stays. The revert is limited to `src/client/` UI posture and its tests/docs.
- No new UI features, no new host seams, no invented push channels.
- No dsh behavior forks to paper over an API change; if 0.2.x removes a seam, record the break honestly and raise it rather than shimming silently.

## Conflicts surfaced (read before touching `src/client/`)

Per `agent.md` §Flag ADR conflicts, this ticket's second goal contradicts accepted, human-ruled decisions:

- **ADR-0021 decisions 2 and 4 (accepted, human-ruled 2026-09-20)** put the dispatcher functions in a separate floating window launched from one additive `shell.overlay` entry, and require the existing surfaces to re-host there.
- **ADR-0022 (accepted, human-ruled 2026-09-22)** revives the collapsed launcher as the floating capsule with counts.
- The PRD carries the matching amendments at §6.1, §11.5 item 5, and §15 item 6 ("a separate floating window over stock dsh").

The authority stack allows only a **dated human explicit override (level 1)** to reverse these. The directive behind this ticket is such an override, but the reversal must be written down before the client revert merges:

1. File a dated human-ruled ADR (or dated status-line notes plus a PRD in-place amendment in the ticket-99 / ticket-64 style) recording that the floating window, launcher, and capsule are retired from the default posture. Do not edit accepted ADR bodies; add dated notes.
2. Note in that record that ADR-0021 decision 1 (stock dsh never displaced) is unchanged — the revert strengthens it.
3. If that records step is not authorized in the execution lane, **stop and ask the human**. Do not merge the revert on the strength of this ticket alone.

Two consequences that need an explicit answer from the owner, recorded here rather than decided by the implementer:

- With no mount, the 101 add/delete affordances and the 106 right-click close become unreachable. Is that intended (functional code retained for a later surface), or does the owner want one reachable place to keep managing dispatcher sessions? The ticket preserves the code either way; only reachability is open.
- `docs/surfaces.md` currently describes the capsule as the live surface. It must end up matching whichever answer above applies.

## Constraints

- Work from `e773ef8` as the reference for the client's default composition, but apply the revert selectively — see the 102b note. A blind checkout silently re-breaks command delivery and drops tickets 101/108/113.
- The live/browser verification follows `read-before-running-live-and-browser-tests.md`: kill timer set at launch, trivial tasks only, never export or copy the dsh key. Evidence goes under `.scratch/testing/2026-10-18-<slug>/` in the repo, created before the session starts; never on the Desktop; never committed.
- The upgrade touches a global install and the user's live profile. Treat that step as operator-authorized; record every command run.
- Comment discipline: use `src/core` / `src/adapter` / `src/client` language; no invented names for the posture.
- Do not commit. The committer lane handles that.

## Comments

### 2026-10-18 — filing (scribe)

Filed for work now underway. The ticket is one file by design: the tracker guide does not require splitting, and the two goals share one verification lane (the post-upgrade smoke test runs against the reverted posture).

Facts above were verified at filing by reading the machine and the repo, not from memory: `dsh --version`, `npm ls -g`, `npm view`, the profile `package.json` files, `dsh --help`, `git diff --stat e773ef8..HEAD -- src/client`, and the settings-card/schema code. The mixed profile tree (`dsh` 0.1.5-rc.1, its `dsh-*` packages 0.1.5-rc.2) is a finding, not a typo: the booted tree is pnpm-managed and separate from the global npm package, so a global upgrade alone may not move it.

Execution is in progress. The owner/implementer fills the acceptance boxes and the version table as the gates run. The ADR/PRD records step in §Conflicts surfaced is a merge precondition, not a suggestion — the authority stack forbids an agent from silently reversing an accepted human-ruled ADR.

### 2026-10-18 — records step complete (scribe)

The merge precondition in §Conflicts surfaced is satisfied. The owner's dated override (2026-10-18, this session) is recorded as **ADR-0024** — `docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md` — status line: "accepted (human-ruled, 2026-10-18 in-session directive) — supersedes ADR-0021 decisions 2 and 4 and ADR-0022 in full; ADR-0021 decision 1 (stock dsh is never displaced) stands and is strengthened".

What the record says:

- The dispatcher UI returns to the `e773ef8` native-dsh posture; the floating window, launcher, and capsule are withdrawn from the default composition.
- ADR-0021 decisions 2 and 4 are superseded; ADR-0022 is superseded in full. ADR-0021 decision 1 stands and is strengthened; decision 3's add/delete permission stands as a retained functional capability; decision 5 stands.
- Scope guard: tickets 101, 108, and 113's functional work and all core/adapter/worker changes are preserved — the override reaches UI chrome only.
- Reversibility: `src/client/index.ts` stays the single client composition point, and the shell machinery stays in the tree as retained, unmounted machinery.

Registry and document edits made in this pass (accepted-ADR bodies untouched; dated notes on Status lines and index rows only):

- `docs/adr/0021-...` and `docs/adr/0022-...` Status lines carry the dated supersession note; `docs/adr/README.md` rows 0021/0022 carry the same note, and a 2026-10-18 prose note was appended. `node tools/adr-index.mjs` regenerated the table (24 rows).
- PRD `PRD-dsh-multitask-dispatcher.md` amended in place at §6.1, §11 item 5, and §15 item 6: the floating-window claim is struck through as historical and replaced by the native-dsh posture citing ADR-0024. Functional sections (wake bus, file inbox, dispatcher behavior) untouched.
- `docs/surfaces.md` corrected: the stale capsule-era inventory is replaced by a withdrawn-surface record and a live/retained-unmounted inventory matching the post-revert posture.

Remaining in this ticket: the execution gates (dsh 0.2.x upgrade and seam re-verification; the selective client revert; test re-basing; `docs/surfaces.md` is already reconciled). The ticket stays in `open/`.

### 2026-10-18 — session-kind indicators rider recorded (scribe)

The owner's 2026-10-18 instruction — add small indication symbols in the default UI, visually separating dispatcher sessions from subagent sessions from normal sessions — is recorded as a dated rider inside **ADR-0024** (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md`, heading "## Rider — 2026-10-18: session-kind indicators (one additive sidebar glyph)"). It narrows ADR-0024 decision 1's "registers nothing into dsh's layout" by exactly one additive registration and leaves decisions 2–4 untouched.

- **Slot:** `sidebar.session.row.leading` — a `list`, root-scoped stock slot, owner payload `{ sessionId }`, 16px leading cell before the session title. Verified against dsh 0.2.1-rc.2 in `.scratch/repo-analysis/2026-10-18-session-indicators.md` (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:123`, runtime `dsh-client-ui-workspace/lib/client.js:5239`, render site `:2306`); `replaceRisk: none`; the only stock occupant is `client-ui-schedule`'s `schedule-mark` at order 10. Scope: a small glyph only — no replacement of stock layout, no floating surface, no removal of stock elements. The dispatcher-vs-peer-dispatcher glyph distinction is TBD; no design is invented.
- **Limit 1 — workers cannot be marked in the list.** Subagent sessions are stamped `origin: 'subagent'` (`dsh-subagent/lib/index.js:354`) and hidden from the stock sidebar (`dsh-client-ui-workspace/lib/client.js:965`), so they are never rows. Only dispatcher-owned sessions can carry the glyph; the "separate subagent sessions" half of the request is a known gap of the requested behavior, not a design choice.
- **Limit 2 — idle-only.** The leading cell renders only for idle, non-archived, non-blank rows; running/pending rows show the stock status dot instead (`dsh-client-ui-workspace/lib/client.js:2306`). The mark appears only on resting sessions.
- **Implementation is pending the client 0.2.1 port** and stays in this ticket's lane; `docs/surfaces.md` lists the glyph as ruled-but-not-implemented. The test pin that asserts the client "renders NOTHING into dsh's layout" is narrowed by exactly this registration when the port lands.

### 2026-10-18 — open questions resolved; ADR bounds recorded; ticket 123 carries the glyph

The six open questions in `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` are closed with host evidence in `.scratch/repo-analysis/2026-10-18-open-questions-resolved.md`. The owner's additional in-session rulings (2026-10-18/19) are recorded in the ADRs; nothing here re-opens them.

**What was recorded**

- **ADR-0025 (mitosis bounds)** — decision 5's "bounds TBD" replaced by §Settled bounds. No self-imposed cap. Host `maxDepth` defaults to 1 (`dsh-subagent/lib/types/index.d.ts:99-104`); `maxActiveSubagents` defaults to 8 per root tree, enforced by a hard reservation (`dsh-subagent/lib/index.js:1046-1052`, pool resolution `:1676`, `rootPool` `:1754-1762`). Dispatcher spawns must pass `maxDepth = parentDepth + 2` so a depth-1 child can still open one hop for its workers. Worker starvation from the shared 8-slot pool is a risk to observe, not to pre-empt. A child dispatcher reaches only its creator.
- **ADR-0026 (chatroom)** — decision 3's "bounds TBD / source material only" replaced by §Settled bound set: 2–8 members; session-id identity with `subagent.label` → title → id as the display fallback; explicit `@name` first else admin-first; `members + 4` rounds capped at 8; 2 messages per member per round; `[PASS]`/`(pass)`; stop on empty round, round limit, 40 total messages, or epoch cancel on any new user message; 15 s slow-member grace that marks the slot `working` and advances while still posting the late reply and notifying only the asker; a 60-line shared log read through each member's own `seen` cursor. The four uncorroborated constants (8, 15 s, 60, 40) are recorded as owner-delegated defaults, not reference-derived truths.
- **ADR-0027 (peer push)** — §Settled identity and dispatch: session id is the only identity; `subagent.label` is the only durable label and is required on continuable children; the roster reads it through `projectionValues`; workers are identified by `origin === 'subagent'` because they now inherit the parent's preset. Dispatcher identity is `agentPreset === 'multitask-dispatcher'` **only if that preset actually exists and is selected on live dispatcher sessions** — recorded as a verification requirement, not a fact.
- **ADR-0028 (RespondToCoordinator)** — §Settled delivery lane: the reply rides the existing `peer` wake lane. It queues during a user-owned turn (`src/core/wake-bus.ts:662-723`) and flushes at turn end (`:825-836`). No new lane, no new wake kind (C15 stands). `requestDispatcherInterrupt` is a no-op on this install, so nothing depends on mid-turn cancel.
- **ADR-0029 (microcompact)** — open question 1 closed: the window comes from `dsh-llm-deepseek/lib/index.js:510-523`, is logged as a durable `request/context` event (`dsh-agent-loop/lib/index.js:1262-1271`), and is read as `session.requestContext()?.contextWindow` with `ctx.tokenMeter.measure(session)` (`dsh-token-meter/lib/index.js:722`) from an `agent/pre-step` listener. `contextPressure.contextWindow` is explicitly not atomic and must not be the trigger denominator. Ratio and keep-count remain ticket-level.

**Two findings that limit scope (recorded, not chosen)**

1. **A worker glyph in `sidebar.session.row.leading` is unreachable.** Subagent sessions are stamped `origin: 'subagent'` and filtered out of the sidebar entirely (`dsh-client-ui-workspace/lib/client.js:964-966`), so they are never rows and the slot never renders for one. The sidebar glyph can therefore only distinguish **dispatcher vs normal**. The worker marker has to live in the **conversation header** instead. That second seat is not licensed by the 2026-10-18 ADR-0024 rider (which licenses exactly one additive sidebar registration), so it is recorded as a scope limit and an owner question in ticket 123 — not slipped in here.
2. **`appendPluginRecord` cannot carry a plugin marker.** Its own declaration restricts callers to production source under `packages/experimental/` and cites the `verify-plugin-record-callers` gate (`dsh-session/lib/types/index.d.ts:95-117`). A third-party plugin is not under `packages/experimental/`, so this path is not licensed. Any durable marker must use a host-owned channel that is open to plugins — `agentPreset`, `subagent.label`, or `origin` — not a plugin record.

Also relevant to the 0.2.1 port: `agentPreset` no longer discriminates our workers (the worker preset row was removed and children inherit the parent's preset), and a spawned worker now inherits host compaction from the deployment preset. Both facts are recorded in the ADRs and change what "worker preset" means in this ticket's re-verification list.

Ticket files 115–125 record the implementation slices and the remaining rulings. Nothing in this comment changes this ticket's own gates.
