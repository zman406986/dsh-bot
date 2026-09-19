# 81 — Wrapper approval cards + capsule retirement (ADR-0020 slice 5)

**Status:** open
**Labels:** needs-triage
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
      `test/approval-cards.test.ts` + `test/client-approval-pane.test.ts`.)
- [x] While a card waits, the session's sidebar row shows the blocked marker with reason
      (closes the approval→presence loop, area 6).
      (Shipped by ticket 79's session-granularity presence — the blocked chip
      rides the roster mirror's structured ask (class+target) with the
      design-17 §4.1 precedence; offline-pinned in the 79/77 tests. Live
      confirmation with a real pending card belongs to 69's L2.)
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
- [ ] Settings card (ticket 47) re-homes into the wrapper's own settings surface or stays a
      shipped-settings entry — decide with evidence once the frame displaces the settings UI.
      (2026-09-19: not this pass — the frame now displaces the settings UI at
      cutover, so the decision is live: the shipped settings page is
      displaced by our root frame, and ticket 47's card currently renders
      only inside the displaced surface. Ready for a live-lane/human call;
      note ticket 46's watch already feeds our own stores.)

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
