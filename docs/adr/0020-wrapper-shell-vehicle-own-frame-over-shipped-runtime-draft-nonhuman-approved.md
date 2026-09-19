# The wrapper vehicle: our own frame over the shipped dsh client runtime

**Status:** draft (non-human-approved) — agent-drafted for ticket 67, pending human sign-off, per the ADR-0013–0016 filing convention.

**Supersedes wherever conflicting:** ADR-0013's remaining UI-vehicle content (capsule as *the* plugin surface — already superseded by ADR-0018; this ADR records what replaces it). **Amends nothing else.** Operates under ADR-0018's master rule ("we build the whole UI") and its exhaustive exception list.

**Evidence:** `docs/research/wrapper-vehicle-seams.md` (2026-09-19, file:line, installed 0.1.5-rc.1), `dsh-plugin-ui-patterns.md`, `dsh-capsule-seams.md`, ticket 29's firehose verification.

## Decision

The wrapper is **our own client module that registers our own application frame over the shipped dsh web runtime** — a whole-UI shell (sidebar, main surface, panels) composed from React components we own, bound to the shipped client services (`ctx.sessions`, `ctx.conversation`, the forwarded Remote Event stream, `ctx.settingsScope`, locale, theme tokens).

Two properties make this the vehicle rather than just an option:

1. **Every surface is ours** (ADR-0018): the frame, the dispatcher roster, the composer, the approval cards, the running-tasks panel are our components. dsh keeps what ADR-0018's exceptions assign to it: the session/job store (A5), the transport and inference behind the conversation, the send path (A4 — sends are direct through the host's sink; we build no send journal).
2. **It fails safe.** A `root`-slot entry registered at runtime is lower-priority than the shipped frame and wins only while live (`dsh-client-ui-renderer` registry.d.ts:24-27, 156-164; `wrapper-vehicle-seams.md` Finding 5). If our frame crashes, it abdicates and **the stock dsh app takes the cell back** — the degradation mode of "the whole UI is ours" is the ordinary product, never a blank window.

The `root` slot's "DO NOT register here" note is dsh's coexistence etiquette for add-on plugins. ADR-0018 ends that posture: the wrapper *is* the product shell, so taking the frame is a deliberate, recorded election — with the fallback above as the safety argument, and plugin-disable as the reversal path.

**Staging:** the frame election flips in the last staging slice. The shell is built and surfaced first as a `main` keyed page (key ours by default; opened via the verified `ctx.layout.selectPanel`, ui-layout `lib/client.js:399-412`) so every surface lands and is verifiable while the shipped UI still coexists. The election to `root` is one registration change once the surfaces are real. This keeps the "wrapper replaces the shipped UI" cutover honest: it happens when ours can stand alone, not before.

### Rejected vehicle options

| Option | Rejected because |
|---|---|
| **Standalone SPA on a plugin webserver route, speaking the remote wire protocol directly** | Page serving is trivial (`WebRoute.handler` owns the full response, `dsh-host-webserver/lib/types/index.d.ts:33-38`), but the page sits *outside* the shipped client runtime: it must reimplement a Typert client, the connection/auth dance, and every service the runtime injects (`wrapper-vehicle-seams.md` Findings 3–4). That duplicates exactly the layer exceptions A4/A5 keep in dsh, and nothing it gains is verifiable offline. Revisit only if dsh ships a documented external client API. |
| **Iframe/embedding the shipped web UI inside our own chrome** | The surfaces stay the host's (their composer, their roster); we would own only decoration around them — precisely the additive posture ADR-0018 voids. Cross-frame wiring (steer prefill, command execution) adds fragility with no ownership gain. |
| **Native/Electron desktop shell** | PRD non-goal ("do not chase Sand/Cursor/Grok Bot binary or UI parity"); no evidenced seam; excluded without further study. |
| **Status quo (capsule/overlay, ADR-0013)** | Voided by ADR-0018; the capsule is an additive entry, not a product shell. |

## Multi-dispatcher placement (ticket 72's verdict applied)

The shell's **sidebar is the dispatcher roster**: one row per dispatcher-capable dsh session, keyed by session id (Finding 1: `ctx.sessions.list` is the standard feed; `open(id)` selects). The main surface shows the selected dispatcher's conversation; presence on each row comes from our per-session roster snapshots. A single dispatcher renders as a roster of one — the map-of-one superset rule from ADR-0019.

Design survives **both** of ticket 72's outcomes:

- **ADR-0019 verified seam (per-agent-scoped tool registration)** — each dispatcher session's tools live in its own agent scope; the roster keys everything by session id and needs no process-global state. This is the expected outcome; implementation is ticket 76.
- **Fallback (session-keyed gating)** — registration stays global and routing is `callerSessionId → dispatcher state`. The shell is unaffected: its keying is already the session id. No wrapper redesign is contingent on which outcome ships.

Dependency recorded: today's roster mirror publishes ONE dispatcher snapshot through our settings namespace (schemaVersion 3 carries `dispatcherSessionId`). Per-dispatcher presence in the sidebar needs the session-keyed mirror from ADR-0019's keying table (ticket 76) — the sidebar degrades to honest "presence unavailable" copy until then, never to a wrong roster.

## Surface inventory (the fidelity map)

Reference surfaces from `always-on-dispatcher-behavior.md` areas 1–3, 7–8 (and the composer of area 4); disposition against ADR-0018's exception list. "Re-host" = surviving capsule-era asset moves into the wrapper; "new" = built fresh; "excluded" = on ADR-0018's list, not designed.

| Reference surface (note area) | Disposition | Home |
|---|---|---|
| Whole shell: sidebar + main surface + always-on (area 1) | new (frame) + re-host (contents) | tickets 77–78 |
| Guided first-run onboarding (area 1) | new — own ticket | ticket 68 |
| Connection lifecycle: phases, reconnect banner, restored snapshot, privacy/account gates (area 1) | **excluded U-A** | — |
| Roster failure states: empty / unreachable, honest copy, retry-less (U-A) (area 1) | new, honest copy only | ticket 79 |
| Dispatcher sidebar rows: status dot, blocked chip, unread marker, live activity line, hover preview precedence (area 2) | re-host from tickets 27/28 stores; row + preview are new | ticket 79 |
| Hidden-agents overlay / pinned identities (area 2) | **excluded C13** | — |
| Running-tasks panel, typed rows, snapshot states (area 3) | re-host — the Active/Needs-you/Finished sections (tickets 27/28) become the wrapper's panel | ticket 79 |
| Worker streaming: agent replies stream in place; tool activity as collapsible rows (area 3) | new surface; toolview *content* re-hosted from ticket 24 | ticket 80 |
| Timeline/housekeeping cards (area 3) | **excluded U-C** | — |
| Delivery as an ordinary assistant message (area 3) | new surface (conversation), host transport | ticket 80 |
| Composer: same-composer steer, no special steer UI (area 4) | new surface, host sink (`ctx.conversation.send`); send journal **excluded A4** | ticket 80 |
| Todos: no user-facing board; private ledger (area 5) | conforms — the running-tasks panel is the only proxy | ticket 79 (re-host) |
| Approval cards, secrets, local-tool permissions (area 6) | new cards in our surface fed by the existing relay; own ticket | tickets 69 / 81 |
| Stop: no user-facing stop affordance anywhere (area 7) | conforms — the wrapper ships no stop control; stops are conversational | ticket 80 (constraint) |
| Notifications: no toasts; roster markers + per-surface notices only (area 8) | conforms on absence; markers re-hosted | ticket 79 |
| Org chart, routines/automations, per-agent memory, group rooms (area 9) | **excluded C14** | — |
| Agent identity panes: avatars, profiles, per-agent persistent chats (area 9) | **excluded C13** | — |
| Rich chat ergonomics: find-in-chat, threads, reactions, drafts, attachment viewers, URL cards (area 9) | **excluded U-B** | — |
| Artifact/file-transfer delivery (U-E), usage accounting / audit trail / content search (U-H), runtime agent management (U-G), persisted always-allow rules (U-D) | **excluded** per list | — |

Copy policy (exception B9): every string above is new or adapted copy in our locale dictionaries; no verbatim reference text; names independent (AGENTS.md, 2026-09-18 ruling).

## Hand-offs (dependencies only — the areas are tickets 68–71's to design)

- **68 (onboarding):** the first-run flow is a wrapper surface — it renders inside our frame (or the `main` page during staging) and can use the shipped `settings.onboarding` list slot only if our frame does not displace the settings surface at that stage. "Seen" persistence rides our settings namespace; U-A forbids sign-in/account beats.
- **69 (auto-review):** approval cards render in the wrapper's conversation surface (ticket 80's), fed by the access relay's pending asks; the classifier layer is new core work. U-D binding (session-scoped always-allow).
- **70 (peer tier):** peers are dispatcher sessions, so the sidebar roster is where peer presence lands; point-to-point only (C14), peer messages are a wake source into the existing pipeline (C15). Blocked by 76's session keying in the same way the sidebar is.
- **71 (remote computer):** remote-box approval cards are 69's card system with location labels in our surface; computer/browser worker types flow through the dispatched-worker wake pipeline (C15). dsh host capability is the blocker check, per that ticket. **Resolved 2026-09-19: the check failed and the area is descoped as capability-blocked (ADR-0018 U-I); only the location-label slice lives on.**

## Consequences

- The capsule epic's surviving assets (roster/panel stores and sections from tickets 27–31, toolview content from 24, settings card from 46/47, token discipline from 49) are **re-host inventory** for tickets 77–81 — reused, not rebuilt. The capsule chip/overlay entry itself is retired when the frame election flips (ticket 81), not before.
- `npm run build:client` gains no new toolchain: the shell is ordinary client-module code in `src/client/`, tested offline in the existing node:test suite; browser-visible verification stays in the live lane (tickets 45/33 chain).
- ADR-0013's seam research (overlay anatomy, activation/steer transports, settings deep-link limits) remains valid — those transports are how the wrapper's intents reach the host.
- The `root` election needs one live-lane confirmation (frame swap, HMR behavior, fallback-on-crash) before the cutover slice ships — flagged for tickets 45/33, not assumed from the contract reading.
