# 37 — Draft ADRs for the capsule epic: slot choice, materialization contract, browser-test infra (epic 35, process req 2)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 36 (ADR-0013's evidence is the re-verified seam findings).

## Context

Epic 35 process requirement 2: the decisions this epic makes are filed as
**draft, non-human-approved** ADRs under `docs/adr/`, with the suffix
`-draft-nonhuman-approved` in the file name and the header line
`**Approval:** non-human — agent-drafted, pending human sign-off`.

**Numbering must be resolved explicitly (ticket 33's open conflict).** The
sequence currently ends at `0009`. Design-17 §9 reserves:
`0010` presence-as-projection (tickets 27/28), `0011` session-scope
always-allow (ticket 30), `0012` activation replays durability (ticket 31).
Those are reserved to their design-17 tickets even though not yet filed; the
capsule ADRs therefore take **0013–0015** and say so in their headers.

## Requirements

File three ADRs in `docs/adr/`:

1. `0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md` — the
   capsule-vs-alternatives decision: additive `shell.overlay` chip+panel (epic
   design direction) vs right-sidebar takeover vs `sidebar.right.pane.tab`
   keyed claim. Cite ticket 36's re-verified findings and the shipped
   `registry.d.ts` DO-NOT-REGISTER-`root` convention as evidence.
2. `0014-client-bundle-materialization-contract-draft-nonhuman-approved.md` —
   what a `dsh.client.inject` declaration obligates (consumer-driven
   materialization; smallest-set rule; no `immediately` for ordinary plugin
   packages), grounded in ticket 34's landed fix (`package.json`, commit
   80c2932) as the worked case.
3. `0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md` —
   Playwright as the real-browser mount-test choice, run against a
   `dsh --profile web --patch` launcher boot; execution lives in ticket 33's
   browser pass (this epic's sub-tickets verify offline).

Each ADR: Context / Decision / Consequences, cites its sources (no reference
plugin code), and carries the required suffix + approval header.

## Acceptance criteria

- [x] Three files exist under `docs/adr/` with the exact suffix in each file
      name and the `**Approval:** non-human — agent-drafted, pending human
      sign-off` header line.
- [x] Each ADR's header explicitly resolves numbering: states 0010–0012 are
      reserved to design-17 §9's tickets, capsule ADRs start at 0013.
- [x] `docs/adr/README.md` index lists all three as draft status.
- [x] No product-code changes; `npm test` still green.

## Verification

File-name grep shows the suffix on all three; the README index includes them;
a reviewer pass confirms each ADR's decision matches epic 35's fixed design
direction (capsule in `shell.overlay`; inject-declared materialization;
Playwright infra) without reopening decided questions.

## Comments

### 2026-09-18 — three draft ADRs filed (0013–0015); done as specified

**Files** (exact names per the ticket's Requirements, suffix `-draft-nonhuman-approved` on each):

- `docs/adr/0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md` — decision:
  the capsule is **one additive `shell.overlay` list entry** (id `multitask-dispatcher-roster`,
  order −10; chip + expanded panel as the entry's own state); right-sidebar takeover and the
  `sidebar.right.pane.tab` keyed claim rejected (shadowing kinds, panel confinement);
  `root` refused per the shipped registry DO-NOT convention (`registry.d.ts:16–38`). Evidence:
  ticket 36's VERIFIED seam 1 (additive/order-sorted/click-through layer, per-entry error
  boundary with list-kind abdication, no geometry API) + the Better Sidebar lesson (Finding 1).
- `docs/adr/0014-client-bundle-materialization-contract-draft-nonhuman-approved.md` — decision:
  `dsh.client.inject` obligates **consumer-driven materialization**: declare the smallest set
  of packages bound at boot, never `immediately` for ordinary plugin packages (bootstrap-tier
  only in shipped 0.1.5-rc.1). Grounded in ticket 34's landed fix (commit 80c2932,
  `package.json` renderer+locale entries, each justified; settings deliberately omitted as a
  runtime-dynamic bind; regression-pinned in `test/client-face-scaffold.test.ts:132–148`) as
  the worked case; option D (no declaration / dynamic-only) recorded as the shipped bug class.
- `docs/adr/0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md` — decision:
  **Playwright headless Chromium** against a `dsh --profile web --patch` launcher boot
  (desktop `dsh-bot.ps1`); execution consolidated in **ticket 33's browser pass** (sub-tickets
  38–42 verify offline; epic AC 1 asserted there). Serial crash-probe shape (1 worker, 0
  retries, filename-separated lanes) per ticket 36's abstract mount-pattern; S8 + kill-timer
  rules binding on the lane.

**Numbering resolution (in every header):** 0010–0012 are reserved to design-17 §9's ADR plan
(ADR-0010 presence-as-projection → tickets 27/28; ADR-0011 session-scope always-allow →
ticket 30; ADR-0012 activation-replays-durability → ticket 31), which supersedes design-16
§9's older *conditional* ADR-0010 sketch (never written). The capsule drafts take 0013–0015.

**Verification done (offline, this ticket):**

- File-name check: all three carry the `-draft-nonhuman-approved` suffix; each file's header
  carries the exact `**Approval:** non-human — agent-drafted, pending human sign-off` line
  and a `**Numbering:**` line resolving 0010–0012.
- `docs/adr/README.md` index lists all three with status `draft (non-human-approved)` plus a
  note on the reservation.
- Decisions match epic 35's fixed direction verbatim (capsule in `shell.overlay`;
  inject-declared materialization; Playwright infra) — nothing reopened.
- Honesty check: ADR-0013 cites seams 1–2 (VERIFIED) only for the slot decision and keeps
  seams 4–5 (DEGRADED Settings deep-link / profile identity) out of it — those bind ticket 42's
  footer, and the ADRs nowhere promise a deep-link or a profile line.
- `npm test` → 515 pass / 0 fail (146 suites); `npm run typecheck` clean; diff is docs-only
  (three new ADRs, README index, this ticket).
- Clean-room: no forbidden tree opened; no reference-plugin code copied — sources are our own
  research notes (file:line), tickets, and design docs; no reconstruction identifiers.

**Handoff:** human sign-off of the drafts rides ticket 33's close-out pass, per epic process
req 2.
