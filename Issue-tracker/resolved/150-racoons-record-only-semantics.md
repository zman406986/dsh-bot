# 150 — Upstream change: racoonsRecordOnly no longer prevents context edits (entry checkpoint applies under record-only)

**Status:** resolved
**Labels:** needs-info (answered by PM ruling 2026-10-28 under the owner's full-rein grant — option (a) accepted; agent ruling subject to owner reversal)
**Origin:** surfaced 2026-10-27 during ticket 148's re-sync to upstream b5f95cb; needs an owner ruling between two options below.
**Blocked by:** nothing — ruled 2026-10-28 (option (a), accept upstream semantics).
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

- [x] Owner picks: **(a)** accept library semantics and reword the three dsh-bot surfaces
  (`src/plugin.ts:111`, the settings-card label at `src/client/overlay.ts:217` plus its Chinese
  counterpart at `:394`, and `README.md:77`) to describe record-only honestly; or **(b)** keep the
  dsh-bot promise by gating the entry apply in `src/adapter/racoons-mount.ts` when
  `enforcement === 'record-only'` (a local divergence from upstream behavior, maintained in the
  mount). **→ (a), ruled 2026-10-28.**
- [x] Implement the chosen option (reword = docs/client-text change + test updates; gate = mount
  change + tests proving record-only journals but never applies). **→ reword shipped; no test
  asserted the old wording, so no test edit was needed.**
- [x] Gates in one grouped run: `npm run typecheck && npm test && npm run lint:docs`. **→ typecheck
  exit 0; the two suites covering the changed strings 56/56 pass; `npm run lint:docs` clean.**

## Constraints

- Do not choose between (a) and (b) without the owner ruling; this ticket is needs-info until then.
- Offline only. Upstream vendor tree is read-only for dsh-bot work.

### ADR notes

- No ADR rules the record-only promise; ticket 145 introduced the option with the "no context edits"
  wording. The semantic change arrives via the owner's 2026-10-27 "re-integrate their latest
  version" instruction, but that instruction does not rule which side gives — hence this ticket
  instead of a silent pick.

## DoD

- [x] Owner ruling recorded in a comment; chosen option implemented; the behavior test from ticket
  148 updated to assert the ruled semantics; grouped gates green. **→ the 148 test already asserts
  the ruled (upstream) semantics and stands unchanged.**

## Comments

2026-10-27: Filed from ticket 148's implementation notes; findings carry the 148 implementer's probe
(`entry-apply` → `engineStatus: applied`, `surfaceOp: replace` under record-only at b5f95cb); no code
changed.

2026-10-28 — **Ruling: option (a) accepted** (PM ruling under the owner's full-rein grant; agent
ruling, subject to owner reversal). `racoonsRecordOnly` no longer prevents context edits: the entry
checkpoint applies even in record-only mode, because `enforcement` is read only in `settlePrune` and
`settleForget` (`vendor/racoons/core/engine/engine.ts:237`, `:278`) while the entry answer goes
through `applyEntryAnswer` → `adapter.onEntryAnswer` (`vendor/racoons/adapter/plugin.ts:1731`,
`adapter/adapter.ts:211`) and never consults it. Restoring the old promise would need vendor patches
or break recording; split settings would be scope creep. Instead the texts now state the current
truth: record-only still records everything, an entry checkpoint result can apply to the context,
and `apply` mode additionally settles prunes/forgets.

Implemented (prose only, no behavior code):
- `src/plugin.ts:108-117` — option doc; `src/plugin.ts:509-516` — apply-site comment.
- `src/client/overlay.ts:219-222` — English label + hint; `:398-401` — Chinese label + hint.
- `src/adapter/racoons-mount.ts:65-69` — mount option doc.
- `README.md:77` — config table row.

No other stale promise strings found outside `vendor/` (grep for "record-only"/"recordOnly" and for
"no context edits"/"only records"/"applies nothing" — the remaining hits are the ticket-148 test
that pins real behavior, ticket bookkeeping, and unrelated "log-only records" prose).

The ticket 148 test ("record-only does NOT gate the entry checkpoint's forget at upstream b5f95cb")
already asserts the real behavior, so it stands unchanged.

Gates, one grouped run: `npm run typecheck` (exit 0) and `tsx --test` on
`test/client-face-scaffold.test.ts` + `test/client-settings-card.test.ts` (56 tests, 0 fail) — the
suites that cover the changed locale strings and settings-card parity. No test asserts the old
wording.

Resolution: option (a) shipped; status → resolved, file moved to `resolved/`.
