# 71 — Remote computer / bots' desktop area (ADR-0018 in-scope area)

**Status:** blocked — capability gate FAILED (AC-1, 2026-09-19): the dsh host exposes no remote-execution / computer-use / browser-automation face (verdict + citations in the gate comment below). Awaiting the human decision: host-seam request vs descope-with-gaps.
**Labels:** ready-for-human
**Blocked by:** human decision (see the 2026-09-19 gate comment). Previously: none for the gated research pass — 67 resolved (ADR-0020); the absent-branch halt pre-sanctioned by the triage brief and this ticket's no-fantasy constraint has now executed.
**Related:** ADR-0018 (in scope: "the remote computer / bots' desktop area (dedicated computer/browser worker types, remote-box approval surfaces with location labels, recording/teaching, remote/cloud jobs)"; exceptions C15, U-D), `docs/research/always-on-dispatcher-behavior.md` area 6 (remote-box cards), 30 (location-line re-base), `docs/research/prd-vs-reference-capability-gaps.md` (remote-box notes)

## Problem

The reference ships a desktop/computer area: dedicated computer and browser worker types, actions
that run on "the product's computer" (remote box) with location-labeled approval cards,
recording/teaching flows, and remote/cloud jobs. ADR-0018 brings the area in scope — with the
exception list constraining it.

## What to do (research/design ticket)

- [x] Verify the reference's remote-box surfaces from the research notes (computer/browser worker
      types, location labels, recording/teaching — cite file:line; never open the reference tree)
      and reconcile with `prd-vs-reference-capability-gaps.md`'s remote-box rows.
      (Done 2026-09-19 with the binding shallow-depth caveat — AC-2 table in the gate comment.)
- [x] Sort the area against the exception list, explicitly:
      - **C15 is binding:** remote/cloud jobs are NOT wake kinds — the single wake kind stays
        dispatched workers; if computer/browser workers exist, they flow through the same
        dispatched-worker wake pipeline or the conflict goes to the human.
      - **U-D is binding:** remote-box "always allow" stays session-scoped.
      - Location labels are IN (they are named in ADR-0018's in-scope sentence) — ticket 30's
        constant "Runs on your computer." line re-bases to per-producer-kind honest labels.
      (Recorded 2026-09-19 — AC-3 in the gate comment.)
- [x] Recording/teaching: scope what "recording a computer session for replay/teaching" means on
      dsh; mark what has no honest seam rather than inventing one.
      (2026-09-19: GAP — no honest seam exists; AC-5 in the gate comment.)
- [ ] Draft implementation ACs once 67's vehicle is decided.
      (Gated out for this pass 2026-09-19: AC-1 verified no host capability, and the brief
      scopes implementation ACs to capabilities that verified — none of this area's did.
      The capability-independent AC-4 label design is recorded and folded into 81.)

## Constraints

- The remote box is dsh/host capability first: if the host offers no remote execution surface,
  the finding is recorded as a blocker — do not spec against fantasy.
- New or adapted copy only.

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

Vehicle decided (draft): **ADR-0020**. Your surfaces land inside the wrapper: remote-box
approval cards are ticket 81's card system with your location labels; computer/browser worker
monitoring renders in 80's conversation surface and 79's sidebar presence. C15 binding
unchanged: computer/browser workers must flow the dispatched-worker wake pipeline or escalate
to the human. The dsh-host capability check remains your first AC — the wrapper adds no
execution capability of its own.

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent, capability-gated)

Verdict (a) — as a bounded research pass whose FIRST AC is the capability gate. The gate is
agent-doable read-only work, which is why this is (a) rather than (b); the escalation it may
produce is pre-sanctioned by this ticket's own constraint ("do not spec against fantasy").
Triage pre-read of the research notes: **no dsh remote-execution / computer-use face is
recorded anywhere** — `dsh-extension-surface.md`'s facility inventory has none;
`dsh-adapter-api-notes.md:296-305`'s sandbox modes are LOCAL. Reference-side depth is also
limited: `always-on-dispatcher-behavior.md` Status lists the remote-box/computer area as
"covered shallowly". Both honesty limits bind the brief. Expected branch: the gate fails →
record the blocker, escalate to the human (request a dsh host seam, or descope with recorded
gaps); the location-label re-base (AC 4) proceeds either way.

**Agent-ready brief**

- **Scope-in:** the capability gate (read-only installed host, file:line); reference
  verification from the notes with the shallow-depth caveat; the explicit exception sort
  (C15 / U-D / location-labels-IN); recording-teaching scope-or-gap; implementation ACs ONLY
  for capabilities that verified.
- **Scope-out:** spec against an unverified host face; remote/cloud jobs as wake kinds
  (C15 — conform or escalate); persisted always-allow (U-D); retry/reconnect-style failure
  UX on unreachable-box states (the conservative U-A reading of ticket 82's interim rule:
  honest copy, no retry affordance); inventing host seams (that request belongs to the
  human).
- **Builds on:** `docs/research/dsh-extension-surface.md` (facility inventory — the
  negative-evidence starting point), `dsh-adapter-api-notes.md` (sandbox = local),
  `always-on-dispatcher-behavior.md:51` + `:32` (remote-box card labels; typed running-tasks
  rows incl. remote/cloud jobs — C15-excluded), `reference-behavior-notes.md:60` (dedicated
  computer/browser worker types and their tool exclusion set),
  `prd-vs-reference-capability-gaps.md` ("deliberately out of scope" remote-box rows),
  `src/adapter/access-prompt.ts:104` (ticket 30's constant location line this ticket
  supersedes), rendering homes per ADR-0020's hand-off: 81's cards + 80/79 surfaces.
- **ACs:**
  1. **GATE — dsh host capability verification** (read-only, file:line): does any
     remote-execution / computer-use / browser-automation face exist? Outcome (i) absent →
     STOP: record the blocker here, draft the ready-for-human escalation (host-seam request
     vs descope-with-gaps), proceed only with AC 4. Outcome (ii) present → proceed to ACs
     2–3, 5.
  2. Reference verification table with the shallow-depth caveat; reconciled against the
     capability-gaps remote-box rows; no invented reference detail.
  3. Exception sort recorded: C15 (computer/browser worker types flow the dispatched-worker
     wake pipeline or the conflict escalates), U-D (remote-box always-allow stays
     session-scoped), location labels IN (named in ADR-0018's in-scope sentence).
  4. Location-label re-base design (capability-independent): per-producer-kind honest
     labels superseding 30's constant "Runs on your computer." line
     (`APPROVAL_LOCATION_LOCAL`), hooked into 81's card contract; offline-testable.
  5. Recording/teaching scope-or-gap record; implementation ACs for branch (ii) only;
     live-only ACs marked for the 45/33 lane.
- **Risks:** the likely branch is the blocker (pre-recorded so dispatch is not surprised);
  the reference research here is inventory-grade, not walkthrough-grade — cite or omit.
- **Size:** S for the gated research pass + AC 4; the remainder is contingent — do not
  estimate until AC 1 resolves.

### 2026-09-19 — agent (AC-1 GATE verdict: **ABSENT** → blocker recorded, escalated ready-for-human; ACs 2/3/4/5 closed as docs)

**AC-1 — GATE: ABSENT.** Read-only sweep of every installed package under
`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\` (~180 packages: package.json
manifests + `lib/types` declarations; no reference tree opened). No remote-execution,
computer-use, or browser-automation face exists. Decisive citations:

- **Every "remote" in the host is Client↔Host transport** — the *web client* remoting into the
  *local* host, not the host executing on a remote box:
  - `dsh-api-gateway/lib/types/stream-protocol.d.ts:4` — `REMOTE_STREAM_MUX_PATH =
    "/api/remote.mux"`, "Exact WebSocket route carrying every Typert Remote stream" (ticket
    67's seam). Pure transport: reconnect generations, ready frames, event-result RPCs.
  - `dsh-api-remotes/package.json` — "Remote BFF assembly for application-selected Host
    capabilities". Its complete forwarded-event allowlist
    (`dsh-api-remotes/lib/types/remote-events.d.ts:12-69`) is UI/status only:
    `approval/request`, `user-questions/request`, `api-session/*`, `commands/change`,
    `settings/document-updated`, `llm/adapters-updated`, `cordis/*`,
    `goal/activation-changed`, `credentials/reference-updated`, `agent-preset/selected`.
    **Nothing execution-shaped rides the mux.**
  - `dsh-api-session-controller/lib/types/client/sessions/session.js:293` —
    `this.remote.commands.execute(...)` is the web client admitting a slash-command line into
    the host-local session executor ("pure admission semantics"); not remote-box execution.
- **Every execution seam ships local implementations only** (abstract seams, local-only impls
  installed): `dsh-shell` (`ctx.shell`) → `dsh-bash-local` ("Local-subprocess implementation"),
  `dsh-pwsh-local` ("Local PowerShell implementation"), `dsh-bash-sandbox`/`dsh-pwsh-sandbox`
  ("Sandbox-consuming ... confines every command via ctx.sandbox"). Sandbox backends
  (`dsh-sandbox-local` package.json): "bwrap, ... landlock-run launcher, macOS Seatbelt, or the
  Windows ACL restricted-token runner". `dsh-jobs-local`: "Process-local implementation" of
  `ctx.jobs`; job types carry no remote/cloud/location vocabulary. `dsh-terminal`/
  `dsh-terminal-bash`: local PTY; `dsh-tmux-context`: pane-location bookkeeping only.
- **The host documents the absence itself** — `dsh-sandbox/lib/types/index.d.ts:3` (same text,
  `dsh-sandbox/lib/index.js:167`): the confinement seam "shares the host kernel and filesystem";
  "**Containers, microVMs, and remote execution replace the surrounding capability seam
  instead**" — i.e. remote execution is named as a *different, not-present* capability family.
- **No computer/browser automation**: no computer/screenshot/screen-control package anywhere;
  the only "screenshot" hit in shipped code is UI copy (`dsh-web-app/lib/index.js`: "The browser
  provides no implicit DOM, route, or screenshot context"); `dsh-web` is a search/fetch provider
  registry; `dsh-acp` is "Automation-only Agent Client Protocol server ... over JSON-RPC stdio"
  (local automation of dsh agents). The only computer-use-shaped types in the tree are vendored
  third-party LLM SDK request schemas (`@anthropic-ai/sdk` beta computer-use tool types) —
  not a dsh face. `dsh-fs/lib/types/index.d.ts:78`'s "remote/sandboxed backend" is a
  hypothetical-backend caveat in the FsTarget mapping contract; installed fs backends are local.

Searches run (all negative beyond the above): package descriptions for
remote/exec/control/computer/screen/automat/mux vocabulary (0 hits for cloud/remote-box);
`computer|screenshot|browser.automation` over all `.d.ts`; `remote` over every `lib/types` tree
(all hits in the gateway/remotes/stream transport family); explicit
`remote.?exec|remote.?shell|remote.?command|remote.?sandbox|remote.?computer|remote.?box|computer.?use`
sweep (all hits resolved above). Verdict is firm, not UNCLEAR.

**Blocker (ticket constraint "do not spec against fantasy"):** ADR-0018:16 brings "the remote
computer / bots' desktop area" in scope, but the host cannot carry it: there is no surface on
which a remote-box action would run, and the wrapper adds no execution capability of its own
(2026-09-19 vehicle hand-off comment). Record: **the area is capability-blocked at the host.**

**Ready-for-human — decision requested (pick one):**
- **(a) Host-seam request:** ask the dsh host lane for a remote-execution / computer-use
  capability family (e.g. a remote provider behind an existing seam — remote `ctx.shell` /
  sandbox provider, or a computer-use tool family). Everything below stays design-only until
  one lands; this ticket re-opens when it does.
- **(b) Descope-with-gaps:** record the area as capability-blocked in the ADR-0018 ledger
  (mirroring `prd-vs-reference-capability-gaps.md:4,82`, whose exclusion was capability-honest
  all along), keeping only the capability-independent slice live (AC-4 location labels, folded
  into 81).

**AC-2 — reference verification table.** Binding caveat: the remote-box/computer feature area is
"covered shallowly (structure confirmed, behavior not fully walked)"
(`always-on-dispatcher-behavior.md:105`) — this table is inventory-grade, not walkthrough-grade;
cited or omitted, nothing invented:

| Reference surface (as recorded in the research notes) | Citation | Gate outcome |
|---|---|---|
| Dedicated computer/browser worker types; the worker exclusion set strips spawn/user-facing tools but workers keep "the computer/browser tools" | `reference-behavior-notes.md:60` | No host computer/browser tool family exists (AC-1); nothing to gate workers onto |
| Risk-gated approval cards typed by surface, incl. "remote-box command/computer action (labeled as running on the product's computer)" with a local-vs-remote location line | `always-on-dispatcher-behavior.md:51` | Card/label concept adoptable capability-independently (AC-4); the remote half has no surface to label |
| Running-tasks rows typed by kind: "dispatched worker, background one-shot command, remote/cloud job" | `always-on-dispatcher-behavior.md:32` (also `:97`) | "remote/cloud job" kind excluded by C15 anyway; `dsh-jobs-local` is process-local |
| Per-surface location labels ("runs on your computer" vs the product's remote computer) + session always-allow | `always-on-dispatcher-behavior.md:96` | Labels IN via AC-4; always-allow already shipped session-scoped (ticket 30, U-D-exact) |
| Recording/teaching, VNC/box surfaces | `prd-vs-reference-capability-gaps.md:82` | GAP — see AC-5 |

Reconciliation with the gaps doc: `:4` scopes the project to "local dsh deployment; ...
remote box / computer-use infrastructure excluded" and `:82` lists "remote sandbox & computer-use
(box, VNC, recording/teaching) ... browser/computer tooling" as present-in-reference but
excluded-from-PRD. ADR-0018:16 re-admitted the area as scope; AC-1 shows the admission is
aspirational until the host grows a seam — the gaps doc's exclusion remains the capability truth.

**AC-3 — exception sort (explicit):**
- **C15 (ADR-0018:30, binding):** remote/cloud jobs are NOT wake kinds; the single wake kind
  stays dispatched workers. Should computer/browser worker types ever land, they flow the
  dispatched-worker wake pipeline (spawn → ledger → running-tasks → completion delivery) or the
  conflict escalates to the human. The reference's third row kind ("remote/cloud job",
  `always-on-dispatcher-behavior.md:32`) is excluded, not adopted.
- **U-D (ADR-0018:37, binding):** remote-box "always allow" stays session-scoped, never
  persisted, no settings-managed rule store. Ticket 30's session rows + clearance are the exact
  shape; 81's cards inherit it unchanged.
- **Location labels IN** (named in ADR-0018:16's in-scope sentence): AC-4 below. Honesty rider
  from AC-1: until a non-local producer kind can exist, the only honest label for every real
  producer is the local one — the re-base must not fabricate a remote claim.

**AC-4 — location-label re-base DESIGN (capability-independent; recorded here, implementation
folded into 81).** Supersedes ticket 30's constant line:
- Current state: `src/adapter/access-prompt.ts:104`
  `export const APPROVAL_LOCATION_LOCAL = "Runs on your computer.";` applied at `:246-247` to
  every prompt detail — constant by documented design ("workers are local dsh child sessions
  ... until a non-local producer kind ever lands", `:98-103`).
- Re-base: replace the single constant with a per-producer-kind label map — dispatched worker
  (local dsh child session) → "Runs on your computer."; computer-worker / browser-worker →
  "Runs on the product's computer (remote box)."; unknown/unrecognized kind → fall back to the
  local line (honest default; never claims remote without a verified kind). All copy adapted,
  design-17 §7 `approval.location.*` family — no reference text.
- Resolution is a pure function of the ask's producer kind, resolved at render. Two render
  homes: (1) the shipped prompt pathway keeps working with the map (today's constant line
  becomes its local entry); (2) ticket 81's card contract carries the resolved label per card —
  the hook point the 67 hand-off names. A dated pointer comment is filed on 81.
- Offline-testable when implemented: pure kind→line mapping; tests assert per-kind lines, the
  unknown-kind fallback, and that no remote line can render while only local kinds exist.
- This is a code change, so per the brief's gating it is NOT implemented in this pass: the
  design stands either way, implementation rides 81's card re-host (or the prompt pathway if
  that ships first).

**AC-5 — recording/teaching scope-or-gap:**
- Scope: nothing. Recording a computer session for replay/teaching requires a
  capture/control seam (screen observation, input replay); AC-1 found none. The PRD persistence
  rule (use the dsh session/job store; no second transcript DB) also forbids inventing a
  parallel recording store. GAP recorded: **recording/teaching has no honest seam on dsh**;
  reference-side depth is likewise shallow (`always-on-dispatcher-behavior.md:105`).
- Implementation ACs: none drafted — the brief scopes those to capabilities that verified, and
  none of this area's did. No live-only ACs exist to hand to the 45/33 lane.

**Final state:** ACs 1 (verdict), 2, 3, 5 closed; AC 4 closed as design (implementation → 81);
implementation ACs for the area gated out. Ticket blocked on the human decision (a) vs (b);
labels → ready-for-human.

### 2026-09-19 — agent (AC-4 implemented via 81: the location-label map is code)

Landed as **e9f18ab** ("Ticket 71 AC-4 via 81"): `approvalLocationLineFor`
in `src/adapter/access-prompt.ts` — dispatched worker + every unknown kind →
the local line (`APPROVAL_LOCATION_LOCAL`, kept as the map's local entry),
computer-worker / browser-worker → `APPROVAL_LOCATION_REMOTE`
("Runs on the product's computer (remote box).", adapted copy). The shipped
prompt pathway resolves its detail line through the map (byte-identical
output today) and 81's card contract carries the resolved label per card
through the `locationFor` hook (`src/client/approval-cards.ts`,
`defaultLocationFor`). Tests pin per-kind lines, the unknown-kind fallback,
and that no remote line renders while only local kinds exist. Capability
truth unchanged: AC-1's gate verdict stands, the ticket stays blocked on the
human (a)-vs-(b) decision — the map is naming, not a claim.
