# Research: can the sidebar show a dispatcher's identity icon AND a live status dot at the same time?

- Question: in the stock dsh sidebar session list, our dispatcher glyph appears to REPLACE the running-work status dot instead of sitting beside it. Is that a defect, what decides it, and can both be visible at once without patching the product?
- Scope: the installed product tree (`C:\Users\TZ\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`, plain readable JavaScript) plus this repo's client module. Read-only against the product; no boot, no server touch, no browser.
- Date: 2026-11-06. Method: code reading with file:line citations, plus one web search for prior art.
- Precedents read first: `docs/research/2026-10-24-dsh-ui-patch-for-spawned-dispatcher-glyph.md` (the earlier glyph question), ADR-0024 and its 2026-10-18 rider, ADR-0031.

---

## 1. The rule: the leading cell is a hard either/or, not a bug

The row's leading 16px cell is one ternary in the shipped row component:

- `dsh-client-ui-workspace/lib/client.js:2606-2609` — the cell is a `<span class="...slot">` whose children are `!row.archived && !row.blank && (showStatus ? <SessionStatusDots .../> : renderSlot("sidebar.session.row.leading", { sessionId: node.id }))`.
- `dsh-client-ui-workspace/lib/client.js:2534` — `const showStatus = primaryStatus.state !== "idle";`.
- `dsh-client-ui-workspace/lib/client.js:2327-2376` — `sessionStatuses()` derives the primary state: pending interaction (warning) > own run (`ongoing`) > running subagents (`ongoing`) > unviewed completion (`done`) > `idle`. Idle is the only state that leaves the cell to the slot.
- The contract states the same rule as a promise to occupants: "A higher-priority state (a pending interaction, a new message, live activity) replaces the seat with that dot for the same row, so an occupant here never renders beside a status dot and is mounted only by a row whose primary state is idle." (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:133-147`.)
- The shipped README repeats it in prose: "It is an occupant of the row's `sidebar.session.row.leading` seat, so it renders only on a row whose primary status is idle and never beside the row's own status dot" (`dsh-client-ui-workspace/README.md:78`; zh mirror `README.zh.md:78`).
- The machine-readable slot catalog says the same (`dsh-cordis-client-runner/lib/client.js:6996-7042`, `replaceRisk: "none"`, occupants `client-ui-schedule SessionScheduleMark id 'schedule-mark'` and `experimental-liveshare ViewerForkMarker id 'liveshare.fork'`).

**Answer: icon-only, dot-only, or both is decided entirely by the product.** There is one cell and the product picks a branch. Both at once is impossible inside `sidebar.session.row.leading` — our occupant is not merely hidden, it is never mounted while the row is not idle. This is the limit ADR-0024's rider already recorded: "**The mark renders only on resting sessions.** … A running or pending row shows stock's own status dot in that cell instead (`dsh-client-ui-workspace/lib/client.js:2306`). The mark therefore appears only when a session is idle; it is not a running indicator." (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:72`).

Two consequences worth stating plainly:

- The glyph vanishes for the whole time a dispatcher is working, which is exactly when a user looks for it — the reported symptom is real, but it is the documented behaviour of the seat we were licensed to use.
- The worker half is unaffected: worker sessions are not sidebar rows at all (`dsh-client-ui-workspace/lib/client.js:964-965`), so no seat can mark them.

## 2. Is there a slot, render prop, or hook that draws the dot beside the icon?

No hook and no prop. The row component receives `renderSlot` and calls it for three child seats (`.../rows/Rows.d.ts:123`; declaration `dsh-client-ui-workspace/lib/client.js:6050-6073`):

| Seat | Declared | Rendered at | Status-gated? |
|---|---|---|---|
| `sidebar.session.row.leading` | `client.js:6059-6063` | `client.js:2608` | **Yes** — replaced by the dot when not idle |
| `sidebar.session.row.trailing` | `client.js:6064-6068` | `client.js:2634` | **No** — inside `!row.blank && span.rowResting` |
| `sidebar.session.row.hover` | `client.js:6069-6072` | `client.js:2417` | Only while the hover card is open |

`sidebar.session.row.trailing` is therefore the **only** per-row seat that renders simultaneously with the leading status dot. Its contract (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:148-161`; catalog `dsh-cordis-client-runner/lib/client.js:7045-7091`, `replaceRisk: "none"`): "Non-interactive icons after the row's time label, before its pin marker, in ascending `order`. On hover-capable devices, hidden while the row is hovered … Occupants address their own data by Session id."

It is a real, occupied, additive seat: `dsh-experimental-client-ui-forge/lib/client.js:11745-11751` registers `forge-panel.row` there at order 10, from a component that reads `{ sessionId, useSessions }` (`dsh-experimental-client-ui-forge/lib/types/client/SessionRowForge.d.ts:37`). `useSessions` and `useSessionStatus` are global standard props on both row seats (`dsh-cordis-client-runner/lib/client.js:7023-7034` for leading, `:7072-7083` for trailing), so our existing glyph component would work unchanged in the trailing cell.

Three costs of the trailing seat, all verifiable in the shipped stylesheet:

1. **Not adjacent to the dot.** It renders after the title and the time label (`client.js:2626-2637`), at the row's trailing end — "both visible", not literally "side by side". There is no seat between the dot and the title.
2. **Hidden on hover.** `@media (hover:hover){.YDXeBa_sessionRow:hover .YDXeBa_rowResting{display:none}}` (the Rows stylesheet string, `dsh-client-ui-workspace/lib/client.js:1955`); on hoverless devices the icons stay, but the timestamp is dropped instead.
3. **No archived gate.** The trailing cell renders for `!row.blank` only (`client.js:2626`), so unlike the leading cell an archived dispatcher row would show the identity icon. Our occupant cannot currently suppress that: `SessionSummary` carries `id/title/displayTitle/cwd/parentId/origin/formatStatus/running/retainedBy/blank/updatedAt/projectionValues` and **no** `archived`, `completed`, `pendingInteraction` or `runningSubagentCount` (`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:17-48`) — those live on the browser's derived tree node (`dsh-client-ui-workspace/lib/client.js:1059-1075`), which occupants never see.

Because of that last gap, an occupant cannot re-derive the product's own "is the leading cell free?" test without duplicating shipped status logic — which is exactly the kind of divergence this repo avoids.

## 3. Does the product already have a fix — a setting, flag, or plugin?

No.

- The workspace client bundle reads no settings service at all: `Select-String "ctx.settings|settingsScope|useSettings"` over `dsh-client-ui-workspace/lib/client.js` returns **0** matches, so no toggle can reach this row.
- The only nearby user switch is the archived filter (`archivedFilter: "default" | "show" | "only"`, store init `client.js:1272`, action `:1311`) — unrelated.
- The slot catalog lists the seats and their occupants (`dsh-cordis-client-runner/lib/client.js:6996-7091`); nothing occupies a row seat to draw a duplicate status dot, and no shipped package draws a second dot.
- No installed third-party package in the tree registers into `sidebar.session.row.trailing` except `dsh-experimental-client-ui-forge` (`client.js:11745`), which draws change-request badges, not session status.

## 4. Prior art (web)

- The shipped row-seat contract and README quoted above are mirrored publicly: [ui-workspace README](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-workspace/README.md).
- A third-party plugin doing the same class of UI surgery on agent-team member rows (replacing static/running/failed status icons with a portrait) — the opposite direction from our ask, but the same seat family: [SpookyWaste/dsh-ohjingjing-team](https://github.com/SpookyWaste/dsh-ohjingjing-team).
- A plugin that owns DSH Sessions in its own sidebar projection rather than decorating stock rows: [PersonaBot sidebar ADR](https://github.com/botharness/deepseekbot/blob/16b11b3f4d4adb1c0bacc78a5daf432b9b0b6c83/docs/adr/0072-personabot-sidebar-projects-owned-dsh-sessions.md).
- Plugin-index listings for UI-enhancement plugins: [dsh-grok-buddy](https://awesome-dsh-plugin.com/p/devzer0o0/dsh-grok-buddy/), [dsh-session-control](https://www.npmjs.com/package/@goodandready/dsh-session-control).
- No source found that documents a supported way to make a row's own status dot and a plugin mark render in the same cell.

## 5. What a fix would look like — and why it was NOT applied

Both candidate changes are mechanically small but neither is a licensed seat today:

**Option A — move the one registration from `leading` to `trailing`.**
Keep one entry, change its `name`. Result: exactly one icon per row at all times, and when the row runs the dot appears at the leading edge while the icon stays at the trailing edge — both visible. Costs: the icon relocates for every dispatcher row (a change the requester did not ask for), it disappears while the row is hovered, and it starts appearing on archived rows.

**Option B — keep `leading`, add a second entry in `trailing`.**
Keeps the icon where it is (left edge, idle) and adds it at the trailing edge when the row is busy — but the trailing copy cannot be gated to "only when the dot occupies the leading cell" without re-implementing the product's status rule, so it would either double the icon on idle rows or mis-time it on pending/completed rows.

**The blocking decision is not an implementer's.** ADR-0024's rider rules: "**Exactly one additional additive registration is permitted, and it is this one.** The client module may register `sidebar.session.row.leading` … no other slot is licensed by this rider." (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:65`), and the idle-only limit is a recorded known limit (`:72`). Option A moves the licensed seat; Option B spends a second registration. Either needs the rider amended first, and the two files that would record that (`README.md`, the ADR) are outside this pass's write scope.

### Exact change if Option A is ruled

1. `src/client/session-kind.tsx:88` — repoint `SIDEBAR_LEADING_SLOT` at `sidebar.session.row.trailing` (rename the constant in the same edit), and correct the doc comments at `:84-97`, `:35-39` and the module header `:8-39` that assert the idle-only leading cell.
2. `src/client/session-kind.tsx:412-419` — unchanged shape; `order` still sorts against the forged row mark (10).
3. `src/client/index.ts:299-313` — the inject call reads `dispatcherGlyphRegistration().name`, so it follows automatically; its comment block must be corrected.
4. `test/client-session-kind.test.ts:222-234` — the registration pin asserts `name === SIDEBAR_LEADING_SLOT` and `order > 10`; it must be retargeted, plus a new pin that the trailing seat is not status-gated.
5. Copy is already in both locale faces (`src/client/overlay.ts:320-322`, `:492-494`) — `overlay.ts` is untouched, no new keys needed.

### Exact change if Option B is ruled

As above, but keep `leading` and add a second inject with a distinct id (for example `multitask-dispatcher-kind-trailing`) and a gate the rider names explicitly; the gate must be specified by the ruling, because the honest gates available to an occupant are only `SessionSummary.running` (`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:30`) — which misses pending-interaction and unviewed-completion rows.

## What remains unproven

- No live render was observed: the change was not applied, so nothing was verified against `http://127.0.0.1:3080`. The claims above are static reads of the shipped bundles plus the repo's own tests.
- The trailing seat's behaviour on an archived row is inferred from the render guard (`client.js:2626`, no archived test) and from the absence of any archived field in `SessionSummary`; it was not exercised.
- Whether the sidebar's hover CSS (`client.js:1955`) hides the trailing cell in every hover modality (for example an open row menu with no pointer over the row) was read, not tested.
