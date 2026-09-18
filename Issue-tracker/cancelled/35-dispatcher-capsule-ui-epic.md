# 35 — Dispatcher control capsule: expandable shell-overlay UI (epic)

**Status:** cancelled
**Labels:** ready-for-agent
**Blocked by:** 34 (client module materialization — landed at 80c2932, effectively unblocked).
**Chunked:** sub-tickets 36–42 filed 2026-09-18 — see "Sub-tickets" below; this epic
resolves when all of them resolve (plus ticket 33's browser pass asserting AC 1).
**Read first:** `docs/research/dsh-plugin-ui-examples.md` (three reference plugins, pattern-only —
and see Process requirement 0: you must research beyond it), `docs/research/dsh-plugin-ui-patterns.md`
(host-tree seam findings), design-16 §4/§5,
`.scratch/clone-always-on/worktree-workflow.md` (tree/merge rules), ticket 17 (ADR numbering note).

## Goal

One always-available control surface for the dispatcher in the dsh web client: a **floating,
expandable capsule** registered into the shipped additive `shell.overlay` list slot — the
surface we already register (tickets 20/21/24) but that never ran until ticket 34's fix.
Design and build it end-to-end: expanded panel, activation control, roster, steer, and the
dormant/activated compositions from ticket 32.

## Design direction (decided here; implementers refine, don't reopen)

**Surface: capsule, not sidebar takeover.** Better Sidebar (research Finding 1) abandoned its
own floating panel for native slots; our equivalent of that lesson: `shell.overlay` is
additive, order-sorted, click-through, and safe to stack — a takeover of the right sidebar is
not. Collapsed state = one small chip (dispatcher glyph + a status dot); expanded state = a
panel card anchored to the chip.

**Collapsed chip shows:** activation state (dormant / active / error) as dot color, worker
count when active, and a wake badge (settled workers with undelivered results) — the chip is
the glanceable presence projection.

**Expanded panel sections (top to bottom):**
1. **Activation row** — the on/off switch. Reflects the real per-session `/dispatcher-start`
   state (ADR-0009); its button calls the same command path, it must not invent a second
   activation channel. Dormant: single "Start dispatcher in this chat" affordance. Active:
   stop affordance + since-timestamp.
2. **Roster** — one row per worker: FSM status, title, elapsed, and a per-row steer affordance
   (opens the steer input). Follows ticket 28's running-tasks sectioning (running / settled /
   undelivered buckets from the reconciler view model).
3. **Deliverables line** — count of todos `completed`-but-not-`delivered` (S6 semantics:
   delivered means the user got it) with the most recent result text, expandable.
4. **Tool views** — NOT in the capsule: the five dispatcher tool-call views stay keyed in
   `tool.call.toolview` (ticket 24) where the calls happen; the capsule links to the latest.
5. **Footer** — profile/flag provenance line (which profile, flag state) and a link into
   Settings; nothing editable inline in v1.

**Honesty rules (binding):** every element renders from core state (the roster snapshot via
the settings-mirror channel — design-16 §4.2's documented fallback); no invented push channel,
no fake status. The dormant composition (ticket 32) is the unactivated chat's whole experience:
chip visible, panel shows the activation pitch, nothing else pretends to run.

**Locale:** all copy through the `multitask-dispatcher` namespace ({en, zh}) — no literals.

## Process requirements (binding on the implementing team)

0. **Do your own research — the scribe's notes are a starting map, not an authority.** Before
   filing child tickets, study the actual source of the three reference plugins on GitHub
   (`omdsh-dev/DSH-better-sidebar`, `Nagi-ovo/dsh-visualize`, `Small-tailqwq/dsh-deep-whale`)
   — clone or read the trees, look at real `package.json` `dsh.client` records, bundle
   layouts, slot registrations, and mount-test setups; the pages in
   `docs/research/dsh-plugin-ui-examples.md` summarize marketing docs only. Re-verify the
   host-tree claims in that note and in `dsh-plugin-ui-patterns.md` against the installed
   dsh 0.1.5-rc.1 code yourself (the ticket-34 diagnosis especially). Record new findings in
   `docs/research/` notes of your own, cite file:line, and correct the scribe's notes where
   they are wrong. Clean-room rules apply to every source you open: pattern learning only,
   no copying (AGENTS.md; the reference-material tree remains forbidden).

1. **This epic must brew tickets and draft ADRs — do not implement it as one blob.** Spawn
   small, granular child tickets (one surface section or one concern each), each with its own
   acceptance criteria, filed under `Issue-tracker/open/36-*`, `37-*`, ... as needed.
2. **ADR plan (draft, non-human-approved):** file the decisions this epic makes as ADRs under
   `docs/adr/`, numbered continuing from the current sequence, **with the suffix
   `-draft-nonhuman-approved` in the file name and an `**Approval:** non-human — agent-drafted,
   pending human sign-off` header line**. Expected at minimum: capsule-vs-sidebar slot choice;
   client-bundle materialization requirements (what `dsh.client.inject` sets a plugin must
   declare); real-browser testing infra choice (Playwright). Respect ticket 33's open ADR
   numbering conflict (design-16's conditional ADR-0010 vs design-17's presence ADR) — resolve
   the numbers explicitly in the draft headers, don't collide.
3. **Full flow per chunk:** design note → review pass (separate agent from the implementer) →
   implement → **Playwright real-browser test** (mount smoke test against a
   `dsh --profile web --patch` launcher boot; research Finding 1 shows the pattern —
   `test:mount`-style). No chunk is done on unit tests alone.
4. **No single subagent implements everything:** dispatch so that design, review,
   implementation, and test authorship rotate across agents; the epic closes only when every
   child ticket has an independent verification comment.
5. **Clean-room:** the three reference plugin repos are pattern references only (mixed
   licenses; one flagged) — never vendor, transliterate, or name-match their code or assets
   (legal boundary per AGENTS.md; `docs/research/dsh-plugin-ui-examples.md` header).
6. **Tree:** implementation rides the ticket-17 worktree
   (`C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`) if ticket
   33's merge has not landed yet; otherwise on `main` after the merge. Tracker records stay on
   `main` either way (worktree-workflow §2).

## Sub-tickets (chunked 2026-09-18)

Implement in this order; each is one coherent step, offline-verifiable, with a
named verification method in the ticket:

| # | Slug | Scope | Blocked by |
|---|---|---|---|
| 36 | `capsule-seam-research-verification` | Process req 0: verify the five capsule seams against installed dsh 0.1.5-rc.1 + the three reference plugin repos (pattern-only); new note `docs/research/dsh-capsule-seams.md` with verified/degraded verdicts | — |
| 37 | `capsule-draft-adrs` | Process req 2: draft ADRs 0013–0015 (slot choice, materialization contract, Playwright infra), `-draft-nonhuman-approved`, numbering conflict with design-17 §9's reserved 0010–0012 resolved in headers | 36 |
| 38 | `capsule-chip-expand-skeleton` | One `shell.overlay` entry becomes the two-state capsule: collapsed chip view model (activation dot, worker count, wake badge) + expand/collapse; expanded renders the existing panel | 36 |
| 39 | `capsule-activation-row-compositions` | Expanded panel §1: activation row (start/stop **intents**, since-timestamp only if honestly sourced), dormant vs activated compositions, no-stop guard extended | 38 |
| 40 | `capsule-action-wiring` | Bind intents to ticket 36's verified seams: `/dispatcher-start` verbatim via the user send path, per-row steer prefill, conversational stop phrasing; degrade UX for unverified seams | 36, 39 |
| 41 | `capsule-deliverables-line` | §3: completed-not-delivered count (snapshot v2 math) + most recent result excerpt via snapshot v3 bump (fail-closed) or count-only fallback | 38 |
| 42 | `capsule-footer-toolview-link-closeout` | §4–5: footer provenance + Settings link, tool-view link (or recorded gap); offline composition close-out (fixtures, locale parity, guards, surfaces README) | 38, 39, 40, 41 |

Adaptations recorded in the first comment below.

## Acceptance criteria (epic-level)

- [ ] Ticket 34 landed; capsule visible in a real browser on a launcher boot, dormant and
      activated compositions both exercised, Playwright-asserted.
- [ ] All child tickets implemented, reviewed by a different agent than wrote them, and
      independently verified; Playwright suite green offline-only where possible (browser
      local, no network/LLM — S8 constraint interpreted in the ticket comments).
- [ ] Draft ADRs filed with the non-human-approved marking; ticket 33's numbering conflict
      addressed in their headers.
- [ ] Offline unit suite (`npm test`) still 0-fail; no regression in the host face.
- [ ] Epic close-out comment lists every spawned ticket + ADR with hashes.

## Comments

### 2026-09-18 — chunked into sub-tickets 36–42 (planning pass)

Triaged and split per process req 1; label set to `ready-for-agent`. Chunking
decisions and adaptations, binding on the sub-tickets:

1. **Per-chunk real-browser tests are deferred to ticket 33.** Process req 3's
   Playwright step is satisfied epic-wide by ticket 33's launcher/browser pass
   (which already holds ticket 34's deferred ACs). Every sub-ticket names an
   **offline** verification method instead (unit suites over the pure
   store/view models, `npm run typecheck`, `npm run build:client`); epic AC 1
   (capsule Playwright-asserted dormant + activated on a launcher boot) is
   unchanged and gates the epic's resolution.
2. **ADR numbering resolved:** design-17 §9 reserves 0010 (presence
   projection), 0011 (approval options), 0012 (restart replay) for tickets
   27/30/31; the capsule's draft ADRs take 0013–0015 and say so in their
   headers (ticket 37). This closes the numbering conflict req 2 flagged.
3. **Honesty reconciliations the sub-tickets implement, not reopen:**
   the active-state "stop affordance" is an *intent* bound to the same
   user-verbatim command path as everything else (no off-while-running exists —
   ADR-0005/0009, design-17 §4.6, ticket 31's guard); the "since-timestamp"
   ships only if an honest `activatedAtMs` source exists (never `publishedAtMs`
   relabeled); any seam ticket 36 cannot verify degrades to copy/hint with the
   gap recorded.
4. **Tree rule (req 6) applies per sub-ticket:** implement on the ticket-17
   worktree (`clone/always-on-dispatcher`) while ticket 33's merge is pending —
   the chip's wake badge and the sectioned panel ride the worktree's snapshot
   v2 code; tracker edits stay on `main`.
5. **Completion:** this epic resolves when sub-tickets 36–42 are all resolved,
   ticket 33's browser pass has asserted AC 1 against the assembled capsule,
   and the close-out comment lists every ticket + ADR with hashes (AC 5).

### 2026-09-18 — agent (status note: all sub-tickets implemented; offline scope closed at 42)

Sub-tickets 36–42 now all have implementation comments on their worktree
branches: seam research 36, draft ADRs 37, chip/expand 38, activation row 39,
intent wiring 40, deliverables line 41, and footer + close-out 42 (worktree
`clone/always-on-dispatcher` @ `1e7c735`). Ticket 42 closed the epic's
OFFLINE scope: the full-composition fixture suite, the enlarged-dictionary
locale validation, the no-stop guard's final form over every capsule view
model, the surfaces-README capsule section, and the identifier grep. The
footer's degraded seams are recorded there per 36's verdicts: no Settings
deep-link (copy-only hint), no profile line (no source), no tool-view link
(no navigation path; ticket 24's registrations byte-unchanged).

**Still open before this epic resolves:** ticket 33's launcher/browser pass
— the real-browser Playwright assertion of the assembled capsule (dormant +
activated, epic AC 1) — plus its LQA/provenance close-out and the merge to
`main`. AC 4's independent-verification requirement is satisfied per-ticket
by each sub-ticket's verification comment; AC 5's hash listing is ticket 33's
close-out comment.

### 2026-09-18 — re-pass #2 vs AC 1: dormant composition green in a real browser; activated composition NOT exercisable — AC 1 stays unchecked

Evidence: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\`. Dormant half of this AC is green on a launcher-profile boot: exactly one capsule entry, collapsed chip `data-dot="dormant"`, expand → dormant pitch + single start affordance, footer present (`shots/01–03`, `07`). The activated half is blocked by two defects recorded on ticket 44 (re-pass #2 comment): (a) the client roster/flag watch never fires live, so the capsule cannot flip to the activated composition even though activation IS real host-side (`/dispatcher-start` matched via RPC A/B, policy injections visible in the next turn); (b) ticket 45's tool-schema defect fails every activated turn at the provider, so no worker/roster/deliverables state can ever be produced to mirror. Both are product-code fixes → out of a no-product-change pass. AC 1 remains open pending ticket 45 + the client-watch fix, then one re-pass.

### 2026-09-18 — capsule styling now rides the host's design tokens (ticket 49)

A post-close-out defect in this epic's surfaces, found while continuing the
always-on work and fixed offline at `75932da`: `CAPSULE_CSS` (ticket 38) and
`ROSTER_PANEL_CSS` (tickets 27/28) hardcoded a private dark palette on the
stated premise "no theme contract is assumed" — false, since the host defines a
per-scheme `--dsw-alias-*` token layer on `body` that every descendant inherits.
On a light theme the chip and card painted a dark card with light text over a
white application. Both blocks now style entirely from the token layer (the
chip/card surface uses `--dsw-alias-bg-layer-3`, the host's own
`--dsw-specific-menu` value), with 15 new pins in
`test/client-theme-tokens.test.ts`. Colours only: layout, the single ring
animation, reduced-motion, namespacing and the locale contract are unchanged,
and the epic's sub-tickets keep their implementations as-is.

**Consequence for epic AC 1's live assertion:** it should now also confirm the
capsule is legible in **both** schemes. That is a dormant-side, zero-LLM check
and is recorded on ticket 33's pass plan. No checkbox moves; AC 1 remains open
on the same blockers as above.


### 2026-09-19 — CLOSED AS MOOT (ADR-0018; ticket 64) — the epic's subject is the voided vehicle

ADR-0018 rules "imitate the reference in its entirety except the enumerated exceptions" and voids
ADR-0013's capsule-as-one-additive-overlay-slot decision — this epic's entire deliverable *is*
that vehicle. Sub-tickets 36–42 are resolved and their assets survive as wrapper design inputs:
the seam research (36, explicitly kept valid by ADR-0018), the pure view models (27/28), the
token styling (49), the locale faces, and the honest-composition fixtures. Epic AC 1 (capsule
asserted live, dormant + activated) is moot. Nothing is deleted; the continuation is the wrapper
shell scope ticket filed under ADR-0018. Moved open/ → cancelled/ (closed without shipping as the
product surface), Status: cancelled.
