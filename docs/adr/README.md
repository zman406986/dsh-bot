# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-in-process-multitask-core.md) | TypeScript in-process multitask core (dsh/Cordis plugin) | accepted |
| [0002](0002-peer-agents-in-scope.md) | Peer agents in scope for this project | accepted |
| [0003](0003-dispatcher-only-spawning.md) | Dispatcher-only spawning (flat team topology) | accepted |
| [0004](0004-reference-as-feature-inventory.md) | Reference is a feature inventory, not a build list | accepted |
| [0005](0005-feature-flag-session-scoped-toggle.md) | Feature flag is session-scoped, not a live toggle | accepted; **superseded by 0018** — no flag, always-on |
| [0006](0006-worker-record-durability-split.md) | WorkerRecord durable (minimum-to-reconstruct); SteerTicket in-memory | accepted |
| [0007](0007-todo-stays-dispatcher-only-with-structural-worker-link.md) | Todo stays the dispatcher's private ledger; the worker link is structural | accepted |
| [0008](0008-worker-access-ask-structured-relay.md) | Worker access asks use a custom structured relay, not dsh's child approval waterfall | accepted |
| [0009](0009-activation-explicit-command-no-capture-on-load.md) | Activation is an explicit user command; the plugin no longer captures the primary chat on load | accepted; **premise retracted 2026-09-18 — superseded by 0018** (no mode, always-on; its deferred-binding *mechanics* may survive) |
| [0010](0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md) | Dispatcher presence is a projection of core state, published on transitions and read from pull-only surfaces | draft (non-human-approved); vehicle half superseded by 0018/0020 — projection rules survive (filed 2026-09-19, ticket 33) |
| [0011](0011-approval-session-scope-always-allow-fenced-option-set-draft-nonhuman-approved.md) | Approval answers: Allow / Always allow (this session) / Deny, with session-scoped memory, a wildcard fence, and honest degraded paths | draft (non-human-approved); location-line and rendering halves superseded by tickets 71/81 (filed 2026-09-19, ticket 33) |
| [0012](0012-restart-replays-durability-never-work-draft-nonhuman-approved.md) | Restart replays durability, never work | draft (non-human-approved); trigger re-based from activation to the per-session lifecycle bind under 0018/0019 (filed 2026-09-19, ticket 33) |
| [0013](0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md) | The dispatcher capsule is one additive shell.overlay entry — not a sidebar takeover or a keyed claim | draft (non-human-approved); **vehicle superseded by 0018** — its seam research remains valid |
| [0014](0014-client-bundle-materialization-contract-draft-nonhuman-approved.md) | dsh.client.inject obligates consumer-driven materialization: smallest boot-time set, never immediately for ordinary plugin packages | draft (non-human-approved) |
| [0015](0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md) | Real-browser verification is Playwright against a dsh --profile web --patch launcher boot; execution consolidates in ticket 33's browser pass | draft (non-human-approved) |
| [0016](0016-dispatcher-front-desk-mode-gated-activation-dedicated-surface.md) | The dispatcher is the front desk: activation moves to the mode boundary, and the dispatcher gets a dedicated surface | **RETRACTED 2026-09-18** — signed under a fabricated premise; superseded by 0018 |
| [0017](0017-core-loop-follows-reference-deviations-need-human-approval-draft-nonhuman-approved.md) | The core loop follows the reference; every deviation needs written human approval | draft (non-human-approved) |
| [0018](0018-imitate-reference-in-entirety-exception-list.md) | Imitate the reference in its entirety, except an enumerated exception list | **accepted (human-ruled, 2026-09-18) — the master rule** |
| [0019](0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md) | Per-dispatcher tool scoping: each dispatcher's tools register in its own agent scope; the process-global singleton retires | draft (non-human-approved) |
| [0020](0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md) | The wrapper vehicle: our own application frame over the shipped dsh client runtime (ADR-0018's "we build the whole UI") | draft (non-human-approved) |

Draft ADRs 0013–0015 (capsule epic 35, ticket 37) are agent-drafted and **pending human
sign-off** (ticket 33's close-out pass). Numbers 0010–0012 were reserved to design-17 §9's
ADR plan (presence projection, session-scope always-allow, activation-replay durability);
**all three were filed 2026-09-19** by ticket 33's close-out part 1 as
`-draft-nonhuman-approved` records of the decisions as actually shipped (tickets 27/28,
30, 31 respectively) — the reservation is consumed, and the pre-0018 ADR headers that
describe 0010–0012 as "reserved" are historical statements of their filing-time state.

Draft ADR 0019 (ticket 72, 2026-09-19) is agent-drafted and **pending human sign-off**. It
resolves ADR-0018's per-dispatcher seam verification item: the installed host's per-agent
tool-scope seam was verified (research note update 2026-09-19), so dispatcher tools register
through each activated agent's scoped context and all single-dispatcher state becomes
session-keyed. Implementation is ticketed separately (ticket 76) per repo rule.

Draft ADR 0020 (ticket 67, 2026-09-19) is agent-drafted and **pending human sign-off**. It
picks ADR-0018's wrapper vehicle: the whole-UI shell is our own client module registering our
own frame over the shipped dsh client runtime — every surface ours, dsh keeps store/transport/
send-path per exceptions A4/A5; fails safe (a crashed frame abdicates back to the shipped app);
staged through a `main` page before the `root` election flips. Vehicle evidence:
`docs/research/wrapper-vehicle-seams.md`; decomposition tickets 77–81; areas 68–71 ride it.

ADR 0016 (tickets 50/51, scribe pass 2026-09-18) was **retracted 2026-09-18**: its sign-off was
given under a fabricated premise (ticket 50/51's "verbatim directive" was never said by the
human), and the human ruled the master model instead — **ADR-0018**, below. Tickets 50/51 are
cancelled. ADR-0009's own premise was retracted the same day; ADR-0018 supersedes both wherever
they conflict.

Draft ADR 0017 (tickets 52/53, scribe pass 2026-09-18) is likewise agent-drafted and
**pending human sign-off**. It **amends ADR-0004**: once accepted, reference behaviour
becomes *normative* for the core loop rather than an inventory/ties-breaker, and any
remaining deviation must carry written human approval. It **suspends design-17 §5's
PRD-first conflict resolutions for core-loop items only** — those nine resolutions, and
the "presence layers collapsed deliberately" choices in design-17 §3, were made under
the latitude 0017 removes. Nothing is re-litigated until the text is signed: ticket 52
(the salvage audit) measures against it, ticket 53 turns the audit into a plan, and no
existing code or ticket is retired on the strength of this draft alone.

ADR 0018 (accepted, human-ruled 2026-09-18) is now the **master rule**: imitate the
reference in its entirety, except its exhaustive exception list (A2, A4, A5, B8, B9,
C13–C15, C19, D21, D22, U-A…U-H). It supersedes ADR-0005/0009/0013/0016 wherever they
conflict, voids the PRD's feature-flag and clean-room-grep requirements (PRD amended in
ticket 64), re-scopes the UI epic onto a wrapper the project builds itself, and makes
multiple dispatchers real (per-dispatcher dsh sessions; tool-scoping verification in
`docs/research/dsh-tool-scoping-seam.md`, design ticketed as 72).

**2026-09-19 — identifier note (ticket 74):** ADR-0018's exception-list item "**A5**"
(persistence stays in dsh's session/job store) and the deviations register's row
"**A-5**" (todo list stays the dispatcher's private ledger, reclassified a conformance)
are **distinct identifiers that happen to collide** — they name different items in
different documents. The register (`docs/research/dsh-core-loop-deviations.md`) remains
authoritative for deviations. ADR-0018's accepted text is left untouched.
