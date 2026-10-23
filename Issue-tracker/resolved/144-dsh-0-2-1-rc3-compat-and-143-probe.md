# 144 — dsh 0.2.1-rc.3 released: check our compatibility, and probe it for issue-143 openings

**Status:** resolved
**Labels:** ready-for-agent
**Origin:** owner 2026-10-23: "dsh v0.2.1-rc.3 just released, need to check our code's compatibility, also this build may provide easier access for issue 143."
**Related:** ticket 114 (the 0.2.1-rc.2 port — our verified baseline), ticket 143 (sidebar-glyph research — rc.3 may have changed the visibility/slot surfaces), ticket 140 (the glyph ruling), docs/surfaces.md (the 0.2.1 surface inventory this ticket updates), `read-before-running-live-and-browser-tests.md` (mandatory before any live run).

## Problem

Upstream shipped dsh 0.2.1-rc.3. Our code was verified against 0.2.1-rc.2 only (README says so; docs/surfaces.md and several tickets cite rc.2 file+line). Two jobs: (1) a compatibility pass — does the plugin still install, load, and pass its gates on rc.3; (2) an rc.3 delta read focused on whether upstream added anything that makes the ticket-143 goal easier (a sanctioned way to show a subagent-origin session in the sidebar, a client-readable session-kind signal, a new slot).

## Acceptance

- [x] **Install rc.3** into a THROWAWAY profile (never touch the owner's live profile). Record the exact install commands used under `.scratch/testing/<yyyy-mm-dd>-rc3-compat/` (never committed).
- [x] **Compatibility gates on rc.3, in order, each recorded with output:** `npm install` in our repo against the new tree, `npm run typecheck`, `npm test` (offline — must stay green with zero code changes), then `npm run build` + `npm run build:client`, then plugin install into the throwaway profile, then the mock-LLM e2e (`npm run e2e`) pointed at rc.3. Any failure: diagnose to root cause, file it as its own ticket, and STOP — do not patch code under this ticket.
- [x] **API-surface diff rc.2 -> rc.3** for every package we touch (`dsh-cordis-host-runner`, `dsh-session-projection*`, `dsh-storage-domain`/`dsh-storage-json`, `dsh-settings`, `dsh-subagents`/`dsh-subagent`, `dsh-agent-preset*`, `dsh-client-ui-sidebar`/`dsh-client-ui-session`/`dsh-client-ui-subagent`/`dsh-client-ui-conversation`): what changed that our plugin relies on? File+line citations into the installed rc.3 tree.
- [x] **Ticket-143 openings in rc.3:** read `dsh-client-ui-sidebar` / `dsh-client-ui-session` (`sessionVisible` and the row renderer) and any new slots/APIs in the rc.3 client tree. Answer: did upstream add a sanctioned way to surface a subagent-origin session in the sidebar or expose a session-kind signal to the client? Cite file+line. Post the answer as a comment on ticket 143 (cross-reference only; 143 keeps the verdict).
- [x] **Docs updated:** README status line and docs/surfaces.md version claims move from rc.2 to rc.3 IF AND ONLY IF all gates pass with zero code changes; otherwise they stay on rc.2 and the failure ticket records the delta.
- [x] **Clean up:** the throwaway profile is deleted after the run; nothing new committed to `.scratch/testing/`.

## Constraints

- Compatibility check means ZERO source changes: if rc.3 breaks something, the finding is a ticket, not a patch (the owner decides priorities).
- Never touch the owner's live dsh profile; throwaway profile only. Never export the dsh key. No real-model calls — mock-LLM e2e only (S8 discipline).
- Kill-timer rules apply the moment a live dsh process boots (read-before-running-live-and-browser-tests.md, mandatory).
- Do not resolve or edit ticket 143 beyond a cross-reference comment.

## Comments

### 2026-10-24 — resolved

Resolved by compat pass 2026-10-24 — all gates green on dsh 0.2.1-rc.3 with zero code changes (typecheck 0 errors; 1556/1556 tests; build+client build pass; boot pass; e2e 37/37; lint clean). rc.2→rc.3 delta recorded in `.scratch/testing/2026-10-24-rc3-compat/` (70-DELTA.md): no API breakage, no ticket-143 openings. Docs updated to name rc.3 as verified baseline. Note for owner: rc.3 is dist-tag `next`; `latest` remains rc.2. Mock-LLM only — no visual/browser pass on rc.3.

### 2026-10-24 — compat pass: rc.3 green, zero code changes; no ticket-143 opening

All acceptance gates ran against **dsh 0.2.1-rc.3** (throwaway install root + throwaway `DSH_HOME`; the owner's live profile and global rc.2 install were never touched). Evidence: `.scratch/testing/2026-10-24-rc3-compat/` (`RESULT.md` is the summary; `70-DELTA.md` is the delta read).

**Gates, in order — all PASS.** `npm install` (up to date in 9 s) → `npm run typecheck` (0 errors) → `npm test` (**1556 tests / 368 suites, 1556 pass, 0 fail**) → `npm run build` → `npm run build:client` (`client/index.js` 157,946 bytes) → `dsh plugin --profile compat add file:<repo>` into a throwaway profile (pnpm 11.22.0, composed as bundle `dsh-multitask-dispatcher`, row `multitask-dispatcher` present in `--dump-config`) → profile boot on rc.3 with `/dsh-bot`, `/dispatcher-steer`, `/dispatcher-resolve` registered and `/dsh-bot` returning `kind: success` → `npm run e2e` with `DSH_INSTALL_ROOT` pointed at rc.3: harness PASS, dispatcher `pass`, `s1=s2=s3=s4=pass`, **37/37 assertions**, zero processes alive after cleanup. No failure to diagnose, so no child ticket was filed and nothing under `src/`, `client/`, or `test/` changed.

**API-surface delta rc.2 → rc.3.** One package added (`dsh-client-ui-entry-customization`), none removed; `cordis` stays 4.0.5. Every host package our adapter binds is **lib-byte-identical** to rc.2 (`dsh-cordis-host-runner`, `dsh-session`, `dsh-session-projection`, `dsh-storage-domain`, `dsh-storage-json`, `dsh-settings`, `dsh-subagent`, `dsh-agent-preset`, `dsh-agent-preset-registry`, `dsh-agent`, `dsh-tools`, `dsh-commands`, `dsh-app-boot`, `dsh-plugin-manager`). Client changes are additive: three new `list`/`root`/`replaceRisk: none` slots (`sidebar.panellist.actions`, `conversation.session.header.views.actions`, `sidebar.right.tab.guide.actions`), plus `DraftInitializationOptions.whenDraftExists`, `MessageSubmission.newSession`/`agentPreset`, `PluginManagerFace.openList()`, and a changed return type on `AgentPresetSeatController.select` — none of which we call. `tool.call.toolview` and `plugins.row.config` contracts are byte-identical.

**Ticket-143 answer (cross-referenced on 143; 143 keeps the verdict): no new opening.** `sessionVisible` is unchanged — `dsh-client-ui-workspace/lib/client.js:965` still returns `false` for every `origin: 'subagent'` session (same line, same text as rc.2), and `dsh-client-ui-workspace/README.md:181` still states the sidebar hides them. No new slot renders a session row: all three additions are navigation "More menu" seats with no `sessionId` payload. The only client-readable session-kind signal remains `SessionSummary.origin?: 'subagent'` (`dsh-api-session-controller/lib/types/types.d.ts:170`, `.../client/sessions/service.d.ts:25-26`), which is what rc.2 already had. `ctx.uiWorkspace.openSession(target)` still accepts a durable subagent address (`navigation.d.ts:19`) — an existing programmatic navigation path, not a sidebar row. The licensed `sidebar.session.row.leading` seat is unchanged in kind, scope, and risk (catalog `dsh-cordis-client-runner/lib/client.js:6497`, render site moved `:2306` → `:2307`).

**Docs updated** (all gates green, zero code changes): `README.md:20` now says verified against rc.3; `docs/surfaces.md` status block and the two slot-delta sentences now cite the rc.3 re-verification. `npm run lint:docs` clean (0 findings; issue index 6 rows; ADR index 30 rows). Edits left uncommitted in the working tree.

**Cleanup:** the throwaway profile (`throwaway-home/profiles/compat`) and both throwaway install roots (`rc3-install`, `rc2-baseline`) were deleted after the run; the owner's live profile (`%USERPROFILE%\.dsh`) and global rc.2 install were never written to. `.scratch/testing/2026-10-24-rc3-compat/` stays git-ignored and uncommitted.

**Needs human attention:** (1) rc.3 is the dist-tag `next`; `latest` is still rc.2, so the owner's global install is unaffected — the doc claim now names a pre-release we verified but do not ship against by default. (2) A pre-existing host-side teardown warning (`agent/disposed listener threw: TypeError: ... reading 'catch'`) still appears once per worker teardown; it reproduces on rc.2 evidence and is not ours (`.scratch/repo-analysis/2026-10-18-dsh-0.2.1-forward-compat.md`). (3) No live-model or browser pass was run in this ticket (mock-LLM only, per constraint), so the sidebar glyph has rc.3 type-level and boot-level verification but no visual confirmation on rc.3.

### 2026-10-23 — filing
Filed verbatim on the owner's instruction; the owner asked for a scribe ticket for the next team, so no investigation was done at filing time — every acceptance box is the next team's to run. rc.2 file+line citations across the repo stay valid until this pass proves otherwise.
