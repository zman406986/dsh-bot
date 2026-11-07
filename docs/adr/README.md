# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-in-process-multitask-core.md) | TypeScript in-process multitask core (dsh/Cordis plugin) | accepted |
| [0002](0002-peer-agents-in-scope.md) | Peer agents in scope for this project | accepted |
| [0003](0003-dispatcher-only-spawning.md) | Dispatcher-only spawning (flat team topology) | accepted; **the flat-topology spawning clause superseded 2026-10-18 by 0025** (human-ruled) for the dispatcher→dispatcher edge only (mitosis) — the worker-leaf, single-parent, and no-worker-to-worker rules are retained |
| [0004](0004-reference-as-feature-inventory.md) | Reference is a feature inventory, not a build list | accepted |
| [0005](0005-feature-flag-session-scoped-toggle.md) | Feature flag is session-scoped, not a live toggle | accepted; **superseded by 0018** — no flag, always-on |
| [0006](0006-worker-record-durability-split.md) | WorkerRecord durable (minimum-to-reconstruct); SteerTicket in-memory | accepted |
| [0007](0007-todo-stays-dispatcher-only-with-structural-worker-link.md) | Todo stays the dispatcher's private ledger; the worker link is structural | accepted |
| [0008](0008-worker-access-ask-structured-relay.md) | Worker access asks use a custom structured relay, not dsh's child approval waterfall | accepted |
| [0009](0009-activation-explicit-command-no-capture-on-load.md) | Activation is an explicit user command; the plugin no longer captures the primary chat on load | accepted; **premise retracted 2026-09-18 — superseded by 0018** (no mode, always-on; its deferred-binding *mechanics* may survive); **2026-10-21 note (0030):** the explicit-activation command's NAME is now `dsh-bot` (human-ruled); the substance stands |
| [0010](0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md) | Dispatcher presence is a projection of core state, published on transitions and read from pull-only surfaces | draft (non-human-approved); vehicle half superseded by 0018/0020 — projection rules survive (filed 2026-09-19, ticket 33) |
| [0011](0011-approval-session-scope-always-allow-fenced-option-set-draft-nonhuman-approved.md) | Approval answers: Allow / Always allow (this session) / Deny, with session-scoped memory, a wildcard fence, and honest degraded paths | draft (non-human-approved); location-line and rendering halves superseded by tickets 71/81 (filed 2026-09-19, ticket 33) |
| [0012](0012-restart-replays-durability-never-work-draft-nonhuman-approved.md) | Restart replays durability, never work | draft (non-human-approved); trigger re-based from activation to the per-session lifecycle bind under 0018/0019 (filed 2026-09-19, ticket 33) |
| [0013](0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md) | The dispatcher capsule is one additive shell.overlay entry — not a sidebar takeover or a keyed claim | draft (non-human-approved); **vehicle superseded by 0018** — its seam research remains valid |
| [0014](0014-client-bundle-materialization-contract-draft-nonhuman-approved.md) | dsh.client.inject obligates consumer-driven materialization: smallest boot-time set, never immediately for ordinary plugin packages | draft (non-human-approved) |
| [0015](0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md) | Real-browser verification is Playwright against a dsh --profile web --patch launcher boot; execution consolidates in ticket 33's browser pass | draft (non-human-approved) |
| [0016](0016-dispatcher-front-desk-mode-gated-activation-dedicated-surface.md) | The dispatcher is the front desk: activation moves to the mode boundary, and the dispatcher gets a dedicated surface | **RETRACTED 2026-09-18** — signed under a fabricated premise; superseded by 0018 |
| [0017](0017-core-loop-follows-reference-deviations-need-human-approval-draft-nonhuman-approved.md) | The core loop follows the reference; every deviation needs written human approval | draft (non-human-approved) |
| [0018](0018-imitate-reference-in-entirety-exception-list.md) | Imitate the reference in its entirety, except an enumerated exception list | **accepted (human-ruled, 2026-09-18) — the master rule**; vehicle clause amended 2026-09-20 by 0021 — addon coexistence, U-G amended for dispatcher sessions only; **U-G amended further 2026-10-18 by 0025** for the dispatcher→dispatcher edge only; **C14's room exclusion superseded 2026-10-18 by 0026** for this product only — C14's other exclusions and C13 stand |
| [0019](0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md) | Per-dispatcher tool scoping: each dispatcher's tools register in its own agent scope; the process-global singleton retires | draft (non-human-approved) |
| [0020](0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md) | The wrapper vehicle: our own application frame over the shipped dsh client runtime (ADR-0018's "we build the whole UI") | draft (non-human-approved); **vehicle superseded 2026-09-20 by 0021** — addon coexistence, floating dispatcher window; the root-frame election leaves the default posture |
| [0021](0021-addon-coexistence-floating-dispatcher-window.md) | Addon coexistence: stock dsh stays the primary UI; dispatcher functions live in a separate floating window | accepted (human-ruled, 2026-09-20 in-session directive) — amends ADR-0018's vehicle clause; supersedes ADR-0020 as vehicle; **decisions 2 and 4 superseded 2026-10-18 by 0024** — floating window withdrawn, native-dsh posture restored; decision 1 stands and is strengthened; **2026-10-21 note (0030):** decision 3's remaining `/dispatcher-stop` command transport is withdrawn (human-ruled) — the add/delete permission stands as retained internal machinery, and deactivation is implicit (host disposal) |
| [0022](0022-floating-capsule-revived-by-human-ruling.md) | The collapsed launcher becomes an information-bearing floating capsule — revived by the human's 2026-09-22 ruling | accepted (human-ruled, 2026-09-22 in-session directive) — supersedes ADR-0021's capsule-retirement clause in part; **superseded in full 2026-10-18 by 0024** |
| [0023](0023-file-driven-external-intake.md) | File-driven external work intake (inbox) | accepted (human-ruled, 2026-10-02 in-session directive) |
| [0024](0024-native-dsh-posture-restored-by-human-ruling.md) | The dispatcher UI returns to the native-dsh posture — floating window, launcher, and capsule withdrawn by the human's 2026-10-18 ruling | accepted (human-ruled, 2026-10-18 in-session directive) — supersedes ADR-0021 decisions 2 and 4 and ADR-0022 in full; ADR-0021 decision 1 (stock dsh is never displaced) stands and is strengthened; **2026-10-18 rider appended** — one additive sidebar session-kind glyph (slot id sidebar.session.row.leading), decisions 2–4 unchanged; **rider addendum appended 2026-10-18** — three session kinds stated (dispatcher / worker / normal), slot confirmed as already occupied by the host's schedule plugin, the session-kind-at-render-time question left unresolved; **2026-10-21 note (0030):** decision 2's `/dispatcher-start` phrasing superseded on the name — the command is `/dsh-bot`; decision 3's retained `/dispatcher-stop` command transport withdrawn; **2026-11-06 note (rider amendment, human-ruled):** the rider's single licensed seat moves from sidebar.session.row.leading to sidebar.session.row.trailing — a seat move, not a second seat; decisions 2–4 unchanged |
| [0025](0025-chief-of-staff-dispatcher-mitosis.md) | Chief-of-Staff dispatcher with mitosis: a dispatcher hands off problem and outcome, and may summon another dispatcher | agent-drafted 2026-10-18 from the owner's decision 1; **owner-reviewed and corrected 2026-10-19** — records what we adopt first, not a ban on anything else. Supersedes ADR-0003's flat-topology spawning clause for the dispatcher→dispatcher edge only and amends ADR-0018 exception U-G for that edge only; ADR-0003's worker-leaf, single-parent, and no-worker-to-worker rules stay in force. §Starting bounds are first-implementation values (host `maxDepth` default 1, 8-live-child root pool, no cap of our own), not an owner ruling |
| [0026](0026-optional-chatroom-broadcasting.md) | Optional chatroom broadcasting: a dispatcher may address a named room instead of a single agent | agent-drafted 2026-10-18 from the owner's decision 2; **owner-reviewed and corrected 2026-10-19** — records what we adopt first, not a ban on anything else. Supersedes ADR-0018 exception C14's room exclusion for this product only; the 1:1 peer path is preserved as-is; C13 and C14's other exclusions bind. §Starting bound set is a first-implementation choice (2–8 members, session-id identity, admin-first order, `members + 4` rounds capped at 8, 2 messages per member per round, `[PASS]`, total cap 40, 15 s grace, 60-line log read by per-member cursor) |
| [0027](0027-peer-awareness-pushed-at-prompt-tail.md) | Peer awareness is pushed into the prompt at the tail: an agent does not have to call a tool to learn who exists | agent-drafted 2026-10-18 from the owner's decision 3; **owner-reviewed and corrected 2026-10-19** — records what we adopt first, not a ban on anything else. No ADR is superseded; C13 binds because this is a session-level projection, not a saved roster. §Starting identity and dispatch are first-implementation choices (session id, the subagent descriptor's label, `projectionValues`); dispatcher identity = `agentPreset === 'multitask-dispatcher'` conditional on verifying that preset exists and lands on live sessions |
| [0028](0028-respond-to-coordinator-worker-reply-channel.md) | A worker→dispatcher mid-task reply channel, distinct from the completion report | agent-drafted 2026-10-18 from the owner's decision 4; **owner-reviewed and corrected 2026-10-19** — records what we adopt first, not a ban on anything else. No ADR is superseded; ADR-0003's worker-leaf and no-worker-to-worker rules bind. §Starting delivery lane is a first-implementation choice — the reply rides the existing `peer` wake lane, queues during a user-owned turn, and flushes at turn end; a separate lane remains open |
| [0029](0029-deterministic-microcompact-boundary-marker.md) | Compaction starts with deterministic microcompact, and the compaction boundary is the success marker resume reads | agent-drafted 2026-10-18 from the owner's decision 6; **owner-reviewed and corrected 2026-10-19** — records what we adopt first, not a ban on anything else. No prior compaction ADR exists; ADR-0018 U-H and ADR-0006 bind. §Starting window source is a first-implementation choice (session request context's contextWindow measured by the token meter's measure(session) from an agent pre-step listener); the contextPressure projection's contextWindow is not the denominator; ratio and keep-count stay ticket-level; full compaction and a steward model call remain open options |
| [0030](0030-dsh-bot-command-and-stop-withdrawn.md) | The activation command is /dsh-bot and /dispatcher-stop is withdrawn — the human's 2026-10-21 ruling | accepted (human-ruled, 2026-10-21 in-session directive) — supersedes the command NAME in ADR-0009's explicit-activation path (dispatcher-start → dsh-bot); ADR-0009's substance stands; withdraws ADR-0021 decision 3's /dispatcher-stop command transport (client affordance already withdrawn by 0024) and ADR-0024 decision 2's /dispatcher-start phrasing on the name; mitosis proceeds under ADR-0025 unchanged |
| [0031](0031-spawned-dispatcher-mark-via-sessionkind-projection-draft-nonhuman-approved.md) | A spawned dispatcher's mark rides the existing `sessionKind` projection, and one header seat renders it | **draft (non-human-approved)** — agent ruling 2026-10-28 under the owner's full-rein grant, explicitly subject to human reversal; pending the owner's signature. Extends ADR-0024's rider seat list by exactly one (`conversation.session.header.actions`, dispatcher mark on subagent-origin children only) and records that the rider's roster-mirror premise is dead — `src/adapter/roster-channel.ts` is key grammar only since the 0.2.1 port, and the `sessionKind` projection is the successor channel. No new projection key, no new host channel, no preset duplication, no stock dsh fork; `sessionKind` moves to stateVersion 2 so pre-140 checkpoints are discarded and refolded. **2026-10-28 note (0032): withdrawn** — its premise (a spawned dispatcher is a hidden subagent child with no row) is void under ADR-0032, so the header seat it licensed was removed from the client and the seat count returns to one; the file is kept unedited, never signed |
| [0032](0032-summoned-dispatcher-is-a-parallel-session.md) | A summoned dispatcher is a new top-level session parallel to its summoner, not a subagent child | **accepted (human-ruled, 2026-10-28 in-session directive)** — the human ruled the direction, the text is the agent's draft of it. Supersedes ADR-0025 decision 6 for the dispatcher→dispatcher edge only; ADR-0025 decisions 1–5 stand. No new ADR-0018 exception and no change to the U-G amendment for the dispatcher edge. Knock-ons recorded as dated notes on those Status lines: 0027's peer identity re-based (a summoned peer has no subagent label), 0019 strengthened (per-dispatcher scoping now applies to a real top-level session), 0024's seat count back to one (the ticket-140 header-seat extension withdrawn — the summoned session has its own sidebar row). ADR-0031's draft premise is void: it is withdrawn, not edited |
| [0033](0033-worker-access-ask-removed.md) | Worker access asks are removed; a blocked worker reports and stops | accepted (owner-ruled 2026-11-03) |
| [0034](0034-two-dispatcher-policy-classes.md) | The dispatcher has two policy classes: chief of staff (human-started) and team leader (summoned) | accepted (owner-ruled, 2026-11-02/03, in-session) — reverses the "one policy text for every dispatcher" reading of ADR-0032 (recorded 2026-10-28, implemented by ticket 166); ADR-0032's session-shape decision otherwise stands in full, and a summoned dispatcher still answers its own user directly. Implementation: ticket 173 (session section) and ticket 175 (standing rules, wake instructions, per-session class record) |
| [0035](0035-spawn-model-option.md) | Opt-in model choice for summoned team leaders and workers | draft (non-human-approved) — agent-drafted 2026-11-08 from the implementation plan; the plan's open questions are still for the owner, so this records the recommended shape rather than a human ruling. |

**2026-11-03 — two-policy-class note (ADR-0034):** the owner ruled the dispatcher has two policy classes — a **chief of staff** in the human's own chat and a **team leader** for a dispatcher another dispatcher summoned — and supplied both texts. [0034](0034-two-dispatcher-policy-classes.md) records it. It **reverses the reading** of [0032](0032-summoned-dispatcher-is-a-parallel-session.md) recorded on 2026-10-28 and implemented by ticket 166 ("one policy text for every dispatcher"); ADR-0032 itself stands in full — a summoned dispatcher is still a top-level session, its header still carries no `origin`/`parentSession`/`delegationDepth`, there is still no cap of ours, and its open question 1 answer still holds (it addresses its own user directly). Only the "one text" consequence is reversed, recorded as a dated note on 0032's Status line; accepted bodies untouched. Implementation: ticket 173 (the session section, shipped) and ticket 175 (the standing rules, the wake instructions, and the per-session class record that survives a restart).

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

**2026-09-20 — AGENTS.md pointer note (ticket 97):** the wall-of-text `AGENTS.md` was
decomposed; its rules now live in tracked files — `docs/agents-rulebook.md` (authority
stack + moved-rule register), `read-before-running-live-and-browser-tests.md`, and
`read-before-reference-tree-work.md`. `AGENTS.md` itself remains only as a local pointer
stub (it is git-ignored). Older ADR text above that says "see AGENTS.md" (e.g. 0001's
"Reference folder policy", 0018's B9) now resolves through that stub to these homes; the
accepted ADR texts are left untouched, same as the 2026-09-19 identifier note.

**2026-09-20 — addon-coexistence note (ADR-0021):** the human ruled the dispatcher UI is an
addon co-existing with dsh — stock dsh stays the primary UI, dispatcher functions live in a
separate floating window, and dispatcher sessions can be added/deleted from the UI (U-G
amended for dispatcher sessions only). ADR-0020's root-frame vehicle is superseded;
ADR-0018's whole-UI vehicle clause is amended. Implementation tickets 99–101; accepted-ADR
bodies untouched (dated notes on the 0018/0020 Status lines, same convention as above).

**2026-09-22 — floating-capsule note (ADR-0022):** the human ruled the collapsed launcher
becomes an information-bearing floating capsule — [dispatcher count | running workers] —
partially superseding ADR-0021's capsule-retirement consequence clause ("The capsule itself
stays retired…"). ADR-0021's decisions 2/3/4 stand: the capsule stays the launcher (the one
additive shell.overlay entry), the floating window stays the whole shell, add/delete
unchanged. Implementation ticket 107; accepted-ADR bodies untouched (dated note on the 0021
Status line, same convention as above).

**2026-10-18 — native-dsh posture note (ADR-0024):** the human ruled the dispatcher UI
returns to the state at commit `e773ef8` — stock dsh is the primary UI, our client module
renders nothing into dsh's layout, and there is no floating window, launcher, or capsule.
ADR-0021's decisions 2 and 4 are superseded; ADR-0022 is superseded in full. ADR-0021's
decision 1 (stock dsh is never displaced) stands and is strengthened, and decision 3's
add/delete permission stands as a retained functional capability. Functional work from
tickets 101/108/113 and all core/adapter/worker changes is preserved — the override reaches
UI chrome only. Implementation ticket 114; accepted-ADR bodies untouched (dated notes on the
0021/0022 Status lines and the index rows, same convention as above).

**2026-10-18 — session-kind indicators rider (ADR-0024):** the human ruled that small
glyphs should separate dispatcher sessions from subagent sessions from normal sessions
in the stock UI. Recorded as a dated rider section inside ADR-0024 (not a body rewrite):
exactly ONE additional additive slot registration, the sidebar session-row leading slot
(slot id: sidebar.session.row.leading), a small
glyph only — no replacement of stock layout, no floating surface, no removal of stock
elements. Two verified limits are recorded as known gaps, not design choices: worker/
subagent sessions are hidden from the stock sidebar and cannot be marked, and the leading
cell renders only on idle, non-archived, non-blank rows. The glyph's visual distinction is
TBD. Implementation is ticket 114's, pending the client 0.2.1 port.

**2026-10-18 — indicators rider addendum (ADR-0024):** the ruling was later stated with
three kinds explicitly — dispatcher, worker, and normal sessions. Appended as a second dated
rider section inside ADR-0024: the slot is confirmed and already occupied by the host's own
schedule plugin (`dsh-client-ui-schedule/lib/client.js:7528`), so the one-additive-registration
claim is backed by the installed tree; the worker-session limit (hidden from the stock
sidebar) stands. **Unresolved:** what identifies a session's kind at render time — the slot
receives only a session id. Accepted-ADR body untouched.

**2026-10-18 — dispatcher role, rooms, discovery, worker reply, and compaction (ADR-0025–0029):**
five decisions from the 2026-10-18 study
(`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions"),
each adopted by the owner and each **drafted into an ADR by an agent** — the human gave the
direction, not the text. **Owner review 2026-10-19** found the drafts had hardened "adopt X"
into "do not do Y": unnecessary prohibitions were softened, and each ADR now states what is
adopted first while the alternatives stay open. **0025** — Chief-of-Staff dispatcher role plus
mitosis: a dispatcher may summon another dispatcher, which carries the full dispatcher tool
surface and policy and is a peer of its creator; supersedes ADR-0003's flat-topology spawning
clause for the dispatcher→dispatcher edge only and amends ADR-0018 U-G for that edge only;
ADR-0003's worker-leaf, single-parent, and no-worker-to-worker rules bind. **0026** — optional
chatroom broadcasting: the 1:1 peer path is preserved and a dispatcher may address a named
room; supersedes ADR-0018 C14's room exclusion for this product only; C13 and C14's other
exclusions bind. **0027** — peer awareness is pushed into the prompt at the tail, with liveness
and current activity (working / waiting / approval / idle plus current tool and target); an
agent does not need a tool call to learn who exists. **0028** — a worker→dispatcher mid-task
reply channel distinct from the completion report; parent→child stays the steer path;
`src/worker/prompt.ts` must document it. **0029** — compaction starts with deterministic
microcompact and the compaction boundary is the success marker resume reads; full compaction
and a steward model call remain open options. Bounds, ratios, caps, membership, termination
policy, and window source are first-implementation values in the ADRs and remain ticket-owned.
Accepted-ADR bodies untouched (dated notes on the 0003/0018 Status lines and the index rows,
same convention as above).

**2026-10-18 — ADR-0012 wording note:** the human ruled that "restart replays durability,
never work" records the **chosen product shape**, not a permanent prohibition. The shipped
behavior is unchanged (no re-run, no re-dispatch, honest unknown-state), but resuming
interrupted work after a restart is a legitimate future option if a ticket states the
duplicate-side-effect risk it accepts and how that risk is bounded. The draft ADR's Decision
and Consequences sections were loosened in place, and its Status line carries the ruling date.

**2026-10-21 — dsh-bot rename and stop-command withdrawal note (ADR-0030):** the human ruled in session: work on the open issues continues; the activation command `/dispatcher-start` becomes `/dsh-bot`; `/dispatcher-stop` is removed; mitosis is built. The verbatim ruling is recorded in [0030](0030-dsh-bot-command-and-stop-withdrawn.md). ADR-0009's substance — explicit command activation, no capture on load — stands; only the command NAME is superseded (`dsh-bot`). ADR-0021 decision 3's add/delete permission stands as retained internal machinery; its client affordance was already withdrawn by 0024 and the `/dispatcher-stop` command transport is now withdrawn too, so deactivation happens only implicitly (host disposal). Mitosis proceeds under ADR-0025 unchanged — ADR-0025 plus tickets 115–118 already cover it; nothing is duplicated. Implementation tickets 128 and 129. Accepted-ADR bodies untouched (dated notes on the 0009/0021/0024 Status lines and the index rows, same convention as above).

**2026-10-28 — spawned-dispatcher mark note (ADR-0031, draft):** an agent ruling under the owner's 2026-10-28 full-rein grant, **subject to human reversal**. It resolves ticket 140's two open questions. **Seat:** one extension of ADR-0024's rider — `conversation.session.header.actions`, dispatcher mark only, on subagent-origin children — because stock dsh filters every `origin: 'subagent'` session out of the sidebar, so the rider's licensed cell never mounts for a spawned dispatcher. **Identity:** the existing `sessionKind` projection, whose `init` now consults the adapter's dispatcher-mark mirror (seeded with the reserved child id before `startActivation`, seed deleted when the spawn fails). No new projection key, no new host channel, no preset duplication, no stock dsh fork. The ruling also records that the rider's item-1 premise is dead: `roster.<sessionId>` no longer reaches the client (`src/adapter/roster-channel.ts` is key grammar only since the 0.2.1 port) and the `sessionKind` projection is its successor — the rider's *prohibition* stands, only its premise is superseded. `sessionKind` moves to `stateVersion` 2, so pre-140 checkpoints are discarded and refolded. Implementation branch `ticket-140-spawned-dispatcher-mark` (commit `5c76e01`) was under review at the time of writing. Filed as a `-draft-nonhuman-approved` record; it moves nothing until signed, and accepted-ADR bodies are untouched.
