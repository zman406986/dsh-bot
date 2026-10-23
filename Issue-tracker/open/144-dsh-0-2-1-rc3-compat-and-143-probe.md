# 144 — dsh 0.2.1-rc.3 released: check our compatibility, and probe it for issue-143 openings

**Status:** open
**Labels:** ready-for-agent
**Origin:** owner 2026-10-23: "dsh v0.2.1-rc.3 just released, need to check our code's compatibility, also this build may provide easier access for issue 143."
**Related:** ticket 114 (the 0.2.1-rc.2 port — our verified baseline), ticket 143 (sidebar-glyph research — rc.3 may have changed the visibility/slot surfaces), ticket 140 (the glyph ruling), docs/surfaces.md (the 0.2.1 surface inventory this ticket updates), `read-before-running-live-and-browser-tests.md` (mandatory before any live run).

## Problem

Upstream shipped dsh 0.2.1-rc.3. Our code was verified against 0.2.1-rc.2 only (README says so; docs/surfaces.md and several tickets cite rc.2 file+line). Two jobs: (1) a compatibility pass — does the plugin still install, load, and pass its gates on rc.3; (2) an rc.3 delta read focused on whether upstream added anything that makes the ticket-143 goal easier (a sanctioned way to show a subagent-origin session in the sidebar, a client-readable session-kind signal, a new slot).

## Acceptance

- [ ] **Install rc.3** into a THROWAWAY profile (never touch the owner's live profile). Record the exact install commands used under `.scratch/testing/<yyyy-mm-dd>-rc3-compat/` (never committed).
- [ ] **Compatibility gates on rc.3, in order, each recorded with output:** `npm install` in our repo against the new tree, `npm run typecheck`, `npm test` (offline — must stay green with zero code changes), then `npm run build` + `npm run build:client`, then plugin install into the throwaway profile, then the mock-LLM e2e (`npm run e2e`) pointed at rc.3. Any failure: diagnose to root cause, file it as its own ticket, and STOP — do not patch code under this ticket.
- [ ] **API-surface diff rc.2 -> rc.3** for every package we touch (`dsh-cordis-host-runner`, `dsh-session-projection*`, `dsh-storage-domain`/`dsh-storage-json`, `dsh-settings`, `dsh-subagents`/`dsh-subagent`, `dsh-agent-preset*`, `dsh-client-ui-sidebar`/`dsh-client-ui-session`/`dsh-client-ui-subagent`/`dsh-client-ui-conversation`): what changed that our plugin relies on? File+line citations into the installed rc.3 tree.
- [ ] **Ticket-143 openings in rc.3:** read `dsh-client-ui-sidebar` / `dsh-client-ui-session` (`sessionVisible` and the row renderer) and any new slots/APIs in the rc.3 client tree. Answer: did upstream add a sanctioned way to surface a subagent-origin session in the sidebar or expose a session-kind signal to the client? Cite file+line. Post the answer as a comment on ticket 143 (cross-reference only; 143 keeps the verdict).
- [ ] **Docs updated:** README status line and docs/surfaces.md version claims move from rc.2 to rc.3 IF AND ONLY IF all gates pass with zero code changes; otherwise they stay on rc.2 and the failure ticket records the delta.
- [ ] **Clean up:** the throwaway profile is deleted after the run; nothing new committed to `.scratch/testing/`.

## Constraints

- Compatibility check means ZERO source changes: if rc.3 breaks something, the finding is a ticket, not a patch (the owner decides priorities).
- Never touch the owner's live dsh profile; throwaway profile only. Never export the dsh key. No real-model calls — mock-LLM e2e only (S8 discipline).
- Kill-timer rules apply the moment a live dsh process boots (read-before-running-live-and-browser-tests.md, mandatory).
- Do not resolve or edit ticket 143 beyond a cross-reference comment.

## Comments

### 2026-10-23 — filing
Filed verbatim on the owner's instruction; the owner asked for a scribe ticket for the next team, so no investigation was done at filing time — every acceptance box is the next team's to run. rc.2 file+line citations across the repo stay valid until this pass proves otherwise.
