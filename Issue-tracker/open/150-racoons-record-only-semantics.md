# 150 — Upstream change: racoonsRecordOnly no longer prevents context edits (entry checkpoint applies under record-only)

**Status:** open
**Labels:** needs-info
**Origin:** surfaced 2026-10-27 during ticket 148's re-sync to upstream b5f95cb; needs an owner ruling between two options below.
**Blocked by:** owner ruling — option (a) reword vs option (b) gate is a product-behavior decision with no recorded ruling (authority-stack rule: never silently pick).
**Related:** ticket 148 (resolved-in-branch — the re-sync that surfaced it; behavior pinned by its new test "record-only does NOT gate the entry checkpoint's forget at upstream b5f95cb"), ADR-0018 (U-H usage rider context), ticket 145 (resolved — introduced racoonsRecordOnly).

## Problem

`racoonsRecordOnly` is documented in this repo as meaning **no context edits**. The claim appears in
three places:

- `src/plugin.ts:111` — "`record-only`: the same passes run and journal their verdicts, but no
  context edit is applied." (the option itself is `src/plugin.ts:114`, mapped to the library's
  `enforcement: "record-only"` at `src/plugin.ts:512-513`).
- The settings-card label — "Racoons record-only mode (no context edits)" at
  `src/client/overlay.ts:217`, with the Chinese counterpart "RACOONS 仅记录模式（不改动上下文）"
  at `src/client/overlay.ts:394` (key registered at `src/client/settings-card-store.ts:255`).
- `README.md:77` — "on means it only records."

At the old upstream pin `70c99ef` the promise held: the judge's `settleVerdicts` read
`enforcement === 'record-only'` and dropped the batch. At the new upstream pin `b5f95cb` the judge
pass is removed (upstream ADR-0028), and `enforcement` is read only in `settlePrune` and
`settleForget` (`vendor/racoons/core/engine/engine.ts:237`, `:278`) — neither is on the
entry-checkpoint path. The 148 implementer verified this with a probe, not by inference: under
record-only, `entry-apply` reports `engineStatus: applied` and writes `surfaceOp: replace` —
identical to apply mode.

Net effect for the owner: a user who enables `racoonsRecordOnly` expecting journal-only behavior now
gets context edits applied by the entry lane. Ticket 148 pinned the actual behavior in a test
(`test/adapter-racoons-mount.test.ts:1378`, "record-only does NOT gate the entry checkpoint's forget
at upstream b5f95cb") so the change cannot pass unnoticed, and deliberately did NOT reword product
text or add a gate — both were out of scope there.

## What to do

- [ ] Owner picks: **(a)** accept library semantics and reword the three dsh-bot surfaces
  (`src/plugin.ts:111`, the settings-card label at `src/client/overlay.ts:217` plus its Chinese
  counterpart at `:394`, and `README.md:77`) to describe record-only honestly; or **(b)** keep the
  dsh-bot promise by gating the entry apply in `src/adapter/racoons-mount.ts` when
  `enforcement === 'record-only'` (a local divergence from upstream behavior, maintained in the
  mount).
- [ ] Implement the chosen option (reword = docs/client-text change + test updates; gate = mount
  change + tests proving record-only journals but never applies).
- [ ] Gates in one grouped run: `npm run typecheck && npm test && npm run lint:docs`.

## Constraints

- Do not choose between (a) and (b) without the owner ruling; this ticket is needs-info until then.
- Offline only. Upstream vendor tree is read-only for dsh-bot work.

### ADR notes

- No ADR rules the record-only promise; ticket 145 introduced the option with the "no context edits"
  wording. The semantic change arrives via the owner's 2026-10-27 "re-integrate their latest
  version" instruction, but that instruction does not rule which side gives — hence this ticket
  instead of a silent pick.

## DoD

- [ ] Owner ruling recorded in a comment; chosen option implemented; the behavior test from ticket
  148 updated to assert the ruled semantics; grouped gates green.

## Comments

2026-10-27: Filed from ticket 148's implementation notes; findings carry the 148 implementer's probe
(`entry-apply` → `engineStatus: applied`, `surfaceOp: replace` under record-only at b5f95cb); no code
changed.
