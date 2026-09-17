# 38 — Capsule skeleton: collapsed chip + expand/collapse in the existing shell.overlay entry (epic 35)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 36 (chip interactivity is bounded by the verified `shell.overlay`
entry anatomy — pointer-events opt-in, anchoring).

## Context

Epic 35's fixed direction: one floating capsule in the shipped additive
`shell.overlay` list slot. Collapsed = a small chip, the glanceable presence
projection (activation-state dot; worker count when active; wake badge =
settled workers with undelivered results). Expanded = the panel. Today the
single overlay entry always renders the full panel
(`src/client/panel.tsx`; enriched sectioned store on the worktree branch).

**Tree rule (epic req 6):** if ticket 33's merge has not landed, implement on
the ticket-17 worktree (`C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch
`clone/always-on-dispatcher`) — the chip's worker count and wake badge need the
snapshot v2 fields (`status`, `delivered`) that only exist there; otherwise on
`main`. Tracker edits land on `main` either way.

## Requirements

- Keep exactly ONE `shell.overlay` entry: same id `multitask-dispatcher-roster`,
  same order −10 (`src/client/overlay.ts`). No second entry, no new slot, no
  shadowing registration.
- Add pure expand/collapse state to the store layer (`roster-store.ts` or a
  sibling `capsule-store.ts`): default **collapsed**; expand/collapse/toggle
  actions; state survives re-renders, resets are fine on fiber reload.
- New chip view model (pure function over the existing panel state + freshness,
  same style as `describeRosterPanel`):
  - **Activation dot** — exactly three states from existing store truth only:
    `dormant` (no snapshot observed — `waiting`), `active` (fresh snapshot),
    `error` (stale/`invalid`/`channel-missing` once an activation was seen).
    Dot color/class is ours, `multitask-dispatcher-` prefixed CSS.
  - **Worker count** — snapshot worker total, rendered only in `active`.
  - **Wake badge** — count of settled (terminal-status) workers with
    `delivered === false`; rendered only when > 0.
- Expanded state renders the existing panel content unchanged this ticket
  (sections from ticket 28); no activation row, deliverables, or footer yet.
- Locale keys for the chip (accessible labels, badge text) added to BOTH faces
  of `localeDictionary`; `validateLocaleDictionary` green. No literals.
- Degrade honestly: unavailable channel → chip shows the `error` dot (or
  `dormant` pre-activation per the mapping above), never a fake count.

## Acceptance criteria

- [ ] Chip view model unit-tested in a new `test/client-capsule-chip.test.ts`:
      dot-state mapping over all store kinds + staleness; worker-count gating;
      wake-badge threshold (0 hides, N>0 shows the exact count); toggle
      behavior; identity of the registration options (one entry, unchanged id).
- [ ] `test/client-roster-panel.test.ts` fixtures still pass — the dormant
      composition of the underlying panel is unchanged at this stage.
- [ ] Locale validator green with the enlarged dictionary (identical en/zh key
      sets, all strings).
- [ ] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      produces `client/index.js` (esbuild contract test green).

## Verification

Named method: `npm test` (new `test/client-capsule-chip.test.ts` + existing
`client-roster-panel`/`client-face-scaffold` suites), `npm run typecheck`,
`npm run build:client`. Browser assertion is deferred to ticket 33's pass.
