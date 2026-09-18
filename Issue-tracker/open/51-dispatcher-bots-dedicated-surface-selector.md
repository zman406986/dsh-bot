# 51 — A dedicated dispatcher surface: select and talk to dispatcher bots without hijacking the conversation box

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none for research/seam-verification (start immediately). Its implementation depends on ticket 50's D1/D4 (what "mode" is, and whether the front desk speaks here or in the primary chat), and on ADR-0016 being signed off.
**Related:** 35 (capsule epic — the dispatcher's *existing* surface, which this ticket extends or supersedes the exclusivity of), 38–42 (capsule implementation), ADR-0013 (capsule = one additive `shell.overlay` entry, "not a sidebar takeover or a keyed claim" — **directly probed by this ticket**), 16 (seam inventory), 36 (`dsh-capsule-seams.md` — the verified seam verdicts to build on), 49 (theme tokens rule for any new surface), 27/28/31/32 (panel + stop semantics the new surface must stay consistent with), 50 (the routing model this surface carries), 33 (live browser pass lane)

## What the human asked for (verbatim intent, 2026-09-18)

> needs a proper UI, sidebar or floating window or box/bar or something as to select and talk to dispatcher bots, not hijacking existing conversation box. this dedicated box is only meant for dispatcher bots, all subagents are summoned in normal sessions, user can override and talk directly to then via normal dsh sessions if needed. UI can look to reference as example.

## What exists today, and what the ask adds

| Surface | Today | Ask |
|---|---|---|
| Dispatcher presence/control | The capsule (tickets 38–42): a collapsed chip expanding into a panel with the activation row, the three roster sections, the deliverables line, and the footer — one `shell.overlay` list entry, `src/client/capsule.tsx` | Keep, extend, or sit beside — see D5. |
| Dispatcher **conversation** | The dispatcher speaks in the *activated primary chat* (ADR-0009: "Delivery remains conversational (the dispatcher speaks in the activated chat)"). There is no dedicated dispatcher channel. | A dedicated surface where the user picks a dispatcher bot and talks to it. |
| Selecting a dispatcher | No such concept exists — one dispatcher, session-scoped. | A selectable list of dispatcher bots. |
| Subagent conversations | Ordinary dsh sessions. | Unchanged, and *deliberately* unchanged: subagents stay in normal sessions and the user can talk to them directly there ("user can override"). |
| Existing conversation box | The shipped `main` keyed panel `"conversation"` (ui-conversation `lib/client.js:16823–16831`). | Must **not** be repurposed or wrapped. |

## Why this is a decision, not a widget — ADR conflicts, surfaced

1. **ADR-0009 option D was already rejected for v1:** "Dedicated UI page / headless daemon agent | Rejected for v1: no verified non-conversational delivery path; breaks the PRD rule that `completed` means **delivered to user**." This ticket **reopens that rejection**. Note the precision: a dedicated surface is *not* a non-conversational delivery path — the dispatcher still speaks to the user in words (PRD S5 preserved). What ADR-0009's option D actually lacked was a verified path for the dispatcher to *live* somewhere other than the activated chat. Verify that path before designing.
2. **ADR-0013 (draft, non-human-approved) chose "one additive `shell.overlay` entry — not a sidebar takeover or a keyed claim."** The ask names "sidebar or floating window or box/bar" — i.e. it asks for exactly the slot *classes* ADR-0013 declined. ADR-0013 is a draft, so a human decision may amend it, but the amendment must be written down (see the ADR requirement below), not assumed.
3. **design-17 §6 lists `main` among the surfaces that are "Never registered (unchanged)":** "root, main, sidebar.right.pane.tab, conversation.approval.detail, any shipped node-type key." A dedicated dispatcher page is a `main` keyed registration, and a right-panel tab is `sidebar.right.pane.tab`. Either the design finds another slot, or this rule is amended explicitly.
4. **design-17 §13 non-goals** include "Agent-identity surfaces: saved-agent roster, org chart, agent info panes, routines, memory (Phase-2-peer territory)". "Select and talk to dispatcher bots" is an agent-identity surface. Reopening it is fine; doing so silently is not.
5. **The reference has exactly this shape** — its left rail is the agent roster and the main surface is the selected agent's chat (`docs/research/always-on-dispatcher-behavior.md:17,72`). That is the "look to reference as example" the human meant. The behaviour is already recorded abstractly and contamination-free in that note. **Cite the note; do not open the tree.**

## Seams to verify before designing (do your own research — the list below is a map, not an authority)

`dsh-capsule-seams.md` and `dsh-plugin-ui-patterns.md` give verified verdicts for the capsule's five seams. This ticket needs a fresh pass over the seams a *conversational* surface would need, against the installed dsh 0.1.5-rc.1, with file:line citations in a new `docs/research/` note:

- **`main` (keyed)** — register a non-shipped key. The open API is verified: `ctx.layout.selectPanel(panelId)`, "Select a global panel or return to the Conversation", throws on unregistered keys (ui-layout `lib/client.js:399–412`; answered in `dsh-capsule-seams.md` Seam 4). **Verify: does a plugin-registered `main` key actually mount, render, and survive switching — and does the layout controller retain it?** (The layout controller's subscription/retention behaviour is recorded but not exercised for a non-shipped key.)
- **Reading a session's transcript client-side** — **the load-bearing unverified seam.** A plugin panel that shows a conversation needs to render message history for an addressed session. Our notes verify only `ctx.conversation.input.for(actx)` (input facade, prefill) and `ctx.conversation.send(text)` ("Send a prompt into the caller scope's session"), plus `ctx.sessions.list` / `ctx.sessions.scope(id)`. Whether transcript content is reachable from a client plugin is **not established**. If it is not, the design must degrade honestly (e.g. the surface routes/sends and links to the host's own session view) rather than fake a transcript.
- **Creating/addressing sessions** — can a client plugin open or target a session for a dispatcher bot, or does it only address the current one? (`ctx.sessions` contract: `list.current`, `scope(id)`.)
- **`sidebar.panellist` (list)** — additive left-rail entries; the natural home for a bot selector if the left rail is the chosen host.
- **`shell.overlay` (list)** — the floating box/bar option. Already used by the capsule: decide whether the new surface is a **second entry** (ordering, coexistence, and two things floating over the app) or the capsule grows into it.
- **`sidebar.right.pane.tab` + `.tab.title` (keyed, unclaimed key `dispatcher`)** — recorded as "ours by default" in the seam inventory, but design-17 §6 forbids it. A human decision can lift the ban; record it.
- **`conversation.input.dock` / `.left` / `.right` (list)** and **`conversation.session.header.actions` (list)** — affordance-only hosts, useful if the answer is a bar rather than a panel. The dock's submit wiring was left unverified when ticket 22 deferred it (design-17 §4.4) — re-verify or keep it out.

**Hard limits, restated so the design does not spec against fantasy** (`dsh-plugin-ui-patterns.md` Finding 5 + hard limits): no new chat node types (the keyed domain is closed); no notifications/toast seam; `root` must not be registered; boot-once seats throw on second claim; console output is not a seam; the plugin-side send journal does not exist and must not be rebuilt (`docs/surfaces.md`).

## Requirements

**R1 — A dedicated surface.** The dispatcher bots get their own place to be selected and talked to. The shipped conversation box is neither repurposed nor visually wrapped: the user's ordinary sessions keep behaving exactly as stock dsh.

**R2 — Selection.** The user can see *which* dispatcher bots exist and address one, without typing an id and without slash commands (pairs with ticket 50 R3).

**R3 — Subagents stay in normal sessions.** Nothing in this surface may present a worker/subagent as a chattable identity (`docs/surfaces.md` "No worker console": rows are not chats, there is no drill-down into a worker's chat). The escape hatch the human named — "user can override and talk directly to them via normal dsh sessions" — is the *only* way to talk to a subagent, and it stays in the host's own UI.

**R4 — Honesty.** Every element renders from real state. No invented peer/bot rows, no placeholder transcripts, no fake unread counts, and no surface that implies push (there is still no notification seam — `docs/surfaces.md` "No push notifications"). When the underlying feed is stale or missing, the surface says so and offers nothing actionable.

**R5 — Copy and locale.** All text through the `multitask-dispatcher` locale namespace, `{en, zh}`, identical key sets (the shipped validator). New copy only.

**R6 — Theme.** Colours come from the host `--dsw-*` token layer, never a private palette; `test/client-theme-tokens.test.ts` is the precedent, and any new surface needs the same kind of pin (ticket 49).

**R7 — Offline-testable structure.** View models and state machines pure and unit-tested without network/LLM/running dsh (S8); the browser assertion belongs to ticket 33's lane.

## Open decisions the implementer must raise, not guess

| # | Decision | Why it cannot be assumed |
|---|---|---|
| D1 | **Which slot** — `main` page, `sidebar.panellist` rail entry, `shell.overlay` box/bar, or a right-panel tab. | Four viable hosts with different kinds (keyed vs list) and different conflict rules; two of them are currently named off-limits by design-17 §6, and ADR-0013 declined all four classes by name. Decide from the seam verification, then write the amendment. |
| D2 | **What "talk to a dispatcher bot" means mechanically** — send into a session and render its transcript, or route-only with the host rendering the conversation. | Hinges on the unverified transcript-read seam. Do not design a fake transcript; a degraded design that is honest beats a clone that is a lie. |
| D3 | **One dispatcher bot or several.** | Ties to ticket 50 D2. The ask says "bots" (plural) and "select"; only one bound parent agent exists per process today (ADR-0009 option C). Decide the identity model before the selector UI. |
| D4 | **Relationship to the capsule.** Does the new surface replace the capsule, sit beside it, or grow out of it? | ADR-0013 built the capsule as the dispatcher's *one* additive entry; two floating surfaces is a different coexce consequence and needs its own answer. |
| D5 | **Does the surface own activation, or reflect it?** | ADR-0009 forbade inventing a second activation channel. If ticket 50 removes the command, this surface may become the honest home of the mode indicator — but then the "no second channel" rule must be restated, not quietly broken. |

## Acceptance criteria

- [ ] (offline, gate) A new `docs/research/` note records a verified/degraded verdict with file:line evidence for every seam in the list above, including the transcript-read seam — corrected against the installed bundle, and correcting our own notes where they are wrong (the ticket-49/Ticket-46 lesson: a seam name in `docs/research/` is worth nothing until the implementation is asserted against it).
- [ ] (offline, gate) A design note exists (design-09…design-17 family) answering D1–D5 with evidence, plus an explicit statement of what the chosen slot does *not* allow.
- [ ] (offline, gate) Any new ADR required by the slot choice is filed `-draft-nonhuman-approved` with an `**Approval:**` header, amending ADR-0013 (and design-17 §6 if a forbidden slot is claimed) rather than contradicting it silently.
- [ ] (offline, gate) The new surface's view models are unit-tested: selection list, empty/unavailable states, and a structural no-fake-identity pin; locale key parity validator green.
- [ ] (offline, gate) The shipped conversation box is untouched: no registration into `root`, no shipped node-type key claimed, no `main` key shadowing `"conversation"`; existing client-surface tests stay green; `npm test` 0 fail and `npm run typecheck` clean (both configs).
- [ ] (live, ticket 33's lane, trivial prompts, zero/near-zero LLM) On a real launcher boot: the surface mounts without crashing the shell (the overlay error boundary *abdicates* a crashing list entry — a silent disappearance, so assert presence, not absence of errors), the user can select a dispatcher bot, and a trivial message reaches it.
- [ ] (live) Legible in **both** light and dark schemes (the ticket-49 rule).

## Notes

- **Clean-room, strictly.** The reference tree (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) is behaviour evidence only — never opened in the same session as product code, never copied from (ticket 17 Phase-1 rule, ticket 35 process req 5). The three third-party reference plugin repos are pattern-only, mixed-licence, no vendoring or name-matching. The safe way to satisfy "UI can look to reference as example" is `docs/research/always-on-dispatcher-behavior.md` and the seam notes.
- **"Not hijacking existing conversation box" is the design's spine, not a caveat.** It is also what makes ticket 50's default-on front desk acceptable: the user's own chats are never repurposed, so consent is preserved even though the per-session command is gone. Say this in the design.
- **Co-dependencies for the live half:** 45 (no activated turn completes live today), 44, 46, 47.

## Comments

### 2026-09-18 — scribe pass (filed, not implemented)

Filed from the human's directive of the same date. Judgement calls, recorded so the implementing team need not re-derive them:

1. **Kept separate from ticket 50.** The two share one product model and cross-reference each other, but 51's blockers are UI-seam and slot-choice questions while 50's are activation/topology questions. Splitting keeps each ticket independently verifiable offline — the same reasoning ticket 35 used to chunk the capsule.
2. **The strongest finding is the unverified transcript-read seam**, not the slot choice. Anything can float in `shell.overlay` or take a `sidebar.panellist` row; *rendering another session's conversation* is the part our research has never established. That is why R2/D2 are written to allow an honest degraded design rather than assuming a full clone.
3. **Nothing in the tracker was edited by this pass.** ADR-0013, design-17 §6, and the design-17 §13 non-goals are contradicted on paper only; amending them is the implementing team's job, with the amendment written down.

### 2026-09-18 (later) — PREMISE RETRACTED by the human

This ticket shares ticket 50's fabricated "verbatim directive" (see 50's retraction comment): the human never said it. **Do not implement.** Superseded pending ADR-0018 (imitate-reference-in-entirety + human-trimmed exception list).
