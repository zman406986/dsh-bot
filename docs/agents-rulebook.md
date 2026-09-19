# dsh agents rulebook

The authority stack, reading order, and moved-rule register for agent work in this repo. Ticket 97 (2026-09-20) decomposed the old wall-of-text `AGENTS.md` into this rulebook plus per-activity `read-before-*.md` guides; nothing was deleted — every old rule is either located here in the register, moved unmodified into a guide, or already had its authoritative home in a higher document that this rulebook points at.

**Why this file is tracked:** `AGENTS.md` is git-ignored (`.gitignore`, local-only). Moving the rules into tracked files (`docs/agents-rulebook.md`, the `read-before-*.md` guides, `Issue-tracker/issue-tracker.md`) is what makes the rulebook durable and reviewable; `AGENTS.md` remains only as a local thin pointer stub so agents that read it first still land correctly.

## Reading order

1. `AGENTS.md` — the local stub: current state, type-of-work routing, stack summary.
2. `docs/agents-rulebook.md` — this file: the authority stack, settled conflicts, moved-rule register, environment/network rules.
3. `CONTEXT.md` — the shared-language glossary; use its vocabulary.
4. `PRD-dsh-multitask-dispatcher.md` — product behavior, scope, success criteria S1–S9. Read before any implementation work.
5. `docs/adr/README.md` — the index of every recorded decision; read the ADRs that touch your area before working in it.
6. The type-of-work table (below, and in `AGENTS.md`) — the guide for your activity.
7. `Issue-tracker/issue-tracker.md` — the tracker guide. Log an issue before implementing anything.

For behavior the PRD leaves open, the reference is the feature inventory (ADR-0004), and ADR-0018's exception list is the exhaustive fidelity bar. Where documents conflict, the authority stack below decides — not folder names, not the reference README, not this rulebook's own prose.

## Type-of-work rules live with the work

| Work | Read first |
|---|---|
| Running live dsh/LLM or browser tests | `read-before-running-live-and-browser-tests.md` |
| Touching the reference tree in any way | `read-before-reference-tree-work.md` |
| Filing, claiming, or moving tickets; before implementing anything | `Issue-tracker/issue-tracker.md` |
| Domain vocabulary, ADR conventions, triage labels | `agent.md` (plus `CONTEXT.md`) |
| Cited research findings | `research/research.md` |
| Product behavior, scope, success criteria | `PRD-dsh-multitask-dispatcher.md` |
| Whether a decision is already ruled | `docs/adr/README.md` (and the ticket file itself) |
| GitHub/network trouble | `docs/agents-rulebook.md` §Environment & network |

## Authority stack

> **Flag (ticket 97):** this order is a **proposed order, verified against recorded practice — human reversal possible**. Each level cites at least one real repo record proving the level has operated that way. Adjacencies the record does not test are marked. If a rule conflicts between layers and **no recorded decision covers the conflict, stop and ask the human; never silently pick.**

In order, highest first:

1. **Human explicit override** — dated human rulings, whether spoken in-session or recorded on an ADR/ticket. *Practice:* ADR-0018 is "accepted (human-ruled, 2026-09-18 trim session) — the master rule" (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md`); the same day's reference-tree accepted-risk ruling is recorded as exception B9; and the ADR-0016 retraction shows a human override striking even a *signed* ADR (`docs/adr/README.md`).
2. **Accepted ADRs** — among them ADR-0018 is the human-ruled master rule and supersedes other accepted ADRs wherever they conflict (it supersedes accepted ADR-0005 and ADR-0009 by name). *Practice:* accepted ADR-0001 (`docs/adr/0001-typescript-in-process-multitask-core.md`) overrides AGENTS.md's "Not TypeScript" constraint row.
3. **The PRD as amended** — amendments ride with the PRD (the ticket-64 amendment batch recorded in ADR-0018's Consequences). It yields to accepted ADRs (ADR-0018 voided the PRD's feature-flag and clean-room-grep requirements; PRD §15 items are struck through as resolved/voided in place) and outranks stale AGENTS.md prose. *Practice:* PRD §8 resolved TypeScript while the AGENTS.md row still said otherwise — ADR-0001's Context records exactly this.
4. **Draft ADRs** (`-draft-nonhuman-approved`) — agent-drafted, pending human sign-off; they **move nothing until signed**. *Practice:* draft ADR-0017 explicitly "suspends" the PRD-first resolutions only upon signing — `docs/adr/README.md`: "Nothing is re-litigated until the text is signed … no existing code or ticket is retired on the strength of this draft alone"; draft ADR-0020 exists only to pick accepted ADR-0018's vehicle, not to extend it. **Delta from the ticket-97 sketch:** drafts are pulled out of the "accepted ADRs" level into their own level *below the PRD*, because the record shows an unsigned draft does not move the PRD.
5. **`CONTEXT.md`** — the shared-language glossary. It conforms upward, never downward. *Practice:* its 2026-09-19 amendment notes conform the glossary to accepted ADR-0018 (imitation boundary, "feature flag" voiding, copy policy). *Untested adjacency:* no record pits the glossary against a draft ADR; the placement is the proposal's.
6. **`AGENTS.md` + the `read-before-*.md` guides** — process rules; they yield to everything above. *Practice:* the old constraints-table rows yield to ADR-0001/ADR-0018 (see the register below), and the log-before-implementing rule bound even an ADR follow-up ("Implementation is ticketed separately (ticket 76) per repo rule", `docs/adr/README.md` on draft ADR-0019).
7. **Recorded ticket rulings** — including agent rulings explicitly marked subject to human reversal. *Practice:* ticket 69's Q1 — "ruled 2026-09-19 (overnight dispatched ruling, agent — subject to human reversal)" (`Issue-tracker/open/69-classifier-gated-auto-review.md`); the U-I re-scope "Agent-recorded 2026-09-19 as a dispatched overnight ruling, subject to human reversal" (recorded in ADR-0018's exception U-I, ticket 71). *Untested adjacency:* no record pits a ticket ruling directly against an AGENTS.md process rule; the sketch's order (process rules above ticket rulings) is kept and flagged.
8. **Research notes** (`docs/research/`) — evidence and decision inputs, **never rulings**. *Practice:* ADR-0001 cites `docs/research/dsh-extension-surface.md` as its evidence base; the notes themselves "take no side" (same file, on the language question).

**The stack settles, it does not re-open.** A recorded decision is the ruling — do not re-litigate ADR-0018, the ADR-0016 retraction, the S7 voiding, ticket 69's Q1, or any other recorded ruling by re-arguing precedence here. And verify a decision's **stated premise** before recording a new one: ADR-0016 was retracted 2026-09-18 as "signed under a fabricated premise" (`docs/adr/README.md`; tickets 50/51 cancelled) — that episode is why explicit precedence and premise-checking exist.

## Settled conflicts (cited by the stack, not re-opened)

1. **S7 self-contradiction (settled).** Old AGENTS.md voided the S7 clean-room identifier grep in its reference-policy section (2026-09-18 human ruling) while its "Definition of working" still required it. Settled by levels 1–2 over level 6: the grep is **voided** as a ship gate (ADR-0018; PRD §4 S7 carries the strikethrough).
2. **"Not TypeScript" row vs ADR-0001 (settled).** The constraints-table row "Not TypeScript. Prefer Go, else Python or Rust" is **superseded by accepted ADR-0001** (TypeScript in-process core; PRD §8/§15 had already resolved it). The row is preserved verbatim, marked superseded, in the register below.
3. **PRD-preference claim vs ADR-0018 (settled).** Old AGENTS.md said "prefer the PRD over folder names or the reference README"; accepted ADR-0018 voids PRD requirements (flag, S7) and the PRD was amended to conform (ticket 64). The real order — accepted ADRs above the PRD — is levels 2–3 above.

## Environment & network

Moved from `AGENTS.md` §Network, 2026-09-20, unmodified:

- A local proxy runs at port 7897. If GitHub connections fail, retry through it (e.g. `git -c http.proxy=http://127.0.0.1:7897 ...`).

npm (not pnpm) drives typecheck, offline tests, and the build (`package.json`).

## Moved-rule register (the no-rule-lost inventory)

Line-by-line disposition of every rule in the pre-decomposition `AGENTS.md` (2026-09-20 tree, tickets 96/97 open). **None deleted.** Grouped by the authority level of the destination home; within groups, old-file order. "Moved, unmodified" = the text now lives verbatim at the destination; "Point(er)" = the rule's authoritative text already lives at the destination and the old wording was a restatement.

### Rules whose home is a higher authority (levels 1–5) — AGENTS.md pointed, now the rulebook points

| Old AGENTS.md section | Rule | Disposition | Home |
|---|---|---|---|
| Reference-tree copying policy | "the reconstruction is confirmed public, but its upstream sources are unknown" (human ruling 2026-09-18) | Pointer | ADR-0018 exception B9 (`docs/adr/0018-imitate-reference-in-entirety-exception-list.md`); PRD §3 amendment |
| Reference-tree copying policy | "Do not verbatim-copy … Adapted copying … is permitted" | Pointer | ADR-0018 exception B9; PRD §3 |
| Reference-tree copying policy | "Architecture observation and implementation may now happen in the same session" | Pointer | PRD §3 Process 2 (tree "may be read and adapted"); ADR-0018 B9 |
| Reference-tree copying policy | "Recorded residual risk (human-accepted) … not a legal clearance" | Pointer | ADR-0018 B9; full sentence preserved in `docs/research/no-verbatim-copy-review-2026-09-19.md` |
| Reference-tree copying policy | "the S7 clean-room identifier grep is voided as a ship gate; naming … quality, not compliance" | Pointer | ADR-0018 Consequences; PRD §4 S7 strikethrough |
| Implementation constraints (PRD) | Multitask core: "**Not TypeScript.** Prefer Go, else Python or Rust. Owns FSM, registry, steer queue, todo reconciler, wake bus, policy assembly." | **Marked superseded — do not silently rewrite history** | Accepted ADR-0001 supersedes the language half (`docs/adr/0001-typescript-in-process-multitask-core.md`); the core's ownership half lives in PRD §7.1 |
| Implementation constraints (PRD) | dsh adapter: "Host-native glue for spawn / interrupt / jobs / todo / user send." | Pointer | PRD §7–§8 (adapter as Cordis/dsh glue); `src/adapter` implements it |
| Implementation constraints (PRD) | IPC: "Prefer embedded library if dsh supports it; else JSON-RPC sidecar." | Resolved by recorded decision | PRD §15 item 2 (resolved: in-process dsh plugin); ADR-0001 |
| Implementation constraints (PRD) | Persistence: "Use dsh session/job store; do not invent a second transcript DB." | Pointer | ADR-0018 exception A5; PRD §7.5 |
| Implementation constraints (PRD) | Prompts: "Adapted from the reference permitted; never verbatim text (2026-09-18 ruling)." | Pointer | ADR-0018 exception B9; PRD §3, §10, §17 |
| Implementation constraints (PRD) | Workers: "Blank context; full work tools; no user messaging. Only the dispatcher delivers to the user." | Pointer (note) | PRD §6.2; ADR-0018 conformances ("workers never address the user"). Note: the "blank context" half is governed by ADR-0018 exception A2 (host preset + persona prefix) — recorded here as a cross-reference, not re-litigated |
| Implementation constraints (PRD) | Steer: "Mid-run inject; preserve context; last-wins; do not restart." | Pointer | ADR-0018 exception B8; PRD §7.3; PRD §15 item 4 |
| Implementation constraints (PRD) | Todos: "Multiple `in_progress` allowed; `completed` means delivered to user, not merely worker exit." | Pointer (note) | PRD §6.5 + S6; ADR-0018 Consequences amended completion semantics to first-visible-ack — recorded here as a cross-reference, not re-litigated |
| Open decisions | "PRD §15 still needs explicit choices: core language … feature-flag default." | **Marked stale/superseded** | PRD §15 as amended: every item resolved or voided (ADR-0001, ADR-0002, ADR-0006, reference-behavior notes, ADR-0018). ADR-0006's Consequences had already recorded that AGENTS.md must not name an open §15 item — the local file had drifted |
| Definition of “working” | "Core unit tests run without network/LLM (fake wake/steer/complete) — S8." | Pointer | PRD §4 S8 |
| Definition of “working” | "Dispatcher stays responsive while workers run; workers never address the user — S1, S5." | Pointer | PRD §4 S1, S5 |
| Definition of “working” | "Legal QA: grep the shipped tree for reconstruction identifiers — S7 / PRD §12." | **Marked voided** | ADR-0018 (S7 grep voided); PRD §4 S7 strikethrough. See Settled conflict 1 |
| Source of truth | "Prefer the PRD over folder names or the reference README when they conflict." | Kept, scoped | Reading order above — and scoped below levels 1–2 per Settled conflict 3 |

### Rules whose home is a process rule (level 6) — moved unmodified into guides, the tracker guide, or this rulebook

| Old AGENTS.md section | Rule | Disposition | Home |
|---|---|---|---|
| (intro) | Repo is a TypeScript Cordis plugin (`src/` core/adapter/worker/client, `client/` surface); npm drives typecheck/tests/build | Kept | `AGENTS.md` stub intro; this file's intro (tracked) |
| Source of truth | "Read `PRD-dsh-multitask-dispatcher.md` before any implementation work." | Moved | Reading order above; `AGENTS.md` stub |
| Reference-tree copying policy | "The nested folder has its own `.git`. Never commit into it or treat it as the product repo." | Moved, unmodified | `read-before-reference-tree-work.md` §The one rule that lives here |
| Browser self-testing (authorized) | Authorization sentence + dsh-key rule + trivial-tasks rule (3 rules) | Moved, unmodified | `read-before-running-live-and-browser-tests.md` |
| Kill timers (mandatory) | Kill-timer-at-launch rule + 3 bullets | Moved, unmodified | `read-before-running-live-and-browser-tests.md` §Kill timers |
| Network | Local proxy on port 7897; retry GitHub through it | Moved, unmodified | This file §Environment & network |
| Agent skills → Issue tracker | Tracker layout: `Issue-tracker/<status>/`, see `Issue-tracker/issue-tracker.md` | Stayed (pointer) | `Issue-tracker/issue-tracker.md` (home) |
| Agent skills → Issue tracker | "always log an issue into the tracker before implementing anything … even for small changes" | Moved, unmodified | `Issue-tracker/issue-tracker.md` (moved there 2026-09-20, ticket 97) |
| Agent skills → Triage labels | Five-role label vocabulary | Stayed (pointer) | `agent.md` §Triage labels (home) |
| Agent skills → Domain docs | One `CONTEXT.md` plus `docs/adr/`; see `agent.md` | Stayed (pointer) | `agent.md` §Domain docs (home) |
| Agent skills → Research notes | `docs/research/<slug>.md`, one file per question; see `research/research.md` | Stayed (pointer) | `research/research.md` (home) |
| Non-goals | "Do not rebuild dsh inference/transcript/tool runtime, remote sandbox, or peer messaging hub … Do not chase Sand/Cursor/Grok Bot binary or UI parity." | Pointer | PRD §2 Non-goals (home); listed in the stub so it stays visible |

Register maintained by ticket 97 (2026-09-20). Verification hint for auditors: diff the pre-decomposition `AGENTS.md` against this table — every section and rule line above appears exactly once, moved or pointed, none deleted.
