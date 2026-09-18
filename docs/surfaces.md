# Dispatcher surfaces — the designed absences

**Status:** shipped with ticket 32 (design-17 §4.8–4.9, §7, §8). Reference:
`.scratch/clone-always-on/design-17-always-on-dispatcher.md` (sections
§4.6–4.9 and the conflict table §5). All text here is original clean-room
copy; the contaminated reference tree was not consulted.

This note records the surfaces the dispatcher deliberately does **not**
build, and why. Each absence is a decision, not a gap left open by
accident. Rationale is drawn from the PRD, the ADRs, and the verified dsh
0.1.5-rc.1 seams (`docs/research/dsh-plugin-ui-patterns.md`) — never from
the reference implementation.

The rule the whole list follows: **presence is a projection of existing
core state, pulled from surfaces that exist** (design-17 §5 conflict 8). A
surface that would need new core state, a new host seam, or a second source
of truth is out — no matter how closely it would imitate the reference's
feel.

## No push notifications

dsh 0.1.5-rc.1 has **no notification or toast seam**. Attention therefore
routes only through pull surfaces:

1. the Workers panel's **Needs you** section (`roster-store.ts`
   `rosterSectionFor`), which a user sees when they look;
2. the dispatcher's conversational narration — wake turns land as ordinary
   chat messages whenever the user is in the chat;
3. the activation success copy, which sets that expectation up front
   (`activation.presence-hint`).

No surface promises or simulates push: there are no "notify me" controls,
no fake toasts, no bell/badge affordances, and no polling loop pretending to
be a subscription. The panel's stale→unavailable degrade is the honest
"presence feed is down" state; there is no banner seam to build on.

**This is the largest fidelity gap against the reference's *feel*, and it is
the host's, not ours.** See design-17 §4.8.

## No todo board

`ADR-0007` keeps the todo ledger **dispatcher-private**. The user-visible
proxies are the panel, presence, and in-chat narration — the dispatcher
reconciles the ledger and *speaks* the result (PRD S6). There is no task
list, no column board, and no per-todo card.

The `todoId` chip rendered muted on a panel row is **linkage metadata**
(worker ↔ ledger correlation so a settled worker can be matched to its
entry), never a board item and never a task list. It is truncated, low
contrast, and has no affordances. Rendered progress is carried by the
worker rows themselves.

Building a board would be *our-invention surface*: the reference has none,
the PRD requires none, and rendering ledger rows as a board risks reading
with the wrong semantics (design-17 §4.9, conflict 2).

## No milestones

**"Milestones" in this repo are development milestones (PRD §13), not
runtime entities.** There is no milestone object in the core, no milestone
tool, and no milestone surface. Nothing to render, nothing to persist.

No prompt, tool description, or user-facing string may imply a milestone UI
exists. Ticket 32's prompt review checked this explicitly; the no-board
rule in the dispatcher policy (`src/core/policy/prompts.ts`, "never
reference a task board or milestone view") keeps narration aligned
(design-17 conflict 3).

## No stop control

There is **no user-facing stop/cancel control on any surface** — not on
panel rows, not in toolviews, not in the composer. Stopping is
conversational: the user says so in plain language, and the dispatcher
policy maps that onto a steer or a stop of the matching worker (PRD §15.3,
design-17 §4.6/conflict 1).

`stop_worker` remains an **agent-facing tool only**. Aborted workers settle
to the terminal `aborted` state with "(Stopped before completion. No
report.)" — no result revival (PRD S3, design-17 §4.6).

The absence is tested structurally (`test/restart-honesty.test.ts`, the
no-stop guard) so a future edit cannot silently reintroduce a button.

## No worker console

Worker transcripts are **never streamed to the user**. Progress is ambient
(panel rows + derived activity line) and results arrive as ordinary
dispatcher messages on wake turns. This matches the PRD's "machinery is
invisible" rule (§6.1) and S1/S5: workers are leaves that never address the
user, and the dispatcher is the only voice.

Per-tool call rows (`tool.call.toolview`) render **collapsible call
details**, not a live console. Long values are clamped. There is no
drill-down from a panel row into a worker's chat — rows are not chats.

## No timeline cards

Adding a **new chat node type is impossible**: `conversation.chat.node` is a
closed keyed domain owned by the shipped set, and the seam research records
it as a hard limit. There is no timeline-card surface, and no fake node type
is registered to imitate one.

Housekeeping notices (access denials, expired approvals, restart honesty)
ride **inside wake turns as text** — the shipped pattern. See
`src/adapter/restart-notice.ts` for the one-time restart notice.

## The capsule (epic 35, tickets 38–42)

The dispatcher's one additive `shell.overlay` entry (ADR-0013): a collapsed
chip that expands into the panel card. Everything on it is a projection of
existing core state through the settings-mirror channel — the same one
channel feeding both the roster store and the footer store: the plugin's
settings namespace, read through the shipped `ctx.settingsScope` service
(`bind({namespace})` → `getSnapshot()`/`subscribe()`; ticket 46 — *not*
`ctx.inject(["settings"])`, which is the host-side seam and never resolves in
the browser). Its states:

- **Dormant** (`waiting` — feed alive, nothing published): the chip's grey
  dot; the expanded panel IS the activation pitch, with the single
  "Start dispatcher in this chat" affordance. Roster sections hidden.
- **Activated** (fresh snapshot): blue dot, worker count, wake badge
  (settled-undelivered); the expanded card shows the activation row
  (conversational stop INTENT — never a kill control), the three roster
  sections, the deliverables line, and the footer.
- **Unavailable** (stale / `invalid` / `channel-missing`): red dot; the
  expanded card shows only the honest degraded copy and NO affordance —
  nothing actionable pretends a broken channel can carry an activation.
- **Deliverables line**: hidden entirely at count 0; count-only when a
  landed row carries no honest excerpt (post-restart restore); the excerpt
  itself is bounded wire truth, expandable.

**Footer provenance and its recorded v1 gaps** (seam verdicts in
`docs/research/dsh-capsule-seams.md`): the footer renders the persisted
feature-flag state from the plugin's own settings namespace, phrased as the
SETTING (ADR-0005 freezes the running chat's flag; a change lands in new
chats), plus a copy-only Settings hint. Deliberately absent, per the
honesty rules — these are decisions, not oversights:

- **No Settings deep-link** — no open/navigation seam exists (verdict 4),
  so the hint names the path and nothing navigates.
- **No profile segment** — no client-visible profile identity exists
  (verdict 5); `$host.home` is not a profile name and is never relabeled
  into one.
- **No tool-view link** — the five dispatcher tool-call views stay keyed in
  `tool.call.toolview` (ticket 24) where the calls happen; the seam research
  found no navigation path, so the capsule links to, embeds, and navigates
  nothing.
- **No Settings card yet** — `Settings → 插件配置` renders the intersection of
  the served namespaces and the cards registered into the keyed
  `settings.plugin.item` slot, and this plugin registers no card, so the section
  never appears even though the Host serves our namespace. Recorded gap, not a
  decision: owned by ticket 47 (the card), independent of the ticket-46 watch.

Nothing on the capsule is editable inline. The no-stop guard's final form
(`test/restart-honesty.test.ts`) structurally covers every capsule view
model; the composition close-out (`test/client-capsule-composition.test.ts`)
assembles dormant and activated end-to-end offline.

## Theming: the surfaces ride the host's design tokens

The capsule and panel take **every colour from the host's shared semantic token
layer** (`--dsw-alias-*`), so they follow the shell's light/dark setting instead
of painting a private palette. The tokens are plain CSS custom properties
defined on `body` by the shipped theme stylesheet
(`dsh-client-ui-theme/lib/client.js:1052–1060`); inheriting them needs no
service, subscription, or boot-graph edge, so `ctx.theme` is deliberately **not**
bound (it owns preferences and theme registration, not styling).

The mapping is semantic, and two near-misses are pinned shut: the accent is
`--dsw-alias-state-business-primary`, **not** `--dsw-alias-brand-primary`
(despite its name that is the high-contrast label colour — it would paint a
white dot on dark and a black dot on light); and `--dsw-font-*` is the
conversation-content scale, so control type stays in px. Text hierarchy stays
opacity-based and no token gets a hex fallback, so the private palette cannot
creep back. `test/client-theme-tokens.test.ts` holds the contract.

## Send journal is host-owned

The composer's optimistic send / offline queue / reconnect-flush behavior
belongs to the **host composer**. We do not rebuild, wrap, or simulate it.
The conversational steer path inherits it for free; the `/dispatcher-steer`
command path returns one-shot success/error copy and does not pretend to
have journal phases (design-17 §4.4, conflict 9).

There is no plugin-side journal around `/dispatcher-steer`, and no queue
introspection seam.

## What the activated experience *does* ship

For contrast, the surfaces that exist (design-17 §3.2, §4):

| Surface | Implementation |
|---|---|
| Workers panel (`shell.overlay`, app-wide) | `src/client/panel.tsx`, sections from `src/client/roster-store.ts` |
| Capsule chip + expandable card (ADR-0013) | `src/client/capsule.tsx`, view models from `src/client/capsule-store.ts` |
| Capsule footer (flag provenance + Settings hint) | `src/client/capsule.tsx` + `describeCapsuleFooter` |
| Roster wire contract (snapshot v2) | `src/core/roster-snapshot.ts` |
| Activation command + presence hint | `src/adapter/activation-command.ts` |
| Steer command | `src/adapter/steer-command.ts` |
| Five tool call views | `src/client/toolviews.ts` |
| Access prompts (Allow / Always allow this session / Deny) | `src/adapter/access-prompt.ts` |
| Restart honesty notice | `src/adapter/restart-notice.ts` |
| Locale dictionary (en + zh, identical key sets) | `src/client/overlay.ts` |

Dormant boot registers nothing beyond the two commands and the passive
host plumbing; the roster, prompts, and tools exist only after an explicit
`/dispatcher-start` (ADR-0009). Client-side, the capsule chip is present
pre-activation as the dormant face (chip + activation pitch) — it spawns
nothing and runs nothing; it is presence copy over an empty feed. The
matrix is asserted in `test/composition-polish.test.ts`,
`test/activation-lifecycle.test.ts`, and
`test/client-capsule-composition.test.ts`.