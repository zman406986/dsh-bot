# History: what we attempted, day one to now

A trajectory of the dsh-bot project — the attempts, the turns, the dead ends, and why the tree
looks the way it does. Not a changelog and not a fine-grained record: every claim here is meant
to be checkable against a commit, an ADR, or a ticket, and the references are given so the
detail can be recovered rather than restated.

- **Scope:** 2026-09-15 (first commit) through 2026-10-31 (this book).
- **Scale at the time of writing:** 420 commits, 32 ADRs, 168 ticket files
  (147 resolved, 13 open, 7 cancelled, 1 deferred), 78 TypeScript sources in `src/`
  (70 `.ts` + 8 `.tsx`), 87 test files, and a vendored context-cleanup library under
  `vendor/racoons/`.
- **What this book is not:** it does not re-litigate rulings. Where a decision is recorded, this
  book says what was decided and points at the record. The ADR index (`docs/adr/README.md`) is
  the authority; this is the story around it.

Two facts shape the whole story and are worth stating up front:

1. **The product is a dispatcher, not a subagent framework.** One chat stays free to talk to the
   user while background workers do the long jobs. Everything built here serves that one idea.
2. **The reference tree is a behaviour spec, not a code source.** `reference material-NOT LICENSE
   SAFE DONT COPY-grok bot/` is git-ignored, has never been tracked, and is read for observable
   behaviour only. The copy policy around it was renegotiated twice (clean-room, then
   adapted-copy-permitted) and is the subject of the project's two recorded copy reviews.
   Separately, the project's biggest recorded mistake — a decision signed on a quote the human
   never said — is the reason premises are now verified before anything is recorded.

---

## Chapter 1 — Day one: the paper product (2026-09-15)

The repo opens with a single commit, `3840c57`, and it contains no code at all: the PRD
(`PRD-dsh-multitask-dispatcher.md`), a domain glossary, a tracker guide, a research guide, and
triage labels. Before a line of TypeScript existed, the shape of the product was already written
down: one dispatcher, blank workers, parallel streams, mid-run steer, wake on completion,
delivery by the dispatcher and never by a worker.

That ordering was deliberate and it held for the whole project: **decide on paper, then build.**

## Chapter 2 — Foundations (2026-09-16)

The second day packed the design work: 17 commits that took the paper product to a tested skeleton.

- **Research first.** `docs/research/` gained the notes that every later decision leans on: the
  dsh extension surface, reference behaviour, reference architecture patterns, PRD-vs-reference
  capability gaps, the agent lifecycle, the prompt inventory.
- **Seven ADRs in one pass** (0001–0007), settling the questions that would otherwise be
  re-opened weekly: TypeScript in-process core (0001), peers in scope (0002), dispatcher-only
  spawning (0003), the reference as a feature inventory rather than a build list (0004), a
  session-scoped feature flag (0005), worker-record durability split (0006), and the todo list
  staying the dispatcher's private ledger (0007). ADR-0008 (worker access asks use a custom
  structured relay) followed within the day's work.
- **Then the build**, as tickets 01–15, one commit per ticket, almost all landing the same day:
  plugin scaffold and the `DshHost` seam with a hand-written fake (01), worker lifecycle FSM (02),
  steer queue (03), stop semantics (04), worker registry and stream-key uniqueness (05), wake bus
  and coalescing (06), todo reconciler (07), durable roster marker and restart rebuild (08), the
  live dsh adapter (09), the worker agent type and tool barrier (10), the dispatcher tools and
  policy prompts (11), the feature-flag/profile split (12), permission and secret relay (13), the
  peer inbox and priority lane (14), and the clean-room/licence audit (15).

The method established here survived to the end: **a seam, a fake, and an offline test** — the core
never needs dsh or a model to be verified.

## Chapter 3 — The first UI, and the first live truth (2026-09-17)

Ticket 16 asked what the dispatcher should look like inside dsh. The answer arrived in three
phases — research into dsh's plugin-UI seams, a design, then implementation as tickets 18–26:
a client face module, a worker roster overlay, a steer command surface, access-request prompts
through an approval seam, per-tool views, and a seam-coexistence QA pass.

Two things from this day matter later:

- **Ticket 19** killed the idea that merely loading the plugin should capture the primary chat.
  Activation became an explicit user command. That principle — no capture on load — never died,
  even when the command's name did.
- **Live testing became its own discipline.** Ticket 17 set up a clone worktree and a
  three-gate workflow (identifier grep, offline tests, provenance review) before anything merged.
  Tickets 43–47 then found, one live run at a time, that the host half of the plugin never actually
  ran, that command registration needed the shipped generator-effect idiom, that tool schemas had
  to be valid JSON Schema or the provider rejected every activated turn, and that the client
  settings watch was reading the wrong service. Tickets 48–49 cleaned up after the same pass: a
  launcher that served stale worktrees, and a capsule painted with a private palette instead of the
  host's design tokens.

This is the pattern the whole project would repeat: **offline tests prove the logic; only a live
boot proves the seams.**

## Chapter 4 — The turn: ADR-0018, and a mistake corrected (2026-09-18 to 2026-09-19)

The most important day in the project is the one where it changed direction, and it started with
a mistake.

**The mistake.** Tickets 50/51 recorded a "verbatim directive" from the human about a
front-desk dispatcher mode, and ADR-0016 was drafted and signed on that premise. The directive had
never been said. The human corrected the record: ADR-0016 was **retracted** as signed under a
fabricated premise, tickets 50/51 were cancelled, and ADR-0009's premise went too — the
"explicit user command" framing was attributed to the human, who had actually said only
"human can toggle activation". The incident is why the rulebook now insists that a premise be
verified before a decision is recorded, and why the authority stack exists at all.

**The turn.** The human then ruled the master model in one sentence's worth of policy:
**imitate the reference in its entirety, except an enumerated exception list.** That is
ADR-0018 — human-ruled on 2026-09-18 and recorded in the repo that night — and it reordered
everything:

- No feature flag, no dispatcher mode: always-on, like the reference. ADR-0005 was superseded.
- The whole UI would be ours — a wrapper around dsh, not a few overlay chips. This superseded
  ADR-0013's one-additive-slot capsule and re-scoped the entire UI epic.
- Multiple dispatchers became real, each with its own dsh session.
- Formerly excluded areas came into scope: onboarding, classifier-gated review, the peer tier,
  and (briefly) the remote-computer area.
- The copy rule was amnestied but not removed: **no verbatim copying; adapted copying is
  permitted**, recorded as a human accepted-risk decision, not a legal clearance (exception B9).
- The clean-room identifier grep (S7) was voided as a ship gate.

The consequences were mechanical: the PRD was amended (ticket 64), the deviation register was
re-based, the UI tickets were re-based rather than silently closed, and the capsule epic was
closed as moot.

**The immediate aftermath** (2026-09-19) was the widest single day of work in the project — 133
commits. The wrapper design produced ADR-0019 (per-dispatcher scoped tools) and ADR-0020 (our own
frame over the shipped runtime), then tickets 77–81 built it: a shell skeleton, mounting as the
`main` page before any root election, a sidebar roster, a conversation surface and composer, and
approval cards. In parallel a fake-vs-host contract audit (86) fixed five high-risk fakes, a
React hook-order bug in the conversation seat (88) was diagnosed and pinned offline, restart
honesty got a generation counter (90), and doc tooling (96) plus the rulebook decomposition (97)
gave the project the zero-dependency lint and generated indexes it still uses.

It was also the day live evidence started to hurt: the roster channel never published, the shell
store mirror was never fed, and the composer's send died on a scope-context property read (92–94).
Each was found live, fixed, and pinned.

## Chapter 5 — Addon coexistence and the floating window (2026-09-20 to 2026-09-22)

The very next day the vehicle changed again, and this time in the opposite direction from
ADR-0018's "we build the whole UI".

**ADR-0021** (human-ruled 2026-09-20): stock dsh stays the primary UI; dispatcher functions live in
a **separate floating window**; dispatcher sessions can be added and deleted from the UI. ADR-0020's
root-frame vehicle was superseded, ADR-0018's vehicle clause was amended, and the agent-management
exception (U-G) was loosened **for dispatcher sessions only**.

Tickets 99–101 shipped it: the root election left the default posture, the floating window mounted
with crash isolation, and add/delete became real. Then the same live-test cycle found the next
layer of defects, and each is a small story about how hard a browser UI is to verify:

- drag flew across the screen because per-event deltas were applied against the drag start (103);
- summon and kill were unreachable because the delete row was hidden until hover and the client
  never declared the nested `remote.commands` face (102);
- the window could not be resized or maximized (105);
- dispatcher rows could not be closed (106);
- and the collapsed launcher, revived by human ruling as **ADR-0022** on 2026-09-22, became a
  floating draggable capsule showing `[dispatcher count | running workers]` (107).

Then the whole thing stopped. The next commit is ten days later.

## Chapter 6 — The quiet interval and the file inbox (2026-10-02)

The project resumed on 2026-10-02 with a smaller, functional piece rather than UI: **ADR-0023,
file-driven external intake**, human-ruled that day. Tickets 108–113 added an opt-in wake-coalesce
window, a spawn in-flight guard, a worker activity ring with a wake digest, wake-bus disposal
wiring, and finally the file inbox itself: an adapter watcher with claim-before-present atomicity,
an external-event wake lane, inbox-origin todos, checkpoint dedupe with boot-rescan adoption, and
deterministic dispatcher routing — disabled by default.

It is the last feature of the "plugin-only" era. Then the repo went quiet — no commits at all
between 2026-10-02 and 2026-10-20 — and when it came back, the host had been upgraded underneath it
and the research of the next chapter had been done.

## Chapter 7 — The context-cleanup research wave (2026-10-18 to 2026-10-19)

Two of the most consequential days in the project **produced no commits of their own**. Everything
below landed on 2026-10-20, inside a single checkpoint (`1cc2dfd`) — which is why that one commit
touches 396 files. The work on 10-18/10-19 was reading, measuring, and writing, and it produced two
separate streams that both changed the tree.

**The dispatcher study.** A multi-source study — this repo, the reference tree, the DeepSeek-Bot
project and its fork, and ZCode v3.15.1 — produced
`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md`. Three corrections came out
of it: peer messaging already shipped but had no discovery; no reference implementation has a
verification layer for worker output; and the reference delegates more loosely than we did — it
hands off "the problem and the outcome, not a prescription", while our spawn prompts demanded goal,
constraints, context, success criteria and report format.

The owner then made **six** decisions, and each was turned into a record **by an agent** — the human
gave the direction, not the text. Five became new ADRs: **ADR-0025** Chief-of-Staff dispatcher with
mitosis (a dispatcher may summon another dispatcher), **ADR-0026** optional chatroom broadcasting,
**ADR-0027** peer awareness pushed at the prompt tail, **ADR-0028** a worker→dispatcher mid-task
reply channel (modelled on ZCode's `RespondToCoordinator`), and **ADR-0029** deterministic
microcompact with a compaction boundary marker. The sixth, session-row indicator glyphs, was
already covered by ADR-0024's rider of the same date, so it became ticket work rather than a new ADR.

On 2026-10-19 the owner reviewed all five and **corrected them**: the drafts had hardened "adopt X"
into "do not do Y", and unnecessary prohibitions were removed. Every one of them was rewritten to
state what is adopted first, with the alternatives left open. That review is why the ADR index rows
for 0025–0029 carry the phrase "records what we adopt first, not a ban on anything else."

**The context research.** A seven-agent sweep produced `racoons-prior-art-wheels-seams-2026-10-19.md`
(prior art: the full combination is unclaimed, but each mechanism ships somewhere), plus a stack of
design notes: `segmented-compaction-design`, `shadow-janitor-design`, `compaction-stack-design`,
`cache-safe-pruning-design`, `janitor-redteam`, `janitor-swap-protocol`, `dsh-forget-proposal`, and
a measured census of the owner's own 9,667-session store (median 296k → 25k tokens thrown away per
compaction; 29.4% of dropped read bytes re-fetched afterwards).

Two facts about that body of work matter for the story:

- It is explicitly **not rulings**. Every one of those files says "evidence, not a ruling" at the
  top, and the shadow-janitor design notes that an LLM in the loop would need an explicit ADR
  amendment because ADR-0029 records "no model call decides whether, when, or what to compact."
- It grew its own product. `PRD-racoons.md` ("Remove Agent Context Overhead — Offload, Not
  Summarize", 记忆焚化工) proposes a harness-agnostic library with dsh-bot as its reference
  integration — a second product living inside this repo's vendor tree.

## Chapter 8 — Native posture, and mitosis becomes real (2026-10-20 to 2026-10-24)

The 2026-10-20 checkpoint commit (`1cc2dfd`) is the single largest behavioural change after
ADR-0018 — 396 files — and it settled the UI vehicle on the fifth posture in five weeks.

**ADR-0024** (human-ruled 2026-10-18): the dispatcher UI returns to the `e773ef8` native-dsh
posture. Stock dsh is the primary UI and the only UI. No floating window, no launcher, no capsule,
nothing of ours in dsh's layout. The override reaches UI chrome only — all functional work from
tickets 101/108/113 and every core/adapter change survives. A rider the same day licensed exactly
**one** additive registration: a small glyph in the sidebar session-row leading slot. Its addendum
recorded two verified limits that never went away: worker/subagent sessions are hidden from the
sidebar entirely, and the leading cell renders only on idle, non-archived, non-blank rows.

The reason for the reversal was not taste. It was the host version. dsh had moved from the
`0.1.5-rc.1` tree the plugin was written against to `0.2.x`, a whole minor version of drift, and
every seam the project used was pinned by `file:line` citation to the old tree. Ticket 114 was both
jobs at once: upgrade to `0.2.1-rc.2` (later `rc.3`) and re-verify every seam, while reverting the
UI. It found, among other things, that `0.2.x` resolves installation packages in memory and needed a
manual 264-junction profile repair.

**The peer tier shipped on the same checkpoint**, as tickets 115–124: settle records and
`awaitWorker` in core (115), `message_agent` with structured provenance replacing `send_peer` (116),
the `await_agent` tool (117), the `spawn_dispatcher` activation path (118), policy/PRD/CONTEXT
amendments (119), a mock-LLM end-to-end harness (120), tail-pushed peer roster (121), the
worker→dispatcher reply lane (122), session-kind indicators (123), and the microcompact boundary
marker (124).

Then the mitosis bugs started arriving, each a lesson in how the host actually behaves:

- **Ticket 130** — a spawned dispatcher had no durable identity, so a restart turned it back into
  a plain subagent.
- **Ticket 131** — the second-level spawn was *never refused*. The depth ceiling was recomputed
  from the parent's own depth on every hop, so the inequality could never become true. The only
  real bound was the host's 8-slot live-child pool. The owner ruled 2026-10-22: unbounded mitosis
  is accepted, no cap wanted.
- **Ticket 138** — a resumed spawned dispatcher could not be messaged and had no glyph.
- **Ticket 141** — the owner ruled spawned dispatchers get **one** generation line ("spawned by a
  generation-X dispatcher, is the generation-X+1 team leader"), persisted across cold resume, with
  the user's own prompt kept byte-identical.
- **Ticket 140** — the glyph question. It produced the cleanest negative result in the project:
  the licensed sidebar seat **cannot** carry the mark, because stock dsh filters every
  `origin: 'subagent'` session out before any row is built. A preset row cannot fix it either — no
  preset changes the header origin.

Ticket 143 then went upstream-hunting: can the `0.2.1` UI be patched or overlaid to make the glyph
show? The 2026-10-24 verdict was **NEEDS-RULING**: the vendored-bundle route breaches ADR-0024, the
non-fork seats are viable, and the choice belonged to the owner. Ticket 144 checked `rc.3` for
openings the same day: zero code changes needed, 37/37 e2e assertions, and no new visibility seam.

**Racoons arrived in this window too**, twice. Ticket 126 vendored a stale M1 snapshot behind an
opt-in flag, ran out of road before its live check, and was cancelled as superseded; **ticket 145**
redid it against the upstream head (`af78642`), full coverage, no session filter, mounting
unconditionally and replacing the flag with three narrower settings. It was then re-synced twice
more (148 to `b5f95cb`, then to `b838ae7`), a range of 259 commits and then 62, which is the origin
of two separate hazards now on record: the record-only flag's meaning changed upstream
(ticket 150, ruled "accept upstream"), and `git status` reports 146 modified files where only 31
carry real changes (ticket 161, still open — a `core.autocrlf` interaction with LF-pinned vendor
sources).

## Chapter 9 — Reconciliation: making the shipped thing true (2026-10-27 to 2026-10-28)

The last dense day is not a new direction. It is a sweep that made the shipped product match what
the documents claimed, much of it triggered by the owner using the thing.

- **Ticket 147/149** — the owner reported that after a dsh restart a dispatcher "loses dispatcher
  status" and the host prints "Tools updated / 10 removed". Two independent defects: the marker
  store was stamped version 1 while the code declared version 2, so every open threw; and nothing
  re-activated a user-started dispatcher on resume. Both fixed; the legacy store is now opened
  through the library's per-record bootstrap.
- **Ticket 146** — the glyph became a small animated bot portrait (inline SVG, reduced-motion safe),
  answering a 2026-10-27 owner instruction the ADR had left TBD.
- **Ticket 151** — the todo ledger was never written in live use, so the per-turn reminder was
  always empty. `spawn_worker` now auto-creates a linked ledger entry and an unknown `todo_id` is
  refused.
- **Ticket 152** — the three newest tools fell back to a generic client row.
- **Ticket 153** — model-facing copy shipped English-only while the client dictionary was en+zh.
  Fixed with real ZH policy copy, parity tests in both directions, and a sweep proving no CJK
  reaches an English face. **Ticket 154** re-ran the adapted-copy review over everything landed
  since 2026-09-19, because the only recorded pass predated tickets 116–152.
- **Ticket 155** — roster rows carried session ids only; ADR-0027 wanted a label plus current
  tool/target. The label and activity now ride the roster. One deliberate refusal is recorded: the
  ADR's `label → title → session id` chain is wired at the label step only, because the title
  projection is a mutable auto-generated conversation title that exists on every session and would
  rename every user-started dispatcher's row.
- **Ticket 140 finally closed** — with a mark that did not need a sidebar row: the existing
  `sessionKind` projection, taught to consult an adapter-side mark mirror, plus one header seat.
  Recorded as **ADR-0031, a draft**, under the owner's full-rein grant and explicitly subject to
  reversal.
- **Ticket 156** — two defects found while preparing a push: `.scratch/racoons-storage/` was
  untracked rather than ignored (a live ledger holding private session content, 31 files, 1.7 MB),
  and doc-lint read a UI slot name as a repo path.

By the end of 2026-10-28 the suite stood at 1693 tests, all green.

## Chapter 10 — The last turn: a summoned dispatcher is a parallel session (2026-10-28 onward)

ADR-0025 decision 2 already said a summoned dispatcher is "a peer of its creator, not a rank
below it", while the mechanism made it a subagent child. The owner ruled on 2026-10-28 that the
mechanism must match the intent: **a summoned dispatcher is a new top-level session parallel to its
summoner** — ADR-0032, accepted the same day, superseding ADR-0025 decision 6 for that edge only.

The feasibility work is worth recording because it changed the shape of the fix. Three research
notes (host parallel-session feasibility, cross-session delivery feasibility, repo subagent
assumptions) established:

- `ctx.agents.create()` with `parentAgent` omitted yields a visible top-level session, but the
  subagent-ownership guard is an **OR** — a parent "for convenience" silently flips it back.
- There is **no promotion path**: `origin`, `parentSession` and `delegationDepth` are
  constructor-time fields with no update API, so the session must be created right the first time.
- Appending a `user/message` into another session's log renders a row and **never wakes it**; the
  only working delivery is `resolveAgent` plus `followup`, the pattern a shipped package already
  uses on sessions it does not own.

This made the cure larger than the symptom. Four compensations had been built on top of the
subagent shape — a header chip, a `sessionKind` mark mirror, a gate-free activation entry point,
and a `spawned` policy variant — and all four became dead weight. Ticket 157 retires them. ADR-0031,
whose whole premise was "a spawned dispatcher is a hidden child with no row", was **withdrawn**
rather than edited, and the seat count returned to one.

The work is **not finished and not committed**. The tree typechecks; the suite has not been run to
green since the change; and one test file was left half-edited when the lane was stopped. On
2026-10-29 the owner ruled: stop, do not test further, file what remains. That produced tickets
158–165. The owner then ruled (2026-10-29) that a summoned dispatcher addresses its own user
directly — "its the same as any other dispatcher" (ticket 166) — and, on 2026-10-30, reported a
live rendering defect: the dispatcher tool rows render labels and values run together (ticket 169).

So the book ends mid-sentence, which is the honest place for it to end. The 13 open tickets are the
next chapter's outline.

---

## What this project actually was, in hindsight

### Three questions, each asked once and answered for good

Almost every reversal in this repo is one of three questions, and each was answered later than it
was first asked.

**1. What is the interface?** Five answers, in order:

| When | ADR | The interface |
|---|---|---|
| 2026-09-18 | 0013 | One additive capsule overlay slot inside stock dsh |
| 2026-09-18 | **0018** | We build the whole UI — a wrapper around dsh |
| 2026-09-20 | **0021** | Addon coexistence: stock dsh primary, dispatcher in a floating window |
| 2026-09-22 | 0022 | The launcher comes back as a floating capsule with live counts |
| 2026-10-18 | **0024** | Nothing at all. Stock dsh only, plus one sidebar glyph |

The last answer is the one that stuck, and it was forced by a host upgrade as much as by taste.
Each reversal is recorded as a dated note on the superseded ADR's status line rather than a rewrite
of its body — a convention the repo adopted early and kept.

**2. How does a dispatcher start?** Capture-on-load was killed on 2026-09-17, the same day it was
recognised as a hijack (ticket 19 + ADR-0009): an explicit command, and the primary chat is never
captured on load. Then no mode at all and always-on (ADR-0018), then the command's name changed to
`/dsh-bot` and the stop command was withdrawn entirely (ADR-0030, 2026-10-21). Deactivation is now
implicit: close the chat, or unload the plugin.

**3. May a dispatcher summon a dispatcher?** No for the whole first month — flat topology, workers
are leaves, only a dispatcher spawns (ADR-0003). Then yes, but as a subagent child (ADR-0025,
2026-10-18), which needed four compensations to look like a peer. Then, at the very end, yes as a
genuine parallel session (ADR-0032, 2026-10-28), which deleted the compensations.

### The method that survived everything

Four practices carried the project from the first commit to the last, and each was adopted after
something went wrong without it.

1. **Ticket before code.** No implementation without a tracker file, even for a one-line fix. 168
   ticket files exist for 420 commits.
2. **Seam, fake, offline test.** The core never needs dsh or a model to be verified. The suite grew
   from 9 tests on day two to 1,693 at the end.
3. **Live truth is separate from offline truth.** Tickets 43–49, 84–94, 102–107 and 169 all found
   defects that offline tests could not: the host half never ran, a command registration was a
   silent no-op, a service property read threw, a slot never mounted, a row rendered unreadable.
4. **A premise gets verified before a decision is recorded.** This one was bought with the
   project's worst mistake — ADR-0016's fabricated directive — and it is now the reason the
   authority stack exists and why ADR-0016 is kept in the index rather than deleted.

### What is deliberately absent

The non-goals never moved: no rebuilding of dsh's inference, transcript or tool runtime; no remote
sandbox; no binary or UI parity with the reference. The exception list in ADR-0018 is exhaustive,
and everything not on it is imitated. Several large areas were examined and then **descoped on
evidence** rather than abandoned silently: the remote-computer area is recorded capability-blocked
at the host (U-I, 2026-09-19); the chatroom channel is accepted but deferred; and the whole context-
cleanup product line lives in `PRD-racoons.md` with its own repo planned.

### Where the numbers went

| Date | Milestone | Tests |
|---|---|---|
| 2026-09-16 | Ticket 01 scaffold | 9 |
| 2026-09-18 | Wrapper merge `400450f` | 701 / 185 suites |
| 2026-09-19 | Live-pass fixes 92–94 | 1,098 / 267 suites |
| 2026-09-20 | Rulebook + doc tooling | 1,118 / 271 |
| 2026-09-22 | Floating capsule | 1,216 / 298 |
| 2026-10-02 | File inbox | 1,284 / 318 |
| 2026-10-21 | Racoons lane merge | 1,352 / 332 |
| 2026-10-24 | rc.3 compatibility | 1,556 |
| 2026-10-24 | Generation line (141) | 1,566 |
| 2026-10-28 | ZH model-facing copy | 1,658 |
| 2026-10-28 | Last green run (156) | 1,693 |

The ticket-157 change is unverified against this baseline: it typechecks, but the suite has not been
run to green since, and ticket 162 records an intermittent inbox e2e failure that appears only in
the full suite.

---

## Appendix — where to look for what

| If you want… | Read |
|---|---|
| Why a decision was made, and whether it still stands | `docs/adr/README.md` — the index rows carry every supersession and dated note |
| What the product is supposed to do | `PRD-dsh-multitask-dispatcher.md` |
| What the product did at a given moment | `Issue-tracker/resolved/` and `Issue-tracker/cancelled/` — 154 closed ticket files with dated comments and commit hashes |
| What is still open | `Issue-tracker/open-issue-index.md` (generated) |
| The rules agents work under, and which document outranks which | `docs/agents-rulebook.md` |
| What the shipped UI does and does not show | `docs/surfaces.md` |
| The evidence behind a decision | `docs/research/` — 43 notes, evidence and never rulings |
| The dispatch/worker machinery drawn out | `docs/diagrams/reference-agent-runtime.html` (with the caveat on ticket 160) |
| The second product | `PRD-racoons.md`, `vendor/racoons/PROVENANCE.md`, `docs/research/racoons-*.md` |
| Copy-policy history | `read-before-reference-tree-work.md`, `docs/research/no-verbatim-copy-review-2026-09-19.md`, `-2026-10-28.md` |

### How this book was verified

Every date, commit hash, ticket number and test count above was read from the repository at
2026-10-31: `git log --reverse` for the commit spine and per-day density, the ADR index for status
and supersession, the ticket files for the "why", `vendor/racoons/PROVENANCE.md` for the upstream
pins, and `package.json` plus a file count for the current scale. Where two records disagreed
(e.g. the earlier racoons reports naming `536e340` or `3578f23` against the actual `af78642`), this
book follows ticket 145's resolution: the value that `git rev-parse HEAD` returned on the date is
the one recorded.

Corrections are welcome and cheap: each chapter names the files that own its claims.
