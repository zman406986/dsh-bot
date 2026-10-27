# Dispatcher surfaces — the designed absences

**Status:** shipped with ticket 32 (design-17 §4.8–4.9, §7, §8); **surface inventory corrected 2026-10-18 for the native-dsh posture (ADR-0024, ticket 114):** stock dsh is the primary UI and the only UI — our client module registers nothing into dsh's layout except the one session-kind glyph licensed by ADR-0024's 2026-10-18 rider (live since ticket 123), and the floating window, launcher, and capsule are withdrawn. **Re-verified against dsh 0.2.1-rc.3 on 2026-10-24 (ticket 144):** the slots this file relies on are unchanged in kind, scope, and replace risk; the shipped slot set grew by three navigation "More menu" seats, none of which renders a session row; `sessionVisible` still drops every `origin: 'subagent'` row. Evidence: `.scratch/testing/2026-10-24-rc3-compat/70-DELTA.md`. The designed absences below still stand; the surface inventory at the end records what ships and what stays in the tree unmounted. Reference:
`.scratch/clone-always-on/design-17-always-on-dispatcher.md` (sections
§4.6–4.9 and the conflict table §5). All text here is original clean-room
copy; the contaminated reference tree was not consulted.

This note records the surfaces the dispatcher deliberately does **not**
build, and why. Each absence is a decision, not a gap left open by
accident. Rationale is drawn from the PRD, the ADRs, and the verified dsh
extension points (`docs/research/dsh-plugin-ui-patterns.md`, read against
0.1.5-rc.1; the shipped 0.2.1 slot deltas are recorded on ticket 114 and
re-verified on 0.2.1-rc.3 by ticket 144) — never from
the reference implementation.

The rule the whole list follows: **presence is a projection of existing
core state, read from surfaces that exist** (design-17 §5 conflict 8). A
surface that would need new core state, a new host extension point, or a second source
of truth is out — no matter how closely it would imitate the reference's
feel.

## No push notifications

dsh exposes **no notification or toast extension point** (verified against
0.1.5-rc.1; none appears among the 0.2.1 slot deltas recorded on ticket 114, and
the rc.3 slot set adds only navigation "More menu" lists — ticket 144).
Attention therefore routes only through surfaces the user has to look at:

1. the Workers panel's **Needs you** section (`roster-store.ts`
   `rosterSectionFor`) when a panel is mounted — since ADR-0024 (2026-10-18)
   the panel is retained, not-composed machinery, so in the default posture
   this route is dormant;
2. the dispatcher's conversational narration — wake turns land as ordinary
   chat messages whenever the user is in the chat (the only live route in the
   native-dsh posture);
3. the activation success copy, which sets that expectation up front
   (`activation.presence-hint`) — since ticket 134 (2026-10-22) the copy names
   the dispatcher's own narration, not a panel, because no panel is mounted.

No surface promises or simulates push: there are no "notify me" controls,
no fake toasts, no bell/badge affordances, and no polling loop pretending to
be a subscription. The panel moving from stale to unavailable is the accurate
"presence feed is down" state; there is no banner extension point to build on.

**This is the largest fidelity gap against the reference's *feel*, and it is
the host's, not ours.** See design-17 §4.8.

## No todo board

`ADR-0007` keeps the todo ledger **dispatcher-private**. The user-visible
proxies are the panel (when mounted) and in-chat narration — the dispatcher
reconciles the ledger and *speaks* the result (PRD S6). There is no task
list, no column board, and no per-todo card.

The `todoId` chip rendered muted on a panel row is **linkage metadata**
(worker ↔ ledger correlation so a settled worker can be matched to its
entry), never a board item and never a task list. It is truncated, low
contrast, and has no affordances. Rendered progress is carried by the
worker rows themselves. This is dormant machinery in the native-dsh posture:
the panel is retained and unmounted, so nothing renders it today.

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

This section concerns worker/turn stopping. `/dispatcher-stop` (ticket 101) was a
**session-binding verb** — it deactivated the dispatcher binding in that session,
not a worker — and was never a control on a surface. The command is withdrawn
(ADR-0030, human-ruled 2026-10-21; ticket 129): deactivation is implicit only,
via host disposal of the chat or plugin unload.

The absence is tested structurally (`test/restart-honesty.test.ts`, the test file that checks restart reporting and the
no-stop guard) so a future edit cannot silently reintroduce a button.

## No worker console

Worker transcripts are **never streamed to the user**. Progress is ambient
(panel rows when a panel is mounted, plus the derived activity line) and results arrive as ordinary
dispatcher messages on wake turns. This matches the PRD's "machinery is
invisible" rule (§6.1) and S1/S5: workers are leaves that never address the
user, and the dispatcher is the only voice.

Per-tool call rows (`tool.call.toolview`) render **collapsible call
details**, not a live console. Long values are clamped. There is no
drill-down from a panel row into a worker's chat — rows are not chats.

## No timeline cards

Adding a **new chat node type is impossible**: `conversation.chat.node` is a
closed keyed domain owned by the shipped set, and the extension-point research records
it as a hard limit. There is no timeline-card surface, and no fake node type
is registered to imitate one.

Housekeeping notices (access denials, expired approvals, restart notices)
arrive **inside wake turns as text** — the pattern the shipped product uses. See
`src/adapter/restart-notice.ts` for the one-time restart notice.

## The floating window, launcher, and capsule — withdrawn (ADR-0024, 2026-10-18)

Epic 35's capsule (tickets 38–42), ticket 100's floating window, and ticket 107's
information-bearing launcher capsule are **not surfaces of the product any more**. The
human's 2026-10-18 ruling (ADR-0024) returns the UI to the `e773ef8` native-dsh posture:
stock dsh is the primary UI and the only UI, our client module renders nothing into dsh's
layout, and there is no floating window, launcher chip, capsule, drag, resize, maximize, or
right-click-close chrome.

The record of what those surfaces were and why they are gone:

- **ADR-0013** chose the additive `shell.overlay` seam for the capsule. Its seam research
  remains valid evidence, but nothing registers it in the default posture.
- **ADR-0021** decisions 2 and 4 put the dispatcher functions in a floating window launched
  from one additive `shell.overlay` entry. Superseded by ADR-0024.
- **ADR-0022** revived the collapsed launcher as an information-bearing capsule with counts.
  Superseded in full by ADR-0024.
- The capsule's footer copy (flag provenance plus a Settings hint) and the presence-counter
  model are **withdrawn with the surface**. They are historical record, not live contracts.

`src/client/floating-window.tsx`, `src/client/floating-window-store.ts`, and the launcher
registration in `src/client/overlay.ts` were deleted by ticket 114 (dsh 0.2.1 port); they
no longer exist in the tree. The shell machinery below stays in the tree as
retained, unmounted machinery.

## Retained but not composed (native-dsh posture)

These remain in the tree and are not registered into dsh's layout. They are the raw material
for a future surface registered at the one composition point, `src/client/index.ts`.

| Machinery | Files | State |
|---|---|---|
| Shell page mount (store + feeds + pane/seat wiring) | `src/client/shell-mount.ts` | Retained, unmounted (as at `e773ef8`) |
| Dispatcher shell element tree | `src/client/shell.tsx`, `src/client/shell-store.ts` | Retained, unmounted |
| Roster panel | `src/client/panel.tsx`, `src/client/roster-store.ts` | Retained, unmounted |
| Conversation pane / onboarding / approval pane | `src/client/conversation.tsx`, `src/client/conversation-store.ts`, `src/client/conversation-feed.ts`, `src/client/onboarding-pane.tsx`, `src/client/approval-pane.tsx`, `src/client/approval-cards.ts`, `src/client/approval-feed.ts` | Retained, unmounted; the approval/mirror feeds have no live channel on 0.2.1 |
| Per-session mirror hub and shell feeds | `src/client/shell-mirror-feed.ts`, `src/client/shell-feed.ts` | Retained; no live channel feeds them (the settings-document mirror is gone) |
| Roster mirror key grammar | `src/adapter/roster-channel.ts` | Retained as plain string functions only — no settings-document channel behind them on 0.2.1 |
| Keyed `main` page and `root` election contracts | `src/client/shell-mount.ts` | Retained, reversible at one registration site |

Ticket 101's client-side add/delete affordances (`describeAddPicker`,
`shellDeletePress`, the per-row delete arming, and the `/dispatcher-stop` line)
were deleted in the 0.2.1 port; the daemon-side activation and the host
`agent/disposed` teardown path remain, and deactivation is now implicit only
(ADR-0030).

The single composition point is `src/client/index.ts`'s `apply`: it registers the locale
namespace, the keyed `tool.call.toolview` entries, the keyed `plugins.row.config`
settings card, and the one session-kind glyph licensed by ADR-0024's
2026-10-18 rider. A future surface is registered there and nowhere else.

## The settings card (the Plugins page row, ticket 47)

The Plugins page renders a plugin row's configuration from the keyed
`plugins.row.config` slot: the row page keys the cell
`<package name>#<row id>` and hands the entry's accepted snapshot and its one
atomic write verb in as owner props. A row the Host serves no settings
namespace for gets no configure control at all, because the page resolves the
form by making the row id, the Loader entry id, and the settings namespace the
same string. `src/client/settings-card-store.ts` +
`src/client/settings-card.tsx` do that registration: one keyed entry whose
`key` names the plugin's settings namespace, and the card edits the form the
page hands it rather than reaching for a service of its own.

(Dated note: this replaced the 0.1.5-rc.1 `settings.plugin.item` card under
`Settings → 插件配置`. dsh 0.2.1 removed that slot and the client
`ctx.settingsScope` service; the roster watch that rode the same scope is gone
too — see "Retained but not composed".)

Deliberate properties, each a decision:

- **One channel.** The card reads and writes only the form the slot owner hands in:
  it re-attaches on each new page snapshot and writes through that form's one
  `mutate(ops, revision)`. It never resolves a service or binds a second view of the
  document — and the roster watch's own scope bind no longer exists to share.
- **Nothing renders while the namespace is not served.** `unavailable`, or a
  section the Host has not accepted, yields an empty card — the pattern the shipped
  cards use (`PluginCard` returns `null`) rather than a disabled control nobody can act
  on.
- **The rendered text is the draft.** A control stages; Save is the single
  point where a draft becomes a document mutation, and a draft a field does not
  accept blocks the save instead of being dropped.
- **`overridden` is presence, not comparison.** A field's presence in the raw
  user layer marks it overridden even when its value equals the composition
  default, so an empty draft plans a clear (the field re-inherits the layer).
- **A save is verified by read-back.** A `mutate` that answers `false`, or a
  read-back that disagrees with what was staged, keeps the drafts and reports
  the failure rather than claiming a success the document does not carry.
- **The flag is phrased as the SETTING.** The `enabled` control's hint states the
  ADR-0005 rule: a saved change applies to new chats, and the running chat keeps
  the flag it started with.
- **No deep-link, still.** No way to navigate to a settings section exists, and
  none is invented here. The card names nothing that navigates.

## Theming: the surfaces use the host's design tokens

In the native-dsh posture (ADR-0024) the only surfaces that own colours are the
**settings card** and the **retained shell components** (unmounted); the live
session-kind glyph inherits the host's label tokens. They take
**every colour from the host's shared semantic token
layer** (`--dsw-alias-*`), so they follow the shell's light/dark setting instead
of painting a private palette. The ticket-47 settings card does the same, in the
shipped card's own vocabulary (`bg-layer-3` → `bg-layer-2` when open, the
`border-l4` hairline, the label ladder) — with one deliberate substitution: the
shipped card's failure line paints `var(--dsw-alias-label-error)`, a token
**defined nowhere** in `dsh-client-ui-theme`, so its text silently inherits; we
use the defined `state-error-primary`. The tokens are plain CSS custom properties
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
come back. `test/client-theme-tokens.test.ts` holds the contract.

## Send journal is host-owned

The composer's optimistic send / offline queue / reconnect-flush behavior
belongs to the **host composer**. We do not rebuild, wrap, or simulate it.
The conversational steer path gets it for free; the `/dispatcher-steer`
command path returns one-shot success/error copy and does not pretend to
have journal phases (design-17 §4.4, conflict 9).

There is no plugin-side journal around `/dispatcher-steer`, and no way for the plugin to inspect the host queue.

## What ships live, and what is retained unmounted

The live surface list in the native-dsh posture (ADR-0024, 2026-10-18). Only stock dsh's own
slots carry our content.

| Surface | Implementation | State |
|---|---|---|
| Session-kind glyph in the sidebar row | `src/client/session-kind.tsx` + the registration in `src/client/index.ts` | **Live** — one additive `sidebar.session.row.leading` entry (order 20, above the stock schedule mark at 10), a dispatcher glyph keyed on the adapter's `sessionKind` projection. Single slot: the rider licenses exactly one registration. Limits: worker/subagent sessions are hidden by stock dsh and never become rows, so only dispatcher vs normal shows here; the leading cell renders only on idle, non-archived, non-blank rows. 16px cell: glyph only, no text (ADR-0024 rider, 2026-10-18) |
| Session-kind header chip (a spawned dispatcher's own conversation) | `src/client/session-kind.tsx` + the registration in `src/client/index.ts` | **Live** — one additive `conversation.session.header.actions` entry (order 20, above the stock `subagent-catalog` at 10), the same dispatcher mark keyed on `projectionValues.sessionKind` read directly (per-session, no `origin` gate — the child IS a subagent). Added by the 2026-10-28 ruling (ticket 140) because a spawned dispatcher has no sidebar row. The WORKER marker in this slot is still **declined** (ticket 123, 2026-10-22) — no seat composes it |
| Settings card (the Plugins page row) | `src/client/settings-card.tsx` + `src/client/settings-card-store.ts` | **Live** — keyed `plugins.row.config`, the one configuration surface we register |
| Six tool call views | `src/client/toolviews.ts` | **Live** — six keyed `tool.call.toolview` entries: the five long-standing dispatcher tools plus the retained historical `send_peer` key. The dispatcher surface is eight tools; `message_agent`, `await_agent`, and `spawn_dispatcher` deliberately have no row renderer yet and fall back to the generic tool row |
| Locale dictionary (en + zh, identical key sets) | `src/client/overlay.ts` | **Live** — namespace registration, not layout |
| Roster wire contract (snapshot v4) | `src/core/roster-snapshot.ts` | **Retained** — the parse/projection contract stays; no live channel feeds it on 0.2.1 (the settings-document mirror is gone) |
| Activation command + presence hint | `src/adapter/activation-command.ts` | **Live** — `/dsh-bot` in the stock chat |
| Stop command | removed (`src/adapter/stop-command.ts` deleted) | **Withdrawn** — ADR-0030 (2026-10-21, ticket 129) removed the command and the file; deactivation is implicit via host disposal or plugin unload |
| Steer command | `src/adapter/steer-command.ts` | **Live** — `/dispatcher-steer` in the stock chat |
| Resolve command | `src/adapter/resolve-command.ts` | **Live** — `/dispatcher-resolve`, the transport approval cards answer through |
| Access prompts (Allow / Always allow this session / Deny) | `src/adapter/access-prompt.ts` | **Live** — host `userQuestions.ask` prompts |
| Restart notice | `src/adapter/restart-notice.ts` | **Live** — in-chat text |
| Workers panel | `src/client/panel.tsx`, sections from `src/client/roster-store.ts` | Retained, unmounted |
| Dispatcher shell (roster panel, conversation pane) | `src/client/shell.tsx`, `src/client/shell-store.ts` | Retained, unmounted |
| Shell page mount + `main`/`root` contracts | `src/client/shell-mount.ts` | Retained, unmounted |
| Floating window / launcher / capsule | deleted — `src/client/floating-window.tsx`, `src/client/floating-window-store.ts`, the launcher registration in `src/client/overlay.ts` | **Withdrawn and deleted** — ticket 114 removed the files; ADR-0024 withdrew the surfaces |

Dormant boot registers the three host commands — `/dsh-bot`, `/dispatcher-steer`,
`/dispatcher-resolve` — plus the passive host plumbing, and nothing else: the prompts
and the tool surface exist only after an explicit `/dsh-bot` (ADR-0009). The roster
snapshot has no live producer at all on 0.2.1, so nothing of it reaches a surface.
Client-side, the default composition registers the locale namespace, the keyed
toolviews, the keyed settings card, and the one session-kind glyph licensed by
ADR-0024's 2026-10-18 rider — and nothing else into dsh's layout: there is no chip,
no window, and no presence copy before activation. The matrix is asserted in
`test/client-shell-mount.test.ts` (the three additive injects),
`test/client-session-kind.test.ts` (the single glyph entry), and
`test/activation-lifecycle.test.ts` (the dormant command list).