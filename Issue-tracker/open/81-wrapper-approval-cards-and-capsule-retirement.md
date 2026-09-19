# 81 — Wrapper approval cards + capsule retirement (ADR-0020 slice 5)

**Status:** open
**Labels:** ready-for-human
**Blocked by:** 80 (cards render in the conversation surface), 69 (classifier gating design — this ticket is the wrapper-side rendering, 69 owns the gating design)
**Related:** ADR-0020 (inventory rows: approvals), 13/23/30 (relay + prompt UX re-host), 45/33 (live lane)

## What to do

- [x] Render the access relay's pending asks as inline cards in the wrapper's conversation
      surface: re-host ticket 30's prompt anatomy (plain-language title, clamped detail with
      omission marker, resolve actions, stale/pending fencing, session-scoped always-allow —
      U-D binding). Secret asks keep the never-shown promise copy (adapted).
      (2026-09-19: landed — commits 9bcdd4d (chunk-B projections) + 1acb918
      (rendering). `src/client/approval-pane.tsx`: the access-ask / secret-ask
      cards mount above the conversation transcript as the Needs-you area
      (heading reuses `roster.section.needs-you`); ticket 30's anatomy rides
      the projections verbatim — option labels, clamped detail + omission
      marker, wildcard-fenced option degradation, expired copy, secret-stored
      promise; the location line resolves per card through the 71 AC-4
      `locationFor` hook. Decision provenance renders the shipped
      `AccessDecision.reason` labels verbatim — a posture deny reads
      policy-denied with the self-naming auto-review detail. Resolve actions
      go through the injected seat; without it (today) a fed pending card
      shows the honest unavailable line — no dead buttons; submit failures
      show one honest line, retry-less (U-A). Honest absence: the section
      renders nothing while the store is unfed — the relay-truth feed +
      resolve transport into `Multitask.resolveAccess` are ticket 69's L1
      live lane. Worker-dispatch cards render presentation-time from the
      conversation's spawn records (replay-safe; C15 holds). Gates:
      typecheck clean; `npm test` 1056/0; build:client ok; tests in
      `test/approval-cards.test.ts` + `test/client-approval-pane.test.ts`. **Live confirm
      2026-09-20 (W14):** the secret-ask card + resolve round-trip LIVE-VERIFIED (Session B-5 —
      ticket 69's L1, ticked there this date); the worker-dispatch card LIVE-VERIFIED from a
      settled spawn (`[data-card-kind="worker-dispatch"]`, `gating="ungated"`; Session B-4
      `w21-42-pollA`/`w21-44-final`, `shots/w21-shot-final-dispatch-card.png` — FINDING 2 fix
      confirmed; re-rendered in Session C).)
- [x] While a card waits, the session's sidebar row shows the blocked marker with reason
      (closes the approval→presence loop, area 6).
      (Shipped by ticket 79's session-granularity presence — the blocked chip
      rides the roster mirror's structured ask (class+target) with the
      design-17 §4.1 precedence; offline-pinned in the 79/77 tests. Live
      confirmation with a real pending card belongs to 69's L2. **Live confirm
      2026-09-20 (W14): 69 L2 LIVE-VERIFIED (Session B-5, `w23-09`) — the
      blocked-with-reason marker rendered on the row while the secret-ask card
      waited.)**
- [x] Capsule retirement: remove the `shell.overlay` chip/panel entry and its routes once the
      frame election has shipped; the stores/sections live on inside the wrapper (they are
      re-host inventory, not deleted). Toolview slot entries retire with the host chat —
      their content moved in ticket 80.
      (2026-09-19: MOOT-VERIFIED — this landed with ticket 78's cutover, not
      here: a44084a retired the capsule and launcher overlay entries, 94e6127
      registered the frame as the dynamic root entry, and the stores/copy/
      components remain as re-host assets with dead-code disposition assigned
      to the 65/66/73 lane. Post-cutover the toolview slot entries are
      registered but unrendered (the frame replaces the host chat; the
      conversation pane renders tool rows from the window, incl. the
      worker-dispatch cards) — their retirement rides the same 65/66/73
      disposition. Nothing left to do in this ticket's rendering scope.)
- [x] Settings card (ticket 47) re-homes into the wrapper's own settings surface or stays a
      shipped-settings entry — decide with evidence once the frame displaces the settings UI.
      (2026-09-19: not this pass — the frame now displaces the settings UI at
      cutover, so the decision is live: the shipped settings page is
      displaced by our root frame, and ticket 47's card currently renders
      only inside the displaced surface. Ready for a live-lane/human call;
      note ticket 46's watch already feeds our own stores.
      **TICKED 2026-09-20 (W14): decided — STAYS a shipped-settings entry**, per the 2026-09-20
      agent ruling recorded below (W11 lane; subject to human reversal; the store is already
      wrapper-side so a human-directed re-home stays cheap). Evidence for the displaced-UI
      precondition: pass-4 + the Session B-2 boot. The ruling comment left this tick to the W14
      sweep; the ruling itself is untouched, and the ticket's disposition is W17's.)

## Constraints

- The relay's semantics (timeout ADR-0008, deny-by-default, dedupe) are untouched — rendering
  only. No persisted always-allow rules (U-D). No new prompt pathway.

### 2026-09-19 — agent (from 71: location-label contract folded here)

Ticket 71's AC-4 re-base design (capability-independent) lands in this ticket's card anatomy:
when re-hosting ticket 30's prompt anatomy, the card's location line resolves from 71's
per-producer-kind label map, superseding 30's constant `APPROVAL_LOCATION_LOCAL`
("Runs on your computer.", `src/adapter/access-prompt.ts:104`). Per 71's AC-1 gate (2026-09-19)
the dsh host exposes no remote-execution face, so today every real producer kind is local and
the map renders the local line everywhere — the contract point is that the card takes the
label resolved from the ask's producer kind, so a remote-box line becomes honest automatically
if the host ever grows the seam (71 is blocked on that human decision: host-seam request vs
descope-with-gaps). Unknown kinds fall back to the local line; no card may claim remote without
a verified kind. U-D binding unchanged: session-scoped always-allow only.

### 2026-09-19 — agent (implemented: approval cards landed; capsule-retirement AC reconciled as already-shipped by 78)

Landed in **9bcdd4d** (chunk-B projections — the contract this ticket renders,
frozen on 69) and **1acb918** (rendering + placement). The composition's
approvals wiring (store creation + pane seat) rode the concurrent **a2c09ed**
(ticket 85) that swept `index.ts` — attribution recorded on 69; no semantic
overlap. Gates at 1acb918: typecheck clean, `npm test` 1056/0 (offline),
`npm run build:client` ok.

**Placement decision.** The cards live in the conversation pane (the ticket's
"conversation surface"), as a pinned Needs-you strip ABOVE the transcript —
not a re-host of the roster panel's Needs-you section, which stays the
per-worker partition (worker rows). One copy vocabulary: the strip heading
reuses `roster.section.needs-you`; card titles reuse the shared
`roster.blocked.*` templates; decision reasons render as core vocabulary
verbatim. The session-row blocked marker (checkbox 2) was already the 79
mechanism, so no second marker was added.

**Worker-dispatch cards** (69 §3.2): settled `spawn_worker` records carry the
frozen card (conversation-store reduction; pure in the record → replay-safe)
and render above their collapsible tool row: title, stream, outcome
(worker id or `refused: <reason>` verbatim), gating
(`ungated | approval-allowed | approval-refused`, derived from the record's
`gated` marker / `auto-review-refused` reason). No relay, no wake kind (C15),
no ledger entry.

**Copy / CSS contracts.** Ticket 30's copy is re-keyed NOWHERE: option labels,
clamped detail, location line, expired copy, secret-stored reassurance arrive
as projected strings (en host-side constants — ticket 30's own precedent) and
render verbatim; the card's own chrome (target label, secret promise,
unavailable/no-channel/failed/submitted lines, gate label) is locale-keyed
en+zh. CSS is namespaced, token-only (`--dsw-alias-*`), opacity hierarchy, no
animation (pinned in tests).

**Honest-state matrix.** Unfed store → the strip renders NOTHING (unknown is
never "nothing needs you"); ready+empty → nothing (roster empty-section rule);
no resolve seat → unavailable line instead of dead buttons; no-channel /
failed submit → one honest line, the card stays, NO retry affordance (U-A);
routed → muted submitted line, card settles when the feed confirms.

**Remaining for this ticket:** the settings-card re-home decision (checkbox 4,
live/human — the frame now displaces the shipped settings UI at cutover) and
live verification of the cards through a real feed (69's L1; blocked-marker
L2). Capsule retirement (checkbox 3) reconciled above: already shipped by 78's
cutover — a44084a / 94e6127 / c437ee8; nothing capsule-era remains to render
against, so this ticket's rendering scope is entirely post-cutover.

Status stays **open** (checkbox 4 + live lane).

### 2026-09-19 — live pass 4 (`C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\`): what the one-flow boot could and could not show for this ticket

- **Needs-you cards:** never fed — the pass's single trivial worker task ("wait ~20 s, then
  reply done") asks no permission, and a permission-ASKING flow needs LLM legs that were out
  of the one-flow budget. Honest absence held: no pending cards, no dead buttons.
- **Worker-dispatch cards in the wrapper conversation:** UNOBSERVABLE this pass — the
  shell's conversation seat crashed on session selection (new ticket 88) and abdicated to
  the stock frame, where the flow ran and the STOCK tool rows rendered. First live render
  of the cards awaits 88.
- **Settings-card decision (the remaining open bullet): live evidence added** — the
  elected frame DISPLACES the shipped settings UI (no settings affordance exists inside the
  shell), so ticket 47's card is reachable only in the abdicated stock UI. That matches the
  comment's "the frame displaces the settings UI at cutover, so the decision is live"; the
  decision itself (re-home into our own settings surface vs stay a shipped-settings entry)
  still needs the lane/human call. Stays open.

### 2026-09-19 — pointer: the "65/66/73 disposition" this ticket rides is now ticket 89

The 2026-09-19 disposition CANCELLED 65/66/73 (moved to `Issue-tracker/cancelled/`) as
capsule-vehicle requests subsumed by the shell. The dead-code disposition they owned —
including this ticket's finding that the post-cutover toolview slot entries (ticket 24)
are registered but unrendered and "ride the same 65/66/73 disposition" — is now tracked
as **open ticket 89 ("Delete retired capsule source assets")**, which lists the toolview
verify-item explicitly. Nothing left to do here; reference updated for the moved files.

### 2026-09-20 — triage (overnight team-lead run, W0 bookkeeping)

Triaged 2026-09-20 by the overnight team-lead run: `ready-for-agent`. Residual: (i) live card
verification (rides 69's L1/L2 live round-trip — this ticket is sequenced behind it, no code work
tonight before that) and (ii) the settings-card re-home decision (checkbox 4, live-lane/human call).

### 2026-09-20 — agent ruling (W11 live lane): settings card STAYS a shipped-settings entry; no re-home into the wrapper

**Agent ruling by an autonomous overnight executor, subject to human reversal** — recorded here
because checkbox 4 asked for the decision "with evidence once the frame displaces the settings UI",
and the displaced-UI state is now live-confirmed (pass-4 evidence + tonight's boot: the elected
frame renders no settings affordance; ticket 47's card is reachable only in the stock settings
surface).

**Ruling: do NOT re-home the settings card into the wrapper.** Ticket 47's card stays a
shipped-settings entry. Reasons, with tonight's evidence:

1. **Re-homing is new surface scope, not a move.** The wrapper deliberately renders no settings
   chrome; a re-home means building a settings surface inside the frame (layout, zh/en copy parity,
   `--dsw-alias-*` token styling, the host's staged-save/discard discipline) to host two fields
   (`enabled`, `accessRequestTimeoutMs`) that apply to NEW chats only.
2. **The wrapper's activation UX is already covered in-frame** by ticket 68's onboarding flow
   (live-verified pass-5 Session A), so the settings entry is a low-traffic secondary surface —
   the flag's own copy says it "applies to new chats", and a new chat starts in the stock shell
   where the card already lives.
3. **U-D adjacency.** A wrapper settings card one refactor away from a settings-managed approvals
   controller is exactly the drift exception U-D excludes; keeping approval-adjacent config out of
   our own frame keeps the fence visual as well as structural.

The card's store (`settings-card-store.ts`) is already wrapper-side, so a later human-directed
re-home is cheap; nothing in this ruling deletes or blocks it. Reversal path: a human decision on
this ticket overrides the ruling; implementation is then ordinary scoped work.

**Checkbox 4 is left UNTICKED** — ticking (and any disposition) belongs to the W14 sweep with the
evidence review; this comment only records the ruling.

### 2026-09-20 — W11 live-lane findings (Session B-2; full record on ticket 33)

Session B-2 (evidence `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B2\`) ran two
trivial task flows on the live lane. No access ask ever parked (3/3 instructed workers skipped the
`request_access` call — suspected worker-toolset visibility gap, FINDING 1 in ticket 33's Session
B-2 record), so **access-ask/secret-ask cards remain live-unverified** (NOT-TRIGGERED; honest
absence held — no strip, no dead buttons). **FINDING 2 (this ticket): worker-dispatch cards did
not render** from two settled live `spawn_worker` records with delivered results — zero
`[data-card-kind]` elements after both spawns (`session-B2/driver/w11-23-dispatchcard.json.out.json`);
the projection's input record (`{ok, worker_id}` from the tool-result message,
`conversation-store.ts:404-424`) either does not arrive in the live host event shape or the
reduction never runs live. Offline pins exist; the live render is unproven. The served bundle
carries the full wiring (`projectDispatchCard` ×2, `applyRelayTruth` ×3 —
`session-B2/driver/w11-32-bundle.json.out.json`). No box moved; dispositions belong to the sweep.

### 2026-09-20 — agent (W19, FINDING 2 pinned AND fixed: the durable record never carried the structured result; the adapter now attaches it — merge f8067c3)

Issue reference: ticket 33's Session B-2 comment 2026-09-20 (commit `39a0dca`), FINDING 2 —
logged there per the tracker rule; no new ticket filed. Branch `wt/approval-relay-live-fixes`,
fix commit **`ec105ae`**, merge **`f8067c3`**.

**Root cause (host-source pinned, offline reproducible):** of the two hypotheses recorded live,
"the reduction never ran live" is out (tool rows render from the same window) and the input
shape is the one that failed — by HOST DESIGN, not by accident. The durable `tool/result` event
carries the tool's RENDERED text plus an OPTIONAL presentation projection, and NEVER the
structured `value`: `dsh-agent-loop/lib/index.js:697-712` (`appendToolResult`) spreads only
`result.meta` into the event; `dsh-tools/lib/index.js:3428` builds that `meta` solely from
`output.presentationMeta` (top-level calls). No registered dispatcher tool defined one, so the
record's `message.content` was the spawn ack prose (`renderStructured` prefers `ack`),
`toolResultRecord` found no `meta` and no JSON text, and `projectDispatchCard` honestly
returned null — zero cards from two settled live spawns. The offline fixtures had passed only
because they inlined the structured result as JSON text, a shape the real host never produces.

**Fix:** `toRegisterableTool` now attaches `structuredPresentationMeta` — the structured result
minus the model-facing prose fields (`ack` embeds the whole worker prompt; `summary` the
rendered table; `note`) — as every dispatcher tool's `output.presentationMeta`, so the durable
record's `meta` IS the structured half the client reducer already reads FIRST. All six tools
benefit: toolview rows gain real outcomes/rows live too (B-2's check_workers rows rendered
args-only). No core/relay change; B3 surfaces untouched.

**RED-check:** dropping only the `presentationMeta:` wiring line → the two adapter pins fail
("every registered dispatcher tool carries output.presentationMeta", "toRegisterableTool output
attaches the presentation projection") → re-applied → green.

**Pins added:** host-faithful `tool/result` fixtures (rendered prose + `meta`, exact
`appendToolResult` shape) projecting spawned / gated (`approval-allowed` from the record's own
`gated` marker) / refused (`approval-refused`) cards through the real reduction; plus a
REGRESSION PIN that the exact B-2 live shape (prose only, no `meta`) still degrades honestly —
no card, no fabricated fields — so a future reducer regression cannot silently "fix" itself by
guessing from prose.

**Gates on merged main:** typecheck clean (both configs); `npm test` **1118/271/0** (baseline
1108/270/0).

**How to verify live (B-4 or any later session):** spawn one worker through the dispatcher;
select the dispatcher row; the settled `spawn_worker` row must now carry a `[data-card-kind=
"worker-dispatch"]` element above it with `outcome` (spawned worker id) and `gating="ungated"`
(shipped posture is EMPTY — `gated: true`/`approval-allowed` still needs W12's L3 posture lane).
This rides the SAME rebuild the FINDING-1 contract fix rides: rebuild + profile remove/re-add
before boot (stale-profile trap), then the card should render with zero extra LLM cost beyond
the one trivial spawn.

### 2026-09-20 — W14 post-live bookkeeping: checkbox 4 ticked (decision recorded); live-confirm annotations added to checkboxes 1–2; no ticket disposition made here

- **Checkbox 4 → ticked.** The box asked for a decision with evidence once the frame displaces the
  settings UI; the decision exists (2026-09-20 agent ruling above, recorded during the W11 lane):
  the settings card STAYS a shipped-settings entry, subject to human reversal. The ruling comment
  left the tick to this sweep; the ruling itself is untouched.
- **Checkboxes 1–2 → live-confirm annotations added** (no new claims): the access-ask/secret-ask
  card render + resolve round-trip and the blocked-with-reason marker were LIVE-VERIFIED in
  Session B-5 (ticket 69's L1/L2, ticked there this date); the worker-dispatch card was
  LIVE-VERIFIED in Session B-4 (`w21-42-pollA`, `w21-44-final`,
  `shots/w21-shot-final-dispatch-card.png`) after the W19 FINDING-2 fix (merge `f8067c3`), and
  again in Session C. Evidence roots: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B4\`
  and `...\session-B5\` (each README maps artifact → claim).
- **`gated: true` / `approval-allowed` card anatomy remains live-unobserved** (needs the L3
  posture lane — 69 L3 BLOCKED-no-seeder). Recorded so the sweep does not overclaim. Capsule
  retirement (checkbox 3) stands MOOT-VERIFIED as recorded.

No file moved; the close/disposition call is W17's.

### 2026-09-20 — W17 disposition (stays OPEN; no file move): substance verified; the residual is the human-gated posture lane plus the reversible settings ruling

Disposition recorded per the overnight PLAN (69/81 are deliberately NOT closed by the sweep).

**What IS verified** (all four checkboxes ticked, live annotations in place):
- Rendering shipped + offline-tested (`9bcdd4d` projections + `1acb918` rendering; gates 1056/0 at the time; typecheck clean; build:client ok).
- Worker-dispatch card LIVE-VERIFIED from a settled spawn — `[data-card-kind="worker-dispatch"]`, `gating="ungated"` (Session B-4 `w21-42-pollA`/`w21-44-final`, `shots/w21-shot-final-dispatch-card.png`; the W19 FINDING-2 fix `f8067c3` confirmed live; re-rendered again in Session C).
- Access/secret-ask card anatomy + the resolve round-trip LIVE-VERIFIED via 69's L1 (Session B-5 — ticked on 69 by W14).
- Blocked-marker loop LIVE via 69's L2 (Session B-5 `w23-09` — the blocked-with-reason marker rendered on the row while the secret-ask card waited).
- Capsule retirement MOOT-VERIFIED (landed with 78's cutover: `a44084a`/`94e6127`; dead-code disposition rides resolved-ticket-89's completed pass).
- Settings-card re-home DECIDED: stays a shipped-settings entry (2026-09-20 agent ruling above, subject to human reversal; checkbox 4 ticked by W14).

Gates at disposition: `npm run typecheck` clean (both configs); `npm test` 1125 pass / 0 fail / 272 suites.

**Why it stays open — the cheap close path for a future session:**
1. `gating="approval-allowed"` / `gated: true` card anatomy remains live-unobserved — it needs the L3 posture lane; 69's L3/L4 are BLOCKED-no-seeder (no live posture-insert path exists and no seeder may ship per Q1/U-D). This resolves when the human rules on Q1 (ticket 69) or explicitly accepts ungated-only evidence as sufficient.
2. The settings ruling is human-reversible; a reversal reopens checkbox 4 cheaply (the store is already wrapper-side).

A future session may close this ticket once item 1 is human-dispositioned; everything else is recorded above with artifacts.
