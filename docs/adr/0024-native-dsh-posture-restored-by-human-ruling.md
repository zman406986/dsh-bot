# The dispatcher UI returns to the native-dsh posture — floating window, launcher, and capsule withdrawn by the human's 2026-10-18 ruling

**Status:** accepted (human-ruled, 2026-10-18 in-session directive) — supersedes ADR-0021 decisions 2 and 4 and ADR-0022 in full; ADR-0021 decision 1 (stock dsh is never displaced) stands and is strengthened; **2026-10-18 rider appended** — one additive sidebar session-kind glyph (slot id sidebar.session.row.leading), decisions 2–4 unchanged; **2026-10-18 rider addendum appended** — three session kinds stated (dispatcher / worker / normal), the slot confirmed as already used by the host's schedule plugin, the session-kind-at-render-time question left unresolved; **2026-10-21 note (0030):** decision 2's `/dispatcher-start` phrasing is superseded on the name — the command is `/dsh-bot` (human-ruled) — and decision 3's retained `/dispatcher-stop` command transport is withdrawn (deactivation implicit via host disposal); decisions otherwise stand

**Numbering:** 0024, the first free number at filing (2026-10-18; highest in use was 0023). Filed by the records pass for the 2026-10-18 in-session human ruling; implementation is ticketed separately as ticket 114 per repo rule.

**Supersedes wherever conflicting:** ADR-0021 **decision 2** (dispatcher functions called out into a separate floating window launched from an additive `shell.overlay` affordance) and **decision 4** (the existing surfaces re-host into that floating window) are superseded — the floating surface is withdrawn. **ADR-0022 is superseded in full** (the collapsed launcher is not revived as a capsule; there is no launcher). ADR-0021 **decision 1 stands and is strengthened**: stock dsh is the user's primary UI, our module registers nothing into its layout, and nothing can displace it. ADR-0021 **decision 3's permission** — dispatcher sessions may be added and deleted, amending ADR-0018 exception U-G for dispatcher sessions only — stands as a functional capability carried by the adapter commands and retained client wiring; only its client affordance is withdrawn from the default posture. ADR-0021 **decision 5** (vocabulary) stands. ADR-0018's vehicle clause as amended by 0021 (addon coexistence, stock dsh primary) stands; this ADR narrows the addon to the stock UI's own keyed slots. ADR-0013's seam research remains evidence, not a vehicle.

**Evidence:** the human's 2026-10-18 in-session directive, recorded at filing in ticket 114 §Problem B and §Conflicts surfaced: the dispatcher UI returns to the state at commit `e773ef8` — stock dsh is the primary UI, the client module renders nothing into dsh's layout, and there is no floating window, launcher, or capsule — while every later functional change is kept. No verbatim quotation of the directive exists in the record, so this ADR cites the ticket's dated transcription rather than inventing a quote (the ADR-0016 fabricated-premise lesson). Codebase facts verified 2026-10-18 at filing: at commit `e773ef8` (ticket 99's resolution) the default composition makes exactly two slot registrations — the keyed `tool.call.toolview` entries and the keyed `settings.plugin.item` card; the locale namespace and the settings-scope bind are the module's other, non-layout registrations. From `e773ef8` to HEAD (`1f5ae26`) the client delta is 9 files, +2322/−100, adding the floating window (`src/client/floating-window.tsx`, `src/client/floating-window-store.ts`), the launcher/capsule registration (`src/client/overlay.ts`), and the shell re-host (`src/client/index.ts`, `src/client/shell.tsx`, `src/client/shell-store.ts`).

## Decision

1. **The dispatcher UI returns to the `e773ef8` native-dsh posture.** Stock dsh is the primary UI. The client module registers nothing into dsh's layout: no `shell.overlay` entry, no keyed `main` page, no `root` frame. Its client-side registrations are the locale namespace, the keyed `tool.call.toolview` entries, and the keyed `settings.plugin.item` card — stock dsh's own surfaces.
2. **The floating surface is withdrawn.** No floating window, launcher chip, capsule, drag, resize, maximize, or right-click-close chrome is composed. Nothing of ours floats over or beside stock dsh. Dispatcher conversation happens in the stock chat (the `/dispatcher-start` activation path), and the stock settings card remains the one configuration surface.
3. **Functional work is preserved in full.** The override reaches UI chrome only. Kept: ticket 101's adapter add/delete/stop commands and their client wiring (the start/stop command lines, add picker, delete arming, and add/delete seats) as retained, unmounted machinery; ticket 108's wake-coalescing window and its settings field; ticket 113's file inbox and its three settings fields; ticket 102b's nested `remote.commands` inject entry that command delivery needs; and every core, adapter, and worker change (tickets 108–110, 112, 113 and their predecessors). Deleting any of these is out of scope for this override.
4. **Reversibility.** The client module composition point stays single — `src/client/index.ts`'s `apply` — so a future surface is registered in one place. The shell machinery (`mountShellPage`, `src/client/shell.tsx`, `src/client/shell-store.ts`, `src/client/shell-mount.ts`, `src/client/panel.tsx`) stays in the tree as retained, not-composed machinery, exactly as `mountShellPage` was at `e773ef8`. The floating-window/capsule files are ticket 114's to delete; restoring that surface means a future ticket re-registering at the one composition point, not resurrecting ADR-0021/0022 silently.

## Context

ADR-0021 ruled the dispatcher UI into a floating window (decisions 2 and 4) and ADR-0022 revived the collapsed launcher as an information-bearing capsule. Both are accepted, human-ruled records. The human has now ruled the target posture back to native dsh: stock dsh is the product's UI, and the dispatcher is a chat-level behavior, not a second window.

Authority stack: a dated human explicit override is level 1 and sits above accepted ADRs (level 2). It is recorded here as a human-ruled ADR per the ADR-0021/0022 precedent so the supersession is explicit rather than silent, and so accepted-ADR bodies stay untouched (the recorded 2026-09-19/09-20 convention: dated notes on Status lines and the index, never body edits). Cancelled ticket 73's anti-revival clause is satisfied by the book: ticket 114 is the new ticket, and the dated ruling is its evidence.

The ticket-114 execution lane is the implementation; this ADR is the record that unblocks it. The records step must be complete before the client revert merges — the authority stack forbids an agent silently reversing an accepted human-ruled ADR.

## Considered options

| Option | Rejected/kept because |
|---|---|
| Keep the floating window (ADR-0021 decisions 2/4) | **Rejected** — contradicts the dated human override. |
| Keep only the capsule/launcher as a small affordance | **Rejected** — the override names the capsule and launcher explicitly; ADR-0022 is superseded in full. |
| Return to the `e773ef8` native-dsh posture, keep all functional changes | **Kept** — the override's own shape; the composition point and shell machinery keep it reversible. |
| Revert `src/client/` wholesale to `e773ef8` | **Rejected** — a literal checkout re-breaks ticket 102b's command delivery and drops tickets 101/108/113; the revert must be selective (ticket 114 §Constraints). |

## Consequences

- The dispatcher module renders nothing into dsh's layout. The stock chat carries dispatcher conversation; the stock settings card carries configuration; tool-call views render where dispatcher tool calls happen.
- ADR-0021's **Status:** line, ADR-0022's **Status:** line, and the ADR README's rows/prose carry dated notes per the recorded convention; accepted-ADR bodies stay untouched.
- The PRD's vehicle wording at §6.1, §11 item 5, and §15 item 6 carries dated amendments in the ticket-64 style, citing this ADR.
- `docs/surfaces.md` is corrected to the post-revert posture: stock dsh primary, no layout registration, shell surfaces retained as unmounted machinery. Its stale capsule-era inventory (files that no longer exist) is removed as a live claim.
- The client-side add/delete affordances from ticket 101 become unreachable without a mount. The functional wiring is retained either way; whether the owner wants one reachable management place later is recorded as an open ticket-level question, not decided here.
- Ticket 106's right-click close menu is withdrawn with the floating window chrome; its disposition (delete or retain unmounted) is ticket 114's to record.
- The crash-isolation principle stands for any future surface: a surface of ours must fail in isolation and never take stock dsh down. With nothing registered, no crash vector exists today.
- Tests that pin the retired floating/launcher/capsule posture are re-based or removed by ticket 114; tests for the preserved functional work stay and are re-based to the native-dsh posture.

## Open questions

None blocking the revert. Whether the owner wants a later reachable place for dispatcher-session add/delete is recorded in ticket 114 for the owner to answer; the code is retained either way.

## Traceability

- ADRs: 0021 (decisions 2/4 superseded; decision 1 stands and is strengthened; decision 3's permission and decision 5 stand), 0022 (superseded in full), 0018 (vehicle clause as amended by 0021 stands; U-G amendment for dispatcher sessions stands), 0013 (seam research survives as evidence), 0010 (mirror honesty, unchanged).
- Tickets: 114 (implementation and the records step), 99 (commit `e773ef8` is its resolution — the posture reference), 100/102/102b/103/105/106/107 (UI work withdrawn; 102b's `remote.commands` fix preserved), 101 (add/delete/stop functional work preserved), 108/109/110/112/113 (functional work preserved), 73 (cancelled — anti-revival clause satisfied by this ADR + ticket 114).

## Rider — 2026-10-18: session-kind indicators (one additive sidebar glyph)

**Status:** recorded (human-ruled, 2026-10-18 in-session directive) — narrows decision 1's sentence "registers nothing into dsh's layout" and nothing else. Decisions 2–4 stand unchanged. Implementation is ticket 114's, pending the client 0.2.1 port; this rider records the ruling, not a shipped surface. **Updated by the rider addendum below (same date):** three session kinds stated, the slot confirmed as already used by the host's schedule plugin, the session-kind-at-render-time question left unresolved.

**Evidence:** the human's 2026-10-18 in-session instruction, as relayed to this records pass: "add some small indication symbols even though we returned to the default UI — visually separating dispatcher sessions from subagent sessions from normal sessions." Verified read-only against dsh 0.2.1-rc.2 in `.scratch/repo-analysis/2026-10-18-session-indicators.md`: `sidebar.session.row.leading` is a `list` slot with `scope: root`, owner payload `{ sessionId }`, declared at `dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:123`, runtime declaration `dsh-client-ui-workspace/lib/client.js:5239`, render site `:2306`; the shipped catalog records `replaceRisk: none`; its only stock occupant is `client-ui-schedule`'s `schedule-mark` at order 10. The slot is a 16px leading cell before the session title.

### The rider ruling

1. **Exactly one additional additive registration is permitted, and it is this one.** The client module may register `sidebar.session.row.leading` to render a small glyph for dispatcher-owned sessions, including peer dispatchers. Decision 1's enumeration otherwise stands; no other slot is licensed by this rider. Dispatcher identity already reaches the client through the existing roster mirror (`roster.<sessionId>`), so no new host channel is licensed either.
2. **The scope is a glyph and nothing else.** A small mark in the stock leading cell. No replacement of stock layout, no floating surface, no removal or shadowing of stock elements, no `shell.overlay`, no keyed `main`, no `root` frame.
3. **The glyph's visual distinction is TBD.** Whether a dispatcher and a peer dispatcher get different glyphs is not decided here; this rider invents no design and no icon vocabulary.

### Known limits of the requested behavior (recorded, not chosen)

- **Worker/subagent sessions cannot be marked in the list.** Stock dsh stamps them `origin: 'subagent'` (`dsh-subagent/lib/index.js:354`) and hides them from the sidebar (`dsh-client-ui-workspace/lib/client.js:965`). They are never rows, so the request's "separate subagent sessions" intent is only partly achievable: the mark can separate dispatcher-owned sessions from normal sessions, and worker activity stays visible only through stock's own "N subagents running" on the parent row. This is a known gap of the requested behavior, not a design choice of ours.
- **The mark renders only on resting sessions.** The leading cell mounts only when the row is idle, non-archived, and non-blank. A running or pending row shows stock's own status dot in that cell instead (`dsh-client-ui-workspace/lib/client.js:2306`). The mark therefore appears only when a session is idle; it is not a running indicator.
- **The cell is 16px.** Glyph only; text does not fit.

### Rider consequences

- `docs/surfaces.md`'s live inventory carries the mark as ruled-but-not-implemented, with its limits.
- `test/client-face-scaffold.test.ts`'s "renders NOTHING into dsh's layout" pin is narrowed by exactly this one registration when the client 0.2.1 port lands; the rest of the pin stands.
- The crash-isolation principle stands: a throwing entry abdicates per entry and does not take stock dsh down.
- This rider does not alter the ADR's Context, Considered options, or Consequences sections, and the 2026-10-18 records pass leaves the accepted body above it untouched.

## Rider addendum — 2026-10-18 (second records pass): three session kinds, the slot confirmed, and the unresolved kind question

**Status:** recorded (human-ruled, 2026-10-18) — updates the rider above with the ruling as later stated in the dispatcher peer/memory/indicators study. The study records the ruling as: "Use `sidebar.session.row.leading` to show a small glyph distinguishing dispatcher sessions, worker sessions, and normal sessions. Nothing else changes in the UI — the native posture stands (ADR-0024)." Its recorded consequence: "needs a durable way to identify a session's kind at render time; the slot receives only a session id" (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 5). The rider above is not rewritten; this addendum is the current record where the two differ.

**What this addendum changes in the rider above:**

1. **Three kinds, stated explicitly.** The ruling distinguishes **dispatcher**, **worker** (subagent), and **normal** sessions. The earlier rider already recorded that worker/subagent sessions are hidden from the stock sidebar and cannot be marked; that limit still stands, and the three-kind wording does not remove it. The glyph decision for each kind, and whether worker sessions get any mark at all, remains the implementation's.
2. **The slot is confirmed, not merely plausible.** `sidebar.session.row.leading` is a real slot and **the host's own schedule plugin already registers into it** (`dsh-client-ui-schedule/lib/client.js:7528`). This is host-shipped usage, so the rider's "exactly one additional additive registration" claim is now backed by an occupant in the installed tree, not only by the catalog. Existing verification stands: the workspace sidebar renders the cell per row (`dsh-client-ui-workspace/lib/client.js:2306`), the payload is `{ sessionId }`, and the cell is 16 px.
3. **Nothing else in the rider changes.** Still one additive registration, glyph only, no layout replacement, no floating surface; the crash-isolation rule stands; the glyph's visual distinction is TBD.

**The open question stays unresolved.** What identifies a session's **kind** at render time — an origin field, our own marker, or session metadata — is **not decided** (`docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Open questions" item 4). The slot receives only a session id. No marker is invented here, and C13 (no agent-identity roster) constrains any answer: the kind must be a session property, not a saved agent identity.

**PRD amendment:** none is made by this addendum. If the glyph ever needs product wording, it is ticket 114's to place in the existing UI-surface paragraph of §6.1, in the ticket-64 style; no new PRD section is anticipated.

**Traceability:** ADR-0024 rider above (one additive glyph, slot id `sidebar.session.row.leading`), `docs/research/dispatcher-peer-memory-indicators-design-2026-10-18.md` §"Owner decisions" item 5 and §"Open questions" item 4, ADR-0018 C13 (no identity roster).
