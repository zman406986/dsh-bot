# 42 — Capsule footer provenance + tool-view link + offline composition close-out (epic 35 §4–5)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 38, 39, 40, 41 (all capsule sections exist; this finishes the
panel and closes the epic's offline scope).

## Context

Epic 35 §4–5: the five dispatcher tool-call views stay keyed in
`tool.call.toolview` (ticket 24) where the calls happen — the capsule at most
**links** to the latest; and the panel footer carries a profile/flag
provenance line plus a link into Settings, nothing editable inline in v1.
Honesty rules bind: every element renders from core state; an unverified
source degrades to omission with a recorded gap, never a fake.

**Tree rule:** same as ticket 38 (worktree branch until 33 merges).

## Requirements

- **Footer** — provenance line from verified sources only: flag state from the
  already-watched `multitask-dispatcher` settings namespace; profile identity
  only if ticket 36 found an honest client-visible source (else omit, gap
  recorded). Settings link only if ticket 36 verified the deep-link seam (else
  copy-only hint). Nothing editable inline.
- **Tool-view link** — ticket 24's `tool.call.toolview` registrations are
  untouched; the capsule adds at most a link affordance to the latest
  dispatcher tool view if ticket 36 verified a navigation path; otherwise no
  link (gap recorded). Never an embedded copy of a tool view inside the
  capsule.
- **Offline close-out (the epic's offline scope ends here):**
  - End-to-end fixture pass: dormant fixture → panel = activation pitch;
    activation flow (existing `test/activation-lifecycle.test.ts` truth) →
    activated composition with chip, activation row, sections, deliverables
    line, footer.
  - Locale validator green across the full enlarged dictionary (identical
    en/zh key sets).
  - No-stop guard final form: structural assertion over ALL capsule view
    models (chip, activation row, rows, deliverables, footer) — no direct
    stop/cancel/deactivate control field anywhere.
  - Update the surfaces README (ticket 32's) with the capsule: what it shows,
    its degrade states, and its honest gaps (36's degraded seams).
  - Clean-room habit: grep the changed tree for reconstruction identifiers
    (S7 discipline).
- `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client` green.

## Acceptance criteria

- [ ] Footer renders flag provenance from the settings watch; profile line and
      Settings link per ticket 36's verdicts (or omitted with the gap recorded
      in the ticket comment).
- [ ] Tool-view link per ticket 36's verdict (or absent, gap recorded);
      `src/client/toolviews.ts` registrations byte-unchanged.
- [ ] Full-composition fixture test added (extend
      `test/client-capsule-chip.test.ts` or new
      `test/client-capsule-composition.test.ts`): dormant and activated
      end-to-end over the store + view models.
- [ ] No-stop guard covers every capsule view model; surfaces README updated;
      identifier grep clean.
- [ ] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green.

## Verification

Named method: `npm test` (new composition suite + full offline suite),
`npm run typecheck`, `npm run build:client`, identifier grep. The real-browser
Playwright assertion of the assembled capsule (dormant + activated) remains
ticket 33's launcher/browser pass — epic AC 1 — and is the last gate before
the epic resolves.
