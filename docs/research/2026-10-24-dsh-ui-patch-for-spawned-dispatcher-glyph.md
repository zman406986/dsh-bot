# Research: can the dsh 0.2.1 UI be patched so a spawned dispatcher shows the team-leader glyph in the sidebar?

- Question (ticket 143): is there a sanctioned way to make an `origin: 'subagent'` session sidebar-visible in dsh 0.2.1, what can our existing patch surfaces actually change in the CLIENT bundle, and can the client read any durable "this child is a dispatcher" fact? Every claim carries a file+line into the installed tree (`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`, all packages `0.2.1-rc.2`) or a URL.
- Scope: installed dsh tree (MIT, read-only) + public docs/releases. The reference tree was not opened. No dsh boot, no browser, no model call, no key export.
- Date: 2026-10-24. Method: code reading of the installed packages plus the public docs site and the GitHub release feed (`https://api.github.com/repos/deepseek-ai/deepseek-harness/releases`), and the rc.3 tag's own sources via the GitHub contents API.
- Feeds: ticket 140 (seat + identity ruling), ticket 144 (rc.3 probe — one rc.3 fact is noted here because it closes a 143 question, the rest stays 144's).

---

## Question 1 — is there a sanctioned way to make a subagent session sidebar-visible?

**Evidence.**

- The filter is one client-side function with a hard-coded literal: `sessionVisible()` returns `false` for `session.origin === "subagent"` (`dsh-client-ui-workspace/lib/client.js:964-965`).
- It gates every list surface: grouping (`:1037`), the ungrouped/stray list (`:1043`), visible-id sets (`:1134`), the single-row selector (`:1152`), search (`:1185`, `:1200`).
- The only user-facing switch nearby is the archived filter (`archivedFilter: "default" | "show" | "only"`, store init `:1272`, action `:1311`). There is no subagent/visibility option in that store and no other setting read in the workspace client bundle (no `ctx.settings` read anywhere in `dsh-client-ui-workspace/lib/client.js`).
- A repository-wide search of the installed tree for a hide/show-subagent setting (`showSubagent`, `subagentSessions`, `hideSubagent`) returns nothing.
- The slot the glyph is licensed for is rendered only inside a row: `renderSlot("sidebar.session.row.leading", { sessionId: node.id })` at `:2306`, and it is mounted only when `!row.archived && !row.blank` and the row is idle (same line; contract wording at `dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:114-127`).
- Public docs: the Session subsystem page documents `SessionController list` as "Read all visible Session rows" and never mentions subagent filtering or a visibility control; the slots page documents `single`/`keyed` as "replacement points" but no way to add a row; the extension cookbook documents no session-row or visibility API. The client-modules page says only "Distinct active Loader sources resolving to one package name fail composition" (https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots, `.../client-modules`, `.../cookbook/extension-cookbook`, `.../subsystems/session`).
- rc.3 does not change this: at tag `dsh-v0.2.1-rc.3`, `packages/client/ui-workspace/src/client/tree.ts:244` still reads `if (session.origin === 'subagent') return false`, and the row still renders the leading slot (`packages/client/ui-workspace/src/client/rows/Rows.tsx:635`). rc.3's one sidebar addition is a new `sidebar.panellist.actions` list slot for the panel "More" menu (`packages/client/ui-sidebar/src/client/contract/slots.ts:38` at that tag), which is unrelated to session rows.
- No client slot can inject rows: `sidebar.workspaces` is a `single` slot occupied by the shipped `WorkspaceBrowser` (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts` and the runner catalog `dsh-cordis-client-runner/lib/client.js:6459`, `replaceRisk: "shadows-shipped-ui"`). A second entry must use a different priority and then replaces the whole browser.

**Answer.** No. There is no flag, API, slot, or catalog entry that makes a subagent-origin session a sidebar row in 0.2.1-rc.2 or rc.3. Any row requires changing the shipped workspace client module itself.

## Question 2 — what can our patch surfaces change in the CLIENT bundle?

**Evidence.**

- Both patch routes are the same object model: `dsh.bundle.patch` files are read at `dsh-app-boot/lib/index.js:517-531`, layered as bundle patches → profile patch → `~/.dsh/cordis.patch.yml` → `--patch` overlays (`:1127-1136`), and all of them are applied by one function.
- `applyEntryPatches` (`dsh-app-boot/lib/index.js:61-109`) supports exactly three operations: `insert` rows (at the root or into a group by id, `:74-89`), field overrides on an existing entry addressed by `id` (`:104-107`), and — because `disabled` is just an override — disabling an entry. `name` is **not** overridable: it is destructured out of the payload and used only as a mismatch guard (`:73`, `:100-103`). So a patch cannot repoint an existing row at a different module.
- Consequence for client code: a patch cannot wrap, monkey-patch, or edit a client bundle. It can only (a) disable the shipped row and (b) insert a different row.
- A client row's browser module id is its package's own `name` (`dsh-client-modules/lib/index.js:720-750`, `:762-800`: the nearest owning `package.json` supplies the id), and the browser table is keyed by that package name.
- Rows that are `disabled` are skipped by the client module scanner (`dsh-client-modules/lib/index.js:854-857`).
- Two different row sources resolving to the same package name fail composition loudly: `client-modules: package X resolves from multiple active Loader sources … remove one entry` (`dsh-client-modules/lib/index.js:890-896`). Two bundles registering the same module id also fail: `duplicate factory registration` (`dsh-client-modules/lib/client.js:704-708`).
- The shipped row id is `ui-workspace` (`dsh-web-app/cordis.patch.yml:361-362`).

**Answer.** The only client-module replacement mechanism that exists is: patch `- id: ui-workspace, disabled: true`, then insert a row pointing at our own package whose `package.json` still says `"name": "@deepseek-ai/dsh-client-ui-workspace"`, and whose `exports["./client"]` is a vendored copy of the shipped bundle. All ~10 consumers inject that package id (`dsh-client-ui-agent-preset`, `-chat`, `-conversation`, `-directory-picker-*`, `-schedule`, `-sidebar`, `-subagent`, `-workflow-run`, `dsh-experimental-client-ui-agent-team` — each declares it in `dsh.client.inject`), so renaming the package breaks them; keeping the name plus disabling the shipped row is the only combination that composes.

That is a **partial fork of dsh**: `dsh-client-ui-workspace/lib/client.js` is 5,354 lines of compiled browser code, and the fork also needs the host half (`lib/index.js`, a no-op `apply()` today). It is profile-wide — every stock session then renders through our copy. The duplicate-id hazard recorded in `cordis.patch.yml` ("two rows with one id make the settings form vanish") is a different failure mode: here a leftover shipped source fails composition with the explicit multiple-source error, not a silently missing form.

Two mechanics the follow-up ticket will need: a relative `name` in an inserted row is anchored beside the patch file (`dsh-app-boot/lib/index.js:3971`, `anchorInsertedPluginNames`), so a vendored copy can ship inside this repo; and the fork package's `package.json` must carry the shipped package name (`@deepseek-ai/dsh-client-ui-workspace`), because that name is the browser module id every consumer injects.

An equivalent route needs no module patch at all: keep the shipped module and register our own occupant into `sidebar.workspaces` (a `single` slot) at a priority above the shipped `WorkspaceBrowser`. The shipped SlotCore refuses a same-priority second entry — `single slot "X" already has a registration at priority 0 … register at a different priority to shadow it (lowest renders)` (`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`, minified; readable mirrors `dsh-client-ui-renderer/lib/types/client/registry.d.ts:18-32`, `:165-173`, and the catalog's `replaceRisk: "shadows-shipped-ui"` at `dsh-cordis-client-runner/lib/client.js:6459`) — so a shadowing entry must carry a negative priority, as our retired `root` election did (`src/client/shell-mount.ts:165`, `SHELL_ROOT_DYNAMIC_PRIORITY = -1`). It is the same work (a re-implemented session browser) with a milder failure mode (one bad entry abdicates and stock returns) and the same ADR-0024 breach, since it replaces a stock region rather than adding a glyph.

## Question 3 — can the client read a "this child is a dispatcher" fact?

**Evidence (new, and narrower than ticket 140 assumed).**

- The host list does **not** filter subagent sessions. `sessionQuery.listSessions` returns every persisted and live session with no origin test (`dsh-session-query/lib/index.js:95-120`), and the session RPC `list` filters only by session access (`dsh-api-session-controller/lib/index.js:3061-3064`). `listFields` attaches `origin` and `parentSessionId` to every row (`:2127-2133`).
- The client therefore already holds hidden child rows: `SessionListState.byId` carries every summary plus `projectionValues` (`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:26`, `:43`, `:47-53`), and `flattenLineage` nests children under parents rather than dropping them (`.../sessions/lineage.js:11-52`). Stock proves the read: `dsh-client-ui-subagent/lib/client.js:612` reads `state.byId[sessionId]?.origin === "subagent"` for a child session.
- So a hidden child's client-visible facts are: `origin`, `parentId`, `title`, `projectionValues` (host projections such as `subagent.label`, `agentPreset`, and our own `sessionKind` once a projection store exists for that id).
- What the client cannot see is our storage domain: `dispatcher_sessions` lives in `multitask_dispatcher.json` (table name `src/adapter/durable-marker.ts:51`; read/write `:510-521`), and a projection unit is synchronous with no I/O (`src/adapter/session-kind-projection.ts:135-145`; host contract `dsh-session-projection/lib/types/index.d.ts:49-58`).
- Durable child-log facts still do not separate a dispatcher child from a worker child: `origin: "subagent"` and `delegationDepth` are set by `childSessionMeta` for every child (`dsh-subagent/lib/index.js:346-355`), and the descriptor carries `provider` (`"spawn"` for both, `src/adapter/cordis-dsh-host.ts:1898`), `mode: "continuable"`, and a caller-supplied `label`.
- One identity route is cheaper than ticket 140 recorded: the `spawn` provider **does** support independent preset selection (`dsh-subagent-spawn-in-process/lib/index.js:17-24`, `capabilities.agentPreset: true`, `inheritsParentContext: false`; the guard is `dsh-subagent/lib/index.js:3312`). Selecting a preset appends `agent-preset/selected` (`dsh-subagent/lib/index.js:1799`), which is client-visible as `projectionValues.agentPreset`. The cost ticket 140 measured stands (the mount replaces the parent composition), but the capability itself is not the blocker.
- The other durable child fact we fully control is the activation `label` (`SubagentActivationSpec.label`, `dsh-subagent/lib/types/types.d.ts:25-38`; our call passes `opts.title`, `src/adapter/cordis-dsh-host.ts:1899`). Folding a reserved prefix out of it would be content-matching an invented marker — already rejected in ticket 140.
- Code-level blocker on the receiving side: `resolveSessionKind` checks `origin === "subagent"` **first** and returns `"worker"` (`src/client/session-kind.tsx:149`), so even with a row and a `sessionKind` mark, a spawned dispatcher would render nothing under the current dispatcher glyph path.

**Answer.** The client can already read the hidden child's row and projections; it needs no new transport for `origin`, `parentId`, `subagent.label`, or `agentPreset`. What it cannot read is our `dispatcher_sessions` table, and no durable event in a child's own log names its kind. So identity still needs either a preset selection at spawn (client-visible `agentPreset`), a new client-readable channel fed from our storage, or an invented marker.

## Question 4 — precedent: has anyone made a hidden session visible, or marked a non-user session?

**Evidence.** No shipped package and no installed third-party package registers into a session list to add rows; the only rows in the sidebar are produced by `WorkspaceBrowser` from `sessions.list` and `flattenLineage`. The shipped marks for non-user work are elsewhere: the subagent catalog dropdown in a parent's conversation header (`dsh-client-ui-subagent/lib/client.js:983-989`, `id: "subagent-catalog"`, `order: 10`), the right-sidebar subagent chat tabs (`:817-838`), and the schedule plugin's row mark in the same 16px leading cell (`dsh-client-ui-schedule/lib/client.js:7528-7534`, `order: 10`, `id: "schedule-mark"`). The `main` + `sidebar.panellist` pair is the shipped pattern for a plugin-owned panel with a sidebar icon (schedule registers both at `:7473` and `:7484`; plugin-manager does the same at `dsh-client-ui-plugin-manager/lib/client.js:4477`), and both slots are `replaceRisk: "none"`. Public docs describe no precedent for surfacing a hidden session in the list.

**Answer.** No precedent exists for making a hidden session a row. The precedent for "show non-user work" is a different surface: a header chip, a right-sidebar tab, or a plugin-owned panel.

---

## Verdict

**NEEDS-RULING.** A concrete path to the literal ask exists, and it breaches ADR-0024 as written. It is a partial fork: disable the shipped `ui-workspace` row in the profile patch and insert our own package under the same package name, carrying a vendored copy of the 5,354-line shipped workspace client bundle with `sessionVisible` relaxed for our marked children. Every other path either cannot produce a row (no flag, no API, no row-injecting slot — verified in rc.2 and rc.3) or lands on a different seat (ticket 140 Route D, or a new `main` + `sidebar.panellist` panel, both of which need their own ruling and their own identity channel).

Three sentences must change for the fork path to be licenced:

1. ADR-0024 decision 1: "The client module registers nothing into dsh's layout … stock dsh is the primary UI, and nothing can displace it." A vendored replacement of the shipped sidebar module is a displacement of stock UI code, not a registration beside it.
2. Rider item 1: "Exactly one additional additive registration is permitted, and it is this one … no other slot is licensed by this rider." The fork changes no slot registration; it changes the module that owns the slot.
3. Rider item 1, second sentence: "Dispatcher identity already reaches the client through the existing roster mirror (`roster.<sessionId>`), so no new host channel is licensed either." That premise is dead (`src/adapter/roster-channel.ts:1-9`); the replacement sentence must name the channel that is allowed (projection key, preset, or a storage-backed read).

A ruling for the literal ask must also accept the two costs the mechanism carries: the fork drifts on every dsh upgrade (it replaces a compiled package, not an API), and it changes the sidebar for every stock session, not just ours. And even with a row, the glyph shows only on idle rows (ADR-0024 rider's recorded limit; `dsh-client-ui-workspace/lib/client.js:2306`), and `resolveSessionKind`'s origin-first order (`src/client/session-kind.tsx:149`) must change or a spawned dispatcher resolves `"worker"` and renders nothing.

If the owner wants "sanctioned methods only", the answer for the sidebar row is **NOT-POSSIBLE** on 0.2.1-rc.2/rc.3, and the decision collapses to ticket 140's existing options: the child's own header chip, a new panel, or defer.

## What ticket 140's human ruling must still decide

1. **Fork or not.** Accept a vendored replacement of `@deepseek-ai/dsh-client-ui-workspace` (visible sidebar row, high upgrade cost, profile-wide), or keep stock UI and use another seat.
2. **If not fork: which seat.** The child's `conversation.session.header.actions` chip (140 Route D; a `list` slot, `replaceRisk: none` — catalog `dsh-cordis-client-runner/lib/client.js:3861`; four shipped occupants: `agent-team` at `-20` (`dsh-experimental-client-ui-agent-team/lib/client.js:491-497`), `agent-preset` at `-10` (`dsh-client-ui-agent-preset/lib/client.js:2408-2413`), `subagent-catalog` at `10` (`dsh-client-ui-subagent/lib/client.js:983-989`), `job-list` at `20` (`dsh-client-ui-jobs/lib/client.js:627-635`)), or a plugin-owned `main` panel plus `sidebar.panellist` icon (the shipped pattern: `dsh-client-ui-schedule/lib/client.js:7473-7492`, `dsh-client-ui-plugin-manager/lib/client.js:4477`; both slots `replaceRisk: none`).
3. **Identity channel, whichever seat.** Name exactly one: (a) select an independent preset at spawn so `agentPreset` becomes the durable, client-visible mark — the `spawn` provider supports it (`dsh-subagent-spawn-in-process/lib/index.js:17-24`), at the composition cost ticket 140 measured; (b) licence one new client-readable channel fed from `dispatcher_sessions`; or (c) accept an invented label marker (already rejected once).
4. **The dead-premise sentence.** Rewrite rider item 1's "Dispatcher identity already reaches the client through the existing roster mirror … no new host channel is licensed either" so the ruling names the channel that is permitted now.
5. **Resolver order.** Say whether `resolveSessionKind`'s origin-first rule may be relaxed for a marked dispatcher child; the ruling must be explicit because ticket 140 pins that order today.
6. **Idle-only limit.** Record that any sidebar-seat glyph still appears only on resting rows.
